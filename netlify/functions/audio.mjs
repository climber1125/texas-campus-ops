// Campus Ops — voice clips. POST raw audio (≤ 1.5 MB, ≈ 60 s); GET by id.
// Ids are random; GET needs no header so <audio src> can play it.
import { cors, json, roleFor, store } from "../lib/comms.mjs";

const MAX = 1_500_000;

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const s = store();
  const id = new URL(req.url).pathname.replace(/^\/api\/audio\/?/, "").split("/")[0];
  try {
    if (req.method === "GET" && id) {
      if (!/^[a-z0-9]{12,40}$/.test(id)) return json({ error: "bad id" }, 400);
      const r = await s.getWithMetadata(`a/${id}`, { type: "arrayBuffer" });
      if (!r) return json({ error: "not found" }, 404);
      return new Response(r.data, { status: 200, headers: { "Content-Type": r.metadata?.type || "audio/webm", "Cache-Control": "private, max-age=86400", ...cors } });
    }
    if (req.method === "POST" && !id) {
      if (roleFor(req) === "viewer") return json({ error: "access code required" }, 403);
      const type = (req.headers.get("content-type") || "audio/webm").split(";")[0];
      if (!/^audio\//.test(type)) return json({ error: "audio only" }, 415);
      const buf = await req.arrayBuffer();
      if (!buf.byteLength) return json({ error: "empty" }, 400);
      if (buf.byteLength > MAX) return json({ error: "clip too long" }, 413);
      const nid = (Date.now().toString(36) + Math.random().toString(36).slice(2, 12)).replace(/[^a-z0-9]/g, "");
      await s.set(`a/${nid}`, buf, { metadata: { type, at: Date.now() } });
      return json({ id: nid, type }, 201);
    }
    return json({ error: "not found" }, 404);
  } catch (e) { return json({ error: e.message }, 500); }
};

export const config = { path: ["/api/audio", "/api/audio/*"] };
