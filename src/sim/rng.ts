/** Mulberry32 — small, fast, deterministic. State is a single uint32. */
export function mulberry(state: number): [number, number] {
  let s = (state + 0x6d2b79f5) >>> 0;
  let t = s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return [((t ^ (t >>> 14)) >>> 0) / 4294967296, s];
}

export class RNG {
  s: number;
  constructor(seed: number) { this.s = seed >>> 0 || 1; }
  next(): number { const [v, s] = mulberry(this.s); this.s = s; return v; }
  range(a: number, b: number) { return a + (b - a) * this.next(); }
  int(a: number, b: number) { return Math.floor(this.range(a, b + 1)); }
  pick<T>(arr: T[]): T { return arr[Math.floor(this.next() * arr.length)]; }
  chance(p: number) { return this.next() < p; }
}
