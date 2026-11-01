// Campus Ops — the channel. Phones and the operator console post here; everyone polls.
// GET  /api/messages?since=<ms>   -> messages newer than since (max 200)          (staff or operator)
// POST /api/messages              -> { to, text?, audio?, dur?, kind?, wo?, status?, fromName? }
//      from = header x-unit (crew phone's unit id) or CONTROL for the operator code
import { cors, json, roleFor, store, postMessage } from "../lib/comms.mjs";

const KEEP_MS = 3 * 24 * 3600 * 1000;

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const role = roleFor(req);
  if (role === "viewer") return json({ error: "access code required" }, 403);
  const s = store();
  try {
    if (req.method === "GET") {
      const since = Number(new URL(req.url).searchParams.get("since") || 0) || Date.now() - 6 * 3600 * 1000;
      const { blobs } = await s.list({ prefix: "m/" });
      const keys = blobs.map(b => b.key).filter(k => Number(k.slice(2, 15)) > since).sort().slice(-200);
      const msgs = (await Promise.all(keys.map(k => s.get(k, { type: "json" }).catch(() => null)))).filter(Boolean);
      // prune old
      const old = blobs.map(b => b.key).filter(k => Number(k.slice(2, 15)) < Date.now() - KEEP_MS).slice(0, 50);
      await Promise.allSettled(old.map(k => s.delete(k)));
      return json(msgs);
    }
    if (req.method === "POST") {
      const r = await postMessage(req, role, await req.json().catch(() => ({})));
      return r.error ? json({ error: r.error }, r.status) : json(r.msg, 201);
    }
    return json({ error: "not found" }, 404);
  } catch (e) { return json({ error: e.message }, 500); }
};

export const config = { path: ["/api/messages"] };
