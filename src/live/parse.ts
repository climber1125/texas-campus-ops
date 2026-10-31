// Radio call → work-order draft. Deterministic, local, no API.
// "This is Mike, N L C twelve has a cracked crossarm, urgent, send Andrew"
//   → item NLC-12, issue "Has a cracked crossarm", Urgent, assign ANDREW, caller MIKE
import type { YardItem } from '../sim/campus';

export interface CallDraft {
  item: YardItem | null; itemText: string; issue: string;
  priority: 'Emergency' | 'Urgent' | 'Routine'; assignee: string; caller: string; notes: string[];
}

const ONES: Record<string, number> = { zero: 0, oh: 0, one: 1, won: 1, two: 2, to: 2, too: 2, three: 3, four: 4, for: 4, five: 5, six: 6, seven: 7, eight: 8, ate: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const NAME_STOP = new Set(['a', 'an', 'the', 'it', 'crew', 'someone', 'somebody', 'them', 'him', 'her', 'out', 'over', 'up', 'me', 'us', 'to', 'and', 'please', 'that', 'this', 'there', 'is', 'on', 'for', 'asap', 'now', 'pole', 'my', 'our', 'his', 'help', 'here', 'control', 'campus', 'ops', 'operator', 'base']);

export const normId = (s: string) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

function numberWords(t: string): string {
  let s = t.replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)[\s-]+(one|two|three|four|five|six|seven|eight|nine)\b/g, (_m, a, b) => String(TENS[a] + ONES[b]));
  s = s.replace(/\b(one|two|three|four|five|six|seven|eight|nine)\s+hundred(?:\s+and)?(?:\s+(\d{1,2}))?\b/g, (_m, a, b) => String(ONES[a] * 100 + (b ? Number(b) : 0)));
  s = s.replace(/\b(twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)\b/g, m => String(TENS[m]));
  s = s.replace(/\b(zero|oh|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)\b/g, (m, _x, off, str) => {
    // only convert "to/too/for/won/ate/oh" when they sit next to another digit or a letter code
    if (['to', 'too', 'for', 'won', 'ate', 'oh'].includes(m)) {
      const before = str.slice(Math.max(0, off - 4), off), after = str.slice(off + m.length, off + m.length + 3);
      if (!/\d\s*$|\b[a-z]{1,3}\s*$/.test(before) || /^\s*[a-z]{4}/.test(after)) return m;
    }
    return String(ONES[m]);
  });
  // "1 2" -> "12" (digits read one at a time)
  s = s.replace(/\b\d(?:\s+\d\b)+/g, m => m.replace(/\s+/g, ''));
  return s;
}

export function parseCall(raw: string, items: YardItem[], people: { id: string; crew: string }[]): CallDraft {
  const out: CallDraft = { item: null, itemText: '', issue: '', priority: 'Routine', assignee: '', caller: '', notes: [] };
  const text = raw.trim();
  if (!text) return out;
  let t = ' ' + text.toLowerCase().replace(/[.,;!?]/g, ' ').replace(/\s+/g, ' ') + ' ';
  // spelled letters "n l c" -> "nlc"
  t = t.replace(/\b[a-z](?:\s[a-z]\b)+/g, m => m.replace(/\s/g, ''));
  t = numberWords(t);

  const elec = items.filter(i => i.itemType !== 'span');
  const labels = elec.map(i => ({ it: i, n: normId(i.poleId) }));
  const prefixes = [...new Set(labels.map(l => (l.n.match(/^[A-Z]+/) ?? [''])[0]).filter(p => p.length >= 2))].sort((a, b) => b.length - a.length);

  // 1. exact label with a letter prefix ("nlc 12", "ta16", "ug 4")
  let found: YardItem | null = null;
  if (prefixes.length) {
    const re = new RegExp(`\\b(${prefixes.map(p => p.toLowerCase()).join('|')})\\s*-?\\s*(?:pole\\s*)?(?:number\\s*)?(\\d{1,4})\\b`, 'g');
    let m: RegExpExecArray | null;
    while ((m = re.exec(t))) {
      const want = (m[1] + m[2]).toUpperCase();
      const hit = labels.filter(l => l.n === want);
      if (hit.length === 1) { found = hit[0].it; break; }
      if (hit.length > 1) { out.notes.push(`${want} is used on ${hit.length} items — pick the right one.`); out.itemText = want; break; }
      out.itemText = want; out.notes.push(`Heard ${want} — not on the map. Check the number.`);
    }
  }
  // 2. named items ("switch gear", "ca pit")
  if (!found && !out.itemText) {
    for (const l of labels) {
      const nm = String(l.it.poleId).toLowerCase().trim();
      if (nm.length >= 4 && /[a-z]{3}/.test(nm) && t.includes(' ' + nm.replace(/[-_]/g, ' ') + ' ')) { found = l.it; break; }
    }
  }
  // 3. "pole 12" with no prefix
  if (!found && !out.itemText) {
    const m2 = t.match(/\bpole\s*(?:number\s*)?(\d{1,4})\b/);
    if (m2) {
      const hits = labels.filter(l => (l.n.match(/\d+$/) ?? [''])[0] === String(Number(m2[1])));
      if (hits.length === 1) found = hits[0].it;
      else if (hits.length > 1) { out.notes.push(`Pole ${m2[1]} could be ${hits.slice(0, 5).map(h => h.it.poleId).join(', ')} — pick one.`); out.itemText = m2[1]; }
      else out.notes.push(`Heard pole ${m2[1]} — no match. Pick the item.`);
    }
  }
  if (found) { out.item = found; out.itemText = found.poleId; }
  else if (!out.itemText) out.notes.push('No pole heard — pick one or leave blank.');

  // priority
  if (/\b(emergency|mayday|911|injur\w*|hurt|fell|fall|fire|smoke|unconscious|bleeding|bee sting\w*|heat (stroke|exhaustion)|not breathing|rescue)\b/.test(t)) {
    out.priority = 'Emergency'; out.notes.push('⚠ Emergency words heard — confirm priority.');
  } else if (/\b(urgent|asap|right away|right now|immediately|priority|hazard\w*|unsafe|leaning|broken|cracked|down)\b/.test(t)) out.priority = 'Urgent';

  // people — prefer names already on the board
  const known = (w: string) => people.find(p => p.id.toLowerCase() === w || p.crew.toLowerCase() === w || p.crew.toLowerCase().split(/\s+/)[0] === w);
  const cap = (w: string) => w.replace(/\b\w/g, c => c.toUpperCase());
  const asg = t.match(/\b(?:assign(?:ed)?|send|dispatch|give (?:it|that) to)\s+(?:it\s+|that\s+)?(?:to\s+)?([a-z]+)(?:\s+([a-z]+))?/);
  if (asg && !NAME_STOP.has(asg[1])) {
    const k = (asg[2] && known(asg[1] + ' ' + asg[2])) || known(asg[1]);
    if (k) out.assignee = k.id; else out.notes.push(`Assign to "${cap(asg[1])}"? Not on the unit board — add them first.`);
  }
  const clr = t.match(/\b(?:this is|it'?s|from)\s+([a-z]+)/);
  if (clr && !NAME_STOP.has(clr[1]) && !prefixes.includes(clr[1].toUpperCase())) { const k = known(clr[1]); out.caller = k ? k.crew : cap(clr[1]); }

  // issue = what was said minus the radio preamble / assignment / sign-off
  let issue = text
    .replace(/^\s*(?:campus\s+)?(?:control|ops|operator|base|dispatch)[,\s]+/i, '')
    .replace(/^\s*this is\s+\w+[,.\s]+/i, '')
    .replace(/[,.\s]*(?:assign(?:ed)?|send|dispatch)\s+(?:it\s+|that\s+)?(?:to\s+)?\w+(?:\s+\w+)?[.\s]*$/i, '')
    .replace(/[,.\s]*\b(?:over|copy|out)\s*$/i, '')
    .replace(/[,.\s]*\b(?:it'?s\s+)?(?:urgent|asap|emergency|routine|right away|priority)\s*$/i, '')
    .trim();
  out.issue = issue ? issue[0].toUpperCase() + issue.slice(1) : text;
  return out;
}
