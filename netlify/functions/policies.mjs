// Campus Ops — Policies & Specs are READ-ONLY here, pulled live from the original Pole Yard site.
// Edit them in the Pole Yard app.
//
// GET /api/policies -> { content, updatedAt, updatedBy }
import { getStore } from "@netlify/blobs";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, x-key",
};
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...cors } });

const SOURCE = (Netlify.env.get("POLE_SOURCE_URL") || "https://poleyard.netlify.app").replace(/\/+$/, "");
const EMPTY = { content: "", updatedAt: null, updatedBy: null };

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (req.method !== "GET") return json({ error: "Policies are read-only here — edit them in the Pole Yard app." }, 403);
  const cacheStore = getStore("pole-cache");
  try {
    const r = await fetch(`${SOURCE}/api/policies`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error(`source ${r.status}`);
    const doc = await r.json();
    await cacheStore.setJSON("policies", doc);
    return json(doc);
  } catch (e) {
    const last = await cacheStore.get("policies", { type: "json" }).catch(() => null);
    return json(last || EMPTY);
  }
};

export const config = { path: ["/api/policies"] };
