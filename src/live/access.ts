// Campus Ops access + shared-server helpers.
// Codes are checked on the server (Netlify env ADMIN_KEY / CREW_KEY):
//   admin = OPERATOR (runs the desk, writes the board)   crew = STAFF (view only)
export type Access = 'operator' | 'staff' | 'viewer';
const KEY = 'campusOpsKey';
export const ACCESS = {
  key: (() => { try { return localStorage.getItem(KEY) || ''; } catch { return ''; } })(),
  role: 'viewer' as Access,
  /** this browser tab's id for the single-writer check */
  /** one id per browser: linked monitor windows and extra tabs on the same machine share the desk */
  client: (() => { try { const k = 'campusOpsClient'; let v = localStorage.getItem(k); if (!v) { v = Math.random().toString(36).slice(2, 10); localStorage.setItem(k, v); } return v; } catch { return Math.random().toString(36).slice(2, 10); } })(),
  name: (() => { try { return localStorage.getItem('campusOpsName') || ''; } catch { return ''; } })(),
};
export const hdr = (): Record<string, string> => (ACCESS.key ? { 'x-key': ACCESS.key } : {});
export function setKey(k: string) { ACCESS.key = k; try { if (k) localStorage.setItem(KEY, k); else localStorage.removeItem(KEY); } catch { /* none */ } }
export function setOperatorName(n: string) { ACCESS.name = n; try { localStorage.setItem('campusOpsName', n); } catch { /* none */ } }

export async function whoami(): Promise<Access | 'offline'> {
  try {
    const r = await fetch('/api/poles/whoami', { method: 'POST', headers: hdr(), signal: AbortSignal.timeout(8000) });
    if (!r.ok) return 'offline';
    const j = await r.json();
    return j.role === 'admin' ? 'operator' : j.role === 'crew' ? 'staff' : 'viewer';
  } catch { return 'offline'; }
}

export async function getJson<T>(path: string): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  try {
    const r = await fetch(path, { headers: hdr(), cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, data: await r.json() as T };
  } catch { return { ok: false, status: 0 }; }
}
export async function putJson(path: string, body: unknown): Promise<{ ok: boolean; status: number; data?: any }> {
  try {
    const r = await fetch(path, { method: 'PUT', headers: { 'Content-Type': 'application/json', ...hdr() }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    let data: any; try { data = await r.json(); } catch { /* none */ }
    return { ok: r.ok, status: r.status, data };
  } catch { return { ok: false, status: 0 }; }
}

export const cacheGet = <T>(k: string): T | null => { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : null; } catch { return null; } };
export const cacheSet = (k: string, v: unknown) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* quota */ } };
