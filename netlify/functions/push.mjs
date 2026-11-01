// Campus Ops — lock-screen alerts (Web Push).
// GET    /api/push        -> { publicKey }
// POST   /api/push        -> body { subscription, unit? }   register this phone / console
// DELETE /api/push        -> body { endpoint }              stop alerts on this device
import { cors, json, roleFor, store, vapid } from "../lib/comms.mjs";

const hash = async (s) => { const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)); return [...new Uint8Array(d)].slice(0, 12).map(b => b.toString(16).padStart(2, "0")).join(""); };

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const role = roleFor(req);
  if (role === "viewer") return json({ error: "access code required" }, 403);
  const s = store();
  try {
    if (req.method === "GET") { const k = await vapid(); return json({ publicKey: k.publicKey }); }
    const b = await req.json().catch(() => ({}));
    if (req.method === "POST") {
      const sub = b.subscription;
      if (!sub || typeof sub.endpoint !== "string" || !sub.keys) return json({ error: "bad subscription" }, 400);
      const unit = String(b.unit || "").toUpperCase().slice(0, 12);
      await s.setJSON(`sub/${await hash(sub.endpoint)}`, { sub, unit: role === "admin" && !unit ? "" : unit, role, at: Date.now() });
      return json({ ok: true });
    }
    if (req.method === "DELETE") {
      if (typeof b.endpoint === "string") await s.delete(`sub/${await hash(b.endpoint)}`);
      return json({ ok: true });
    }
    return json({ error: "not found" }, 404);
  } catch (e) { return json({ error: e.message }, 500); }
};

export const config = { path: ["/api/push"] };
