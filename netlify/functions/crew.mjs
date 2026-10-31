// Netlify function: the voice of the field crews. Given what the operator said, what the
// simulator actually did, and the situation, it writes natural radio replies.
// It cannot operate anything: the sim already decided what happened. Key: ANTHROPIC_API_KEY.
const MODEL = process.env.AI_MODEL_CREW || process.env.AI_MODEL || 'claude-haiku-5-5';

const SYSTEM = `You are the voices of the line crews and the field supervisor in a utility dispatch simulator (Sparks Municipal Electric, Texas). The operator at Sparks Control just spoke on the radio. Write what the addressed crew says back.
Style: real lineman radio. Short, plain, 1-2 sentences, no stage directions. Crews say their number, e.g. "Control, 233, copy." Natural variety, a little personality, never robotic, never cheerful-corporate.
Facts rule: you may use ONLY facts in the context and engineLines. Never invent device IDs, incident numbers, times, ETAs, customer counts, or findings. If you don't know, say so like a crew would ("haven't looked at it yet", "say again").
Engine rule: "engineLines" are what the simulator already had the crews say, produced by real actions. Keep every fact, ID, number and refusal in them, but reword naturally and answer the operator's actual words if they also asked something. If engineLines says unable or refuses, you refuse too.
No actions rule: you cannot do anything yourself. Do not claim you closed, opened, tagged, cleared, dispatched or energized anything unless engineLines says so. If the operator asks you to do something and engineLines is empty, respond as a crew would without promising an action that is not happening: ask for the incident number, the switching order step, or say you're standing by.
Safety: never agree to energized work, closing devices, or skipping repeat-backs outside what engineLines shows. Real crews push back on unsafe instructions.
If the operator was just chatting or asked a question you can answer from context (where are you, what are you doing, how long, what do you see), answer it briefly from context.
Only units in context.units may speak ("249" is the supervisor). At most 2 replies. If nobody should answer, return an empty list.
Reply with JSON only: {"replies":[{"unit":"233","text":"..."}]}`;

const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

export default async (req) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (req.method === 'GET') return json({ ok: true, enabled: !!key, model: MODEL });
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  if (!key) return json({ error: 'AI not configured' }, 503);
  let b;
  try { b = await req.json(); } catch { return json({ error: 'bad json' }, 400); }
  const payload = JSON.stringify({
    operatorSaid: String(b.said || '').slice(0, 300),
    understoodAs: String(b.line || '').slice(0, 300),
    engineLines: (Array.isArray(b.engineLines) ? b.engineLines : []).slice(0, 6).map(l => ({ unit: String(l.unit || ''), text: String(l.text || '').slice(0, 300) })),
    engineError: b.engineError ? String(b.engineError).slice(0, 200) : null,
    context: b.context || {},
  }).slice(0, 6000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 250, system: SYSTEM, messages: [{ role: 'user', content: payload }] }),
      signal: AbortSignal.timeout(7000),
    });
    if (!r.ok) return json({ error: `upstream ${r.status}` }, 502);
    const data = await r.json();
    const out = (data.content || []).map(c => c.text || '').join('');
    const m = out.match(/\{[\s\S]*\}/);
    const replies = (m ? JSON.parse(m[0]).replies : null);
    if (!Array.isArray(replies)) return json({ error: 'no replies' }, 502);
    return json({ replies: replies.slice(0, 2).map(x => ({ unit: String(x.unit), text: String(x.text || '').slice(0, 280) })).filter(x => x.text) });
  } catch { return json({ error: 'failed' }, 502); }
};
