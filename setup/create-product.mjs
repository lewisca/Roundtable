// One-time setup: create the Roundtable product + yearly price in Stripe.
// Managed Payments handles tax, so the product carries a digital-services tax code.
//
// Run once with YOUR key (never commit it):
//   STRIPE_SECRET_KEY=sk_test_xxx node setup/create-product.mjs
//
// It prints the price ID — set that as the STRIPE_PRICE_ID secret for the
// create-checkout Edge Function.

const KEY = process.env.STRIPE_SECRET_KEY;
if (!KEY) {
  console.error("Missing STRIPE_SECRET_KEY. Run: STRIPE_SECRET_KEY=sk_test_xxx node setup/create-product.mjs");
  process.exit(1);
}

// Stripe form-encodes nested params as key[sub][sub2]=value.
function form(obj, prefix = "", out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v !== null && typeof v === "object") form(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

async function stripe(path, params) {
  const res = await fetch(`https://api.stripe.com/v1/${path}`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": "2026-02-25.preview",   // Managed Payments preview
    },
    body: form(params),
  });
  const data = await res.json();
  if (!res.ok) { console.error("Stripe error:", data.error?.message || data); process.exit(1); }
  return data;
}

const product = await stripe("products", {
  name: "Roundtable — one family",
  description: "Keeps a family's board live for a year (renews yearly).",
  tax_code: "txcd_10103100",                     // digital / SaaS tax code
  default_price_data: {
    unit_amount: 1999,                           // $19.99
    currency: "usd",
    recurring: { interval: "year" },
  },
});

const priceId = typeof product.default_price === "string"
  ? product.default_price
  : product.default_price?.id;

console.log("\n✅ Created product:", product.id);
console.log("✅ Yearly price:   ", priceId);
console.log("\nNext: set this as the create-checkout secret →");
console.log(`   STRIPE_PRICE_ID=${priceId}\n`);
