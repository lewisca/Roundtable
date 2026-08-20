// Supabase Edge Function: create-checkout
// Creates a Stripe Checkout session for a board and returns its URL.
// Called from the app via: sb.functions.invoke("create-checkout", { body: { code } })
//
// Card details are collected on Stripe's hosted page — they never touch this
// code, the app, or your database. We only ever store Stripe reference IDs.

import Stripe from "https://esm.sh/stripe@16.2.0?target=deno";

// Managed Payments runs on the preview API version (Stripe is merchant of record
// and handles tax via the product's tax code).
const stripe = new Stripe(Deno.env.get("STRIPE_SECRET_KEY")!, {
  apiVersion: "2026-02-25.preview" as any,
  httpClient: Stripe.createFetchHttpClient(),
});

const PRICE_ID = Deno.env.get("STRIPE_PRICE_ID")!;         // yearly $19.99 recurring price (from create-product)
const SITE_URL = Deno.env.get("SITE_URL") ?? "https://famroundtable.com";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { code } = await req.json();
    const board = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (!board) return json({ error: "missing board code" }, 400);

    const session = await stripe.checkout.sessions.create({
      mode: "subscription",                                  // yearly, auto-renews
      line_items: [{ price: PRICE_ID, quantity: 1 }],
      managed_payments: { enabled: true },                   // Stripe handles payment + tax
      client_reference_id: board,
      metadata: { board_code: board },
      subscription_data: { metadata: { board_code: board } }, // so renewals know the board
      allow_promotion_codes: true,
      success_url: `${SITE_URL}/?board=${encodeURIComponent(board)}&paid=1`,
      cancel_url: `${SITE_URL}/?board=${encodeURIComponent(board)}`,
    } as any);

    return json({ url: session.url });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
