// Supabase Edge Function: notify-board
// Emails (Resend) or texts (Twilio) a person their board code + when it expires.
// Called on create/join when they gave an optional email/phone:
//   sb.functions.invoke("notify-board", { body: { code, contact } })
//
// Best-effort and optional — if the matching provider isn't configured it just
// returns a 501 that the app ignores.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
);

const SITE_URL = Deno.env.get("SITE_URL") ?? "https://famroundtable.com";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY");
const RESEND_FROM = Deno.env.get("RESEND_FROM") ?? "Roundtable <hello@famroundtable.com>";

const TWILIO_SID = Deno.env.get("TWILIO_ACCOUNT_SID");
const TWILIO_TOKEN = Deno.env.get("TWILIO_AUTH_TOKEN");
const TWILIO_FROM = Deno.env.get("TWILIO_FROM");

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (b: unknown, status = 200) =>
  new Response(JSON.stringify(b), { status, headers: { ...cors, "content-type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const { code, contact } = await req.json();
    const board = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    const c = String(contact || "").trim();
    if (!board || !c) return json({ error: "missing code or contact" }, 400);

    // Expiry from the board row (72-hour rule); fall back to now + 72h for a
    // board that hasn't finished being created yet.
    const { data } = await admin.from("boards").select("created_at, expires_at, is_paid").eq("code", board).maybeSingle();
    const now = Date.now();
    const expiresMs = data?.expires_at ? Date.parse(data.expires_at) : now + 72 * 3600 * 1000;
    const paid = !!data?.is_paid;
    const days = Math.max(0, Math.ceil((expiresMs - now) / (24 * 3600 * 1000)));
    const dateStr = new Date(expiresMs).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    const link = `${SITE_URL}/?board=${board}`;
    const expiryLine = paid
      ? `This board is saved — it stays live (renews ${dateStr}).`
      : `Reminder: a free board expires 72 hours after it's created — this one is gone on ${dateStr} (${days} day${days === 1 ? "" : "s"} left). Keep it for a year for $19.99 before then.`;

    const isEmail = c.indexOf("@") > 0;

    if (isEmail) {
      if (!RESEND_API_KEY) return json({ error: "email not configured" }, 501);
      const html =
        `<div style="font-family:system-ui,sans-serif;color:#201e1d;line-height:1.5">
          <h2 style="font-family:Georgia,serif;margin:0 0 8px">Your Roundtable board</h2>
          <p>Board code: <b style="font-size:20px;letter-spacing:.1em">${board}</b></p>
          <p><a href="${link}" style="color:#8c491a">Open the board →</a></p>
          <p style="color:#645c50">${expiryLine}</p>
        </div>`;
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from: RESEND_FROM, to: c, subject: `Your Roundtable board — ${board}`, html }),
      });
      if (!r.ok) return json({ error: "email send failed", detail: await r.text() }, 502);
      return json({ ok: true, channel: "email" });
    }

    // Phone → SMS via Twilio
    if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) return json({ error: "sms not configured" }, 501);
    const to = c.replace(/[^\d+]/g, "");
    const body = `Your Roundtable board code: ${board}\nOpen: ${link}\n${expiryLine}`;
    const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;
    const form = new URLSearchParams({ To: to, From: TWILIO_FROM, Body: body });
    const r = await fetch(url, {
      method: "POST",
      headers: { Authorization: "Basic " + btoa(`${TWILIO_SID}:${TWILIO_TOKEN}`), "content-type": "application/x-www-form-urlencoded" },
      body: form,
    });
    if (!r.ok) return json({ error: "sms send failed", detail: await r.text() }, 502);
    return json({ ok: true, channel: "sms" });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
