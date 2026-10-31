// ─────────────────────────────────────────────────────────────
// Connectivity solver: BFS from each substation bus through closed
// devices. Tracks energized nodes, source feeder, parent element
// (for upstream tracing) and parallels/loops between sources.
// ─────────────────────────────────────────────────────────────
import type { Topology, DevEl } from './types';

export interface NetState {
  en: Set<string>;
  src: Map<string, string>;     // node -> feeder id supplying it
  sub: Map<string, string>;     // node -> substation id
  parent: Map<string, string>;  // node -> element id toward source
  loops: string[];              // elements closing a loop/parallel
  parallelSubs: boolean;        // loop spans two different substations
}

export function solve(T: Topology, dev: Record<string, { open: boolean }>): NetState {
  const en = new Set<string>();
  const src = new Map<string, string>();
  const sub = new Map<string, string>();
  const parent = new Map<string, string>();
  const loops = new Set<string>();
  let parallelSubs = false;

  for (const s of Object.values(T.subs)) {
    if (en.has(s.bus)) continue;
    en.add(s.bus); src.set(s.bus, ''); sub.set(s.bus, s.id);
    const q = [s.bus];
    let qi = 0;
    while (qi < q.length) {
      const n = q[qi++];
      for (const eid of T.adj[n]) {
        const el = T.els[eid];
        if (el.kind === 'device' && dev[eid]?.open) continue;
        if (eid === parent.get(n)) continue;
        const m = el.from === n ? el.to : el.from;
        if (en.has(m)) {
          if (parent.get(m) !== eid) {
            loops.add(eid);
            if (sub.get(m) !== s.id) parallelSubs = true;
          }
          continue;
        }
        en.add(m);
        parent.set(m, eid);
        sub.set(m, s.id);
        const f = el.kind === 'device' && (el as DevEl).type === 'breaker' ? el.feeder : src.get(n)!;
        src.set(m, f);
        q.push(m);
      }
    }
  }
  return { en, src, sub, parent, loops: [...loops], parallelSubs };
}

/** Elements on the path from a node back to its source (nearest first). */
export function pathToSource(T: Topology, net: NetState, node: string): string[] {
  const out: string[] = [];
  let n: string | undefined = node;
  let guard = 0;
  while (n && guard++ < 5000) {
    const p = net.parent.get(n);
    if (!p) break;
    out.push(p);
    const el = T.els[p];
    n = el.from === n ? el.to : el.from;
  }
  return out;
}

/**
 * Electrical section around an element, bounded by sectionalizing devices
 * (breaker / recloser / switch / tie). Fuses and transformers are inside.
 */
export function sectionAround(T: Topology, elId: string): { nodes: string[]; bounds: string[] } {
  const el = T.els[elId];
  const seen = new Set<string>();
  const bounds = new Set<string>();
  const stop = (id: string) => {
    const e = T.els[id];
    return e.kind === 'device' && ['breaker', 'recloser', 'switch', 'tie'].includes((e as DevEl).type);
  };
  const q: string[] = [];
  if (el.kind === 'device' && stop(elId)) return { nodes: [], bounds: [elId] };
  q.push(el.from, el.to);
  while (q.length) {
    const n = q.pop()!;
    if (seen.has(n)) continue;
    seen.add(n);
    for (const eid of T.adj[n]) {
      if (stop(eid)) { bounds.add(eid); continue; }
      const e = T.els[eid];
      const m = e.from === n ? e.to : e.from;
      if (!seen.has(m)) q.push(m);
    }
  }
  return { nodes: [...seen], bounds: [...bounds] };
}

export function faultNode(T: Topology, elId: string, onLoad: boolean): string {
  if (onLoad) return T.loads[elId].node;
  return T.els[elId].to;
}
