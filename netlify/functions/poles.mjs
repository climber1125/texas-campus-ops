// Campus Ops — poles are READ-ONLY here. They come live from the original Pole Yard site.
// Pole edits / testing still happen in the Pole Yard app; this site never writes to it.
//
// Env vars (Netlify → Site configuration → Environment variables):
//   POLE_SOURCE_URL  original site, default https://poleyard.netlify.app
//   ADMIN_KEY        operator code (creates / edits work orders)
//   CREW_KEY         instructor/staff code (views work orders)
// No code = viewer. If NEITHER key is set, everyone is admin (works before setup — set them).
//
// GET  /api/poles          -> all poles from the original site (falls back to last good copy)
// POST /api/poles/whoami   -> { role }  (checks the x-key header)
// anything else            -> 403 (edit poles in the Pole Yard app)
import { getStore } from "@netlify/blobs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-key",
};
const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors, ...extra } });

function roleFor(req) {
  const admin = (Netlify.env.get("ADMIN_KEY") || Netlify.env.get("ops") || Netlify.env.get("OPS") || "").trim();
  const crew = (Netlify.env.get("CREW_KEY") || Netlify.env.get("crew") || Netlify.env.get("CREW") || "").trim();
  if (!admin && !crew) return "admin";
  const key = (req.headers.get("x-key") || "").trim();
  if (admin && key === admin) return "admin";
  if (crew && key === crew) return "crew";
  return "viewer";
}

const SOURCE = (Netlify.env.get("POLE_SOURCE_URL") || "https://poleyard.netlify.app").replace(/\/+$/, "");

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const parts = new URL(req.url).pathname.replace(/^\/api\/poles\/?/, "").split("/").filter(Boolean);

  if (req.method === "POST" && parts[0] === "whoami") return json({ role: roleFor(req) });

  if (req.method === "GET" && !parts.length) {
    const cacheStore = getStore("pole-cache");
    try {
      const r = await fetch(`${SOURCE}/api/poles`, { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`source ${r.status}`);
      const poles = await r.json();
      if (!Array.isArray(poles)) throw new Error("source returned non-list");
      await cacheStore.setJSON("last", { poles, at: new Date().toISOString() });
      return json(poles, 200, { "x-pole-source": "live" });
    } catch (e) {
      const last = await cacheStore.get("last", { type: "json" }).catch(() => null);
      if (last) return json(last.poles, 200, { "x-pole-source": "cached " + last.at });
      return json({ error: "Pole Yard site unreachable and no cached copy: " + e.message }, 502);
    }
  }

  return json({ error: "Poles are read-only here — edit them in the Pole Yard app." }, 403);
};

export const config = { path: ["/api/poles", "/api/poles/*"] };
