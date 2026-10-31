// Netlify function: turns free-form radio speech into one standard-phraseology line.
// The API key lives only here (env var ANTHROPIC_API_KEY). The sim engine still makes
// every real decision and enforces all safety rules — the AI only rewords what you said.
const MODEL = process.env.AI_MODEL || 'claude-haiku-5-5';

const SYSTEM = `You are the radio-phraseology normalizer for a utility dispatch simulator.
The operator (Sparks Control) spoke or typed a transmission to a field crew. Rewrite it as ONE line of standard phraseology the simulator's parser understands. Do not add actions the operator did not say. Do not invent device or incident IDs: use only IDs from the context, or ones the operator said.
Rules:
- Start with the unit: "Truck 233, Sparks Control, ..." or "Supervisor 249, Sparks Control, ...". If the operator did not name a unit, use lastUnit from context if present, otherwise the unit with a pending request or repeat-back.
- Dispatch: "respond to INC-4101". Status: "status". Return: "return to the shop".
- Answering a close-the-fuse request: "permission granted to close" or "hold, stand by".
- Clearance request: "clearance is issued on that section" or "unable, stand by".
- Release: "copy, clearance released". Hot-line request: "hot-line tag is on, clear for energized work" or "hold, stand by".
- Repeat-back: "that is correct, proceed" or "negative, say again".
- Switching: "open S-2114" / "close R-2125" (IDs exactly as in context).
- Emergency: "All units, Sparks Control, emergency traffic only". Line dead: "the line is dead, locked out".
- Welfare: "check on Truck 233".
- If it makes no sense as a radio transmission, return it unchanged.
Reply with JSON only: {"line":"..."}`;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export default async (req) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (req.method === 'GET') return json({ ok: true, enabled: !!key, model: MODEL });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (!key) return json({ error: 'AI not configured' }, 503);
  let body;
  try { body = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const text = String(body.text || '').slice(0, 300);
  if (!text.trim()) return json({ error: 'empty' }, 400);
  const context = JSON.stringify(body.context || {}).slice(0, 4000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL, max_tokens: 120, system: SYSTEM,
        messages: [{ role: 'user', content: `Context: ${context}\nTransmission: ${text}` }],
      }),
      signal: AbortSignal.timeout(6000),
    });
    if (!r.ok) return json({ error: `upstream ${r.status}` }, 502);
    const data = await r.json();
    const out = (data.content || []).map(c => c.text || '').join('');
    const m = out.match(/\{[\s\S]*\}/);
    const line = m ? JSON.parse(m[0]).line : null;
    if (!line || typeof line !== 'string') return json({ error: 'no line' }, 502);
    return json({ line: line.slice(0, 300) });
  } catch (e) {
    return json({ error: 'failed' }, 502);
  }
};
