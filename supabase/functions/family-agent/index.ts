// Supabase Edge Function: family-agent
// A board-scoped assistant for seating charts and obituaries.
//
// The model ONLY parses intent and formats output. Every fact comes from the
// tools below, which run over this board's tree — so it can't invent relatives,
// dates, or places. It has access to nothing but the tree for the given code.
//
// App call: sb.functions.invoke("family-agent", { body: { code, task, message } })
//   task: "obituary" | "seating_chart" | "ask"

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const MODEL = Deno.env.get("AGENT_MODEL") ?? "claude-sonnet-5";
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "content-type": "application/json" } });

/* ----------------------------- tools over the tree ---------------------- */

// deno-lint-ignore no-explicit-any
type P = any;

function helpers(people: P[]) {
  const byId = (id: string) => people.find((p) => p.id === id);
  const kidsOf = (id: string | null) => people.filter((p) => (p.parentId || null) === (id || null) && !p.placeholder);
  const partnersOf = (p: P) => (p?.partners) ? p.partners : (p?.partner?.name ? [p.partner] : []);
  const depthOf = (p: P) => { let d = 0, cur = p; while (cur && cur.parentId) { cur = byId(cur.parentId); d++; if (d > 20) break; } return d; };
  const years = (p: P) => !p ? "" : (p.born && p.died) ? `${p.born}–${p.died}` : p.born ? `b. ${p.born}` : p.died ? `d. ${p.died}` : "";
  const deceased = (p: P) => !!p.died;
  const real = people.filter((p) => !p.placeholder);
  const norm = (s: string) => (s || "").trim().toLowerCase();
  const resolve = (name: string) => {
    const q = norm(name);
    let m = real.filter((p) => norm(p.name) === q);
    if (!m.length) m = real.filter((p) => norm(p.name).split(/\s+/)[0] === q);
    if (!m.length && q.length >= 2) m = real.filter((p) => norm(p.name).includes(q));
    return m;
  };
  const brief = (p: P) => ({
    name: p.name, years: years(p), place: p.place || null, note: p.note || null,
    deceased: deceased(p), generation: depthOf(p) + 1,
    partners: partnersOf(p).map((pp: P) => ({ name: pp.name, years: years(pp), deceased: !!pp.died })),
  });
  return { byId, kidsOf, partnersOf, depthOf, years, deceased, real, resolve, brief };
}

function runTool(name: string, input: P, ctx: { people: P[]; familyName: string }) {
  const H = helpers(ctx.people);
  switch (name) {
    case "family_overview": {
      const roots = H.kidsOf(null);
      const gens = H.real.reduce((m, p) => Math.max(m, H.depthOf(p) + 1), 0);
      return {
        family_name: ctx.familyName || "this family",
        total_people: H.real.length,
        generations: gens,
        living: H.real.filter((p) => !H.deceased(p)).length,
        deceased: H.real.filter((p) => H.deceased(p)).length,
        root_ancestors: roots.map((p) => p.name),
        has_unresolved_duplicates: ctx.people.some((p) => p.flag && !p.placeholder),
      };
    }
    case "list_people": {
      let list = H.real.slice();
      if (input.only_living) list = list.filter((p) => !H.deceased(p));
      if (input.only_deceased) list = list.filter((p) => H.deceased(p));
      if (typeof input.generation === "number") list = list.filter((p) => H.depthOf(p) + 1 === input.generation);
      if (input.has_children) list = list.filter((p) => H.kidsOf(p.id).length > 0);
      const total = list.length;
      const limit = Math.min(input.limit || 150, 300);
      return {
        total, showing: Math.min(total, limit),
        people: list.slice(0, limit).map((p) => ({ ...H.brief(p), children: H.kidsOf(p.id).map((k) => k.name) })),
      };
    }
    case "find_person": {
      const m = H.resolve(input.name || "");
      if (!m.length) return { found: false, message: `No one on this board matches "${input.name || ""}".` };
      if (m.length > 1) return { found: false, ambiguous: true, candidates: m.slice(0, 8).map((p) => ({ name: p.name, years: H.years(p), place: p.place || null })) };
      return { found: true, person: H.brief(m[0]) };
    }
    case "get_relatives": {
      const m = H.resolve(input.name || "");
      if (m.length !== 1) return { error: m.length ? "ambiguous_name" : "not_found", candidates: m.map((p) => p.name) };
      const p = m[0], rel = String(input.relation || "").toLowerCase();
      let out: P[] = [];
      if (rel === "children") out = H.kidsOf(p.id);
      else if (rel === "parents") out = p.parentId ? [H.byId(p.parentId)].filter(Boolean) : [];
      else if (rel === "siblings") out = H.kidsOf(p.parentId || null).filter((x) => x.id !== p.id);
      else if (rel === "spouses") return { person: p.name, relation: "spouses", relatives: H.partnersOf(p).map((pp: P) => ({ name: pp.name, years: H.years(pp), deceased: !!pp.died })) };
      else if (rel === "grandparents") { const par = p.parentId ? H.byId(p.parentId) : null; out = par?.parentId ? [H.byId(par.parentId)].filter(Boolean) : []; }
      else if (rel === "grandchildren") { out = []; H.kidsOf(p.id).forEach((c) => H.kidsOf(c.id).forEach((g) => out.push(g))); }
      else if (rel === "descendants") { const acc: P[] = []; const walk = (id: string) => H.kidsOf(id).forEach((c) => { acc.push(c); walk(c.id); }); walk(p.id); out = acc; }
      else if (rel === "ancestors") { const acc: P[] = []; let cur = p.parentId ? H.byId(p.parentId) : null; while (cur) { acc.push(cur); cur = cur.parentId ? H.byId(cur.parentId) : null; } out = acc; }
      else return { error: "unknown_relation", allowed: ["parents", "children", "siblings", "spouses", "grandparents", "grandchildren", "ancestors", "descendants"] };
      return { person: p.name, relation: rel, relatives: out.filter(Boolean).map(H.brief) };
    }
    case "find_conflicts": {
      const flagged = ctx.people.filter((p) => p.flag && !p.placeholder);
      const groups: Record<string, P[]> = {};
      flagged.forEach((p) => { const k = (p.name || "").trim().toLowerCase(); (groups[k] = groups[k] || []).push(p); });
      const duplicates = Object.values(groups).filter((g) => g.length > 1)
        .map((g) => ({ name: g[0].name, entries: g.map((p) => ({ years: H.years(p), place: p.place || null, added_by: p.addedBy || null })) }));
      const unfilled_prompts = ctx.people.filter((p) => p.placeholder).map((p) => p.name);
      return { duplicates, unfilled_prompts };
    }
    default:
      return { error: "unknown_tool" };
  }
}

const TOOLS = [
  { name: "family_overview", description: "High-level facts about this family board: name, total people, generations, living/deceased counts, root ancestors, and whether unresolved duplicates exist. Call first for context.", input_schema: { type: "object", properties: {} } },
  { name: "list_people", description: "List people on the board, with optional filters. Use for seating charts and overviews.", input_schema: { type: "object", properties: { only_living: { type: "boolean" }, only_deceased: { type: "boolean" }, generation: { type: "integer", description: "1-based generation; 1 = eldest/roots" }, has_children: { type: "boolean" }, limit: { type: "integer" } } } },
  { name: "find_person", description: "Find one person by name. Returns the person, candidate names if ambiguous, or not-found.", input_schema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] } },
  { name: "get_relatives", description: "Get a person's relatives of a given relation (spouses come from their partner records).", input_schema: { type: "object", properties: { name: { type: "string" }, relation: { type: "string", enum: ["parents", "children", "siblings", "spouses", "grandparents", "grandchildren", "ancestors", "descendants"] } }, required: ["name", "relation"] } },
  { name: "find_conflicts", description: "List duplicate (flagged) people and unfilled placeholder prompts so you can avoid using unreliable data.", input_schema: { type: "object", properties: {} } },
];

/* ----------------------------- system prompts --------------------------- */

function systemPrompt(task: string, familyName: string) {
  const base = `You are the Roundtable assistant for the "${familyName}" family board.
You help with exactly two jobs: drafting obituaries and planning seating charts, using ONLY the family data available through your tools.

HARD RULES — never break these:
- Never invent, assume, or guess a name, date, place, or relationship. Every fact MUST come from a tool result.
- If information is missing, say it's unknown or leave it out — do NOT fill the gap.
- You know nothing about this family beyond what the tools return for THIS board.
- Gather what you need with tools first, then produce the final output only (no tool narration).
- If the request or a person is ambiguous, ask one short clarifying question instead of guessing.`;

  if (task === "obituary") {
    return base + `

TASK — Obituary. Use find_person to locate the subject; get_relatives for children, spouses, siblings, and grandchildren. "Survived by" = living relatives; "Preceded in death by" = deceased relatives (each person record has a deceased flag). Structure:
- Opening line: full name and years (only if known).
- A short, warm paragraph built only from their place/note facts (omit if none).
- "Survived by:" living relatives grouped by relation.
- "Preceded in death by:" deceased relatives.
Mark any missing dates as "(date unknown)" rather than inventing. Keep it respectful and factual.`;
  }
  if (task === "seating_chart") {
    return base + `

TASK — Seating chart. Use list_people and get_relatives to understand who's attending and how they group into families/branches; use find_conflicts to avoid seating a duplicate twice or including unfilled placeholder cards. Honor the user's constraints (table size, keep families together, separate specific people). Output tables as clear lists:
  Table 1 — [names]
  Table 2 — [names]
List anyone you couldn't place and why. Only seat real people returned by tools.`;
  }
  return base + `

The person will ask in their own words. First decide which of these they want, then follow that format:

- OBITUARY for someone → find them with find_person; use get_relatives for children, spouses, siblings, and grandchildren. "Survived by" = living relatives; "Preceded in death by" = deceased (each record has a deceased flag). Open with full name and years (only if known), then a short warm paragraph built only from their place/note facts (omit if none), then the two lists. Mark missing dates "(date unknown)" — never invent one.

- SEATING CHART → use list_people and get_relatives to see who's attending and how they group into families/branches; use find_conflicts to avoid seating a duplicate twice or including an unfilled placeholder card. Honor their constraints (table size, keep families together, separate specific people). Output "Table 1 — [names]" lines, and list anyone you couldn't place and why.

- A QUESTION about the family → answer concisely, citing the specific people and relationships the tools returned.

If it's genuinely unclear which they want, ask one short clarifying question. Produce only the final result — no tool narration.`;
}

/* ------------------------------ agent loop ------------------------------ */

async function callAnthropic(system: string, messages: P[]) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": ANTHROPIC_KEY!, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 2500, system, tools: TOOLS, messages }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error?.message || JSON.stringify(data));
  return data;
}

async function runAgent(ctx: { people: P[]; familyName: string }, task: string, message: string) {
  const system = systemPrompt(task, ctx.familyName);
  const messages: P[] = [{ role: "user", content: message || (task === "obituary" ? "Draft an obituary." : task === "seating_chart" ? "Plan a seating chart." : "Tell me about this family.") }];
  for (let round = 0; round < 8; round++) {
    const resp = await callAnthropic(system, messages);
    if (resp.stop_reason === "tool_use") {
      messages.push({ role: "assistant", content: resp.content });
      const results = resp.content
        .filter((b: P) => b.type === "tool_use")
        .map((b: P) => ({ type: "tool_result", tool_use_id: b.id, content: JSON.stringify(runTool(b.name, b.input || {}, ctx)) }));
      messages.push({ role: "user", content: results });
      continue;
    }
    return (resp.content || []).filter((b: P) => b.type === "text").map((b: P) => b.text).join("\n").trim();
  }
  return "That request needed too many steps — please narrow it (e.g. name the person, or the number of tables).";
}

/* ------------------------------- handler -------------------------------- */

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    if (!ANTHROPIC_KEY) return json({ error: "assistant_not_configured" }, 501);
    const { code, task, message } = await req.json();
    const board = String(code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
    if (!board) return json({ error: "missing board code" }, 400);
    // The app sends "auto" (free-text intent). Explicit tasks are still honored if passed.
    const t = ["obituary", "seating_chart", "ask"].includes(task) ? task : "auto";

    const { data, error } = await admin.from("boards").select("data").eq("code", board).maybeSingle();
    if (error) throw error;
    const tree = data?.data;
    if (!tree || !Array.isArray(tree.people) || !tree.people.length) {
      return json({ error: "This board has no family tree yet — add some people first." }, 400);
    }

    const result = await runAgent({ people: tree.people, familyName: tree.familyName || "this family" }, t, String(message || "").slice(0, 1000));
    return json({ result });
  } catch (e) {
    return json({ error: String((e as Error)?.message ?? e) }, 500);
  }
});
