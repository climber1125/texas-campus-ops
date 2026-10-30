// Campus Ops — work orders. Stored in this site's Netlify Blobs, one key per order.
// Same ADMIN_KEY / CREW_KEY as poles.mjs.
//   admin (operator)      create + edit
//   crew  (instructors)   view only
//   viewer (no code)      nothing
// Orders are never deleted — cancel them (status "Canceled") so the history stays intact.
//
// GET   /api/workorders        -> all orders, newest first          (crew or admin)
// POST  /api/workorders        -> create  body {poleItemId, poleLabel, issue, priority, assignee, caller, source, by}
// PATCH /api/workorders/:num   -> update  body {changes:{status,priority,assignee,issue,caller}, note, by}
import { getStore } from "@netlify/blobs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,PATCH,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-key",
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });

function roleFor(req) {
  const admin = Netlify.env.get("ADMIN_KEY") || "";
  const crew = Netlify.env.get("CREW_KEY") || "";
  if (!admin && !crew) return "admin";
  const key = req.headers.get("x-key") || "";
  if (admin && key === admin) return "admin";
  if (crew && key === crew) return "crew";
  return "viewer";
}

const STATUSES = ["New", "Assigned", "In Progress", "On Hold", "Complete", "Canceled"];
const PRIORITIES = ["Emergency", "Urgent", "Routine"];
const EDITABLE = ["status", "priority", "assignee", "issue", "caller"];
const clean = (v, max = 2000) => String(v ?? "").trim().slice(0, max);

async function nextNumber(store) {
  const meta = (await store.get("_counter", { type: "json" })) || { n: 1000 };
  let n = meta.n + 1;
  while (await store.get(`wo-${n}`)) n++; // skip any number already taken
  await store.setJSON("_counter", { n });
  return n;
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const role = roleFor(req);
  if (role === "viewer") return json({ error: "crew or admin code required" }, 403);
  const store = getStore("workorders");
  const num = new URL(req.url).pathname.replace(/^\/api\/workorders\/?/, "").split("/").filter(Boolean)[0];
  const now = new Date().toISOString();

  try {
    if (req.method === "GET" && !num) {
      const { blobs } = await store.list({ prefix: "wo-" });
      const orders = (await Promise.all(blobs.map(b => store.get(b.key, { type: "json" })))).filter(Boolean);
      orders.sort((a, b) => b.num - a.num);
      return json(orders);
    }

    if (role !== "admin") return json({ error: "operator (admin) code required" }, 403);

    if (req.method === "POST" && !num) {
      const b = await req.json();
      const issue = clean(b.issue);
      if (!issue) return json({ error: "issue is required" }, 400);
      const by = clean(b.by, 60) || "Operator";
      const assignee = clean(b.assignee, 80);
      const n = await nextNumber(store);
      const order = {
        num: n,
        id: `WO-${n}`,
        poleItemId: clean(b.poleItemId, 80) || null,
        poleLabel: clean(b.poleLabel, 80) || "",
        issue,
        priority: PRIORITIES.includes(b.priority) ? b.priority : "Routine",
        assignee,
        caller: clean(b.caller, 80),
        source: b.source === "radio" ? "radio" : "typed",
        status: assignee ? "Assigned" : "New",
        createdAt: now,
        createdBy: by,
        updatedAt: now,
        history: [{ at: now, by, text: `Created (${b.source === "radio" ? "radio call" : "typed"})` + (assignee ? ` — assigned to ${assignee}` : "") }],
      };
      await store.setJSON(`wo-${n}`, order);
      return json(order, 201);
    }

    if (req.method === "PATCH" && num) {
      const key = `wo-${String(num).replace(/^WO-/i, "")}`;
      const order = await store.get(key, { type: "json" });
      if (!order) return json({ error: "not found" }, 404);
      const b = await req.json();
      const by = clean(b.by, 60) || "Operator";
      const changes = b.changes || {};
      const log = [];
      for (const f of EDITABLE) {
        if (!(f in changes)) continue;
        let v = clean(changes[f], f === "issue" ? 2000 : 80);
        if (f === "status" && !STATUSES.includes(v)) continue;
        if (f === "priority" && !PRIORITIES.includes(v)) continue;
        if (f === "issue" && !v) continue;
        if (v === (order[f] || "")) continue;
        log.push(f === "issue" ? "Issue edited" : `${f[0].toUpperCase() + f.slice(1)}: ${order[f] || "—"} → ${v || "—"}`);
        order[f] = v;
      }
      const note = clean(b.note);
      if (note) log.push(`Note: ${note}`);
      if (!log.length) return json(order);
      if (changes.assignee && order.status === "New" && !("status" in changes)) { order.status = "Assigned"; log.push("Status: New → Assigned"); }
      if (order.status === "Complete" && !order.completedAt) order.completedAt = now;
      if (order.status !== "Complete") order.completedAt = null;
      order.updatedAt = now;
      order.history = [...(order.history || []), ...log.map(text => ({ at: now, by, text }))];
      await store.setJSON(key, order);
      return json(order);
    }

    return json({ error: "not found" }, 404);
  } catch (e) {
    return json({ error: e.message }, 500);
  }
};

export const config = { path: ["/api/workorders", "/api/workorders/*"] };
