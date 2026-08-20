# Roundtable — payments (Stripe + Supabase Edge Functions)

Turns the "Keep it live — $19.99/yr" button into a real subscription. Card
details are collected on Stripe's hosted Checkout page — they never touch the
app or the database. The board only flips to paid via the signed webhook.

Two functions:
- `create-checkout` — the app calls it; returns a Stripe Checkout URL.
- `stripe-webhook` — Stripe calls it after payment; flips the board to paid.

---

## 1. Database — run once in the SQL Editor

```sql
-- Billing / lifecycle columns (safe to re-run)
alter table public.boards
  add column if not exists created_at  timestamptz not null default now(),
  add column if not exists expires_at  timestamptz not null default (now() + interval '3 days'),
  add column if not exists is_paid      boolean     not null default false,
  add column if not exists owner_email  text,
  add column if not exists paid_until   timestamptz,
  add column if not exists stripe_customer_id     text,
  add column if not exists stripe_subscription_id text;

-- Fast lookup for renewals / cancellations
create index if not exists boards_stripe_sub_idx on public.boards (stripe_subscription_id);

-- "The link goes dark": free boards stop loading once expired; paid stay live
drop policy if exists "read boards" on public.boards;
drop policy if exists "read live boards" on public.boards;
create policy "read live boards" on public.boards
  for select using (is_paid or expires_at > now());

-- Browser clients (anon) can only edit the tree; billing columns are server-only
create or replace function public.guard_board_billing()
returns trigger language plpgsql as $$
begin
  if tg_op = 'update' and current_user in ('anon','authenticated') then
    new.is_paid := old.is_paid;                 new.expires_at := old.expires_at;
    new.owner_email := old.owner_email;          new.paid_until := old.paid_until;
    new.created_at := old.created_at;
    new.stripe_customer_id := old.stripe_customer_id;
    new.stripe_subscription_id := old.stripe_subscription_id;
  end if;
  return new;
end $$;

drop trigger if exists boards_guard_billing on public.boards;
create trigger boards_guard_billing
before update on public.boards
for each row execute function public.guard_board_billing();
```

## 2. Stripe — create the product

1. Stripe Dashboard → **Products** → add product "Roundtable — one family".
2. Add a **recurring** price: **$19.99 / year**. Copy the **price ID** (`price_…`).
3. Grab your **secret key** (`sk_live_…` or `sk_test_…`) from Developers → API keys.

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
- **One board, one code.** Paying only extends the board's life (a year); it
  never changes who can access it. Everyone with the code keeps full access.
- **Renewals** (`invoice.paid`) push `expires_at`/`paid_until` out another year.
- **Cancellation** clears `is_paid`; the board then lives until `expires_at` and
  goes dark after, exactly like a free board.
- The purchaser's email is stored as `owner_email` (receipt + link recipient).

---

# `notify-board` — email/text the code + expiry (optional)

On the create/join screen a person can enter an **optional** email or phone.
When they create or join, the app calls this function, which emails (Resend) or
texts (Twilio) them the board code, the link, and when it expires (the 72-hour
rule, or the renew date if paid). It's best-effort — if the relevant provider
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
