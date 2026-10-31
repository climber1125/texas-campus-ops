// ─────────────────────────────────────────────────────────────
// Radio phraseology parser. Turns what the operator said (speech-to-text
// output or typed) into unit numbers, device IDs, incident IDs and a
// normalized lowercase string the engine matches intents against.
// Handles spoken numbers: "two thirty three" → 233, "twenty one fourteen"
// → 2114, "forty one oh two" → 4102, "S 21 14" → S-2114.
// ─────────────────────────────────────────────────────────────

const ONES: Record<string, number> = { zero: 0, oh: 0, o: 0, one: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, ate: 8, nine: 9 };
const TEENS: Record<string, number> = { ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
// words that are only numbers when next to other number words (avoid "go to the" → "go 2 the")
const WEAK = new Set(['o', 'to', 'too', 'for', 'ate']);

function isNumWord(w: string) { return w in ONES || w in TEENS || w in TENS || w === 'hundred' || /^\d+$/.test(w); }

/** Replace runs of spoken number words with digit strings. */
export function wordsToDigits(text: string): string {
  const toks = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let i = 0;
  while (i < toks.length) {
    const w = toks[i];
    if (!isNumWord(w) || (WEAK.has(w) && !(isNumWord(toks[i + 1] ?? '') && !WEAK.has(toks[i + 1] ?? '')) && !(isNumWord(toks[i - 1] ?? '') && !WEAK.has(toks[i - 1] ?? '')))) { out.push(w); i++; continue; }
    let digits = '';
    while (i < toks.length && isNumWord(toks[i])) {
      const t = toks[i];
      if (/^\d+$/.test(t)) { digits += t; i++; continue; }
      if (t in TENS) {
        const n = toks[i + 1];
        if (n && n in ONES && !WEAK.has(n) && ONES[n] > 0) { digits += String(TENS[t] + ONES[n]); i += 2; }
        else { digits += String(TENS[t]); i++; }
        continue;
      }
      if (t in TEENS) { digits += String(TEENS[t]); i++; continue; }
      if (t === 'hundred') { digits += '00'; i++; continue; }
      digits += String(ONES[t]); i++;
    }
    out.push(digits);
  }
  return out.join(' ');
}

export interface Parsed { norm: string; units: string[]; devs: string[]; incs: string[]; feeders: string[]; }

/**
 * @param knownUnits truck numbers on the roster (to recognize bare numbers like "233")
 * @param knownDevs  predicate: does this device ID exist
 */
export function parseRadio(raw: string, knownUnits: string[], knownDevs: (id: string) => boolean): Parsed {
  let t = ' ' + raw.toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9' -]+/g, ' ')
    .replace(/-/g, ' ') + ' ';
  t = ' ' + wordsToDigits(t.trim()) + ' ';
  // spoken prefixes → letters
  t = t.replace(/\b(tie switch|tie|ts)\b/g, ' ts ').replace(/\b(sierra|switch)\b/g, ' s ').replace(/\b(romeo|recloser)\b/g, ' r ').replace(/\b(circuit breaker|breaker|cb)\b/g, ' cb ')
    .replace(/\b(fuse|foxtrot)\b/g, ' f ').replace(/\b(transformer|xfmr|tx)\b/g, ' tx ')
    .replace(/\b(incident|ticket|inc)\b/g, ' inc ').replace(/\b(cedar hollow)\b/g, ' ch ').replace(/\b(ironwood)\b/g, ' iw ').replace(/\b(bluestem|blue stem)\b/g, ' bs ')
    .replace(/\s+/g, ' ');
  // merge digit groups that follow a prefix: "s 21 14" → "s 2114"
  t = t.replace(/\b(s|r|cb|ts|f|tx|inc|ch|iw|bs|truck|unit)\s+((?:\d+\s*)+)/g, (_m, p, d) => `${p} ${String(d).replace(/\s+/g, '')} `);
  const devs: string[] = [], incs: string[] = [], feeders: string[] = [], units: string[] = [];
  const add = (arr: string[], v: string) => { if (!arr.includes(v)) arr.push(v); };
  for (const m of t.matchAll(/\b(s|r|cb|ts|f|tx)\s?(\d{2,5})\b/g)) {
    const pre = { s: 'S', r: 'R', cb: 'CB', ts: 'TS', f: 'F', tx: 'TX' }[m[1] as 's'];
    const id = `${pre}-${m[2]}`;
    if (knownDevs(id)) add(devs, id);
  }
  for (const m of t.matchAll(/\b(ch|iw|bs)\s?(\d{4})\b/g)) {
    const id = `CB-${m[2]}`;
    if (knownDevs(id)) { add(feeders, `${m[1].toUpperCase()}-${m[2]}`); add(devs, id); }
  }
  for (const m of t.matchAll(/\binc\s?(\d{4})\b/g)) add(incs, `INC-${m[1]}`);
  for (const m of t.matchAll(/\b(?:truck|unit)\s?(\d{2,4})\b/g)) add(units, m[1]);
  for (const m of t.matchAll(/\b(\d{2,4})\b/g)) if (knownUnits.includes(m[1])) add(units, m[1]);
  if (/\b(supervisor|2 49|249)\b/.test(t)) add(units, '249');
  return { norm: t.replace(/\s+/g, ' ').trim(), units, devs, incs, feeders };
}
