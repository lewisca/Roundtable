// Supabase Edge Function: stripe-webhook
// Stripe calls this after payment events. It verifies the signature and is the
// ONLY thing that flips a board to paid — the browser can never do it (the app
// uses the anon key, which the DB guard trigger blocks from billing columns;
// this runs with the service_role key).
//
// Deploy WITHOUT JWT verification (Stripe doesn't send a Supabase token):
//   supabase functions deploy stripe-webhook --no-verify-jwt

import Stripe from "https://esm.sh/stripe@16.2.0?target=deno";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2026-02-25.preview" as any,   // Managed Payments preview version
  httpClient: Stripe.createFetchHttpClient(),
});
const WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET")!;

// service_role client bypasses RLS and the billing guard trigger.
const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const inAYear = () => new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();

// The top-level `invoice.subscription` field was removed in API 2025-03-31.basil+
// (we're on 2026-02-25.preview). Read it from wherever this version puts it.
// deno-lint-ignore no-explicit-any
function subIdFromInvoice(inv: any): string | null {
  const direct = typeof inv?.subscription === "string" ? inv.subscription : inv?.subscription?.id;
  const fromParent = inv?.parent?.subscription_details?.subscription;
  const fromLine = inv?.lines?.data?.find((l: any) => l?.subscription)?.subscription;
  const s = direct || fromParent || fromLine || null;
  return typeof s === "string" ? s : (s?.id ?? null);
}

Deno.serve(async (req) => {
  const sig = req.headers.get("stripe-signature");
  const raw = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(raw, sig!, WEBHOOK_SECRET);
  } catch (e) {
    return new Response(`bad signature: ${(e as Error).message}`, { status: 400 });
  }

  try {
    switch (event.type) {
      // Initial purchase: map the board to the subscription + go live for a year.
      case "checkout.session.completed": {
        const s = event.data.object as Stripe.Checkout.Session;
        const code = (s.metadata?.board_code as string) || (s.client_reference_id as string);
        if (code) {
          await admin.from("boards").update({
            is_paid: true,
            paid_until: inAYear(),
            expires_at: inAYear(),
            owner_email: s.customer_details?.email ?? null,
            stripe_customer_id: typeof s.customer === "string" ? s.customer : s.customer?.id ?? null,
            stripe_subscription_id: typeof s.subscription === "string" ? s.subscription : s.subscription?.id ?? null,
          }).eq("code", code);
        }
        break;
      }

      // Yearly renewals: push expiry out another year.
      case "invoice.paid": {
        const inv = event.data.object as Stripe.Invoice;
        const subId = subIdFromInvoice(inv);
        if (subId) {
          await admin.from("boards").update({
            is_paid: true, paid_until: inAYear(), expires_at: inAYear(),
          }).eq("stripe_subscription_id", subId);
        }
        break;
      }

      // Cancelled / lapsed: drop the paid flag so the board reverts to its
      // expiry date (it drops back to read-only once expires_at passes).
      case "customer.subscription.deleted": {
        const sub = event.data.object as Stripe.Subscription;
        await admin.from("boards").update({ is_paid: false }).eq("stripe_subscription_id", sub.id);
        break;
      }
    }
    return new Response("ok");
  } catch (e) {
    return new Response(`handler error: ${(e as Error).message}`, { status: 500 });
  }
});
