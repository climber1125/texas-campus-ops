// Campus Ops — saved yard network (which items are tied together, source, devices).
// GET  /api/network  -> { v, source, links, updatedAt, updatedBy } or 404 if never saved   (staff or operator)
// PUT  /api/network  -> body NetCfg                                                       (operator)
import { getStore } from "@netlify/blobs";

const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,PUT,OPTIONS", "Access-Control-Allow-Headers": "Content-Type, x-key" };
const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors } });
function roleFor(req) {
  const admin = (Netlify.env.get("ADMIN_KEY") || Netlify.env.get("ops") || Netlify.env.get("OPS") || "").trim(), crew = (Netlify.env.get("CREW_KEY") || Netlify.env.get("crew") || Netlify.env.get("CREW") || "").trim();
  if (!admin && !crew) return "admin";
  const key = (req.headers.get("x-key") || "").trim();
  if (admin && key === admin) return "admin";
  if (crew && key === crew) return "crew";
  return "viewer";
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const role = roleFor(req);
  if (role === "viewer") return json({ error: "access code required" }, 403);
  const store = getStore("campus-ops");
  try {
    if (req.method === "GET") {
      const cfg = await store.get("network", { type: "json" });
      return cfg ? json(cfg) : json({ error: "no network saved yet" }, 404);
    }
    if (req.method === "PUT") {
      if (role !== "admin") return json({ error: "operator code required" }, 403);
      const b = await req.json();
      if (!b || !Array.isArray(b.links)) return json({ error: "links missing" }, 400);
      const links = b.links.filter(l => l && typeof l.a === "string" && typeof l.b === "string").slice(0, 5000).map(l => {
        const o = { a: l.a, b: l.b };
        if (l.dev && ["switch", "fuse", "recloser"].includes(l.dev.type)) o.dev = { type: l.dev.type, ...(l.dev.id ? { id: String(l.dev.id).slice(0, 24) } : {}), ...(l.dev.at ? { at: String(l.dev.at) } : {}), ...(l.dev.no ? { no: true } : {}) };
        return o;
      });
      const cfg = { v: 1, source: typeof b.source === "string" ? b.source : null, links, updatedAt: new Date().toISOString(), updatedBy: String(b.updatedBy || "Operator").slice(0, 60) };
      await store.setJSON("network", cfg);
      // keep the previous version so a bad save can be undone by hand
      const prev = await store.get("network-history", { type: "json" }).catch(() => null);
      const hist = Array.isArray(prev) ? prev : [];
      hist.push(cfg); await store.setJSON("network-history", hist.slice(-10));
      return json(cfg);
    }
    return json({ error: "not found" }, 404);
  } catch (e) { return json({ error: e.message }, 500); }
};

export const config = { path: ["/api/network"] };
