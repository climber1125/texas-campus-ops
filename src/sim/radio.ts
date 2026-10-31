// Radio phrasing helpers. Display text stays exact (device IDs);
// `speakable` converts IDs/numbers into how an operator would say them.
import type { Cause, DevEl } from './types';

export const CONTROL = 'CAMPUS CONTROL';

export function devWord(d: DevEl | undefined): string {
  if (!d) return 'device';
  switch (d.type) {
    case 'breaker': return 'breaker';
    case 'recloser': return 'recloser';
    case 'switch': return 'switch';
    case 'tie': return 'tie switch';
    case 'fuse': return 'fuse';
    case 'xfmr': return 'transformer';
  }
}

export const CAUSE_TEXT: Record<Cause, string> = {
  animal: 'animal contact',
  tree_lateral: 'tree contact on the lateral',
  xfmr_failure: 'failed transformer',
  tree_primary: 'tree on the primary',
  insulator: 'failed insulator',
  vehicle: 'vehicle hit pole',
  lightning: 'lightning',
  temporary: 'temporary fault',
  planned: 'planned work',
  contact: 'electrical contact',
};

export function findingText(c: Cause, hazard: boolean): string {
  switch (c) {
    case 'animal': return 'Found a squirrel on the cutout, fuse is blown. No other damage';
    case 'xfmr_failure': return 'Transformer is failed, bushing is blown out and leaking oil. Need to change it out';
    case 'tree_lateral': return 'Found a limb across the lateral primary, fuse is blown. Need to clear the limb and refuse';
    case 'vehicle': return 'Vehicle hit the pole, pole is cracked, conductor intact. Will need to frame a new pole';
    case 'tree_primary': return hazard
      ? 'Found a large limb took down B-phase primary, wire is on the ground. Police on scene holding traffic'
      : 'Found a large limb in the B-phase primary, conductor is burned but still up';
    case 'insulator': return 'Found a flashed-over pin insulator, crossarm is burned';
    case 'lightning': return 'Lightning arrester is blown, flash marks on the pole';
    case 'contact': return 'Electrical contact at the work location';
    default: return 'Patrolled the line, no trouble found';
  }
}

export function repairMinutes(c: Cause, r: () => number): number {
  switch (c) {
    case 'animal': return 10 + r() * 8;
    case 'tree_lateral': return 25 + r() * 20;
    case 'xfmr_failure': return 55 + r() * 35;
    case 'vehicle': return 120 + r() * 60;
    case 'tree_primary': return 45 + r() * 30;
    case 'insulator': return 40 + r() * 20;
    case 'lightning': return 25 + r() * 15;
    default: return 8;
  }
}

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];

function pairs(n: string): string {
  if (n.length === 4) {
    const a = n.slice(0, 2), b = n.slice(2);
    return `${a} ${b === '00' ? 'hundred' : b.startsWith('0') ? 'oh ' + ONES[+b[1]] : b}`;
  }
  if (n.length === 3) return `${n[0]} ${n.slice(1).startsWith('0') ? 'oh ' + ONES[+n[2]] : n.slice(1)}`;
  return n;
}

/** Convert display text into natural spoken radio phrasing. */
export function speakable(text: string): string {
  return text
    .replace(/\bCB-(\d+)/g, (_, n) => `breaker ${pairs(n)}`)
    .replace(/\bTS-(\d+)/g, (_, n) => `tie switch ${n.split('').join(' ')}`)
    .replace(/\bS-(\d+)/g, (_, n) => `switch ${pairs(n)}`)
    .replace(/\bR-(\d+)/g, (_, n) => `recloser ${pairs(n)}`)
    .replace(/\bF-(\d{3})(\d{2})/g, (_, a, b) => `fuse ${a.split('').join(' ')} dash ${b}`)
    .replace(/\bTX-(\d+)/g, (_, n) => `transformer ${pairs(n)}`)
    .replace(/\bINC-(\d+)/g, (_, n) => `incident ${pairs(n)}`)
    .replace(/\bSO-(\d+)/g, (_, n) => `switching order ${pairs(n)}`)
    .replace(/\bCL-(\d+)/g, (_, n) => `clearance ${pairs(n)}`)
    .replace(/\bWO-(\d+)/g, (_, n) => `work order ${pairs(n)}`)
    .replace(/\b(CH|IW|BS)-(\d{4})/g, (_, s, n) => `${s.split('').join(' ')} ${pairs(n)}`)
    .replace(/\bTruck (\d{3})/g, (_, n) => `Truck ${pairs(n)}`)
    .replace(/(^|[\s,])(2\d\d)([,.\s]|$)/g, (_, a, n, b) => `${a}${pairs(n)}${b}`)
    .replace(/\b(\d{1,2}):(\d{2})\b/g, (_, h, m) => `${h.padStart(2, '0')} ${m === '00' ? 'hundred' : m}`)
    .replace(/\bETR\b/g, 'E T R')
    .replace(/\bOMS\b/g, 'O M S')
    .replace(/&/g, 'and');
}
