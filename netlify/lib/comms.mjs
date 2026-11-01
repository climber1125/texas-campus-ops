// Shared helpers for the Campus Ops comms functions (imported by messages / audio / push).
import { getStore } from "@netlify/blobs";
import webpush from "web-push";

export const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type, x-key, x-unit, x-name" };
export const json = (d, status = 200) => new Response(JSON.stringify(d), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...cors } });

export function roleFor(req) {
  const admin = (Netlify.env.get("ADMIN_KEY") || Netlify.env.get("ops_key") || Netlify.env.get("OPS_KEY") || Netlify.env.get("ops") || Netlify.env.get("OPS") || "").trim();
  const crew = (Netlify.env.get("CREW_KEY") || Netlify.env.get("crew_key") || Netlify.env.get("crew") || Netlify.env.get("CREW") || "").trim();
  if (!admin && !crew) return "admin";
  const key = (req.headers.get("x-key") || "").trim();
  if (admin && key === admin) return "admin";
  if (crew && key === crew) return "crew";
  return "viewer";
}

export const store = () => getStore("campus-comms");

/** VAPID keys are generated once and kept in this site's blob store — nothing to configure. */
export async function vapid() {
  const s = store();
  let k = await s.get("vapid", { type: "json" }).catch(() => null);
  if (!k) { k = webpush.generateVAPIDKeys(); await s.setJSON("vapid", k); }
  webpush.setVapidDetails("mailto:campus-ops@nlc.invalid", k.publicKey, k.privateKey);
  return k;
}

/** Send a push to every subscription that should hear this message. */
export async function fanout(msg) {
  const s = store();
  await vapid();
  const { blobs } = await s.list({ prefix: "sub/" });
  const subs = (await Promise.all(blobs.map(b => s.get(b.key, { type: "json" }).then(v => v && { key: b.key, ...v }).catch(() => null)))).filter(Boolean);
  const want = subs.filter(x => {
    if (x.unit && x.unit === msg.from) return false;            // not to yourself
    if (msg.to === "CONTROL") return x.role === "admin";
    if (msg.to === "ALL") return x.role !== "admin";
    return x.unit === msg.to;
  });
  const title = msg.to === "CONTROL" ? `${msg.fromName || msg.from} → Control` : msg.from === "CONTROL" ? `Campus Control${msg.to === "ALL" ? " → all units" : ""}` : `${msg.fromName || msg.from}`;
  const body = msg.text ? msg.text.slice(0, 180) : msg.audio ? "🎙 Voice message" : "";
  const payload = JSON.stringify({ title, body, tag: msg.kind === "assign" ? "wo-" + (msg.wo || msg.id) : "msg", urgent: msg.priority === "Emergency" || msg.kind === "emergency", url: "/" });
  await Promise.allSettled(want.map(async x => {
    try { await webpush.sendNotification(x.sub, payload, { TTL: 3600, urgency: "high" }); }
    catch (e) { if (e && (e.statusCode === 404 || e.statusCode === 410)) await s.delete(x.key); }
  }));
  return want.length;
}
