// ─────────────────────────────────────────────────────────────
// NLC CAMPUS OPS — builds the electrical model from the real
// Pole Yard inventory (live poles / pad-mounts / pedestals) plus a
// saved "network" file that says which items are tied together,
// where the source is, and where the switches / fuses sit.
//
// Nothing on the yard is energized. "Energized" in this model means
// IN SERVICE for training: open a device and everything past it shows
// out of service, exactly like GRID OPS.
// ─────────────────────────────────────────────────────────────
import type { LatLng, Topology, DevEl, LineEl, FeederInfo, Load, DevType, SchItem } from './types';
import { dist, lerp, offset } from './geo';
import { solve } from './network';

export interface YardItem {
  id: string; poleId: string; itemType?: string; lat: number; lng: number;
  components?: string[]; fromId?: string; toId?: string; size?: string; notes?: string;
  /** original Pole Yard GPS when the display position was snapped to an even grid */
  gpsLat?: number; gpsLng?: number;
}
export type LinkDev = 'switch' | 'fuse' | 'recloser';
export interface NetLink {
  a: string; b: string;
  /** Device on this span. `at` = which end it sits at (item id). `no` = normally open. */
  dev?: { type: LinkDev; id?: string; at?: string; no?: boolean };
}
export interface NetCfg { v: 1; source: string | null; links: NetLink[]; draft?: boolean; updatedAt?: string; updatedBy?: string; }

export interface CampusModel {
  T: Topology;
  subs: { id: string; name: string; pos: LatLng; bus: LatLng; mva: number }[];
  home: LatLng;
  bounds: [[number, number], [number, number]];
  items: YardItem[];
  /** electric items that are not tied to anything */
  orphans: string[];
  /** blocks snapped to even grids */
  grids: GridBlock[];
  /** item id -> node id */
  itemNode: Record<string, string>;
  /** node id -> item id */
  nodeItem: Record<string, string>;
  cfg: NetCfg;
}

export const ELECTRIC = (it: YardItem) => !it.itemType || it.itemType === 'pole' || it.itemType === 'transformer' || it.itemType === 'pedestal';
const isPole = (it: YardItem) => !it.itemType || it.itemType === 'pole';
export const itemPos = (it: YardItem): LatLng => [Number(it.lat), Number(it.lng)];
export const label = (it: YardItem) => String(it.poleId ?? it.id).trim();
const hasXfmr = (it: YardItem) => it.itemType === 'transformer' || (it.components ?? []).some(c => /transformer/i.test(c) && !/ground/i.test(c));

export const FEEDER_COLORS = ['#4e9ad6', '#9b86d1', '#45b5c4', '#c9b27c', '#6fb59a', '#c98bb9', '#d08a5c', '#8fb34e'];

// ── Draft: directional minimum spanning tree ─────────────────
/** Auto-draft connections: Pole Yard spans first, then a minimum spanning tree that
 *  prefers straight N-S / E-W runs (how yard rows are strung). Always one connected tree. */
export function draftNetwork(items: YardItem[]): NetCfg {
  const el = items.filter(ELECTRIC);
  const byId = new Map(el.map(i => [i.id, i]));
  const links: NetLink[] = [];
  const parent = new Map<string, string>();
  const find = (x: string): string => { let r = x; while (parent.get(r) !== r) r = parent.get(r)!; let c = x; while (parent.get(c) !== r) { const n = parent.get(c)!; parent.set(c, r); c = n; } return r; };
  for (const i of el) parent.set(i.id, i.id);
  const join = (a: string, b: string) => { const ra = find(a), rb = find(b); if (ra === rb) return false; parent.set(ra, rb); return true; };
  // 1. spans already drawn in Pole Yard
  for (const s of items) if (s.itemType === 'span' && s.fromId && s.toId && byId.has(s.fromId) && byId.has(s.toId)) {
    if (join(s.fromId, s.toId)) links.push({ a: s.fromId, b: s.toId });
  }
  // 2. straight runs: yard rows are strung pole-to-pole, so chain items that sit on the same
  //    line (E-W first, then N-S for poles that aren't in a row). Pad-mounts run on their own.
  const M = 111320, cosL = Math.cos((el[0] ? Number(el[0].lat) : 33.19) * Math.PI / 180);
  const xy = (i: YardItem) => [Number(i.lng) * M * cosL, Number(i.lat) * M] as const;
  const deg = new Map<string, number>(); const bump = (x: string) => deg.set(x, (deg.get(x) ?? 0) + 1);
  for (const l of links) { bump(l.a); bump(l.b); }
  const runPass = (pool: YardItem[], ew: boolean, maxGap: number, maxOff: number) => {
    const along = (i: YardItem) => (ew ? xy(i)[0] : xy(i)[1]), across = (i: YardItem) => (ew ? xy(i)[1] : xy(i)[0]);
    const sorted = [...pool].sort((p, q) => along(p) - along(q));
    const hasNext = new Set<string>(), hasPrev = new Set<string>();
    for (let k = 0; k < sorted.length; k++) {
      const a = sorted[k];
      let best: YardItem | null = null, bs = Infinity;
      for (let m = k + 1; m < sorted.length; m++) {
        const b = sorted[m];
        const g = along(b) - along(a);
        if (g > maxGap) break;
        const off = Math.abs(across(b) - across(a));
        if (g < 0.5 || off > maxOff || off > g * 0.45) continue;
        const sc = g + off * 4;
        if (sc < bs) { bs = sc; best = b; }
      }
      if (!best || hasNext.has(a.id) || hasPrev.has(best.id)) continue;
      if (join(a.id, best.id)) { links.push({ a: a.id, b: best.id }); hasNext.add(a.id); hasPrev.add(best.id); bump(a.id); bump(best.id); }
    }
  };
  const poles = el.filter(isPole), gear = el.filter(i => i.itemType === 'transformer');
  runPass(poles, true, 30, 2.6);
  runPass(gear, true, 30, 3);
  runPass(poles.filter(i => !deg.get(i.id)), false, 45, 2.6);
  runPass(poles.filter(i => (deg.get(i.id) ?? 0) < 2), false, 12, 1.6); // short N-S hops close up grid columns
  // 3. tie the runs together: minimum spanning tree preferring straight N-S / E-W jumps
  //    (pedestals are left out here and hung off the nearest gear in step 4)
  const core = el.filter(i => i.itemType !== 'pedestal');
  const pairs: { a: string; b: string; w: number }[] = [];
  for (let i = 0; i < core.length; i++) {
    const pa = itemPos(core[i]);
    for (let j = i + 1; j < core.length; j++) {
      const pb = itemPos(core[j]);
      const d = dist(pa, pb);
      if (d > 400) continue;
      const dy = Math.abs(pa[0] - pb[0]) * 111320, dx = Math.abs(pa[1] - pb[1]) * 111320 * Math.cos(pa[0] * Math.PI / 180);
      const skew = Math.min(dx, dy) / (Math.max(dx, dy) || 1); // 0 = straight, 1 = diagonal
      const mixed = isPole(core[i]) !== isPole(core[j]) ? 1.4 : 1; // keep UG gear on its own run when possible
      // joining at a run's end beats tapping the middle of a row
      const ends = ((deg.get(core[i].id) ?? 0) <= 1 ? 0 : 1) + ((deg.get(core[j].id) ?? 0) <= 1 ? 0 : 1);
      pairs.push({ a: core[i].id, b: core[j].id, w: d * (1 + 1.6 * skew) * mixed * (1 + 0.25 * ends) });
    }
  }
  pairs.sort((x, y) => x.w - y.w);
  for (const p of pairs) if (join(p.a, p.b)) { links.push({ a: p.a, b: p.b }); bump(p.a); bump(p.b); }
  // 4. pedestals: service stub to the nearest pad-mount (or pole)
  for (const pd of el.filter(i => i.itemType === 'pedestal')) {
    let best: YardItem | null = null, bd = Infinity;
    for (const c of core) { const d = dist(itemPos(pd), itemPos(c)) * (c.itemType === 'transformer' ? 0.6 : 1); if (d < bd) { bd = d; best = c; } }
    if (best && join(pd.id, best.id)) links.push({ a: best.id, b: pd.id });
  }
  // 5. anything still isolated: nearest neighbour
  for (const i of el) {
    if (find(i.id) === find(el[0].id)) continue;
    let best: YardItem | null = null, bd = Infinity;
    for (const j of el) if (find(j.id) !== find(i.id)) { const d = dist(itemPos(i), itemPos(j)); if (d < bd) { bd = d; best = j; } }
    if (best && join(i.id, best.id)) links.push({ a: i.id, b: best.id });
  }
  const src = el.find(i => (i.components ?? []).some(c => /riser/i.test(c))) ?? el.find(i => /switch ?gear/i.test(label(i))) ?? el[0];
  return { v: 1, source: src?.id ?? null, links, draft: true };
}

// ── Even grids: the climbing yards are blocks of ~20 poles set in rows. Hand-dropped GPS
//    pins wander a metre or two, so each block is snapped to a perfect, evenly spaced grid
//    for display. Pole Yard's GPS is untouched (kept on the item as gpsLat / gpsLng).
export interface GridBlock { ids: string[]; rows: number; cols: number; }
export function snapGrids(items: YardItem[]): { items: YardItem[]; grids: GridBlock[] } {
  const M = 111320;
  const poles = items.filter(i => isPole(i));
  const cos = Math.cos((poles[0] ? Number(poles[0].lat) : 33.19) * Math.PI / 180);
  const X = (i: YardItem) => Number(i.lng) * M * cos, Y = (i: YardItem) => Number(i.lat) * M;
  const median = (v: number[]) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
  // 1. rows: chain each pole to its nearest east neighbour on the same line
  const nxt = new Map<string, YardItem>(), prv = new Set<string>();
  for (const a of [...poles].sort((p, q) => X(p) - X(q))) {
    let best: YardItem | null = null, bs = Infinity;
    for (const b of poles) {
      const g = X(b) - X(a), off = Math.abs(Y(b) - Y(a));
      if (g > 2.5 && g <= 10 && off <= 2.2) { const sc = g + off * 4; if (sc < bs) { bs = sc; best = b; } }
    }
    if (best && !prv.has(best.id)) { nxt.set(a.id, best); prv.add(best.id); }
  }
  const rows: YardItem[][] = [];
  for (const p of poles) {
    if (prv.has(p.id)) continue;
    const ch = [p];
    while (nxt.has(ch[ch.length - 1].id)) ch.push(nxt.get(ch[ch.length - 1].id)!);
    // split where spacing jumps (a neighbouring block or a stray pole)
    const gaps = ch.slice(1).map((q, k) => X(q) - X(ch[k]));
    const med = median(gaps);
    let cur = [ch[0]];
    gaps.forEach((g, k) => { if (g > 1.7 * med || g < 0.55 * med) { if (cur.length >= 3) rows.push(cur); cur = [ch[k + 1]]; } else cur.push(ch[k + 1]); });
    if (cur.length >= 3) rows.push(cur);
  }
  // 2. stack rows that sit one above another
  const my = (r: YardItem[]) => r.reduce((a, i) => a + Y(i), 0) / r.length;
  const overlap = (A: YardItem[], B: YardItem[]) => { const o = Math.min(X(A[A.length - 1]), X(B[B.length - 1])) - Math.max(X(A[0]), X(B[0])); return o / Math.max(1e-6, Math.min(X(A[A.length - 1]) - X(A[0]), X(B[B.length - 1]) - X(B[0]))); };
  const below = new Map<YardItem[], YardItem[]>();
  for (const A of rows) {
    let best: YardItem[] | null = null;
    for (const B of rows) {
      if (B === A) continue;
      const dy = my(A) - my(B);
      if (dy >= 3 && dy <= 9 && overlap(A, B) >= 0.6 && (!best || dy < my(A) - my(best))) best = B;
    }
    if (best && ![...below.values()].includes(best)) below.set(A, best);
  }
  const hasAbove = new Set(below.values());
  const snapped = new Map<string, [number, number]>();
  const grids: GridBlock[] = [];
  for (const top of rows) {
    if (hasAbove.has(top)) continue;
    let stack = [top];
    while (below.has(stack[stack.length - 1])) stack.push(below.get(stack[stack.length - 1])!);
    // even row spacing only — stop where the next row is much farther away
    const dys = stack.slice(1).map((r, k) => my(stack[k]) - my(r));
    const mdy = median(dys);
    const cut = dys.findIndex(d => d > 1.6 * mdy || d < 0.6 * mdy);
    if (cut >= 0) stack = stack.slice(0, cut + 1);
    // a block shares its naming (NLC-…, TA…, DB…): trim rows from another set
    const pre = (i: YardItem) => (label(i).toUpperCase().match(/^[A-Z]+/) ?? [''])[0];
    const rowPre = (r: YardItem[]) => { const c = new Map<string, number>(); r.forEach(i => c.set(pre(i), (c.get(pre(i)) ?? 0) + 1)); return [...c.entries()].sort((a, b) => b[1] - a[1])[0][0]; };
    const counts = new Map<string, number>(); stack.forEach(r => counts.set(rowPre(r), (counts.get(rowPre(r)) ?? 0) + 1));
    const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    while (stack.length && rowPre(stack[0]) !== main) stack.shift();
    while (stack.length && rowPre(stack[stack.length - 1]) !== main) stack.pop();
    if (stack.length < 3) continue;
    // 3. columns from the most common row length, then match every pole to a column
    const n = median(stack.map(r => r.length));
    const ref = stack.filter(r => r.length === n);
    const colX = Array.from({ length: n }, (_, c) => ref.reduce((a, r) => a + X(r[c]), 0) / ref.length);
    const spacing = (colX[n - 1] - colX[0]) / Math.max(1, n - 1);
    const cell = new Map<string, [number, number]>(); const taken = new Set<string>();
    stack.forEach((r, ri) => r.forEach(p => {
      let c = 0; for (let k = 1; k < n; k++) if (Math.abs(X(p) - colX[k]) < Math.abs(X(p) - colX[c])) c = k;
      if (Math.abs(X(p) - colX[c]) > spacing * 0.45 || taken.has(ri + ':' + c)) return;
      taken.add(ri + ':' + c); cell.set(p.id, [ri, c]);
    }));
    // drop thin outside columns (strays that happened to line up with one or two rows)
    const occ = (c: number) => [...cell.values()].filter(v => v[1] === c).length;
    let c0 = 0, c1 = n - 1;
    while (c0 < c1 && occ(c0) <= stack.length / 2) c0++;
    while (c1 > c0 && occ(c1) <= stack.length / 2) c1--;
    for (const [id, v] of [...cell]) if (v[1] < c0 || v[1] > c1) cell.delete(id);
    const cols = c1 - c0 + 1;
    if (cols < 3 || cell.size < stack.length * cols * 0.75) continue;
    const rowY = stack.map(r => my(r));
    const y0 = rowY[0], y1 = rowY[rowY.length - 1], x0 = colX[c0], x1 = colX[c1];
    for (const [id, [r, c]] of cell) snapped.set(id, [(y0 + (y1 - y0) * r / (stack.length - 1)) / M, (x0 + (x1 - x0) * (c - c0) / (cols - 1)) / (M * cos)]);
    grids.push({ ids: [...cell.keys()], rows: stack.length, cols });
  }
  const out = items.map(i => { const p = snapped.get(i.id); return p ? { ...i, gpsLat: Number(i.lat), gpsLng: Number(i.lng), lat: p[0], lng: p[1] } : i; });
  return { items: out, grids };
}

// ── Build the GRID OPS topology ──────────────────────────────
export function buildCampus(itemsIn: YardItem[], cfgIn: NetCfg | null): CampusModel {
  const { items, grids } = snapGrids(itemsIn.filter(i => Number.isFinite(Number(i.lat)) && Number.isFinite(Number(i.lng))));
  const el = items.filter(ELECTRIC);
  const byId = new Map(el.map(i => [i.id, i]));
  const cfg: NetCfg = cfgIn && Array.isArray(cfgIn.links) ? cfgIn : draftNetwork(items);
  const T: Topology = {
    nodes: {}, els: {}, adj: {}, loads: {}, loadIds: [], subs: {}, feeders: {}, feederIds: [], laterals: {},
    devIds: [], switchable: [], ties: [], normParent: {}, normFeeder: {}, loadAnc: {}, devLoads: {}, devCust: {}, totalCustomers: 0,
  };
  const used = new Set<string>();
  const uniq = (base: string) => { let id = base.replace(/\s+/g, '').toUpperCase() || 'X'; if (!used.has(id)) { used.add(id); return id; } let k = 2; while (used.has(`${id}.${k}`)) k++; used.add(`${id}.${k}`); return `${id}.${k}`; };
  let nSeq = 0;
  const mkNode = (pos: LatLng, id?: string) => { const nid = id ?? 'N' + (nSeq++); T.nodes[nid] = { id: nid, pos }; T.adj[nid] = []; return nid; };
  const addEl = (x: LineEl | DevEl) => { T.els[x.id] = x; T.adj[x.from].push(x.id); T.adj[x.to].push(x.id); if (x.kind === 'device') T.devIds.push(x.id); };
  const nameAt = (p: LatLng) => campusName(p);
  const mkDev = (id: string, from: string, to: string, feeder: string, type: DevType, normalOpen: boolean, pos: LatLng) =>
    addEl({ id, kind: 'device', from, to, feeder, type, scada: false, normalOpen, pos, loc: nameAt(pos) });
  const mkLine = (id: string, from: string, to: string, feeder: string, path: LatLng[], ug: boolean, lateral = false, tie = false) =>
    addEl({ id, kind: 'line', from, to, feeder, len: dist(path[0], path[path.length - 1]), ug, lateral, tie, path });

  // register names for location strings
  setCampusNames(el);

  const itemNode: Record<string, string> = {}, nodeItem: Record<string, string> = {};
  for (const it of el) { const n = mkNode(itemPos(it), 'n:' + it.id); itemNode[it.id] = n; nodeItem[n] = it.id; }

  // clean link list: both ends electric & present, no duplicates / self-links
  const seen = new Set<string>();
  const links = cfg.links.filter(l => {
    if (!byId.has(l.a) || !byId.has(l.b) || l.a === l.b) return false;
    const k = l.a < l.b ? l.a + '|' + l.b : l.b + '|' + l.a;
    if (seen.has(k)) return false; seen.add(k); return true;
  });
  const adj = new Map<string, number[]>();
  for (const it of el) adj.set(it.id, []);
  links.forEach((l, i) => { adj.get(l.a)!.push(i); adj.get(l.b)!.push(i); });

  let srcId = cfg.source && byId.has(cfg.source) ? cfg.source : null;
  if (!srcId) srcId = (el.find(i => (i.components ?? []).some(c => /riser/i.test(c))) ?? el[0])?.id ?? null;

  // BFS tree from the source: first through normally-closed spans, then the rest
  const par = new Map<string, number>(); // item -> link index to parent
  const order: string[] = [];
  const treeLinks = new Set<number>();
  if (srcId) {
    const vis = new Set([srcId]); order.push(srcId);
    const grow = (allowNo: boolean) => {
      const q = [...order];
      for (let qi = 0; qi < q.length; qi++) {
        const u = q[qi];
        for (const li of adj.get(u)!) {
          const l = links[li]; const v = l.a === u ? l.b : l.a;
          if (vis.has(v) || (!allowNo && l.dev?.no)) continue;
          vis.add(v); par.set(v, li); treeLinks.add(li); order.push(v); q.push(v);
        }
      }
    };
    grow(false); grow(true);
  }
  const orphans = el.filter(i => i.id !== srcId && !par.has(i.id) && adj.get(i.id)!.length === 0).map(i => i.id);

  // Substation (yard source)
  const sPos = srcId ? itemPos(byId.get(srcId)!) : (el[0] ? itemPos(el[0]) : [33.193, -97.176] as LatLng);
  const subs = [{ id: 'NLC', name: 'NLC YARD', pos: offset(sPos, -14, 10), bus: sPos, mva: 5 }];
  const bus = srcId ? itemNode[srcId] : mkNode(sPos);
  T.subs.NLC = { id: 'NLC', name: 'NLC YARD', pos: subs[0].pos, bus, mva: 5, feeders: [] };

  // Feeders: one per span leaving the source
  const kids = new Map<string, string[]>();
  for (const v of order) { const li = par.get(v); if (li === undefined) continue; const l = links[li]; const u = l.a === v ? l.b : l.a; if (!kids.has(u)) kids.set(u, []); kids.get(u)!.push(v); }
  const feederOf = new Map<string, string>();
  const heads = srcId ? (kids.get(srcId) ?? []) : [];
  const headNode = new Map<string, string>();
  heads.forEach((h, k) => {
    const fid = `CKT-${k + 1}`;
    const info: FeederInfo = { id: fid, sub: 'NLC', color: FEEDER_COLORS[k % FEEDER_COLORS.length], ratingA: 200, length: 0, breaker: `CB-${k + 1}`, mainEls: [], end: '', sch: [], vertNodes: [], ties: [] };
    T.feeders[fid] = info; T.feederIds.push(fid); T.subs.NLC.feeders.push(fid);
    const hn = mkNode(lerp(sPos, itemPos(byId.get(h)!), 0.1));
    used.add(info.breaker);
    mkDev(info.breaker, bus, hn, fid, 'breaker', false, T.nodes[hn].pos);
    headNode.set(h, hn);
    const stack = [h];
    while (stack.length) { const x = stack.pop()!; feederOf.set(x, fid); for (const c of kids.get(x) ?? []) stack.push(c); }
  });
  if (!T.feederIds.length) {
    // no connections at all — keep the model valid with an empty circuit
    const fid = 'CKT-1';
    const hn = mkNode(offset(sPos, 6, 0));
    T.feeders[fid] = { id: fid, sub: 'NLC', color: FEEDER_COLORS[0], ratingA: 200, length: 1, breaker: 'CB-1', mainEls: [], end: hn, sch: [{ kind: 'dev', id: 'CB-1', f: 0, node: hn }], vertNodes: [], ties: [] };
    T.feederIds.push(fid); T.subs.NLC.feeders.push(fid); used.add('CB-1');
    mkDev('CB-1', bus, hn, fid, 'breaker', false, T.nodes[hn].pos);
  }

  // Spans → line sections + devices (tree links in BFS order so feeders are known)
  const devPrefix: Record<LinkDev, string> = { switch: 'S', fuse: 'F', recloser: 'R' };
  const linkEls: Record<number, string[]> = {};
  const childEntry = new Map<string, string>(); // child item -> node where its span arrives (for upstream lookups)
  const buildSpan = (li: number, pItem: string, cItem: string, fid: string, tie: boolean) => {
    const l = links[li];
    const pi = byId.get(pItem)!, ci = byId.get(cItem)!;
    const pp = itemPos(pi), cp = itemPos(ci);
    const from = pItem === srcId && headNode.has(cItem) ? headNode.get(cItem)! : itemNode[pItem];
    const fromPos = T.nodes[from].pos;
    const to = itemNode[cItem];
    const ug = !isPole(pi) || !isPole(ci);
    const lid = uniq(`${label(pi)}~${label(ci)}`);
    const els: string[] = [];
    const devType: DevType | null = tie ? 'tie' : l.dev ? l.dev.type : null;
    if (!devType) {
      mkLine(lid, from, to, fid, [fromPos, cp], ug, false, tie); els.push(lid);
    } else {
      const atChild = l.dev?.at ? l.dev.at === cItem : false;
      const did = uniq(l.dev?.id || (tie ? `T-${label(ci)}` : `${devPrefix[l.dev!.type]}-${label(atChild ? ci : pi)}`));
      const no = tie ? true : !!l.dev?.no;
      if (!atChild) {
        const m = mkNode(lerp(pp, cp, from !== itemNode[pItem] ? 0.34 : 0.16));
        mkDev(did, from, m, fid, devType, no, T.nodes[m].pos);
        mkLine(lid, m, to, fid, [T.nodes[m].pos, cp], ug, false, tie); els.push(did, lid);
      } else {
        const m = mkNode(lerp(pp, cp, 0.84));
        mkLine(lid, from, m, fid, [fromPos, T.nodes[m].pos], ug, false, tie);
        mkDev(did, m, to, fid, devType, no, T.nodes[m].pos); els.push(lid, did);
      }
      if (tie) T.ties.push(did);
    }
    linkEls[li] = els;
    void pp;
  };
  for (const v of order) {
    const li = par.get(v); if (li === undefined) continue;
    const l = links[li]; const u = l.a === v ? l.b : l.a;
    buildSpan(li, u, v, feederOf.get(v) ?? T.feederIds[0], false);
    childEntry.set(v, itemNode[v]);
  }
  // Non-tree spans → normally-open ties (or dead stubs if neither end is reachable)
  const tieInfo: { dev: string; a: string; b: string }[] = [];
  links.forEach((l, li) => {
    if (treeLinks.has(li)) return;
    const fa = feederOf.get(l.a) ?? (l.a === srcId ? T.feederIds[0] : undefined);
    const fb = feederOf.get(l.b) ?? (l.b === srcId ? T.feederIds[0] : undefined);
    const fid = fa ?? fb ?? T.feederIds[0];
    const [p, c] = fa ? [l.a, l.b] : [l.b, l.a];
    // a stub between two unreachable items is just a de-energized line
    const reachable = !!(fa || fb);
    buildSpan(li, p, c, fid, reachable);
    if (reachable) tieInfo.push({ dev: linkEls[li].find(x => T.els[x].kind === 'device')!, a: p, b: c });
  });

  // Loads: pad-mounts, pedestals and poles that carry a transformer
  for (const it of el) {
    if (!hasXfmr(it) && it.itemType !== 'pedestal') continue;
    const id = uniq(`TX-${label(it)}`);
    const pos = itemPos(it);
    const ln = mkNode(offset(pos, 2.5, -2.5));
    const fid = feederOf.get(it.id) ?? T.feederIds[0];
    mkDev(id, itemNode[it.id], ln, fid, 'xfmr', false, pos);
    const L: Load = { id, node: ln, feeder: fid, customers: 1, kwPer: it.itemType === 'pedestal' ? 6 : 20, cls: 'com', pos, xfmr: id, kva: it.itemType === 'pedestal' ? 25 : 75, addr: label(it) };
    T.loads[id] = L; T.loadIds.push(id);
  }

  T.switchable = T.devIds.filter(id => (T.els[id] as DevEl).type !== 'xfmr');

  // Normal-state tree (same as GRID OPS)
  const dev: Record<string, { open: boolean }> = {};
  for (const id of T.devIds) dev[id] = { open: (T.els[id] as DevEl).normalOpen };
  const net = solve(T, dev);
  for (const [n, p] of net.parent) T.normParent[n] = p;
  for (const [n, f] of net.src) T.normFeeder[n] = f;
  const upNode = (n: string): string | null => { const p = T.normParent[n]; if (!p) return null; const e = T.els[p]; return e.from === n ? e.to : e.from; };
  for (const id of T.devIds) { T.devLoads[id] = []; T.devCust[id] = 0; }
  for (const lid of T.loadIds) {
    const anc: string[] = [];
    let n: string | null = T.loads[lid].node;
    while (n) { const p = T.normParent[n]; if (p && T.els[p].kind === 'device') anc.push(p); n = upNode(n); }
    T.loadAnc[lid] = anc.length ? anc : [T.loads[lid].xfmr];
    for (const d of anc) { T.devLoads[d].push(lid); T.devCust[d] += T.loads[lid].customers; }
    T.totalCustomers += T.loads[lid].customers;
  }

  // Lateral marking: everything normally downstream of a fuse
  const downOf = (devId: string): string[] => {
    const d = T.els[devId] as DevEl;
    const start = T.normParent[d.to] === devId ? d.to : T.normParent[d.from] === devId ? d.from : null;
    if (!start) return [];
    const out: string[] = []; const st = [start];
    while (st.length) {
      const n = st.pop()!;
      for (const eid of T.adj[n]) { const e = T.els[eid]; const m = e.from === n ? e.to : e.from; if (T.normParent[m] === eid) { out.push(eid); st.push(m); } }
    }
    return out;
  };
  for (const id of T.devIds) {
    const d = T.els[id] as DevEl;
    if (d.type !== 'fuse') continue;
    const els = downOf(id);
    for (const x of els) { const e = T.els[x]; if (e.kind === 'line') e.lateral = true; }
    T.laterals[id] = { fuse: id, feeder: d.feeder, els: els.filter(x => T.els[x].kind === 'line'), loads: T.devLoads[id] ?? [], street: d.loc };
  }

  // Feeder schematics: main path = farthest point from the breaker
  for (const fid of T.feederIds) {
    const F = T.feeders[fid];
    const bk = T.els[F.breaker] as DevEl;
    const head = bk.to;
    const distTo = new Map<string, number>([[head, 0]]);
    const via = new Map<string, string>();
    const st = [head];
    while (st.length) {
      const n = st.pop()!;
      for (const eid of T.adj[n]) {
        const e = T.els[eid]; const m = e.from === n ? e.to : e.from;
        if (T.normParent[m] !== eid || distTo.has(m)) continue;
        const len = e.kind === 'line' ? e.len : 0;
        distTo.set(m, distTo.get(n)! + len); via.set(m, eid); st.push(m);
      }
    }
    let end = head, far = -1;
    for (const [n, d] of distTo) { if (T.els[via.get(n) ?? '']?.kind === 'device' && (T.els[via.get(n)!] as DevEl).type === 'xfmr') continue; if (d > far) { far = d; end = n; } }
    const path: string[] = [];
    for (let n = end; n !== head;) { const e = via.get(n)!; path.unshift(e); const x = T.els[e]; n = x.from === n ? x.to : x.from; }
    const L = Math.max(1, far);
    F.length = L; F.end = end; F.mainEls = path.filter(x => T.els[x].kind === 'line');
    const mainNodes = new Map<string, number>([[head, 0]]);
    const sch: SchItem[] = [{ kind: 'dev', id: F.breaker, f: 0, node: head }];
    let cur = head;
    for (const eid of path) {
      const e = T.els[eid]; const nxt = e.from === cur ? e.to : e.from;
      mainNodes.set(nxt, distTo.get(nxt)! / L);
      if (e.kind === 'device' && (e as DevEl).type !== 'xfmr') sch.push({ kind: 'dev', id: eid, f: Math.min(0.97, Math.max(0.03, distTo.get(nxt)! / L)), node: nxt });
      cur = nxt;
    }
    // fuse laterals off the main path
    const mainF = (n: string): { f: number; node: string } => {
      let x: string | null = n, g = 0;
      while (x && g++ < 5000) { if (mainNodes.has(x)) return { f: mainNodes.get(x)!, node: x }; x = upNode(x); }
      return { f: 0.5, node: head };
    };
    for (const lat of Object.values(T.laterals)) {
      if (lat.feeder !== fid) continue;
      const d = T.els[lat.fuse] as DevEl;
      if (path.includes(lat.fuse)) continue;
      const up = T.normParent[d.to] === lat.fuse ? d.from : d.to;
      const m = mainF(up);
      sch.push({ kind: 'lat', id: lat.fuse, f: Math.min(0.96, Math.max(0.04, m.f)), node: m.node });
    }
    F.sch = sch.sort((a, b) => a.f - b.f);
    F.vertNodes = [{ pos: T.nodes[head].pos, node: head }];
  }
  for (const t of tieInfo) {
    const d = T.els[t.dev] as DevEl;
    const fa = T.normFeeder[d.from] || d.feeder, fb = T.normFeeder[d.to] || fa;
    for (const fid of new Set([fa, fb])) {
      const F = T.feeders[fid]; if (!F) continue;
      F.ties.push(t.dev);
      const n = T.normFeeder[d.from] === fid ? d.from : d.to;
      let x: string | null = n, f = 0.5;
      const onMain = new Set<string>([T.els[F.breaker].to]);
      for (const e of F.mainEls) { onMain.add(T.els[e].from); onMain.add(T.els[e].to); }
      let g = 0;
      while (x && g++ < 5000) { if (onMain.has(x)) { f = x === F.end ? 1 : 0.5; break; } x = upNode(x); }
      F.sch.push({ kind: 'tie', id: t.dev, f: f >= 0.999 ? 1 : Math.min(0.95, f), node: n });
    }
  }
  for (const F of Object.values(T.feeders)) F.sch.sort((a, b) => a.f - b.f);

  // bounds / home
  const pts = items.map(itemPos);
  const lats = pts.map(p => p[0]), lngs = pts.map(p => p[1]);
  const bounds: [[number, number], [number, number]] = pts.length
    ? [[Math.min(...lats) - 0.0002, Math.min(...lngs) - 0.0002], [Math.max(...lats) + 0.0002, Math.max(...lngs) + 0.0002]]
    : [[sPos[0] - 0.002, sPos[1] - 0.002], [sPos[0] + 0.002, sPos[1] + 0.002]];
  const blds = items.filter(i => i.itemType === 'building');
  const home: LatLng = blds.length ? itemPos(blds.find(b => /^BLD/i.test(label(b))) ?? blds[0]) : offset(sPos, -25, 15);

  return { T, subs, home, bounds, items, orphans, grids, itemNode, nodeItem, cfg: { ...cfg, source: srcId } };
}

// ── Location names (used everywhere GRID OPS said "Bell and Eagle") ──
let NAMES: { pos: LatLng; name: string }[] = [];
export function setCampusNames(items: YardItem[]) { NAMES = items.map(i => ({ pos: itemPos(i), name: label(i) })); }
export function campusName(p: LatLng): string {
  let best = '', bd = Infinity;
  for (const n of NAMES) { const d = dist(p, n.pos); if (d < bd) { bd = d; best = n.name; } }
  if (!best) return 'NLC yard';
  return bd < 4 ? best : `near ${best}`;
}
