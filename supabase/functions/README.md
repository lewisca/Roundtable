# Roundtable — payments (Stripe + Supabase Edge Functions)

Turns the "Keep it live — $19.99/yr" button into a real subscription using
**Stripe Managed Payments** (Stripe is merchant of record and handles tax via the
product's tax code). Card details are collected on Stripe's hosted Checkout page —
they never touch the app or the database. The board only flips to paid via the
signed webhook. Uses the preview API version **`2026-02-25.preview`**.

Two functions + a one-time product setup:
- `setup/create-product.mjs` — run once; creates the product + yearly price.
- `create-checkout` — the app calls it; returns a Stripe Checkout URL
  (`managed_payments[enabled]=true`).
- `stripe-webhook` — Stripe calls it after payment; flips the board to paid.

---

## 1. Database — run once in the SQL Editor

Lifecycle: a free board is **fully editable for 7 days**, then goes
**read-only** — everyone can still see the whole tree, but no one can edit it or
add new people until someone pays. Paying flips `is_paid` (via the webhook) and
editing returns instantly.

```sql
-- Billing / lifecycle columns (safe to re-run). 7-day free trial.
alter table public.boards
  add column if not exists created_at  timestamptz not null default now(),
  add column if not exists expires_at  timestamptz not null default (now() + interval '7 days'),
  add column if not exists is_paid      boolean     not null default false,
  add column if not exists owner_email  text,
  add column if not exists paid_until   timestamptz,
  add column if not exists stripe_customer_id     text,
  add column if not exists stripe_subscription_id text;

-- New default is 7 days; move any existing 3-day rows out to a week from creation.
update public.boards set expires_at = created_at + interval '7 days'
  where not is_paid and expires_at < created_at + interval '7 days';

-- Fast lookup for renewals / cancellations
create index if not exists boards_stripe_sub_idx on public.boards (stripe_subscription_id);

-- Boards stay READABLE forever (read-only after the trial); the write guard below
-- is what actually freezes editing. Anyone with the code can read, as before.
drop policy if exists "read boards" on public.boards;
drop policy if exists "read live boards" on public.boards;
create policy "read boards" on public.boards
  for select using (true);

-- Browser clients (anon): billing columns are server-only, AND once the free
-- week is up on an unpaid board the tree data is frozen too (read-only).
create or replace function public.guard_board_billing()
returns trigger language plpgsql as $$
begin
  if tg_op = 'update' and current_user in ('anon','authenticated') then
    new.is_paid := old.is_paid;                 new.expires_at := old.expires_at;
    new.owner_email := old.owner_email;          new.paid_until := old.paid_until;
    new.created_at := old.created_at;
    new.stripe_customer_id := old.stripe_customer_id;
    new.stripe_subscription_id := old.stripe_subscription_id;
    -- read-only after the trial: reject tree edits on an expired, unpaid board
    if not old.is_paid and old.expires_at <= now() then
      new.data := old.data;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists boards_guard_billing on public.boards;
create trigger boards_guard_billing
before update on public.boards
for each row execute function public.guard_board_billing();
```

## 2. Stripe — create the product (managed payments)

Grab your **secret key** (`sk_test_…` to start) from Stripe → Developers → API keys,
then create the product + yearly price by running the setup script once — it
creates a product with the digital tax code `txcd_10103100` and a $19.99/year
recurring price, and prints the **price ID**:

```bash
STRIPE_SECRET_KEY=sk_test_xxx node setup/create-product.mjs
# -> ✅ Yearly price: price_xxx   (use this as STRIPE_PRICE_ID below)
```

(You can also create the product in the Dashboard, but the script sets the tax
code + preview version for you.)

## 3. Set the function secrets

```bash
supabase secrets set \
  STRIPE_SECRET_KEY=sk_test_xxx \
  STRIPE_PRICE_ID=price_xxx \
  SITE_URL=https://famroundtable.com
# SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.
```

## 4. Deploy

```bash
supabase functions deploy create-checkout
supabase functions deploy stripe-webhook --no-verify-jwt
```

## 5. Register the webhook

1. Stripe Dashboard → Developers → **Webhooks** → Add endpoint:
   `https://<your-ref>.functions.supabase.co/stripe-webhook`
2. Select events: `checkout.session.completed`, `invoice.paid`,
   `customer.subscription.deleted`.
3. Copy the endpoint's **Signing secret** (`whsec_…`) and set it:
   ```bash
   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_xxx
   supabase functions deploy stripe-webhook --no-verify-jwt
   ```

## 6. Test

Use Stripe **test mode** + card `4242 4242 4242 4242`, any future expiry/CVC.
Click "Keep it live" in the app → Checkout → pay → you're returned to the board
with `?paid=1`; within a couple of seconds the webhook flips `is_paid` and the
"Live" state appears (via realtime).

---

### How it behaves
- **One board, one code.** The tree is always visible to anyone with the code.
  Paying just keeps it *editable*; it never changes who can view it.
- **Free for 7 days, then read-only.** After the trial an unpaid board freezes —
  fully visible, no edits, no new people — until someone pays.
- **Paying unfreezes instantly.** The webhook sets `is_paid`; the browser sees it
  over realtime and editing returns with no reload.
- **Renewals** (`invoice.paid`) push `expires_at`/`paid_until` out another year.
- **Cancellation** clears `is_paid`; the board stays live until `expires_at`, then
  drops back to read-only (not dark), exactly like a lapsed free board.
- The purchaser's email is stored as `owner_email` (receipt + link recipient).

---

# `notify-board` — email/text the code + expiry (optional)

On the create/join screen a person can enter an **optional** email or phone.
When they create or join, the app calls this function, which emails (Resend) or
texts (Twilio) them the board code, the link, and when it goes read-only (the
7-day rule, or the renew date if paid). It's best-effort — if the relevant provider
isn't configured it returns 501 and the app silently ignores it.

### Providers (set the ones you want)

**Email — Resend**
1. Create a Resend account, verify your sending domain, get an API key.
2. Set secrets:
   ```bash
   supabase secrets set \
     RESEND_API_KEY=re_xxx \
     RESEND_FROM="Roundtable <hello@famroundtable.com>" \
     SITE_URL=https://famroundtable.com
   ```

**Text — Twilio** (SMS needs a Twilio number + A2P/10DLC registration and
recipient consent, per carrier rules)
```bash
supabase secrets set \
  TWILIO_ACCOUNT_SID=ACxxx \
  TWILIO_AUTH_TOKEN=xxx \
  TWILIO_FROM=+1xxxxxxxxxx
```

### Deploy
```bash
supabase functions deploy notify-board
```
(Keep JWT verification on — the app calls it with the anon key.)

Until it's deployed, the field still works and is saved; the app just doesn't
send anything (no error shown to the user).

---

# `family-agent` — the tree assistant (optional)

The "✨ Assistant" in the board menu drafts an **obituary** or a **seating chart**,
or **answers questions** about the family — but only from the tree on that board.
The model does two things only: read the person's intent, and format the output.
Every fact comes from deterministic, board-scoped tools (`family_overview`,
`find_person`, `get_relatives`, `find_conflicts`, …); the model is told it may
never invent a name, date, or relationship. So it can't hallucinate a relative
into someone's obituary — if it isn't in the tree, it isn't in the draft.

The Anthropic API key lives only in this function (never in the static client).
The app calls it with the anon key and the board **code**; the function loads
that board's tree with the service_role key and runs the agent against it.

### Set the secret

```bash
supabase secrets set ANTHROPIC_API_KEY=sk-ant-xxx
# optional — defaults to claude-sonnet-5:
supabase secrets set AGENT_MODEL=claude-sonnet-5
```

### Deploy

```bash
supabase functions deploy family-agent
```

(Keep JWT verification on — the app calls it with the anon key.)

Until the key is set the app degrades gracefully: the Assistant still opens, and
Generate shows "The assistant isn't available yet (it needs setup)" instead of
erroring.
