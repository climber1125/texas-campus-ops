// Campus Ops — the shared operations board (full engine state).
// One operator console writes it; staff screens (and other operator devices) read it.
// GET /api/state  -> { s, readings, devKw, client, at } or 404           (staff or operator)
// PUT /api/state  -> body { client, s, readings, devKw, force? }         (operator)
//   409 if a DIFFERENT operator console wrote in the last 25 s (unless force) — stops two desks overwriting each other.
import { getStore } from "@netlify/blobs";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,PUT,OPTIONS", "Access-Control-Allow-Headers": "Content-Type, x-key" };
const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors } });
function roleFor(req) {
  const admin = (Netlify.env.get("ADMIN_KEY") || Netlify.env.get("ops_key") || Netlify.env.get("OPS_KEY") || Netlify.env.get("ops") || Netlify.env.get("OPS") || "").trim(), crew = (Netlify.env.get("CREW_KEY") || Netlify.env.get("crew_key") || Netlify.env.get("crew") || Netlify.env.get("CREW") || "").trim();
  if (!admin && !crew) return "admin";
  const key = (req.headers.get("x-key") || "").trim();
  if (admin && key === admin) return "admin";
  if (crew && key === crew) return "crew";
  return "viewer";
}
const HOLD_MS = 25000;

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const role = roleFor(req);
  if (role === "viewer") return json({ error: "access code required" }, 403);
  const store = getStore("campus-ops");
  try {
    if (req.method === "GET") {
      const st = await store.get("state", { type: "json" });
      return st ? json(st) : json({ error: "no state yet" }, 404);
    }
    if (req.method === "PUT") {
      if (role !== "admin") return json({ error: "operator code required" }, 403);
      const b = await req.json();
      if (!b || !b.s || typeof b.client !== "string") return json({ error: "bad body" }, 400);
      const meta = await store.get("state-meta", { type: "json" }).catch(() => null);
      const now = Date.now();
      if (meta && meta.client !== b.client && now - meta.at < HOLD_MS && !b.force) return json({ error: "another operator console is live", client: meta.client, at: meta.at }, 409);
      const doc = { s: b.s, readings: b.readings || {}, devKw: b.devKw || {}, client: b.client, at: now };
      await store.setJSON("state", doc);
      await store.setJSON("state-meta", { client: b.client, at: now });
      return json({ ok: true, at: now });
    }
    return json({ error: "not found" }, 404);
  } catch (e) { return json({ error: e.message }, 500); }
};

export const config = { path: ["/api/state"] };
