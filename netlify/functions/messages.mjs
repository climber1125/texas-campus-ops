// Campus Ops — the channel. Phones and the operator console post here; everyone polls.
// GET  /api/messages?since=<ms>   -> messages newer than since (max 200)          (staff or operator)
// POST /api/messages              -> { to, text?, audio?, dur?, kind?, wo?, status?, fromName? }
//      from = header x-unit (crew phone's unit id) or CONTROL for the operator code
import { cors, json, roleFor, store, fanout } from "../lib/comms.mjs";

const KEEP_MS = 3 * 24 * 3600 * 1000;
const clean = (v, n) => String(v ?? "").trim().slice(0, n);

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
      const b = await req.json().catch(() => ({}));
      const from = role === "admin" && !req.headers.get("x-unit") ? "CONTROL" : clean(req.headers.get("x-unit"), 12).toUpperCase();
      if (!from) return json({ error: "pick who you are first" }, 400);
      const to = clean(b.to, 12).toUpperCase() || (from === "CONTROL" ? "ALL" : "CONTROL");
      if (from !== "CONTROL" && to !== "CONTROL") return json({ error: "crew phones talk to Control" }, 400);
      const text = clean(b.text, 600), audio = clean(b.audio, 40);
      if (!text && !audio && !b.status) return json({ error: "empty message" }, 400);
      const ts = Date.now();
      const id = `${ts}-${Math.random().toString(36).slice(2, 7)}`;
      const msg = {
        id, ts, from, to, fromName: clean(b.fromName || req.headers.get("x-name"), 60), text, audio: audio || undefined,
        dur: Number(b.dur) > 0 ? Math.min(60, Number(b.dur)) : undefined,
        kind: ["msg", "status", "assign", "emergency"].includes(b.kind) ? b.kind : "msg",
        wo: clean(b.wo, 16) || undefined, status: clean(b.status, 16) || undefined, priority: clean(b.priority, 12) || undefined,
      };
      await s.setJSON(`m/${String(ts).padStart(13, "0")}-${id.slice(14)}`, msg);
      let pushed = 0;
      try { pushed = await fanout(msg); } catch (e) { console.error("push failed", e); }
      return json({ ...msg, pushed }, 201);
    }
    return json({ error: "not found" }, 404);
  } catch (e) { return json({ error: e.message }, 500); }
};

export const config = { path: ["/api/messages"] };
