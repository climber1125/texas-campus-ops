// ─────────────────────────────────────────────────────────────
// GRID OPS simulation engine.
// Single source of truth: every UI panel reads from Engine.s and
// every operator action goes through an Engine method. All future
// activity lives in a time-ordered, serializable event queue so the
// run is deterministic for a given seed and can be saved/restored.
// ─────────────────────────────────────────────────────────────
import type {
  SimState, DevEl, Fault, Cause, Truck, Incident, Call, Request, SwitchingOrder, SwStep,
  LatLng, FeederReading, QItem, LogEntry, Clearance, WorkOrder, CrewStatus, LineEl, WoPriority,
} from './types';
import { TOPO } from './topology';
import { solve, pathToSource, sectionAround, faultNode, type NetState } from './network';
import { mulberry } from './rng';
import { dist, bearing, lerp } from './geo';
import { route, nearestName, SERVICE_CENTER } from './roads';
import { CONTROL, devWord, findingText, repairMinutes, CAUSE_TEXT } from './radio';
import { SCENARIOS, type ScenarioDef } from './scenarios';
import { parseRadio } from './voice';

export const START_EPOCH = new Date(2026, 9, 28, 14, 30, 0).getTime();
const CURVE = [0.52, 0.48, 0.46, 0.45, 0.46, 0.52, 0.62, 0.72, 0.78, 0.82, 0.86, 0.9, 0.93, 0.96, 0.98, 1.0, 1.0, 0.99, 0.95, 0.88, 0.8, 0.72, 0.64, 0.57];
const PROTECTIVE = ['xfmr', 'fuse', 'recloser', 'breaker'];
const CALL_RATE: Record<string, number> = { res: 0.12, apt: 0.08, com: 0.35, ind: 0.5, critical: 1 };

export const TRUCK_ROSTER: Record<string, { crew: string; type: string }> = {
  '230': { crew: 'Ruiz / Daniels', type: '55 ft bucket' },
  '233': { crew: 'Whitaker / Gomez', type: '45 ft bucket' },
  '235': { crew: 'Okafor / Brandt', type: 'Digger derrick' },
  '238': { crew: 'Tran / Mendez', type: '45 ft bucket' },
  '240': { crew: 'Hollis / Price', type: '55 ft bucket' },
  '242': { crew: 'Vega / Nunez', type: 'Troubleman pickup' },
};

const WO_TYPES: [string, number][] = [
  ['streetlight repair', 20], ['pole inspection', 25], ['new service connect', 35], ['meter set', 15],
  ['padmount inspection', 20], ['tree trim survey', 25], ['locate assist', 15], ['recloser battery check', 20],
];

export type Speaker = string; // 'C' = control, truck id, or '249'

export class Engine {
  T = TOPO;
  s: SimState;
  net: NetState;
  scen: ScenarioDef;
  readings: Record<string, FeederReading> = {};
  devKw: Record<string, number> = {};
  ver = 0;
  netVer = 0;
  private listeners = new Set<() => void>();
  private lastPeriodic = 0;
  private lastReadings = -99;
  private prevLoadEn = new Set<string>();
  private closeOntoTrips: string[] = [];
  /** Campus Ops live mode: real people, real time, no simulated faults or crew chatter. */
  get live() { return this.s.scenario === 'LIVE'; }

  constructor(s: SimState) {
    this.s = s;
    this.scen = SCENARIOS[s.scenario] ?? SCENARIOS.A;
    this.net = solve(this.T, this.s.dev);
    for (const lid of this.T.loadIds) if (this.net.en.has(this.T.loads[lid].node)) this.prevLoadEn.add(lid);
    this.lastPeriodic = s.t;
    this.computeReadings();
  }

  static create(scenarioId: string, seed: number): Engine {
    const T = TOPO;
    const dev: SimState['dev'] = {};
    for (const id of T.devIds) dev[id] = { open: (T.els[id] as DevEl).normalOpen, lockout: false, tags: [], comm: true, ops: 0 };
    const s: SimState = {
      version: 2, seed, scenario: scenarioId, t: 0, startEpoch: START_EPOCH, speed: 1, paused: false,
      rng: (seed * 2654435761) >>> 0 || 1, seq: 0, queue: [], dev, faults: {}, loadOutSince: {}, planned: {},
      trucks: {}, incidents: {}, calls: {}, callOrder: [], alarms: [], soe: [], radio: [], log: [], requests: [],
      orders: {}, clearances: {}, workorders: {},
      metrics: { cmi: 0, ci: 0, momentary: 0, violations: [], decisions: [], dispatchTimes: [], contacts: 0 },
      scen: { id: scenarioId, obj: {}, flags: {}, done: false, startT: 0, aarShown: false },
      autoAssist: false, weather: { text: 'Clear, 78°F, wind S 8 mph', level: 'normal' }, loopSince: null, ids: {},
    };
    if (scenarioId === 'LIVE') { s.startEpoch = Date.now(); s.weather = { text: 'LIVE · NLC campus · nothing energized', level: 'normal' }; }
    const e = new Engine(s);
    for (const o of e.scen.objectives) s.scen.obj[o.id] = { status: 'pending' };
    if (!e.live) for (let i = 0; i < 6; i++) e.newWorkOrder();
    e.scen.setup(e);
    for (const [g, mean] of Object.entries(e.scen.background)) if (mean) e.schedule(e.expo(mean) * 0.6 + 20, 'gen', { g });
    e.log('SYSTEM', 'info', e.live ? 'Campus Ops live log started.' : `Shift started — scenario ${e.scen.short}: ${e.scen.name}. Seed ${seed}.`);
    e.refresh();
    return e;
  }

  // ── Core plumbing ──────────────────────────────────────────
  subscribe(fn: () => void) { this.listeners.add(fn); return () => { this.listeners.delete(fn); }; }
  bump() { this.ver++; }
  notify() { for (const l of this.listeners) l(); }

  rand(): number { const [v, s] = mulberry(this.s.rng); this.s.rng = s; return v; }
  range(a: number, b: number) { return a + (b - a) * this.rand(); }
  pick<T>(arr: T[]): T { return arr[Math.floor(this.rand() * arr.length)]; }
  expo(mean: number) { return -Math.log(1 - this.rand()) * mean; }
  nextId(prefix: string, base: number) { const n = (this.s.ids[prefix] = (this.s.ids[prefix] ?? base) + 1); return `${prefix}-${n}`; }

  clock(t = this.s.t): Date { return new Date(this.s.startEpoch + t * 1000); }
  hhmm(t = this.s.t) { const d = this.clock(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; }
  hhmmss(t = this.s.t) { const d = this.clock(t); return `${this.hhmm(t)}:${String(d.getSeconds()).padStart(2, '0')}`; }
  hourOfDay() { const d = this.clock(); return d.getHours() + d.getMinutes() / 60; }

  schedule(dt: number, kind: string, data: any = {}) {
    const it: QItem = { t: this.s.t + Math.max(0, dt), seq: ++this.s.seq, kind, data };
    const q = this.s.queue;
    let lo = 0, hi = q.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (q[m].t < it.t || (q[m].t === it.t && q[m].seq < it.seq)) lo = m + 1; else hi = m; }
    q.splice(lo, 0, it);
  }

  /** Called from the UI loop with real elapsed milliseconds. */
  tick(realMs: number) {
    if (this.live) {
      const dt = (Date.now() - this.s.startEpoch) / 1000 - this.s.t;
      if (dt > 0) this.advance(dt);
      this.bump(); this.notify();
      return;
    }
    if (this.s.paused) return;
    const dt = Math.min(realMs, 250) / 1000 * this.s.speed;
    this.advance(dt);
    this.bump();
    this.notify();
  }

  advance(dt: number) {
    const end = this.s.t + dt;
    let guard = 0;
    while (this.s.queue.length && this.s.queue[0].t <= end && guard++ < 4000) {
      const it = this.s.queue.shift()!;
      this.s.t = Math.max(this.s.t, it.t);
      try { this.handle(it); } catch (err) { console.error('handler error', it, err); }
    }
    this.s.t = end;
    this.updateTrucks();
    if (this.s.t - this.lastPeriodic >= 1) {
      const pdt = this.s.t - this.lastPeriodic;
      this.lastPeriodic = this.s.t;
      this.periodic(pdt);
    }
  }

  // ── Session controls (routed as actions so linked windows can use them) ──
  setTutStep(n: number) { this.s.scen.flags.tutStep = n; this.bump(); }
  setSpeed(x: number) { this.s.speed = x; this.s.paused = false; this.bump(); }
  setPaused(p: boolean) { this.s.paused = p; this.bump(); }
  setAutoAssist(on: boolean) { this.s.autoAssist = on; this.decision(`Auto-assist ${on ? 'ON' : 'OFF'}`); this.bump(); }
  /** Id the next newOrder() will get (lets a linked window select it before the main window replies). */
  peekId(prefix: string, base: number) { return `${prefix}-${(this.s.ids[prefix] ?? base) + 1}`; }

  // ── Replica sync (linked monitor windows) ──────────────────
  private devSig = '';
  syncFrom(s: SimState, readings: Record<string, FeederReading>, devKw: Record<string, number>) {
    this.s = s;
    this.scen = SCENARIOS[s.scenario] ?? SCENARIOS.A;
    let sig = '';
    for (const id of this.T.switchable) sig += s.dev[id].open ? '1' : '0';
    if (sig !== this.devSig) { this.devSig = sig; this.net = solve(this.T, s.dev); this.netVer++; }
    this.readings = readings; this.devKw = devKw;
    this.bump(); this.notify();
  }

  // ── Logging ────────────────────────────────────────────────
  log(cat: LogEntry['cat'], level: LogEntry['level'], text: string) {
    this.s.log.push({ id: ++this.s.seq, t: this.s.t, cat, level, text });
    if (this.s.log.length > 600) this.s.log.splice(0, this.s.log.length - 600);
  }
  soe(text: string, kind: SimState['soe'][number]['kind'], dev?: string, t = this.s.t) {
    this.s.soe.push({ t, text, kind, dev });
    if (this.s.soe.length > 500) this.s.soe.splice(0, this.s.soe.length - 500);
  }
  alarm(key: string, text: string, pri: 1 | 2 | 3, dev?: string) {
    if (this.s.alarms.some(a => a.key === key && a.active)) return;
    this.s.alarms.push({ id: 'A' + (++this.s.seq), key, t: this.s.t, text, pri, dev, acked: false, active: true });
    if (this.s.alarms.length > 300) this.s.alarms.splice(0, this.s.alarms.length - 300);
    this.soe(text, 'alarm', dev);
    this.log('SCADA', pri === 1 ? 'alarm' : 'warn', text);
  }
  clearAlarm(key: string) {
    for (const a of this.s.alarms) if (a.key === key && a.active) { a.active = false; this.soe(`RTN — ${a.text}`, 'info', a.dev); }
  }
  ackAlarm(id: string) { const a = this.s.alarms.find(x => x.id === id); if (a && !a.acked) { a.acked = true; this.decision(`Acknowledged alarm: ${a.text}`); } this.bump(); }
  ackAll() { let n = 0; for (const a of this.s.alarms) if (!a.acked) { a.acked = true; n++; } if (n) this.decision(`Acknowledged ${n} alarm(s)`); this.bump(); }
  decision(text: string, good?: boolean) { this.s.metrics.decisions.push({ t: this.s.t, text, good }); }
  violation(code: string, text: string) {
    this.s.metrics.violations.push({ t: this.s.t, code, text });
    this.log('SAFETY', 'alarm', `SAFETY: ${text}`);
    this.decision(`VIOLATION — ${text}`, false);
  }

  // ── Radio ──────────────────────────────────────────────────
  speaker(sp: Speaker) { return sp === 'C' ? CONTROL : sp === '249' ? 'SUPERVISOR 249' : this.live ? (this.s.trucks[sp]?.crew || sp).toUpperCase() : `TRUCK ${sp}`; }
  /** True while handling the operator's own voice transmission: Control lines are not generated (the operator said them). */
  voiced = false;
  /** When set, crew replies are captured here instead of being sent (so an AI can word them). */
  holdBuf: { sp: Speaker; text: string; kind: 'routine' | 'switching' | 'emergency'; unit: string }[] | null = null;
  say(lines: [Speaker, string][], opts: { kind?: 'routine' | 'switching' | 'emergency'; start?: number; unit?: string } = {}): number {
    if (this.live) return 0;
    let at = opts.start ?? 0;
    if (this.voiced) lines = lines.filter(l => l[0] !== 'C');
    else if (this.s.voiceRadio) lines = lines.filter(l => l[0] !== 'C' || !/^(Copy|That's correct)/.test(l[1])); // operator gives their own acknowledgments
    const unit = opts.unit ?? (lines.find(l => l[0] !== 'C')?.[0] ?? '');
    if (this.holdBuf) { for (const [sp, text] of lines) this.holdBuf.push({ sp, text, kind: opts.kind ?? 'routine', unit }); return 0; }
    for (const [sp, text] of lines) {
      this.schedule(at, 'radio', { sp, text, kind: opts.kind ?? 'routine', unit });
      at += 2.2 + text.length / 20;
    }
    return at;
  }
  private radioNow(sp: Speaker, text: string, kind: 'routine' | 'switching' | 'emergency' | 'system' | 'operator', unit: string) {
    if (sp !== 'C' && sp !== '249' && this.s.trucks[sp] && !this.s.trucks[sp].comm) return; // no TX from a unit without comms
    this.s.radio.push({ id: ++this.s.seq, t: this.s.t, from: this.speaker(sp), to: '', text, kind, unit });
    if (this.s.radio.length > 400) this.s.radio.splice(0, this.s.radio.length - 400);
  }

  // ── Network ────────────────────────────────────────────────
  dev(id: string) { return this.T.els[id] as DevEl; }
  loadEn(lid: string) { return this.net.en.has(this.T.loads[lid].node); }
  nodeEn(n: string) { return this.net.en.has(n); }
  elEnergized(id: string) { const el = this.T.els[id]; return this.net.en.has(el.from) && this.net.en.has(el.to); }

  refresh() {
    for (let i = 0; i < 6; i++) {
      this.net = solve(this.T, this.s.dev);
      let tripped = false;
      for (const f of Object.values(this.s.faults)) {
        if (f.active && f.permanent && this.net.en.has(faultNode(this.T, f.el, f.onLoad))) { this.protect(f, true); tripped = true; }
      }
      if (!tripped) break;
    }
    this.netVer++;
    const now = new Set<string>();
    const out: string[] = [], back: string[] = [];
    for (const lid of this.T.loadIds) {
      if (this.net.en.has(this.T.loads[lid].node)) { now.add(lid); if (!this.prevLoadEn.has(lid)) back.push(lid); }
      else if (this.prevLoadEn.has(lid)) out.push(lid);
    }
    this.prevLoadEn = now;
    if (out.length) this.onLoadsOut(out);
    if (back.length) this.onLoadsBack(back);
    this.computeReadings();
  }

  /** First open device on the normal path from load to source (what actually interrupted it). */
  outageDevice(lid: string): string | null {
    // Nearest protective operation wins; otherwise the furthest-upstream open device.
    let far: string | null = null;
    for (const d of this.T.loadAnc[lid]) if (this.s.dev[d].open) { if (this.s.dev[d].tripFault) return d; far = d; }
    return far;
  }

  /** Lowest common device ancestor of a set of loads (OMS roll-up prediction). */
  predict(loads: string[]): string {
    const uniq = [...new Set(loads)];
    if (uniq.length < 2) return this.T.loadAnc[uniq[0]][0];
    const sets = uniq.slice(1).map(l => new Set(this.T.loadAnc[l]));
    for (const d of this.T.loadAnc[uniq[0]]) if (sets.every(s => s.has(d))) return d;
    return this.T.loadAnc[uniq[0]].at(-1)!;
  }

  // ── Faults & protection ────────────────────────────────────
  createFault(el: string, onLoad: boolean, cause: Cause, permanent: boolean, hazard = false): Fault {
    const id = this.nextId('FLT', 100);
    const pos: LatLng = onLoad ? this.T.loads[el].pos : (() => { const p = (this.T.els[el] as LineEl).path; return lerp(p[0], p[p.length - 1], 0.5); })();
    const f: Fault = { id, el, onLoad, cause, permanent, active: true, found: false, t: this.s.t, pos, hazard, desc: CAUSE_TEXT[cause] };
    this.s.faults[id] = f;
    return f;
  }

  applyFault(f: Fault) {
    const node = faultNode(this.T, f.el, f.onLoad);
    if (!this.net.en.has(node)) return; // latent until energized
    this.protect(f, false);
    this.refresh();
  }

  /** Protective device response. Sets device state; caller refreshes. */
  protect(f: Fault, closeOnto: boolean) {
    const node = faultNode(this.T, f.el, f.onLoad);
    const path = pathToSource(this.T, this.net, node);
    const devs = path.filter(id => this.T.els[id].kind === 'device');
    const prot = devs.find(id => PROTECTIVE.includes(this.dev(id).type));
    if (!prot) return;
    const d = this.dev(prot);
    const st = this.s.dev[prot];
    if (!f.permanent && !closeOnto) {
      const rc = devs.find(id => ['recloser', 'breaker'].includes(this.dev(id).type));
      f.active = false;
      if (!rc) return;
      this.soe(`${rc} TRIP — ${f.cause === 'lightning' ? 'GND' : 'PH-B'} INST`, 'trip', rc);
      this.soe(`${rc} RECLOSE SHOT 1 — SUCCESSFUL`, 'reclose', rc, this.s.t + 0.6);
      this.s.dev[rc].ops++;
      const cust = this.T.devCust[rc];
      this.s.metrics.momentary += cust;
      this.log('SCADA', 'info', `${rc} momentary operation (${f.cause === 'lightning' ? 'lightning' : 'temporary fault'}) — reclosed successfully. ~${cust} customers blinked.`);
      const n = Math.min(3, 1 + Math.floor(this.rand() * 3));
      const loads = this.T.devLoads[rc];
      for (let i = 0; i < n && loads.length; i++) this.schedule(30 + this.rand() * 180, 'call', { load: this.pick(loads), kind: 'momentary' });
      return;
    }
    st.open = true; st.tripFault = f.id; st.ops++; st.lastT = this.s.t;
    if (closeOnto) this.closeOntoTrips.push(f.id);
    if (d.type === 'recloser' || d.type === 'breaker') {
      if (closeOnto) {
        st.lockout = true;
        this.soe(`${prot} TRIP — CLOSE INTO FAULT — LOCKOUT`, 'trip', prot);
        this.alarm(`lockout:${prot}`, `${prot} ${d.feeder} LOCKOUT (close into fault)`, 1, prot);
        this.scadaIncident(prot);
      } else if (st.nonReclose) {
        st.lockout = true;
        this.soe(`${prot} TRIP — NON-RECLOSE (HOT-LINE TAG) — LOCKOUT`, 'trip', prot);
        this.alarm(`lockout:${prot}`, `${prot} ${d.feeder} LOCKOUT — non-reclose trip, ${this.T.devCust[prot]} customers`, 1, prot);
        this.scadaIncident(prot);
        this.scen.event?.(this, 'nrTrip', { dev: prot, fault: f.id });
      } else {
        this.soe(`${prot} TRIP — PH-B 51/50 — SHOT 0`, 'trip', prot);
        this.alarm(`trip:${prot}`, `${prot} ${d.feeder} TRIP — reclosing in progress`, 2, prot);
        this.schedule(2, 'reclose', { dev: prot, shot: 1, fault: f.id });
      }
    } else {
      this.log('OMS', 'info', `Model: ${prot} operated (${f.desc}) — not SCADA monitored.`);
    }
  }

  private handleReclose(dev: string, shot: number, fid: string) {
    const st = this.s.dev[dev];
    if (!st.open || st.lockout || st.tripFault !== fid) return;
    const f = this.s.faults[fid];
    this.soe(`${dev} RECLOSE SHOT ${shot}`, 'reclose', dev);
    if (!f.active) {
      st.open = false; st.tripFault = undefined;
      this.soe(`${dev} RECLOSE SUCCESSFUL`, 'close', dev);
      this.clearAlarm(`trip:${dev}`);
      this.refresh();
      return;
    }
    this.scen.event?.(this, 'recloseOnFault', { dev, fault: fid, shot });
    this.soe(`${dev} TRIP — SHOT ${shot}`, 'trip', dev, this.s.t + 0.2);
    st.ops++;
    if (shot < 2) { this.schedule(15, 'reclose', { dev, shot: shot + 1, fault: fid }); return; }
    st.lockout = true;
    this.clearAlarm(`trip:${dev}`);
    this.soe(`${dev} LOCKOUT`, 'trip', dev, this.s.t + 0.3);
    this.alarm(`lockout:${dev}`, `${dev} ${this.dev(dev).feeder} LOCKOUT — ${this.T.devCust[dev]} customers`, 1, dev);
    this.scadaIncident(dev);
  }

  /** Operate a device (operator SCADA, field crew, or protection-independent). */
  operate(id: string, action: 'open' | 'close', ctx: { by: string; loopOk?: boolean; order?: string }): { ok: boolean; reason?: string } {
    const d = this.dev(id);
    const st = this.s.dev[id];
    if (!d || !st) return { ok: false, reason: `Unknown device ${id}` };
    const wantOpen = action === 'open';
    if (st.open === wantOpen) return { ok: false, reason: `${id} is already ${wantOpen ? 'open' : 'closed'}` };
    if (!wantOpen && st.tags.length) {
      this.violation('tag', `Attempted to close ${id} while tagged under ${st.tags.join(', ')}`);
      return { ok: false, reason: `${id} carries HOLD tag ${st.tags.join(', ')} — close blocked` };
    }
    if (ctx.by === 'SCADA') {
      if (!d.scada) return { ok: false, reason: `${id} is not SCADA controllable — requires a field crew` };
      if (!st.comm) return { ok: false, reason: `${id} SCADA communication failure — control unavailable` };
    }
    if (!wantOpen) {
      const trial = { ...this.s.dev, [id]: { ...st, open: false } };
      const n2 = solve(this.T, trial);
      if (n2.loops.length > this.net.loops.length && !ctx.loopOk) {
        return { ok: false, reason: `Closing ${id} would parallel ${n2.parallelSubs ? 'two substation sources' : 'two feeders'} — loop closures only as a LOOP step of an active switching order` };
      }
    }
    st.open = wantOpen; st.ops++; st.lastT = this.s.t;
    if (!wantOpen) { st.lockout = false; st.tripFault = undefined; this.clearAlarm(`lockout:${id}`); this.clearAlarm(`trip:${id}`); }
    const who = ctx.by === 'SCADA' ? 'SCADA' : ctx.by === 'model' ? 'model' : this.live ? (ctx.by === 'Operator' ? 'recorded by operator' : `field, ${this.s.trucks[ctx.by]?.crew ?? ctx.by}`) : `field, Truck ${ctx.by}`;
    this.soe(`${id} ${wantOpen ? 'OPEN' : 'CLOSE'} (${who})`, wantOpen ? 'open' : 'close', id);
    this.log(ctx.by === 'SCADA' ? 'SCADA' : 'DISPATCH', 'info', `${id} ${wantOpen ? 'opened' : 'closed'} — ${who}${ctx.order ? ` (${ctx.order})` : ''}`);
    this.closeOntoTrips = [];
    this.refresh();
    for (const fid of this.closeOntoTrips) {
      const f = this.s.faults[fid];
      if (f.found) this.violation('energize-fault', `Energized known faulted section (${f.desc}) by closing ${id}`);
      else this.decision(`Closed ${id} into an unlocated fault — protection re-tripped`, false);
    }
    return { ok: true };
  }

  /** What-if for a device operation (used by select-before-operate dialogs). */
  preview(id: string, action: 'open' | 'close') {
    const st = this.s.dev[id];
    const trial = { ...this.s.dev, [id]: { ...st, open: action === 'open' } };
    const n2 = solve(this.T, trial);
    let lose = 0, gain = 0, critLose = 0;
    for (const lid of this.T.loadIds) {
      const L = this.T.loads[lid];
      const was = this.net.en.has(L.node), now = n2.en.has(L.node);
      if (was && !now) { lose += L.customers; if (L.cls === 'critical') critLose++; }
      if (!was && now) gain += L.customers;
    }
    let knownFault = false, unknownFault = false;
    for (const f of Object.values(this.s.faults)) {
      if (!f.active || !f.permanent) continue;
      const n = faultNode(this.T, f.el, f.onLoad);
      if (n2.en.has(n) && !this.net.en.has(n)) { if (f.found) knownFault = true; else unknownFault = true; }
    }
    const loop = n2.loops.length > this.net.loops.length;
    return { lose, gain, critLose, loop, parallelSubs: n2.parallelSubs, knownFault, unknownFault, tagged: st.tags };
  }

  /** Operator SCADA control (select-before-operate confirmed in UI). */
  scadaControl(id: string, action: 'open' | 'close', order?: string, loopOk = false) {
    const r = this.operate(id, action, { by: 'SCADA', order, loopOk });
    if (r.ok) this.decision(`SCADA ${action.toUpperCase()} ${id}${order ? ` (${order})` : ' (direct control)'}`);
    else this.log('SCADA', 'warn', `Control rejected: ${r.reason}`);
    this.bump();
    return r;
  }

  // ── Loads out / back ───────────────────────────────────────
  private onLoadsOut(lids: string[]) {
    const devs = new Set<string>();
    for (const lid of lids) {
      const L = this.T.loads[lid];
      this.s.loadOutSince[lid] = this.s.t;
      if (this.s.planned[lid] || this.live) continue;
      this.s.metrics.ci += L.customers;
      const od = this.outageDevice(lid);
      if (od) devs.add(od);
      const mult = this.s.scen.flags.callMult ?? 1;
      const p = (CALL_RATE[L.cls] ?? 0.12) * mult;
      let n = 0;
      for (let i = 0; i < L.customers; i++) if (this.rand() < p) n++;
      if (L.cls === 'critical') n = 1;
      for (let i = 0; i < n; i++) {
        const delay = L.cls === 'critical' ? 20 + this.rand() * 40 : 35 + this.expo(220);
        this.schedule(delay, 'call', { load: lid, kind: 'outage', epoch: this.s.t });
      }
    }
    if (!this.live) for (const d of devs) this.schedule(150 + this.rand() * 90, 'ami', { dev: d });
  }

  private onLoadsBack(lids: string[]) {
    for (const lid of lids) delete this.s.loadOutSince[lid];
  }

  // ── OMS ────────────────────────────────────────────────────
  openIncidents() { return Object.values(this.s.incidents).filter(i => i.status !== 'Closed'); }

  private scadaIncident(dev: string) {
    const ex = this.openIncidents().find(i => i.truthDev === dev);
    if (ex) { ex.timeline.push({ t: this.s.t, text: `SCADA: ${dev} locked out` }); if (ex.status === 'Restored') ex.status = 'New'; return ex; }
    return this.createIncident('SCADA', dev, dev);
  }

  createIncident(source: Incident['source'], truthDev: string | null, predDev: string, kind: Incident['kind'] = 'outage', loadId?: string): Incident {
    const id = this.nextId('INC', 4100);
    const d = this.dev(predDev);
    const inc: Incident = {
      id, t: this.s.t, kind, source, truthDev, predDev, feeder: d.feeder, loadId, status: 'New', priority: 3,
      critical: false, hazard: false, calls: [], callLoads: [], crew: null, crewHistory: [], etr: null, cause: null,
      faults: [], timeline: [{ t: this.s.t, text: `Incident created (${source}) — predicted device ${predDev}` }],
      custOut: 0, peak: 0, stage: 'Assess', isolation: [], firstDispatchT: null, restoredT: null, closedT: null, onSceneT: null, cmi: 0,
    };
    if (truthDev && this.s.dev[truthDev].tripFault) inc.faults.push(this.s.dev[truthDev].tripFault!);
    this.s.incidents[id] = inc;
    this.updateIncident(inc);
    inc.peak = inc.custOut;
    this.log('OMS', inc.priority === 1 ? 'alarm' : 'warn',
      kind === 'single' ? `${id} single-customer no-power — ${this.T.loads[loadId!].addr}` :
        `${id} created — ${predDev} on ${inc.feeder}, ~${inc.custOut} customers out (${source})`);
    return inc;
  }

  private onCall(lid: string, kind: Call['kind'], epoch?: number) {
    const L = this.T.loads[lid];
    if (kind === 'outage' && (this.loadEn(lid) || this.s.loadOutSince[lid] !== epoch)) return;
    const f = kind === 'outage' ? this.faultForLoad(lid) : undefined;
    const hazard = !!(f && f.hazard && dist(f.pos, L.pos) < 450 && this.rand() < 0.5);
    const remark = this.callRemark(kind, L.cls, f, hazard);
    const call: Call = { id: this.nextId('C', 5000), t: this.s.t, load: lid, pos: L.pos, addr: L.name ?? L.addr, remark, hazard, incident: null, kind };
    this.s.calls[call.id] = call;
    this.s.callOrder.push(call.id);
    if (this.s.callOrder.length > 500) { const old = this.s.callOrder.shift()!; delete this.s.calls[old]; }
    if (kind === 'momentary') return;
    if (kind === 'single') {
      const inc = this.createIncident('Calls', null, L.xfmr, 'single', lid);
      inc.calls.push(call.id); call.incident = inc.id; inc.custOut = 1; inc.peak = 1;
      return;
    }
    const od = this.outageDevice(lid);
    let inc = this.openIncidents().find(i => i.kind === 'outage' && i.truthDev === od);
    if (!inc && od && !this.s.dev[od].tripFault) {
      // Interrupted by switching (no protective op): belongs to the incident upstream of it
      const anc = this.T.loadAnc[lid];
      inc = this.openIncidents().filter(i => i.kind === 'outage' && i.truthDev && anc.includes(i.truthDev))
        .sort((a, b) => anc.indexOf(a.truthDev!) - anc.indexOf(b.truthDev!))[0];
    }
    if (!inc) inc = this.createIncident('Calls', od, L.xfmr);
    inc.calls.push(call.id); inc.callLoads.push(lid); call.incident = inc.id;
    if (hazard) { inc.hazard = true; inc.timeline.push({ t: this.s.t, text: `HAZARD reported: ${remark}` }); this.log('OMS', 'alarm', `${inc.id} HAZARD — ${remark} (${call.addr})`); }
    if (L.cls === 'critical') inc.timeline.push({ t: this.s.t, text: `Critical customer call: ${L.name}` });
    if (inc.source === 'Calls') {
      const np = this.predict(inc.callLoads);
      if (np !== inc.predDev) { inc.timeline.push({ t: this.s.t, text: `Prediction rolled up ${inc.predDev} → ${np} (${new Set(inc.callLoads).size} calls)` }); inc.predDev = np; }
    }
    this.updateIncident(inc);
  }

  private faultForLoad(lid: string): Fault | undefined {
    const od = this.outageDevice(lid);
    const fid = od ? this.s.dev[od].tripFault : undefined;
    return fid ? this.s.faults[fid] : undefined;
  }

  private callRemark(kind: Call['kind'], cls: string, f: Fault | undefined, hazard: boolean): string {
    if (kind === 'momentary') return this.pick(['Lights blinked a couple of times', 'Power flickered, clocks reset', 'Brief flicker, power is on']);
    if (kind === 'single') return this.pick(['No power at residence, neighbors have power', 'Half the house is out, lights dim', 'Power out at meter, neighbors on']);
    if (cls === 'critical') return 'Facility lost utility power — on emergency generator, requesting ETR';
    if (hazard) return this.pick(['Wire down in the street, arcing', 'Line on the ground near the sidewalk', 'Power line down across driveway']);
    const c = f?.cause;
    const pool = ['No power', 'Power out, neighbors out too', 'Whole street is dark'];
    if (c === 'animal' || c === 'xfmr_failure' || c === 'insulator') pool.push('Heard a loud boom, then lights went out', 'Saw a flash on the pole');
    if (c === 'tree_lateral' || c === 'tree_primary') pool.push('Tree limb in the lines', 'Lights went out during the wind');
    if (c === 'vehicle') pool.push('Car hit a power pole');
    return this.pick(pool);
  }

  updateIncident(inc: Incident) {
    if (inc.status === 'Closed') return;
    if (inc.kind === 'single') { inc.priority = 3; return; }
    const dev = inc.truthDev ?? inc.predDev;
    if (inc.truthDev && this.s.dev[inc.truthDev].tripFault) {
      const fid = this.s.dev[inc.truthDev].tripFault!;
      if (!inc.faults.includes(fid)) inc.faults.push(fid);
    }
    for (const fid of inc.faults) this.s.faults[fid].incident = inc.id;
    let out = 0, crit = false;
    for (const lid of this.T.devLoads[dev] ?? []) {
      if (!this.loadEn(lid)) { out += this.T.loads[lid].customers; if (this.T.loads[lid].cls === 'critical') crit = true; }
    }
    inc.custOut = out;
    inc.peak = Math.max(inc.peak, out);
    inc.critical = inc.critical || crit;
    if (inc.faults.some(fid => this.s.faults[fid].hazard && this.s.faults[fid].found)) inc.hazard = true;
    const pri: 1 | 2 | 3 = inc.critical || inc.hazard || inc.peak >= 500 ? 1 : inc.peak >= 50 ? 2 : 3;
    if (pri < inc.priority) inc.priority = pri;
    if (inc.status === 'Restored' && out > 0) { inc.status = inc.crew ? 'On Scene' : 'New'; inc.restoredT = null; inc.stage = 'Assess'; inc.timeline.push({ t: this.s.t, text: 'Customers interrupted again' }); }
    const repaired = inc.faults.every(fid => !this.s.faults[fid].active);
    if (out === 0 && repaired && inc.status !== 'Restored') {
      inc.status = 'Restored'; inc.restoredT = this.s.t; inc.stage = 'Verify';
      inc.timeline.push({ t: this.s.t, text: 'All customers restored — awaiting verification' });
      this.log('OMS', 'good', `${inc.id} restored — ${inc.peak} customers back on`);
      if (inc.crew) this.releaseCrewFromIncident(inc);
      if (this.s.autoAssist) this.schedule(120, 'autoVerify', { inc: inc.id });
    }
  }

  verifyIncident(id: string) {
    const inc = this.s.incidents[id];
    if (!inc || inc.status !== 'Restored') return 'Incident is not in Restored state';
    inc.status = 'Closed'; inc.closedT = this.s.t; inc.stage = 'Done';
    inc.timeline.push({ t: this.s.t, text: 'Restoration verified (AMI ping + callback) — incident closed' });
    this.log('OMS', 'good', `${id} verified and closed`);
    this.decision(`Verified restoration and closed ${id}`, true);
    this.bump();
    return null;
  }

  // ── Crews / dispatch ───────────────────────────────────────
  truck(id: string) { return this.s.trucks[id]; }

  addTruck(id: string, pos: LatLng, status: CrewStatus = 'Available') {
    const r = TRUCK_ROSTER[id] ?? { crew: 'Crew', type: 'Bucket' };
    this.s.trucks[id] = { id, crew: r.crew, type: r.type, pos, heading: 0, status, route: null, task: null, tok: 0, comm: true, home: SERVICE_CENTER, sw: null, waitIso: null, clearance: null };
    return this.s.trucks[id];
  }

  startRoute(tr: Truck, dest: LatLng, purpose: string, slow = 1) {
    const r = route(tr.pos, dest);
    const tok = ++this.s.seq;
    tr.route = { pts: r.pts, cumT: r.cumT.map(x => x * slow), total: r.total * slow, t0: this.s.t, tok, purpose };
    this.schedule(r.total * slow, 'arrive', { truck: tr.id, tok, purpose });
    return r.total * slow;
  }

  private updateTrucks() {
    for (const tr of Object.values(this.s.trucks)) {
      const r = tr.route;
      if (!r) continue;
      const el = this.s.t - r.t0;
      if (el >= r.total) { tr.pos = r.pts[r.pts.length - 1]; continue; }
      let i = 1;
      while (i < r.cumT.length - 1 && r.cumT[i] < el) i++;
      const seg = r.cumT[i] - r.cumT[i - 1];
      const f = seg > 0 ? (el - r.cumT[i - 1]) / seg : 1;
      tr.pos = lerp(r.pts[i - 1], r.pts[i], Math.max(0, Math.min(1, f)));
      if (dist(r.pts[i - 1], r.pts[i]) > 2) tr.heading = bearing(r.pts[i - 1], r.pts[i]);
    }
  }

  eta(tr: Truck): number | null { return tr.route ? tr.route.t0 + tr.route.total : null; }
  locOf(p: LatLng) { return nearestName(p); }

  incidentTarget(inc: Incident): LatLng {
    const d = this.dev(inc.predDev);
    if (d.type === 'breaker') return this.T.nodes[this.T.feeders[d.feeder].sch[1]?.node ?? d.to].pos;
    return d.pos;
  }

  incidentPhrase(inc: Incident): string {
    const d = this.dev(inc.predDev);
    if (inc.kind === 'single') return `a single-customer no-power at ${this.T.loads[inc.loadId!].addr}`;
    if (inc.hazard) return `a reported wire down near ${d.loc}`;
    if (d.type === 'breaker') return `a feeder lockout on ${d.feeder}, breaker ${d.id} locked out`;
    if (d.type === 'recloser') return `recloser ${d.id} locked out on ${d.feeder}, near ${d.loc}`;
    if (d.type === 'xfmr') return `a reported outage near ${d.loc}. Possible transformer problem at ${d.id}`;
    if (d.type === 'fuse') return `a reported outage near ${d.loc}. Predicted lateral fuse ${d.id}`;
    return `a reported outage near ${d.loc}`;
  }

  /** Operator dispatches a truck to an incident. Returns an error string or null. */
  dispatch(truckId: string, incId: string, auto = false): string | null {
    const tr = this.truck(truckId), inc = this.s.incidents[incId];
    if (!tr || !inc) return 'Unknown unit or incident';
    if (inc.status === 'Closed' || inc.status === 'Restored') return 'Incident already restored';
    if (tr.status === 'Off Duty') return `${truckId} is off duty`;
    if (tr.clearance) return `${truckId} holds clearance ${tr.clearance} — cannot reassign`;
    if (tr.sw) return `${truckId} is performing switching`;
    if (tr.task?.kind === 'incident' && tr.task.id === incId) return `${truckId} already assigned`;
    if (!tr.comm) {
      this.say([['C', `Truck ${truckId}, Campus Control.`]], { unit: truckId });
      this.schedule(14, 'noResponse', { truck: truckId });
      this.s.metrics.contacts++;
      return `No response from ${truckId}`;
    }
    const prevWo = tr.task?.kind === 'workorder' ? tr.task.id : null;
    if (prevWo) this.s.workorders[prevWo].status = 'Open';
    if (tr.task?.kind === 'incident') { const old = this.s.incidents[tr.task.id]; if (old && old.crew === truckId) { old.crew = null; old.status = 'New'; } }
    tr.task = { kind: 'incident', id: incId, stage: 'dispatched' };
    tr.tok++; tr.route = null; tr.status = 'Dispatched'; tr.waitIso = null;
    inc.crew = truckId; inc.crewHistory.push(truckId); inc.status = 'Dispatched';
    inc.timeline.push({ t: this.s.t, text: `${auto ? 'Auto-dispatch' : 'Dispatched'} Truck ${truckId}` });
    if (inc.firstDispatchT === null) { inc.firstDispatchT = this.s.t; this.s.metrics.dispatchTimes.push(this.s.t - inc.t); }
    this.decision(`${auto ? '[Auto-assist] ' : ''}Dispatched Truck ${truckId} to ${incId} (P${inc.priority}, ${inc.custOut} out)`);
    const calls = inc.calls.length;
    const hint = inc.calls.map(c => this.s.calls[c]?.remark).find(r => r && /boom|flash|limb|wire|car/i.test(r));
    const detail = `${this.incidentPhrase(inc)}. ${inc.custOut ? `${inc.custOut} customer${inc.custOut === 1 ? '' : 's'} out` : ''}${calls ? `, ${calls} call${calls === 1 ? '' : 's'}` : ''}.${hint ? ` Caller reports: ${hint.toLowerCase()}.` : ''}`;
    const end = this.voiced
      ? this.say([[truckId, `${truckId} copies${prevWo ? `, breaking off ${prevWo}` : ''}, responding to ${inc.id}${this.dev(inc.predDev)?.loc ? `, ${this.dev(inc.predDev).loc}` : ''}. En route.`]], { kind: inc.priority === 1 ? 'emergency' : 'routine', unit: truckId }) + 2
      : this.say([
      ['C', `Truck ${truckId}, Campus Control.`],
      [truckId, `${truckId}, go ahead.`],
      ['C', `${truckId}, respond to ${detail} ${inc.id}.`],
      [truckId, prevWo ? `${truckId} copies, breaking off ${prevWo}, en route.` : `${truckId} copies. En route.`],
      ['C', `Copy, ${truckId}. Advise when you're on location.`],
    ], { kind: inc.priority === 1 ? 'emergency' : 'routine', unit: truckId });
    this.schedule(end - 3, 'crew', { truck: truckId, tok: tr.tok, step: 'depart' });
    this.bump();
    return null;
  }

  private releaseCrewFromIncident(inc: Incident) {
    const tr = inc.crew ? this.truck(inc.crew) : null;
    if (!tr || tr.task?.kind !== 'incident' || tr.task.id !== inc.id) return;
    if (tr.clearance || tr.sw) return;
    if (tr.task.stage === 'closing') return; // crew handles its own report
    this.say([
      ['C', `Truck ${tr.id}, Campus Control. Customers are restored on ${inc.id}. You're clear, thank you.`],
      [tr.id, `${tr.id} copies, clear and available.`],
    ], { unit: tr.id });
    this.freeTruck(tr);
  }

  freeTruck(tr: Truck) {
    tr.task = null; tr.tok++; tr.waitIso = null;
    if (tr.status !== 'Out of Contact') tr.status = 'Available';
    tr.route = null;
    this.schedule(60 + this.rand() * 150, 'woPick', { truck: tr.id, tok: tr.tok });
  }

  recall(truckId: string) {
    const tr = this.truck(truckId);
    if (!tr) return 'Unknown unit';
    if (tr.clearance) return `${truckId} holds clearance ${tr.clearance}`;
    if (tr.sw) return `${truckId} is performing switching`;
    if (tr.task?.kind === 'incident') { const inc = this.s.incidents[tr.task.id]; if (inc) { inc.crew = null; if (inc.status !== 'Restored' && inc.status !== 'Closed') inc.status = 'New'; inc.timeline.push({ t: this.s.t, text: `Truck ${truckId} released from incident` }); } }
    if (tr.task?.kind === 'workorder') this.s.workorders[tr.task.id].status = 'Open';
    this.say([['C', `Truck ${truckId}, Campus Control. Break off and return to the service center.`], [truckId, `${truckId} copies, returning to the service center.`]], { unit: truckId });
    tr.task = { kind: 'home' }; tr.tok++; tr.status = 'En Route';
    this.startRoute(tr, tr.home, 'home');
    this.decision(`Recalled Truck ${truckId} to service center`);
    return null;
  }

  statusCheck(truckId: string) {
    const tr = this.truck(truckId);
    if (!tr) return;
    this.s.metrics.contacts++;
    this.say([['C', `Truck ${truckId}, Campus Control, status check.`]], { unit: truckId });
    if (!tr.comm) { this.schedule(14, 'noResponse', { truck: truckId }); this.decision(`Radio status check to ${truckId} — no response`); this.s.scen.flags.contactAttempts = (this.s.scen.flags.contactAttempts ?? 0) + 1; return; }
    const what = tr.task?.kind === 'incident' ? `on ${tr.task.id}` : tr.task?.kind === 'workorder' ? `on ${tr.task.id}` : tr.task?.kind === 'planned' ? 'on the planned job' : 'available';
    this.say([[truckId, `${truckId}, ${tr.status.toLowerCase()} ${what}, ${this.locOf(tr.pos)}.`], ['C', `Copy ${truckId}.`]], { start: 4, unit: truckId });
    this.decision(`Radio status check with ${truckId}`);
  }

  cellCall(truckId: string) {
    const tr = this.truck(truckId);
    if (!tr) return;
    this.s.metrics.contacts++;
    this.s.scen.flags.contactAttempts = (this.s.scen.flags.contactAttempts ?? 0) + 1;
    if (!tr.comm) {
      this.log('DISPATCH', 'warn', `Cell call to ${truckId} foreman (${tr.crew.split(' / ')[0]}) — rang to voicemail. Left message to call Control.`);
      this.decision(`Called ${truckId} foreman cell phone — no answer`);
    } else {
      this.log('DISPATCH', 'info', `Cell call to ${truckId} foreman — crew OK, ${tr.status}.`);
      this.decision(`Called ${truckId} foreman cell phone — reached`);
    }
    this.bump();
  }

  welfareCheck(byTruck: string, target: string): string | null {
    const tr = this.truck(byTruck), tg = this.truck(target);
    if (!tr || !tg) return 'Unknown unit';
    if (byTruck === target) return 'Pick a different unit';
    if (tr.clearance || tr.sw) return `${byTruck} is committed`;
    if (!tr.comm) return `${byTruck} has no comms`;
    if (tr.task?.kind === 'workorder') this.s.workorders[tr.task.id].status = 'Open';
    tr.task = { kind: 'welfare', target }; tr.tok++; tr.status = 'Dispatched';
    this.say([
      ['C', `Truck ${byTruck}, Campus Control.`],
      [byTruck, `${byTruck}, go ahead.`],
      ['C', `${byTruck}, we've lost contact with Truck ${target}, last known at ${this.locOf(tg.pos)}, working under clearance. Make contact with that crew and have them call Control.`],
      [byTruck, `${byTruck} copies, en route to check on ${target}.`],
    ], { unit: byTruck, kind: 'emergency' });
    this.schedule(16, 'crew', { truck: byTruck, tok: tr.tok, step: 'welfareDepart' });
    this.decision(`Dispatched ${byTruck} for welfare check on ${target}`, true);
    this.s.scen.flags.welfareT = this.s.scen.flags.welfareT ?? this.s.t;
    this.bump();
    return null;
  }

  // ── Requests from the field ────────────────────────────────
  request(type: Request['type'], truck: string, text: string, extra: Partial<Request> = {}): Request {
    const r: Request = { id: this.nextId('RQ', 0), t: this.s.t, type, truck, text, status: 'Pending', ...extra };
    this.s.requests.push(r);
    if (!this.live) this.log('RADIO', 'warn', `Request from ${truck === '249' ? 'Supervisor 249' : 'Truck ' + truck}: ${text}`);
    if ((type === 'close') && this.s.autoAssist) this.schedule(45, 'autoApprove', { req: r.id });
    return r;
  }

  approve(reqId: string, auto = false): string | null {
    const r = this.s.requests.find(x => x.id === reqId);
    if (!r || r.status !== 'Pending') return 'Request not pending';
    const tr = this.truck(r.truck);
    if (r.type === 'close') {
      if (!tr) return 'Unit missing';
      const st = this.s.dev[r.dev!];
      if (st.tags.length) return `${r.dev} is tagged — cannot authorize`;
      r.status = 'Approved';
      this.decision(`${auto ? '[Auto-assist] ' : ''}Authorized ${r.truck} to close ${r.dev}`);
      const end = this.say([['C', `${r.truck}, Campus Control. Permission granted to close ${r.dev}.`], [r.truck, `${r.truck} copies, closing ${r.dev}.`]], { unit: r.truck });
      if (tr.task?.kind === 'incident') tr.task.stage = 'closing';
      this.schedule(end + 30, 'crew', { truck: r.truck, tok: tr.tok, step: 'closeDev', dev: r.dev, req: r.id });
    } else if (r.type === 'clearance') {
      const err = this.issueClearance(r);
      if (err) return err;
    } else if (r.type === 'release') {
      const err = this.releaseClearance(r.devs?.[0] ?? '', false, r);
      if (err) return err;
    } else if (r.type === 'hotline') {
      const st = this.s.dev[r.dev!];
      r.status = 'Approved';
      if (st.nonReclose) this.decision(`Placed hot-line tag (non-reclose) on ${r.dev} and released ${r.truck} for energized work`, true);
      else { this.decision(`Released ${r.truck} for energized work but ${r.dev} reclosing is still ENABLED`, false); this.log('SAFETY', 'alarm', `${r.truck} told hot-line tag is on, but ${r.dev} non-reclose is OFF`); }
      this.say([['C', `${r.truck}, Campus Control. Hot-line tag is on ${r.dev}, non-reclose, at ${this.hhmm()}. You're clear for energized work.`], [r.truck, `${r.truck} copies, hot-line tag on ${r.dev}. Starting energized work.`]], { unit: r.truck });
      this.scen.event?.(this, 'hotlineGranted', { req: r.id, nr: !!st.nonReclose });
    } else if (r.type === 'pressure') {
      r.status = 'Approved';
      this.decision('Agreed to supervisor request to restore section under clearance', false);
      this.say([['C', `249, Campus Control, copy, will attempt to close ${r.dev}.`]], { unit: '249' });
      const res = this.operate(r.dev!, 'close', { by: 'SCADA' });
      if (!res.ok) this.log('SCADA', 'alarm', `Control rejected: ${res.reason}`);
    }
    this.bump();
    return null;
  }

  deny(reqId: string): string | null {
    const r = this.s.requests.find(x => x.id === reqId);
    if (!r || r.status !== 'Pending') return 'Request not pending';
    r.status = 'Denied';
    const tr = this.truck(r.truck);
    if (r.type === 'close') {
      this.say([['C', `${r.truck}, Campus Control. Hold on closing ${r.dev}, stand by.`], [r.truck, `${r.truck} copies, holding.`]], { unit: r.truck });
      if (tr) { tr.status = 'Standing By'; this.schedule(240, 'crew', { truck: r.truck, tok: tr.tok, step: 'reRequestClose', dev: r.dev, inc: r.inc }); }
      this.decision(`Held ${r.truck} from closing ${r.dev}`);
    } else if (r.type === 'clearance') {
      this.say([['C', `${r.truck}, Campus Control. Unable to issue clearance at this time, stand by.`], [r.truck, `${r.truck} copies, standing by.`]], { unit: r.truck });
      if (tr) { tr.waitIso = tr.waitIso ?? null; this.schedule(180, 'crew', { truck: r.truck, tok: tr.tok, step: 'reRequestClr', req: r.id }); }
      this.decision(`Deferred clearance request from ${r.truck}`);
    } else if (r.type === 'hotline') {
      this.say([['C', `${r.truck}, Campus Control. Stand by on the hot-line tag.`], [r.truck, `${r.truck} copies, standing by.`]], { unit: r.truck });
      this.decision(`Held ${r.truck} hot-line tag request`);
      if (tr) this.schedule(240, 'crew', { truck: r.truck, tok: tr.tok, step: 'reHotline', dev: r.dev });
    } else if (r.type === 'pressure') {
      this.say([['C', `249, Campus Control. Negative. That section is under clearance to Truck 235 and we don't have contact with the crew. It stays de-energized until 235 releases it.`], ['249', '249 copies, understood.']], { unit: '249' });
      this.decision('Refused to energize section under an active clearance with crew out of contact', true);
    } else if (r.type === 'release') {
      r.status = 'Pending';
      return 'A clearance release must be acknowledged';
    }
    this.bump();
    return null;
  }

  // ── Clearances ─────────────────────────────────────────────
  private issueClearance(r: Request): string | null {
    const tr = this.truck(r.truck);
    const sec = sectionAround(this.T, r.dev!);
    const notOpen = sec.bounds.filter(b => !this.s.dev[b].open);
    if (notOpen.length) { this.violation('clearance', `Attempted to issue clearance with isolation points not open: ${notOpen.join(', ')}`); return `Isolation points not open: ${notOpen.join(', ')}`; }
    const live = sec.nodes.filter(n => this.net.en.has(n));
    if (live.length) { this.violation('clearance', 'Attempted to issue clearance on an energized section (backfeed path present)'); return 'Section is still energized — check for backfeed'; }
    const id = this.nextId('CL', 300);
    const cl: Clearance = { id, truck: r.truck, devs: sec.bounds, nodes: sec.nodes, issued: this.s.t, released: null, status: 'Active', purpose: r.text, inc: r.inc };
    this.s.clearances[id] = cl;
    for (const b of sec.bounds) this.s.dev[b].tags.push(id);
    r.status = 'Approved';
    tr.clearance = id; tr.waitIso = null;
    const pts = sec.bounds.join(', ');
    this.decision(`Issued clearance ${id} to ${this.live ? this.unitName(r.truck) : r.truck} — hold tags on ${pts}`, true);
    this.log('SAFETY', 'good', `Clearance ${id} issued to ${this.live ? this.unitName(r.truck) : 'Truck ' + r.truck}: HOLD tags on ${pts}${this.live && r.text ? ` — ${r.text}` : ''}`);
    const end = this.say([
      ['C', `Truck ${r.truck}, Campus Control. Clearance ${id} is issued to you on the section bounded by ${pts}. All points are open and hold tagged at ${this.hhmm()}.`],
      [r.truck, `${r.truck} repeating, clearance ${id} issued on the section bounded by ${pts}, all points open and tagged, ${this.hhmm()}. We'll test and ground.`],
      ['C', `That's correct, ${r.truck}.`],
    ], { kind: 'switching', unit: r.truck });
    tr.status = 'Working';
    if (this.live) return null;
    const fid = r.inc ? this.s.incidents[r.inc]?.faults[0] : undefined;
    const mins = fid ? repairMinutes(this.s.faults[fid].cause, () => this.rand()) : (this.s.scen.flags.plannedMinutes ?? 20);
    if (r.inc) { const inc = this.s.incidents[r.inc]; inc.stage = 'Repair'; inc.status = 'Working'; inc.etr = this.s.t + end + mins * 60 + 900; inc.timeline.push({ t: this.s.t, text: `Clearance ${id} issued to ${r.truck}` }); }
    this.schedule(end + mins * 60, 'crew', { truck: r.truck, tok: tr.tok, step: 'repairDone' });
    return null;
  }

  releaseClearance(clId: string, force: boolean, req?: Request): string | null {
    const cl = this.s.clearances[clId] ?? (req ? Object.values(this.s.clearances).find(c => c.truck === req.truck && c.status === 'Active') : undefined);
    if (!cl || cl.status !== 'Active') return 'No active clearance';
    const pend = this.s.requests.find(r => r.type === 'release' && r.status === 'Pending' && r.truck === cl.truck);
    if (!pend && force) this.violation('clearance-release', `Released clearance ${cl.id} without a release from the holder (Truck ${cl.truck})`);
    else if (!pend) return `${this.live ? this.unitName(cl.truck) : 'Truck ' + cl.truck} has not released ${cl.id}`;
    for (const b of cl.devs) this.s.dev[b].tags = this.s.dev[b].tags.filter(x => x !== cl.id);
    cl.status = 'Released'; cl.released = this.s.t;
    const tr = this.truck(cl.truck);
    if (tr) tr.clearance = null;
    if (pend) {
      pend.status = 'Done';
      this.decision(`Acknowledged release of ${cl.id} from ${cl.truck}; hold tags removed`, true);
      this.say([['C', `Truck ${cl.truck}, Campus Control. Copy, clearance ${cl.id} released at ${this.hhmm()}, tags removed. Stand by for restoration switching.`], [cl.truck, `${cl.truck} copies, standing by.`]], { kind: 'switching', unit: cl.truck });
      if (tr) tr.status = 'Standing By';
    }
    this.log('SAFETY', pend ? 'good' : 'alarm', `Clearance ${cl.id} released${this.live ? ` by ${this.unitName(cl.truck)}` : ''}${pend ? '' : ' (FORCED)'}`);
    this.bump();
    return null;
  }

  // ── Switching orders ───────────────────────────────────────
  newOrder(title: string, steps: Partial<SwStep>[] = []): SwitchingOrder {
    const id = this.nextId('SO', 1040);
    const o: SwitchingOrder = { id, title, status: 'Draft', cur: 0, created: this.s.t, steps: [] };
    for (const st of steps) o.steps.push({ dev: st.dev!, action: st.action!, exec: st.exec ?? 'SCADA', loop: !!st.loop, status: 'Pending', injectError: st.injectError, injectErrorDev: st.injectErrorDev });
    this.s.orders[id] = o;
    this.bump();
    return o;
  }
  addStep(oid: string, dev: string, action: 'open' | 'close', exec: string, loop: boolean) {
    const o = this.s.orders[oid];
    if (!o || o.status === 'Complete' || o.status === 'Cancelled') return 'Order not editable';
    if (!this.dev(dev)) return 'Unknown device';
    if (exec === 'SCADA' && !this.dev(dev).scada) return `${dev} is not SCADA controllable`;
    o.steps.push({ dev, action, exec, loop, status: 'Pending' });
    this.bump(); return null;
  }
  removeStep(oid: string, idx: number) {
    const o = this.s.orders[oid];
    if (!o || idx < o.cur || o.steps[idx]?.status !== 'Pending') return;
    o.steps.splice(idx, 1); this.bump();
  }
  activateOrder(oid: string) {
    const o = this.s.orders[oid];
    if (!o || o.status !== 'Draft' || !o.steps.length) return 'Order needs at least one step';
    o.status = 'Active';
    this.decision(`Approved and activated switching order ${oid} (${o.steps.length} steps)`);
    this.log('DISPATCH', 'info', `${oid} activated — ${o.title}`);
    this.bump(); return null;
  }
  cancelOrder(oid: string) { const o = this.s.orders[oid]; if (o && o.status !== 'Complete') { o.status = 'Cancelled'; this.decision(`Cancelled ${oid}`); this.bump(); } }

  /** Issue the current step. SCADA steps execute immediately (UI confirms SBO first). */
  issueStep(oid: string): string | null {
    const o = this.s.orders[oid];
    if (!o || o.status !== 'Active') return 'Order not active';
    const st = o.steps[o.cur];
    if (!st) return 'No step';
    if (!['Pending', 'Failed'].includes(st.status)) return 'Step already in progress';
    const d = this.dev(st.dev);
    if (st.exec === 'SCADA') {
      const r = this.operate(st.dev, st.action, { by: 'SCADA', loopOk: st.loop, order: oid });
      if (!r.ok) { st.status = 'Failed'; st.note = r.reason; this.log('SCADA', 'warn', `${oid} step ${o.cur + 1} failed: ${r.reason}`); this.bump(); return r.reason!; }
      st.status = 'Done'; st.doneT = this.s.t;
      this.decision(`${oid} step ${o.cur + 1}: SCADA ${st.action} ${st.dev}`);
      this.advanceOrder(o);
      this.bump(); return null;
    }
    const tr = this.truck(st.exec);
    if (!tr) return 'Unknown unit';
    if (!tr.comm) { this.say([['C', `Truck ${tr.id}, Campus Control.`]], { unit: tr.id }); this.schedule(14, 'noResponse', { truck: tr.id }); return `No response from ${tr.id}`; }
    const okStatus = ['Available', 'Standing By', 'On Scene', 'En Route', 'Dispatched'].includes(tr.status) || tr.task?.kind === 'workorder';
    if (!okStatus || tr.clearance) return `Truck ${tr.id} is ${tr.clearance ? 'working under clearance' : tr.status.toLowerCase()} — not available for switching`;
    if (tr.task?.kind === 'workorder') { this.s.workorders[tr.task.id].status = 'Open'; tr.task = null; }
    tr.sw = { order: oid, idx: o.cur }; tr.tok++; tr.route = null; tr.status = 'Switching';
    st.status = 'Issued'; st.note = undefined;
    if (this.live) {
      st.status = 'RepeatBack'; st.rbDev = st.dev; st.rbAction = st.action;
      this.log('DISPATCH', 'info', `${oid} step ${o.cur + 1} issued to ${tr.crew}: ${st.action.toUpperCase()} ${st.dev} — confirm their repeat-back`);
      this.decision(`Issued ${oid} step ${o.cur + 1} to ${tr.crew}: ${st.action} ${st.dev}`);
      this.bump(); return null;
    }
    const act = st.action === 'open' ? 'Open' : 'Close';
    const end = this.voiced ? 2.5 : this.say([
      ['C', `Truck ${tr.id}, Campus Control, switching.`],
      [tr.id, `${tr.id}, go ahead with switching.`],
      ['C', `Switching order ${oid}, step ${o.cur + 1}: ${act} ${devWord(d)} ${st.dev}${st.loop ? ', loop close,' : ''} at ${d.loc}. Repeat.`],
    ], { kind: 'switching', unit: tr.id });
    this.schedule(end + 1, 'sw', { order: oid, idx: o.cur, phase: 'repeat' });
    this.decision(`Issued ${oid} step ${o.cur + 1} to ${tr.id}: ${act} ${st.dev}`);
    this.bump(); return null;
  }

  confirmRepeat(oid: string, correct: boolean) {
    const o = this.s.orders[oid];
    const st = o?.steps[o.cur];
    if (!st || st.status !== 'RepeatBack') return 'No repeat-back pending';
    const tr = this.truck(st.exec)!;
    const wrong = st.rbDev !== st.dev || st.rbAction !== st.action;
    if (!correct) {
      if (wrong) { this.decision(`Caught incorrect repeat-back from ${tr.id} (${st.rbAction} ${st.rbDev})`, true); this.s.scen.flags.caughtRepeat = true; }
      else this.decision(`Rejected a correct repeat-back from ${tr.id}`, false);
      const d = this.dev(st.dev);
      const end = this.say([['C', `Negative, ${tr.id}. Step ${o.cur + 1}: ${st.action === 'open' ? 'Open' : 'Close'} ${devWord(d)} ${st.dev} at ${d.loc}. Repeat.`]], { kind: 'switching', unit: tr.id });
      st.status = 'Issued'; st.injectError = false;
      this.schedule(end + 1, 'sw', { order: oid, idx: o.cur, phase: 'repeat' });
      this.bump(); return null;
    }
    if (wrong && !this.live) { this.violation('repeat-back', `Confirmed an incorrect repeat-back (${tr.id} repeated ${st.rbAction} ${st.rbDev}; order says ${st.action} ${st.dev})`); this.s.scen.flags.missedRepeat = true; }
    else this.decision(`Confirmed repeat-back from ${tr.id}, step ${o.cur + 1}`, true);
    st.status = 'InProgress';
    if (this.live) { this.log('DISPATCH', 'info', `${oid} step ${o.cur + 1}: repeat-back confirmed, ${tr.crew} performing`); this.bump(); return null; }
    const end = this.say([['C', `That's correct, ${tr.id}. Perform.`]], { kind: 'switching', unit: tr.id });
    const target = this.dev(st.rbDev!).pos;
    const travel = dist(tr.pos, target) > 60 ? this.startRoute(tr, target, 'sw') : 0;
    if (!travel) this.schedule(end + 35, 'sw', { order: oid, idx: o.cur, phase: 'operate' });
    this.bump(); return null;
  }

  private advanceOrder(o: SwitchingOrder) {
    o.cur++;
    if (o.cur >= o.steps.length) {
      o.status = 'Complete';
      this.log('DISPATCH', 'good', `${o.id} complete — ${o.title}`);
      this.decision(`Switching order ${o.id} completed`, true);
      this.scen.event?.(this, 'orderComplete', { order: o.id });
    }
  }

  private handleSw(data: { order: string; idx: number; phase: string }) {
    const o = this.s.orders[data.order];
    if (!o || o.cur !== data.idx || o.status !== 'Active') return;
    const st = o.steps[data.idx];
    const tr = this.truck(st.exec);
    if (!tr) return;
    if (data.phase === 'repeat') {
      if (st.status !== 'Issued') return;
      let rbDev = st.dev, rbAction = st.action;
      const errP = this.s.scen.flags.repeatErrorRate ?? 0.03;
      if (st.injectError || (!this.s.scen.flags.noRandomErrors && this.rand() < errP)) {
        const d = this.dev(st.dev);
        const sib = this.T.feeders[d.feeder].sch.filter(x => x.kind === 'dev' && x.id !== st.dev && this.dev(x.id).type === 'switch').map(x => x.id);
        rbDev = st.injectErrorDev ?? (sib.length ? this.pick(sib) : st.dev);
        if (rbDev === st.dev) rbAction = st.action === 'open' ? 'close' : 'open';
      }
      st.rbDev = rbDev; st.rbAction = rbAction; st.status = 'RepeatBack';
      const rd = this.dev(rbDev);
      this.say([[tr.id, `${tr.id} repeating, switching order ${o.id} step ${o.cur + 1}: ${rbAction === 'open' ? 'open' : 'close'} ${devWord(rd)} ${rbDev} at ${rd.loc}.`]], { kind: 'switching', unit: tr.id });
      this.log('DISPATCH', 'warn', `${tr.id} repeat-back on ${o.id} step ${o.cur + 1} — confirm or correct`);
    } else if (data.phase === 'operate') {
      if (st.status !== 'InProgress') return;
      const r = this.operate(st.rbDev!, st.rbAction!, { by: tr.id, loopOk: st.loop && st.rbDev === st.dev, order: o.id });
      if (!r.ok) {
        st.status = 'Failed'; st.note = r.reason;
        this.say([[tr.id, `Control, ${tr.id}. Unable to ${st.rbAction} ${st.rbDev}. ${r.reason}.`], ['C', `Copy ${tr.id}, stand by.`]], { kind: 'switching', unit: tr.id });
        tr.sw = null; this.restoreTruckStatus(tr);
        this.bump(); return;
      }
      const state = st.rbAction === 'open' ? 'open' : 'closed';
      this.say([
        [tr.id, `Control, ${tr.id}. Switching order ${o.id} step ${o.cur + 1} complete, ${st.rbDev} is ${state}, ${this.hhmm()}.`],
        ['C', `Copy ${tr.id}, ${st.rbDev} ${state} at ${this.hhmm()}.`],
      ], { kind: 'switching', unit: tr.id });
      st.status = 'Done'; st.doneT = this.s.t;
      tr.sw = null; this.restoreTruckStatus(tr);
      this.advanceOrder(o);
    }
    this.bump();
  }

  private restoreTruckStatus(tr: Truck) {
    if (tr.task?.kind === 'incident') {
      const stage = tr.task.stage, inc = this.s.incidents[tr.task.id];
      if (stage === 'dispatched') { tr.status = 'En Route'; this.schedule(3, 'crew', { truck: tr.id, tok: tr.tok, step: 'depart' }); return; }
      if (stage === 'patrol' && inc?.faults[0]) { tr.status = 'En Route'; this.startRoute(tr, this.s.faults[inc.faults[0]].pos, 'patrol', 1.6); return; }
      if (stage === 'onscene') { tr.status = 'On Scene'; this.schedule(90, 'crew', { truck: tr.id, tok: tr.tok, step: 'investigate' }); return; }
      tr.status = 'Standing By';
    } else if (tr.task?.kind === 'planned') tr.status = 'Standing By';
    else if (!tr.task) { tr.status = 'Available'; this.schedule(120, 'woPick', { truck: tr.id, tok: tr.tok }); }
  }

  // ── Work orders ────────────────────────────────────────────
  newWorkOrder() {
    const [type, dur] = this.pick(WO_TYPES);
    const ld = this.T.loads[this.pick(this.T.loadIds)];
    const id = this.nextId('WO', 4470);
    const wo: WorkOrder = { id, type, pos: ld.pos, loc: nearestName(ld.pos), dur: dur * 60 * (0.8 + this.rand() * 0.5), status: 'Open' };
    this.s.workorders[id] = wo;
    return wo;
  }

  woPick(truckId: string, tok: number) {
    const tr = this.truck(truckId);
    if (this.live) return;
    if (!tr || tr.tok !== tok || tr.task || tr.status !== 'Available' || !tr.comm || tr.sw || tr.clearance) return;
    if (this.s.scen.flags.noRoutine) return;
    const open = Object.values(this.s.workorders).filter(w => w.status === 'Open');
    if (open.length < 3) this.newWorkOrder();
    const wo = open.sort((a, b) => dist(tr.pos, a.pos) - dist(tr.pos, b.pos))[0] ?? this.newWorkOrder();
    wo.status = 'Assigned'; wo.truck = truckId;
    tr.task = { kind: 'workorder', id: wo.id }; tr.tok++;
    const end = this.say([
      [truckId, `Campus Control, ${truckId}.`],
      ['C', `${truckId}, go ahead.`],
      [truckId, `${truckId} will be en route to ${wo.id}, ${wo.type}, ${wo.loc}.`],
      ['C', `Copy ${truckId}.`],
    ], { unit: truckId });
    this.schedule(end, 'crew', { truck: truckId, tok: tr.tok, step: 'woDepart' });
  }

  // ── Event dispatch ─────────────────────────────────────────
  private handle(it: QItem) {
    const d = it.data;
    switch (it.kind) {
      case 'radio': this.radioNow(d.sp, d.text, d.kind, d.unit); break;
      case 'reclose': this.handleReclose(d.dev, d.shot, d.fault); break;
      case 'call': this.onCall(d.load, d.kind, d.epoch); break;
      case 'ami': this.handleAmi(d.dev); break;
      case 'arrive': this.handleArrive(d.truck, d.tok, d.purpose); break;
      case 'crew': this.handleCrew(d); break;
      case 'sw': this.handleSw(d); break;
      case 'woPick': this.woPick(d.truck, d.tok); break;
      case 'gen': this.handleGen(d.g); break;
      case 'scn': this.scen.event?.(this, d.name, d); break;
      case 'cd': this.cdEvent(d.name); break;
      case 'autoApprove': { const r = this.s.requests.find(x => x.id === d.req); if (r?.status === 'Pending' && this.s.autoAssist) this.approve(d.req, true); break; }
      case 'autoVerify': { const inc = this.s.incidents[d.inc]; if (inc?.status === 'Restored' && this.s.autoAssist) { inc.status = 'Closed'; inc.closedT = this.s.t; inc.stage = 'Done'; inc.timeline.push({ t: this.s.t, text: 'Auto-verified by AMI — closed' }); } break; }
      case 'noResponse': this.log('RADIO', 'warn', `No response from Truck ${d.truck}`); this.radioNow('C', `Truck ${d.truck}, Campus Control... nothing heard.`, 'system', d.truck); break;
      case 'commRestore': this.restoreComm(d.truck, d.reason); break;
      case 'devComm': this.handleDevComm(d.dev, d.ok); break;
    }
  }

  private handleAmi(dev: string) {
    if (!this.s.dev[dev].open) return;
    if (!this.s.dev[dev].tripFault) {
      const anc = this.T.devLoads[dev][0] ? this.T.loadAnc[this.T.devLoads[dev][0]] : [];
      if (this.openIncidents().some(i => i.truthDev && anc.includes(i.truthDev))) return;
    }
    const ex = this.openIncidents().find(i => i.truthDev === dev);
    if (ex) {
      if (ex.source === 'Calls' && ex.predDev !== dev) { ex.timeline.push({ t: this.s.t, text: `AMI last-gasp confirms outage at ${dev}` }); ex.predDev = dev; ex.source = 'AMI'; this.updateIncident(ex); }
      return;
    }
    this.createIncident('AMI', dev, dev);
  }

  private handleDevComm(dev: string, ok: boolean) {
    this.s.dev[dev].comm = ok;
    if (ok) { this.clearAlarm(`comm:${dev}`); this.log('SCADA', 'good', `${dev} communications restored`); }
    else { this.alarm(`comm:${dev}`, `${dev} RTU COMM FAIL — status stale, control unavailable`, 2, dev); this.schedule(600 + this.rand() * 900, 'devComm', { dev, ok: true }); }
  }

  restoreComm(truckId: string, reason: string) {
    const tr = this.truck(truckId);
    if (!tr || tr.comm) return;
    tr.comm = true;
    if (tr.status === 'Out of Contact') tr.status = tr.clearance ? 'Working' : 'Standing By';
    this.say([
      [truckId, `Campus Control, ${truckId}. ${reason}`],
      ['C', `Copy ${truckId}, glad you're OK. Confirm you still hold clearance ${tr.clearance ?? ''}.`],
      [truckId, `${truckId} affirmative, still working under the clearance.`],
    ], { kind: 'emergency', unit: truckId });
    this.clearAlarm(`unit:${truckId}`);
    this.scen.event?.(this, 'commRestored', { truck: truckId });
  }

  private handleArrive(truckId: string, tok: number, purpose: string) {
    const tr = this.truck(truckId);
    if (!tr || !tr.route || tr.route.tok !== tok) return;
    tr.pos = tr.route.pts[tr.route.pts.length - 1];
    tr.route = null;
    if (purpose === 'incident') {
      if (tr.task?.kind !== 'incident') return;
      const inc = this.s.incidents[tr.task.id];
      tr.status = 'On Scene'; tr.task.stage = 'onscene';
      if (inc && inc.onSceneT == null) inc.onSceneT = this.s.t;
      if (inc && inc.status !== 'Restored' && inc.status !== 'Closed') { inc.status = 'On Scene'; inc.timeline.push({ t: this.s.t, text: `Truck ${truckId} on scene` }); }
      const end = this.say([[truckId, `Campus Control, ${truckId} on location, ${this.locOf(tr.pos)}.`], ['C', `Copy ${truckId}, on location at ${this.hhmm()}.`]], { unit: truckId });
      if (inc && (inc.status === 'Restored' || inc.status === 'Closed')) { this.schedule(end + 10, 'crew', { truck: truckId, tok: tr.tok, step: 'alreadyOn' }); return; }
      const fid = inc?.faults[0];
      const inv = inc?.kind === 'single' ? 300 : fid && ['tree_primary', 'insulator'].includes(this.s.faults[fid].cause) ? 120 : 240 + this.rand() * 240;
      this.schedule(end + inv, 'crew', { truck: truckId, tok: tr.tok, step: 'investigate' });
    } else if (purpose === 'patrol') {
      this.schedule(20, 'crew', { truck: truckId, tok: tr.tok, step: 'patrolFound' });
    } else if (purpose === 'wo') {
      tr.status = 'Working';
      if (tr.task?.kind === 'workorder') this.schedule(this.s.workorders[tr.task.id].dur, 'crew', { truck: truckId, tok: tr.tok, step: 'woDone' });
    } else if (purpose === 'sw') {
      if (tr.sw) this.schedule(35, 'sw', { order: tr.sw.order, idx: tr.sw.idx, phase: 'operate' });
    } else if (purpose === 'welfare') {
      tr.status = 'On Scene';
      const tg = tr.task?.kind === 'welfare' ? tr.task.target : '';
      this.say([[truckId, `Campus Control, ${truckId} on location with ${tg}. Crew is OK. Their portable died and the truck radio has a bad antenna lead. Putting their foreman on our radio.`], ['C', `Copy ${truckId}, thank you.`]], { kind: 'emergency', unit: truckId });
      this.schedule(30, 'commRestore', { truck: tg, reason: `${tg} back on the air on ${truckId}'s radio. Crew is all OK.` });
      this.schedule(60, 'crew', { truck: truckId, tok: tr.tok, step: 'welfareDone' });
    } else if (purpose === 'home') {
      if (tr.task?.kind === 'home') { tr.task = null; tr.status = 'Available'; this.schedule(90, 'woPick', { truck: truckId, tok: tr.tok }); }
    }
  }

  private handleCrew(d: any) {
    const tr = this.truck(d.truck);
    if (!tr || tr.tok !== d.tok) return;
    const id = tr.id;
    const inc = tr.task?.kind === 'incident' ? this.s.incidents[tr.task.id] : undefined;
    switch (d.step) {
      case 'depart': {
        if (!inc) return;
        if (inc.status === 'Restored' || inc.status === 'Closed') { this.freeTruck(tr); return; }
        tr.status = 'En Route'; inc.status = 'En Route';
        this.startRoute(tr, this.incidentTarget(inc), 'incident');
        inc.timeline.push({ t: this.s.t, text: `Truck ${id} en route, ETA ${this.hhmm(this.eta(tr)!)}` });
        break;
      }
      case 'alreadyOn': {
        this.say([[id, `Control, ${id}. Everything is back on here, nothing found. ${id} available.`], ['C', `Copy ${id}.`]], { unit: id });
        this.freeTruck(tr); break;
      }
      case 'investigate': this.investigate(tr, inc); break;
      case 'patrolFound': this.patrolFound(tr, inc); break;
      case 'repairDone': this.repairDone(tr, inc); break;
      case 'closeDev': {
        const r = this.operate(d.dev, 'close', { by: id });
        const req = this.s.requests.find(x => x.id === d.req);
        if (req) req.status = 'Done';
        if (!r.ok) { this.say([[id, `Control, ${id}. Unable to close ${d.dev}: ${r.reason}.`]], { unit: id }); tr.status = 'Standing By'; break; }
        if (this.s.dev[d.dev].open) { // re-blew
          this.say([[id, `Control, ${id}. ${d.dev} blew again on closing. We'll keep looking.`], ['C', `Copy ${id}.`]], { unit: id });
          if (inc && tr.task?.kind === 'incident') tr.task.stage = 'onscene';
          this.schedule(300, 'crew', { truck: id, tok: tr.tok, step: 'investigate' });
          break;
        }
        this.say([[id, `Control, ${id}. ${d.dev} is closed, customers are on at ${this.hhmm()}. ${id} clear and available.`], ['C', `Copy ${id}, ${d.dev} closed at ${this.hhmm()}. Thank you.`]], { unit: id });
        if (inc) { inc.timeline.push({ t: this.s.t, text: `${id} closed ${d.dev} — power restored` }); this.updateIncident(inc); }
        this.freeTruck(tr);
        break;
      }
      case 'reRequestClose': {
        if (!inc || inc.status === 'Restored' || inc.status === 'Closed') return;
        const end = this.say([[id, `Campus Control, ${id}. Still standing by to close ${d.dev}, requesting permission.`]], { unit: id });
        this.schedule(end, 'crew', { truck: id, tok: tr.tok, step: 'raiseClose', dev: d.dev });
        break;
      }
      case 'raiseClose': this.request('close', id, `Close ${d.dev} (repairs complete)`, { dev: d.dev, inc: inc?.id }); break;
      case 'reHotline': {
        if (this.s.requests.some(r => r.type === 'hotline' && r.truck === id && r.status !== 'Denied')) break;
        this.say([[id, `Campus Control, ${id}. Still standing by for a hot-line tag on ${d.dev}.`]], { unit: id });
        this.request('hotline', id, `Hot-line tag (non-reclose) on ${d.dev} for energized work`, { dev: d.dev });
        break;
      }
      case 'reRequestClr': {
        if (tr.clearance) return;
        const old = this.s.requests.find(x => x.id === d.req);
        if (old) this.request('clearance', id, old.text, { dev: old.dev, devs: old.devs, inc: old.inc });
        break;
      }
      case 'woDepart': {
        if (tr.task?.kind !== 'workorder') return;
        tr.status = 'En Route';
        this.startRoute(tr, this.s.workorders[tr.task.id].pos, 'wo');
        break;
      }
      case 'woDone': {
        if (tr.task?.kind !== 'workorder') return;
        const wo = this.s.workorders[tr.task.id];
        wo.status = 'Done';
        this.say([[id, `Campus Control, ${id}, complete on ${wo.id}, available.`], ['C', `Copy ${id}.`]], { unit: id });
        this.freeTruck(tr);
        break;
      }
      case 'welfareDepart': {
        if (tr.task?.kind !== 'welfare') return;
        tr.status = 'En Route';
        this.startRoute(tr, this.truck(tr.task.target).pos, 'welfare');
        break;
      }
      case 'welfareDone': this.freeTruck(tr); break;
      case 'plannedDone': this.repairDone(tr, undefined); break;
      case 'raiseRelease': if (tr.clearance) this.request('release', id, `Release of clearance ${tr.clearance} — work complete, grounds removed, crew clear`, { devs: [tr.clearance] }); break;
    }
    this.bump();
  }

  private investigate(tr: Truck, inc: Incident | undefined) {
    if (!inc || tr.task?.kind !== 'incident') return;
    const id = tr.id;
    if (inc.status === 'Restored' || inc.status === 'Closed') { this.handleCrew({ truck: id, tok: tr.tok, step: 'alreadyOn' }); return; }
    if (inc.kind === 'single') {
      const why = this.pick(['customer main breaker is tripped, reset it, power is on', 'meter base is burned up on the customer side, advised customer to call an electrician', 'customer had a tripped GFCI and a breaker off, all good now']);
      this.say([[id, `Control, ${id}. On the single no-power at ${this.T.loads[inc.loadId!].addr}, ${why}. Utility side is good. ${id} available.`], ['C', `Copy ${id}, closing it out.`]], { unit: id });
      inc.status = 'Closed'; inc.closedT = this.s.t; inc.stage = 'Done'; inc.cause = 'Customer-side equipment';
      inc.timeline.push({ t: this.s.t, text: `Crew: ${why}` });
      this.freeTruck(tr); return;
    }
    const dev = inc.truthDev;
    const fid = inc.faults[0];
    const f = fid ? this.s.faults[fid] : undefined;
    const d = dev ? this.dev(dev) : this.dev(inc.predDev);
    if (dev && dev !== inc.predDev) {
      inc.timeline.push({ t: this.s.t, text: `Crew confirmed outage device ${dev} (predicted ${inc.predDev})` });
      inc.predDev = dev;
    }
    if (!f || !f.active) {
      // Device open but nothing found (e.g. fault cleared or operator-opened)
      if (dev && this.s.dev[dev].open && !this.s.dev[dev].tags.length) {
        const end = this.say([[id, `Control, ${id}. ${dev} is open at ${d.loc}. Patrolled it, no trouble found. Requesting permission to close ${dev}.`]], { unit: id });
        tr.status = 'Standing By';
        this.schedule(end, 'crew', { truck: id, tok: tr.tok, step: 'raiseClose', dev });
      } else {
        this.say([[id, `Control, ${id}. No trouble found here. ${id} available.`], ['C', `Copy ${id}.`]], { unit: id });
        this.freeTruck(tr);
      }
      return;
    }
    const dt = d.type;
    if (dt === 'fuse' || dt === 'xfmr') {
      f.found = true;
      const mins = repairMinutes(f.cause, () => this.rand());
      inc.cause = f.desc; inc.etr = this.s.t + (mins + 20) * 60; inc.stage = 'Repair'; inc.status = 'Working';
      inc.timeline.push({ t: this.s.t, text: `Cause: ${f.desc}. ETR ${this.hhmm(inc.etr)}` });
      this.say([
        [id, `Campus Control, ${id}.`],
        ['C', `${id}, go ahead.`],
        [id, `${findingText(f.cause, f.hazard)} at ${dev}, ${d.loc}. Estimate about ${Math.round(mins / 5) * 5} minutes.`],
        ['C', `Copy ${id}. ${CAUSE_TEXT[f.cause]} at ${dev}, ETR ${this.hhmm(inc.etr)}.`],
      ], { unit: id });
      tr.status = 'Working'; tr.task.stage = 'repair';
      this.schedule(mins * 60 + 30, 'crew', { truck: id, tok: tr.tok, step: 'repairDone' });
      return;
    }
    // Mainline device: patrol to the fault
    inc.stage = 'Assess';
    inc.timeline.push({ t: this.s.t, text: `${id} patrolling ${d.feeder} downstream of ${dev}` });
    this.say([[id, `Control, ${id}. ${dev} shows locked out${d.type === 'breaker' ? ', relay targets phase B' : ''}. Beginning patrol of ${d.feeder} downstream.`], ['C', `Copy ${id}, patrolling ${d.feeder}.`]], { unit: id });
    tr.status = 'En Route'; tr.task.stage = 'patrol';
    this.startRoute(tr, f.pos, 'patrol', 1.6);
  }

  private patrolFound(tr: Truck, inc: Incident | undefined) {
    if (!inc || tr.task?.kind !== 'incident') return;
    const f = this.s.faults[inc.faults[0]];
    if (!f) return;
    const id = tr.id;
    f.found = true;
    const sec = sectionAround(this.T, f.el);
    inc.isolation = sec.bounds;
    inc.stage = 'Isolate'; inc.status = 'On Scene'; inc.cause = f.desc;
    if (f.hazard) inc.hazard = true;
    const mins = repairMinutes(f.cause, () => this.rand());
    inc.etr = this.s.t + (mins + 45) * 60;
    inc.timeline.push({ t: this.s.t, text: `Fault located: ${f.desc}. Isolation points: ${sec.bounds.join(', ')}` });
    this.log('OMS', 'alarm', `${inc.id}: fault located by ${id} — ${f.desc}. Isolate at ${sec.bounds.join(', ')}`);
    this.say([
      [id, `Campus Control, ${id}, priority traffic.`],
      ['C', `${id}, go ahead.`],
      [id, `${findingText(f.cause, f.hazard)}, ${this.locOf(f.pos)}. Fault is between ${sec.bounds.join(' and ')}. Requesting isolation at ${sec.bounds.join(', ')} for repairs.`],
      ['C', `Copy ${id}. Fault between ${sec.bounds.join(' and ')}. Stand by for switching.`],
    ], { kind: 'emergency', unit: id });
    tr.status = 'Standing By'; tr.task.stage = 'isolate';
    tr.waitIso = { inc: inc.id, devs: sec.bounds, purpose: `Repair ${f.desc} (${inc.id})` };
    (tr.waitIso as any).el = f.el;
  }

  private repairDone(tr: Truck, inc: Incident | undefined) {
    const id = tr.id;
    if (!tr.comm) { this.schedule(120, 'crew', { truck: id, tok: tr.tok, step: 'repairDone' }); return; }
    if (tr.clearance) {
      // Mainline/planned repair under clearance
      if (inc) for (const fid of inc.faults) this.s.faults[fid].active = false;
      const cl = this.s.clearances[tr.clearance];
      if (inc) inc.timeline.push({ t: this.s.t, text: `Repairs complete — ${id} releasing ${cl.id}` });
      const end = this.say([
        [id, `Campus Control, ${id}.`],
        ['C', `${id}, go ahead.`],
        [id, `${id}, work is complete. Grounds are removed, all personnel are clear. Releasing clearance ${cl.id}.`],
      ], { kind: 'switching', unit: id });
      this.schedule(end, 'crew', { truck: id, tok: tr.tok, step: 'raiseRelease' });
      tr.status = 'Standing By';
      return;
    }
    if (!inc) return;
    for (const fid of inc.faults) this.s.faults[fid].active = false;
    const dev = inc.truthDev ?? inc.predDev;
    inc.timeline.push({ t: this.s.t, text: `${id}: repairs complete, requesting to close ${dev}` });
    const end = this.say([[id, `Campus Control, ${id}. Repairs complete at ${dev}. Requesting permission to close ${dev}.`]], { unit: id });
    tr.status = 'Standing By';
    this.schedule(end, 'crew', { truck: id, tok: tr.tok, step: 'raiseClose', dev });
  }

  // ── Periodic ───────────────────────────────────────────────
  private periodic(dt: number) {
    let out = 0;
    for (const lid of Object.keys(this.s.loadOutSince)) if (!this.s.planned[lid]) out += this.T.loads[lid].customers;
    this.s.metrics.cmi += out * dt / 60;
    for (const inc of Object.values(this.s.incidents)) if (inc.custOut && inc.status !== 'Closed' && inc.status !== 'Restored') inc.cmi = (inc.cmi ?? 0) + inc.custOut * dt / 60;
    if (this.s.t - this.lastReadings >= 2) { this.computeReadings(); this.lastReadings = this.s.t; }
    for (const inc of this.openIncidents()) this.updateIncident(inc);
    // auto-assist dispatch
    if (this.s.autoAssist) {
      const pending = this.openIncidents().filter(i => !i.crew && i.status === 'New' && this.s.t - i.t > 60).sort((a, b) => a.priority - b.priority || a.t - b.t);
      for (const inc of pending) {
        const tgt = this.dev(inc.predDev).pos;
        const avail = Object.values(this.s.trucks).filter(t => t.comm && !t.clearance && !t.sw && (t.status === 'Available' || t.task?.kind === 'workorder'))
          .sort((a, b) => dist(a.pos, tgt) - dist(b.pos, tgt));
        if (!avail.length) break;
        this.dispatch(avail[0].id, inc.id, true);
      }
    }
    // isolation watchers -> clearance request
    for (const tr of Object.values(this.s.trucks)) {
      if (!tr.waitIso || tr.clearance || !tr.comm) continue;
      const w = tr.waitIso as any;
      if (!w.devs.every((x: string) => this.s.dev[x].open)) continue;
      const sec = sectionAround(this.T, w.el);
      if (sec.nodes.some(n => this.net.en.has(n))) continue;
      if (this.s.requests.some(r => r.type === 'clearance' && r.truck === tr.id && r.status === 'Pending')) continue;
      const pts = sec.bounds.join(', ');
      this.say([[tr.id, `Campus Control, ${tr.id}. We show ${pts} open. Requesting a clearance on the section bounded by ${pts} for ${w.purpose.toLowerCase()}.`]], { kind: 'switching', unit: tr.id });
      this.request('clearance', tr.id, `Clearance on section bounded by ${pts} — ${w.purpose}`, { dev: w.el, devs: sec.bounds, inc: w.inc || undefined });
      tr.waitIso = null;
      if (w.inc) { const inc = this.s.incidents[w.inc]; if (inc) inc.timeline.push({ t: this.s.t, text: `Isolation complete — ${tr.id} requesting clearance` }); }
    }
    // loop / parallel supervision
    if (this.net.loops.length) {
      if (this.s.loopSince === null) this.s.loopSince = this.s.t;
      if (this.s.t - this.s.loopSince > 900) this.alarm('loop', `LOOP/PARALLEL condition for ${Math.round((this.s.t - this.s.loopSince) / 60)} min — ${this.net.loops.join(', ')}`, 2);
    } else if (this.s.loopSince !== null) { this.s.loopSince = null; this.clearAlarm('loop'); }
    this.scen.periodic?.(this);
    this.evalCommon();
  }

  private evalCommon() {
    if (!this.s.scen.done && this.scen.isDone?.(this)) {
      this.s.scen.done = true;
      for (const [k, v] of Object.entries(this.s.scen.obj)) if (v.status === 'pending') this.s.scen.obj[k] = { status: 'fail', t: this.s.t, note: 'Not achieved' };
      this.log('SCENARIO', 'info', `Exercise complete — after-action review available.`);
    }
  }

  setObj(id: string, status: 'pass' | 'fail', note?: string) {
    const o = this.s.scen.obj[id];
    if (!o || o.status !== 'pending') return;
    this.s.scen.obj[id] = { status, t: this.s.t, note };
    this.log('SCENARIO', status === 'pass' ? 'good' : 'alarm', `Objective ${status === 'pass' ? 'MET' : 'FAILED'}: ${this.scen.objectives.find(x => x.id === id)?.text}${note ? ` — ${note}` : ''}`);
  }

  // ── Readings (simplified, labeled as estimates) ────────────
  computeReadings() {
    const h = this.hourOfDay();
    const i0 = Math.floor(h) % 24, fr = h - Math.floor(h);
    const curve = CURVE[i0] * (1 - fr) + CURVE[(i0 + 1) % 24] * fr;
    const acc: Record<string, FeederReading> = {};
    for (const f of this.T.feederIds) acc[f] = { kw: 0, amps: 0, ia: 0, ib: 0, ic: 0, pct: 0, vEnd: 0, cust: 0, custOut: 0, src: f };
    const devKw: Record<string, number> = {};
    for (const lid of this.T.loadIds) {
      const L = this.T.loads[lid];
      if (!this.net.en.has(L.node)) { acc[L.feeder].custOut += L.customers; continue; }
      const fac = L.cls === 'res' || L.cls === 'apt' ? curve : 0.55 + 0.45 * curve;
      const kw = L.customers * L.kwPer * fac * (1 + 0.025 * Math.sin(this.s.t / 240 + L.node.length + lid.charCodeAt(5)));
      const f = this.net.src.get(L.node) || L.feeder;
      if (acc[f]) { acc[f].kw += kw; acc[f].cust += L.customers; }
      let n: string | undefined = L.node, g = 0;
      while (n && g++ < 400) {
        const p = this.net.parent.get(n);
        if (!p) break;
        const el = this.T.els[p];
        if (el.kind === 'device') devKw[p] = (devKw[p] ?? 0) + kw;
        n = el.from === n ? el.to : el.from;
      }
    }
    for (const f of this.T.feederIds) {
      const a = acc[f], info = this.T.feeders[f];
      a.amps = a.kw / (1.732 * 12.47 * 0.95);
      const ph = this.s.t / 600;
      a.ia = a.amps * (1 + 0.035 * Math.sin(ph)); a.ib = a.amps * (1 + 0.035 * Math.sin(ph + 2.1)); a.ic = a.amps * (1 + 0.035 * Math.sin(ph + 4.2));
      a.pct = a.amps / info.ratingA;
      a.vEnd = a.amps > 0 ? 1.028 - 0.05 * a.pct * (info.length / 4500) : 0;
      if (a.pct > 1.0) this.alarm(`ovl:${f}`, `${f} LOADING ${Math.round(a.pct * 100)}% of planning limit`, 1, info.breaker);
      else if (a.pct > 0.9) this.alarm(`hi:${f}`, `${f} high loading ${Math.round(a.pct * 100)}%`, 3, info.breaker);
      else { this.clearAlarm(`ovl:${f}`); if (a.pct < 0.85) this.clearAlarm(`hi:${f}`); }
      if (a.amps > 0 && a.vEnd < 0.95) this.alarm(`lv:${f}`, `${f} est. end-of-line voltage low (${(a.vEnd * 120).toFixed(1)} V base)`, 2);
      else this.clearAlarm(`lv:${f}`);
    }
    this.readings = acc;
    this.devKw = devKw;
  }

  devAmps(id: string) { return (this.devKw[id] ?? 0) / (1.732 * 12.47 * 0.95); }

  // ── Operator lockout / hot-line tag ────────────────────────
  /** Open (if closed) and operator-lock a breaker/recloser so nothing can close it until the lockout is removed. */
  lockoutDevice(id: string): string | null {
    const d = this.dev(id), st = this.s.dev[id];
    if (!d || !st) return `Unknown device ${id}`;
    if (!['breaker', 'recloser'].includes(d.type)) return 'Operator lockout applies to breakers and reclosers';
    if (st.tags.includes('OPR-LO')) return `${id} is already locked out`;
    if (!st.open) {
      const r = this.operate(id, 'open', { by: this.live ? 'Operator' : 'SCADA' });
      if (!r.ok) return r.reason ?? 'Open failed';
    }
    st.lockout = true;
    st.tags.push('OPR-LO');
    this.soe(`${id} OPERATOR LOCKOUT — DO NOT CLOSE TAG APPLIED`, 'open', id);
    this.log('SAFETY', 'warn', `${id} (${d.feeder}) opened and locked out by operator`);
    this.decision(`Opened and locked out ${id} (${d.feeder})`);
    this.scen.event?.(this, 'lockout', { dev: id });
    this.bump();
    return null;
  }
  releaseLockout(id: string): string | null {
    const st = this.s.dev[id];
    if (!st?.tags.includes('OPR-LO')) return `${id} is not operator-locked`;
    st.tags = st.tags.filter(t => t !== 'OPR-LO');
    this.soe(`${id} OPERATOR LOCKOUT REMOVED (device remains open)`, 'info', id);
    this.decision(`Removed operator lockout on ${id}`);
    this.bump();
    return null;
  }
  /** Hot-line tag: block automatic reclosing so a fault trips straight to lockout. */
  setNonReclose(id: string, on: boolean): string | null {
    const d = this.dev(id), st = this.s.dev[id];
    if (!d || !st) return `Unknown device ${id}`;
    if (!['breaker', 'recloser'].includes(d.type)) return 'Non-reclose applies to breakers and reclosers';
    if (d.scada && !st.comm) return `${id} SCADA communication failure — cannot change reclosing`;
    st.nonReclose = on;
    this.soe(`${id} ${on ? 'HOT-LINE TAG ON — RECLOSING BLOCKED' : 'HOT-LINE TAG OFF — RECLOSING ENABLED'}`, 'info', id);
    this.decision(`${on ? 'Placed' : 'Removed'} hot-line tag (non-reclose) on ${id}`);
    this.scen.event?.(this, 'nonReclose', { dev: id, on });
    this.bump();
    return null;
  }

  // ── Emergency handling ─────────────────────────────────────
  notify911(): string | null {
    this.log('SAFETY', 'alarm', '911 called by Campus Control — EMS requested to the reported location');
    this.decision('Called 911 / EMS', true);
    this.scen.event?.(this, 'ems', {});
    const F0 = this.s.scen.flags;
    if (F0.cdUnit && F0.cdEms === undefined) { F0.cdEms = this.s.t; this.log('SAFETY', 'good', 'EMS dispatched by 911 — ETA about 7 minutes'); this.schedule(420, 'cd', { name: 'ems' }); }
    this.bump();
    return null;
  }
  declareEmergency(): string | null {
    if (!this.voiced) this.say([['C', 'All units, Campus Control. Emergency traffic only on OPS-1 until further notice. Hold all routine traffic.']], { kind: 'emergency' });
    this.log('RADIO', 'alarm', 'Emergency traffic declared on OPS-1');
    this.decision('Declared emergency traffic', true);
    this.s.scen.flags.emergencyTraffic = true;
    this.scen.event?.(this, 'emergencyTraffic', {});
    if (this.s.scen.flags.cdUnit && this.s.scen.flags.cdEt === undefined) { this.s.scen.flags.cdEt = this.s.t; this.say([['249', 'Campus Control, Supervisor 249. Copy emergency traffic, I am rolling to that location now.']], { unit: '249', kind: 'emergency', start: 3 }); }
    this.bump();
    return null;
  }
  /** Training drill available in every scenario: a crew member is hurt (non-electrical injury). */
  crewDownDrill(): string | null {
    const F = this.s.scen.flags;
    if (F.emT !== undefined || (F.cdUnit && !F.cdDone)) return 'An emergency is already in progress';
    const live = Object.values(this.s.trucks).filter(t => t.comm && t.status !== 'Off Duty' && !t.sw && !t.clearance);
    const busy = live.filter(t => t.task && t.task.kind !== 'home');
    const t = (busy.length ? busy : live)[0];
    if (!t) return 'No crew available to run the drill';
    F.cdUnit = t.id; F.cdT = this.s.t; F.cdDone = false; F.cdEms = undefined; F.cdEt = undefined; F.cdNag = 0;
    t.tok++; t.route = null; t.status = 'Working';
    const loc = this.locOf(t.pos);
    this.alarm('mayday-cd', `EMERGENCY — Truck ${t.id} crew member injured near ${loc}`, 1);
    this.log('SAFETY', 'alarm', `EMERGENCY: Truck ${t.id} reports a crew member injured near ${loc}`);
    this.say([[t.id, `Emergency, emergency, emergency! Campus Control, ${t.id}!`], [t.id, `We have an injured man, he fell from the pole near ${loc}. He is down and in pain. We need EMS here now!`]], { unit: t.id, kind: 'emergency' });
    this.schedule(75, 'cd', { name: 'nag' });
    this.decision(`Crew-down drill started on ${t.id}`);
    this.bump();
    return null;
  }
  /** Set up a crew-down emergency to strike `delaySec` into the exercise (chosen in the scenario picker). */
  scheduleDrill(delaySec: number) { this.s.scen.flags.cdPlanned = delaySec; this.schedule(delaySec, 'cd', { name: 'start' }); }
  private cdEvent(name: string) {
    if (name === 'start') { const r = this.crewDownDrill(); if (r && r.startsWith('No crew') && (this.s.scen.flags.cdRetry ?? 0) < 3) { this.s.scen.flags.cdRetry = (this.s.scen.flags.cdRetry ?? 0) + 1; this.schedule(120, 'cd', { name: 'start' }); } return; }
    const F = this.s.scen.flags; const t = F.cdUnit ? this.s.trucks[F.cdUnit] : null;
    if (!t || F.cdDone) return;
    if (name === 'nag') {
      if (F.cdEms !== undefined || (F.cdNag ?? 0) >= 3) return;
      F.cdNag = (F.cdNag ?? 0) + 1;
      this.say([[t.id, `Campus Control, ${t.id}! Has anyone called 911? We still have nobody here!`]], { unit: t.id, kind: 'emergency' });
      this.schedule(75, 'cd', { name: 'nag' });
    } else if (name === 'ems') {
      this.say([[t.id, `Control, ${t.id}. EMS is on scene and taking over patient care.`]], { unit: t.id, kind: 'emergency' });
      this.schedule(300, 'cd', { name: 'transport' });
    } else if (name === 'transport') {
      this.say([[t.id, `Control, ${t.id}. EMS is transporting to Sparks Regional. ${t.id} will be out of service.`]], { unit: t.id, kind: 'emergency' });
      if (t.task?.kind === 'incident') { const inc = this.s.incidents[t.task.id]; if (inc) { inc.crew = null; if (inc.status !== 'Restored' && inc.status !== 'Closed') inc.status = 'New'; inc.timeline.push({ t: this.s.t, text: `Truck ${t.id} out of service (crew injury)` }); } }
      t.task = null; t.status = 'Off Duty'; t.tok++; t.route = null;
      F.cdDone = true; this.clearAlarm('mayday-cd');
      this.decision(`Crew-down drill complete — 911 called ${F.cdEms !== undefined ? Math.round(F.cdEms - F.cdT) + 's after the call' : 'never'}`, F.cdEms !== undefined && F.cdEms - F.cdT < 120);
    }
    this.bump();
  }
  /** Tell the crew at an emergency that the line is dead (rescue scenario). */
  confirmDead(): string | null {
    this.scen.event?.(this, 'confirmDead', {});
    this.bump();
    return null;
  }
  setVoiceRadio(on: boolean) { this.s.voiceRadio = on; this.bump(); }

  // ── Operator voice transmissions ───────────────────────────
  /** The operator keyed up and said `text`. Logs it, works out who was addressed and what was asked, and acts. */
  /** Compact, non-secret situation summary sent to the optional AI phraseology normalizer. */
  aiContext() {
    return {
      units: Object.keys(this.s.trucks),
      lastUnit: this.s.radioCtx && this.s.t - this.s.radioCtx.t < 120 ? this.s.radioCtx.unit : null,
      incidents: this.openIncidents().filter(i => i.status !== 'Restored').slice(0, 8).map(i => ({ id: i.id, dev: i.predDev, crew: i.crew ?? null })),
      pending: this.s.requests.filter(r => r.status === 'Pending').map(r => ({ truck: r.truck, type: r.type, dev: r.dev ?? null })),
      repeatBack: Object.values(this.s.orders).filter(o => o.status === 'Active' && o.steps[o.cur]?.status === 'RepeatBack').map(o => ({ truck: o.steps[o.cur].exec, step: `${o.steps[o.cur].action} ${o.steps[o.cur].dev}` })),
      activeStep: Object.values(this.s.orders).filter(o => o.status === 'Active').map(o => ({ truck: o.steps[o.cur]?.exec, step: `${o.steps[o.cur]?.action} ${o.steps[o.cur]?.dev}` })),
      emergency: this.s.scen.flags.emT !== undefined && this.s.scen.flags.confT === undefined,
    };
  }

  /** Run an operator transmission but capture the crew's replies for AI wording. */
  voiceTxHeld(text: string, display?: string) {
    this.holdBuf = [];
    let err: string | null = null;
    try { err = this.voiceTx(text, display); } finally { /* keep buffer */ }
    const lines = this.holdBuf; this.holdBuf = null;
    return { err, lines };
  }
  /** Send captured (or AI-worded) crew lines to the radio. */
  emitHeld(lines: { sp: Speaker; text: string; kind: 'routine' | 'switching' | 'emergency'; unit: string }[]) {
    let at = 1.2;
    for (const l of lines) { this.schedule(at, 'radio', { sp: l.sp, text: l.text, kind: l.kind, unit: l.unit }); at += 2.2 + l.text.length / 20; }
    this.bump();
  }
  /** A crew reply worded by the AI. Only rostered units can speak. */
  crewSay(unit: string, text: string, kind: 'routine' | 'switching' | 'emergency' = 'routine') {
    if (unit !== '249' && !this.s.trucks[unit]) return;
    this.emitHeld([{ sp: unit as Speaker, text: text.slice(0, 280), kind, unit }]);
  }
  /** Rich, read-only snapshot for the AI crew voice. */
  aiCrewContext(unit: string | null) {
    const t = unit ? this.s.trucks[unit] : null;
    const inc = t?.task?.kind === 'incident' ? this.s.incidents[t.task.id] : null;
    return {
      time: this.hhmm(),
      truck: t ? { id: t.id, crew: t.crew, status: t.status, location: this.locOf(t.pos), task: t.task, commOk: t.comm } : null,
      incident: inc ? { id: inc.id, status: inc.status, stage: inc.stage, device: inc.predDev, customersOut: inc.custOut, hazard: inc.hazard } : null,
      recentRadio: this.s.radio.slice(-8).map(m => `${m.from}: ${m.text}`),
      emergency: this.s.scen.flags.emT !== undefined && this.s.scen.flags.confT === undefined,
    };
  }

  voiceTx(text: string, display?: string): string | null {
    const raw = text.trim();
    if (!raw) return null;
    const shown = (display ?? raw).trim();
    this.radioNow('C', shown.charAt(0).toUpperCase() + shown.slice(1), 'operator', '');
    const units = Object.keys(this.s.trucks);
    const p = parseRadio(raw, units, id => !!this.T.els[id]);
    const n = p.norm;
    const has = (re: RegExp) => re.test(n);
    const ctx = this.s.radioCtx && this.s.t - this.s.radioCtx.t < 120 ? this.s.radioCtx.unit : null;
    const pend = this.s.requests.filter(r => r.status === 'Pending');
    const repeatSteps = Object.values(this.s.orders).filter(o => o.status === 'Active' && o.steps[o.cur]?.status === 'RepeatBack');
    let unit = p.units.find(u => u !== '249') ?? (p.units.includes('249') ? '249' : null);
    if (!unit) unit = ctx;
    if (!unit && repeatSteps.length === 1) unit = repeatSteps[0].steps[repeatSteps[0].cur].exec;
    if (!unit && pend.length === 1) unit = pend[0].truck;
    const reply = (u: string, msg: string, kind: 'routine' | 'switching' | 'emergency' = 'routine') => this.say([[u, msg]], { unit: u, kind, start: 1.5 });
    const done = (r: string | null) => { if (unit) this.s.radioCtx = { unit, t: this.s.t }; this.bump(); return r; };
    this.voiced = true;
    try {
      // 1. Emergency traffic (no unit needed)
      if (has(/\b(emergency traffic|all units|clear the (channel|air|frequency)|hold all (routine )?traffic)\b/)) { this.declareEmergency(); if (!has(/\b(dead|de ?energi[sz]ed|locked out)\b/)) return done(null); }
      // 2. Rescue: line is dead
      if (this.s.scen.flags.emT !== undefined && !this.s.scen.flags.confT && has(/\b(dead|de ?energi[sz]ed|locked out|line is (open|out|clear))\b/)) { this.confirmDead(); return done(null); }
      if (!unit) { this.log('RADIO', 'warn', 'Transmission not addressed to a unit — nobody answered. Start with the truck number.'); return done('No unit addressed — start with the truck number, e.g. "Truck 233, Campus Control"'); }
      if (unit !== '249' && !this.s.trucks[unit]) return done(`Truck ${unit} is not on the roster`);
      const tr = this.s.trucks[unit];
      if (tr && !tr.comm) { this.schedule(14, 'noResponse', { truck: unit }); this.s.metrics.contacts++; this.s.scen.flags.contactAttempts = (this.s.scen.flags.contactAttempts ?? 0) + 1; this.decision(`Radio call to ${unit} — no response`); return done(null); }
      const myReq = (type: string) => pend.find(r => r.truck === unit && r.type === type);
      const yes = has(/\b(correct|affirm(ative)?|perform|execute|proceed|that is right|thats right|that's right)\b/) && !has(/\b(in ?correct|not correct)\b/);
      const no = has(/\b(negative|incorrect|not correct|wrong|say again|repeat)\b/);
      // 3. Repeat-back confirmation
      const rb = repeatSteps.find(o => o.steps[o.cur].exec === unit);
      if (rb && (yes || no)) return done(this.confirmRepeat(rb.id, yes && !no));
      // 4. Supervisor pressure
      const pr = pend.find(r => r.type === 'pressure');
      if (unit === '249' && pr) { if (no || has(/\b(no|stays|hold|cannot|can't|not going)\b/)) return done(this.deny(pr.id)); if (has(/\b(ok|okay|will close|closing|go ahead)\b/)) return done(this.approve(pr.id)); }
      // 5. Pending requests from this unit
      const hl = myReq('hotline');
      if (hl && has(/\b(hot ?line|non ?reclose|tag (is )?(on|placed|hung|applied)|clear (for|to start) (energized )?work)\b/)) return done(this.approve(hl.id));
      if (hl && has(/\b(stand ?by|hold|not yet)\b/)) return done(this.deny(hl.id));
      const rel = myReq('release');
      if (rel && has(/\b(releas|copy|acknowledg)/)) return done(this.approve(rel.id));
      const clr = myReq('clearance');
      if (clr && has(/\b(clearance|you have the (line|section)|issued|tagged)\b/) && !has(/\b(unable|stand ?by|hold)\b/)) return done(this.approve(clr.id));
      if (clr && has(/\b(unable|stand ?by|hold)\b/)) return done(this.deny(clr.id));
      const cl = myReq('close');
      if (cl && has(/\b(permission granted|granted|go ahead|ok(ay)? to (close|refuse|re fuse)|clear to close|close it|you can close|you may close)\b/)) return done(this.approve(cl.id));
      if (cl && has(/\b(hold|stand ?by|not yet|do not close|don't close)\b/)) return done(this.deny(cl.id));
      // 6. Switching instruction
      const act = has(/\bopen\b/) ? 'open' : has(/\bclose\b/) ? 'close' : null;
      if (act && p.devs.length && unit !== '249') {
        const dev = p.devs.find(x => !x.startsWith('CB') || p.devs.length === 1) ?? p.devs[0];
        const ord = Object.values(this.s.orders).find(o => o.status === 'Active' && ['Pending', 'Failed'].includes(o.steps[o.cur]?.status) && o.steps[o.cur].exec === unit);
        if (!ord) {
          this.decision(`Gave ${unit} a verbal switching instruction (${act} ${dev}) with no active switching order`, false);
          reply(unit, `Campus Control, ${unit}. I don't show ${act === 'open' ? 'opening' : 'closing'} ${dev} on an active switching order. Give me the order and step number before we operate.`, 'switching');
          return done(null);
        }
        const st = ord.steps[ord.cur];
        if (st.dev !== dev || st.action !== act) {
          reply(unit, `Campus Control, ${unit}. That doesn't match ${ord.id} step ${ord.cur + 1}. I show step ${ord.cur + 1} as ${st.action} ${st.dev}. Please verify.`, 'switching');
          this.decision(`Switching instruction to ${unit} did not match ${ord.id} step ${ord.cur + 1}`, false);
          return done(null);
        }
        return done(this.issueStep(ord.id));
      }
      // 7. Welfare check on another unit
      const other = p.units.find(u => u !== unit && u !== '249');
      if (other && has(/\b(check on|welfare|make contact|go find|check the crew)\b/)) return done(this.welfareCheck(unit, other));
      // 8. Recall
      if (has(/\b(return|head back|go back|come back|come in)\b/) && has(/\b(shop|yard|service center|barn|base|home)\b/)) return done(this.recall(unit));
      // 9. Dispatch to an incident
      const wantsDispatch = p.incs.length > 0 || has(/\b(respond|go to|head (over )?to|en route|check (on|out)|investigate|take (the|that)|go check|go look|outage|lockout|trouble)\b/);
      if (wantsDispatch && unit !== '249') {
        const open = this.openIncidents().filter(i => i.status !== 'Restored');
        let inc = p.incs.map(id => this.s.incidents[id]).find(Boolean);
        if (!inc && p.devs.length) inc = open.find(i => p.devs.includes(i.predDev) || (i.truthDev && p.devs.includes(i.truthDev)));
        if (!inc) {
          const words = n.split(' ').filter(w => w.length > 3);
          inc = open.find(i => { const loc = (i.kind === 'single' ? this.T.loads[i.loadId!].addr : this.dev(i.predDev).loc).toLowerCase(); return words.some(w => loc.includes(w)); });
        }
        if (!inc) { const un = open.filter(i => !i.crew).sort((a, b) => a.priority - b.priority || a.t - b.t); if (un.length === 1 || (un.length && has(/\b(highest|priority|p1|worst|biggest)\b/))) inc = un[0]; }
        if (!inc) { reply(unit, `Campus Control, ${unit}. Say again the incident number or location.`); return done(null); }
        const err = this.dispatch(unit, inc.id);
        if (err) reply(unit, `Campus Control, ${unit}. Unable, ${err.toLowerCase()}.`);
        return done(err);
      }
      // 10. Status
      if (has(/\b(status|where are you|what's your|whats your|location|your 20|20)\b/)) { this.statusCheck(unit); return done(null); }
      // 11. Call-up only
      if (has(/\b(sparks control|control)\b/) && p.devs.length === 0 && p.incs.length === 0 && n.split(' ').length <= 6) { reply(unit, unit === '249' ? '249, go ahead.' : `${unit}, go ahead.`); return done(null); }
      // 12. Plain acknowledgment
      if (has(/^(\w+ )?(\d+ )?(copy|copies|10 4|ten four|roger|ok|okay|thank you|thanks|received|understood)\b/) || has(/\bcopy\b/)) return done(null);
      reply(unit, `Campus Control, ${unit === '249' ? '249' : unit}, say again your last?`);
      return done('Crew did not understand — try standard phraseology (unit, action, device or incident)');
    } finally {
      this.voiced = false;
    }
  }

  /** Exercise-period reliability indices (IEEE 1366 style, simplified: every interruption counts as sustained). */
  reliability() {
    const N = this.T.totalCustomers, m = this.s.metrics;
    const incs = Object.values(this.s.incidents).filter(i => i.kind === 'outage' || i.kind === 'single');
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
    const resp = incs.filter(i => i.onSceneT != null).map(i => i.onSceneT! - i.t);
    const disp = incs.filter(i => i.firstDispatchT != null).map(i => i.firstDispatchT! - i.t);
    const rest = incs.filter(i => i.restoredT != null && i.kind === 'outage').map(i => i.restoredT! - i.t);
    return {
      N, ci: m.ci, cmi: m.cmi, mom: m.momentary,
      saidi: m.cmi / N, saifi: m.ci / N, caidi: m.ci ? m.cmi / m.ci : 0, maifi: m.momentary / N,
      avgDispatch: avg(disp), avgResp: avg(resp), avgRestore: avg(rest),
      worstResp: resp.length ? Math.max(...resp) : null, incidents: incs.length,
    };
  }

  // ── Crew roster (operator-managed) ─────────────────────────
  rosterAdd(id: string, crew: string, type: string, quiet = false): string | null {
    id = String(id).trim();
    if (this.live) {
      id = id.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 8);
      if (!id) return 'Enter a name';
      if (this.s.trucks[id]) return `${id} is already on the board`;
      const tr = this.addTruck(id, SERVICE_CENTER);
      tr.crew = crew.trim() || id; tr.type = type.trim() || 'Instructor';
      tr.home = SERVICE_CENTER;
      this.log('DISPATCH', 'good', `${tr.crew} (${tr.type}) added to the unit board`);
      this.bump();
      return null;
    }
    if (!/^\d{2,4}$/.test(id)) return 'Truck number must be 2–4 digits';
    if (this.s.trucks[id]) return `Truck ${id} is already on the roster`;
    const tr = this.addTruck(id, SERVICE_CENTER);
    tr.crew = crew.trim() || 'Crew'; tr.type = type.trim() || 'Bucket';
    if (!quiet) {
      this.say([[id, `Campus Control, ${id} on duty at the service center, ${tr.type.toLowerCase()}, ready for assignment.`], ['C', `Copy ${id}.`]], { unit: id });
      this.log('DISPATCH', 'good', `Truck ${id} (${tr.crew}) added to roster`);
      this.decision(`Added Truck ${id} to roster`);
    }
    this.schedule(60 + this.rand() * 60, 'woPick', { truck: id, tok: tr.tok });
    this.bump();
    return null;
  }
  rosterEdit(id: string, crew: string, type: string): string | null {
    const tr = this.s.trucks[id];
    if (!tr) return `Truck ${id} not on roster`;
    if (crew.trim()) tr.crew = crew.trim();
    if (type.trim()) tr.type = type.trim();
    this.bump();
    return null;
  }
  rosterRemove(id: string): string | null {
    const tr = this.s.trucks[id];
    if (!tr) return `Truck ${id} not on roster`;
    if (tr.clearance) return `Truck ${id} holds clearance ${tr.clearance} — release it first`;
    if (tr.sw) return `Truck ${id} is in the middle of switching`;
    if (tr.task?.kind === 'planned') return `Truck ${id} is assigned to planned job ${tr.task.id}`;
    if (tr.task?.kind === 'incident') {
      const inc = this.s.incidents[tr.task.id];
      if (inc && inc.crew === id) { inc.crew = null; if (inc.status !== 'Restored' && inc.status !== 'Closed') inc.status = 'New'; inc.timeline.push({ t: this.s.t, text: `Truck ${id} removed from roster — incident unassigned` }); }
    }
    if (tr.task?.kind === 'workorder') { const wo = this.s.workorders[tr.task.id]; if (wo) { wo.status = 'Open'; wo.truck = undefined; } }
    for (const r of this.s.requests) if (r.truck === id && r.status === 'Pending') r.status = 'Denied';
    delete this.s.trucks[id];
    this.log('DISPATCH', 'warn', `Truck ${id} removed from roster (off duty)`);
    this.decision(`Removed Truck ${id} from roster`);
    this.bump();
    return null;
  }

  customersOut() { let n = 0; for (const lid of Object.keys(this.s.loadOutSince)) n += this.T.loads[lid].customers; return n; }

  // ── Random activity generators ─────────────────────────────
  private handleGen(g: string) {
    const mean = this.scen.background[g as keyof ScenarioDef['background']];
    const flags = this.s.scen.flags;
    if (!mean || flags.genOff?.[g]) return;
    this.genEvent(g);
    this.schedule(this.expo(mean), 'gen', { g });
  }

  genEvent(g: string) {
    const energizedLoads = this.T.loadIds.filter(l => this.loadEn(l) && this.T.loads[l].cls !== 'critical' && !this.s.planned[l]);
    switch (g) {
      case 'xfmr': {
        const lid = this.pick(energizedLoads.filter(l => this.T.loads[l].cls !== 'ind'));
        if (!lid) return;
        const f = this.createFault(lid, true, this.pick(['animal', 'animal', 'xfmr_failure'] as Cause[]), true);
        this.applyFault(f); break;
      }
      case 'lateral': {
        const fuses = Object.keys(this.T.laterals).filter(fz => !this.s.dev[fz].open && this.nodeEn(this.dev(fz).to));
        const fz = this.pick(fuses); if (!fz) return;
        const el = this.pick(this.T.laterals[fz].els);
        const f = this.createFault(el, false, this.pick(['tree_lateral', 'animal', 'tree_lateral', 'vehicle'] as Cause[]), true);
        this.applyFault(f); break;
      }
      case 'momentary': {
        const fid = this.pick(this.T.feederIds);
        const el = this.pick(this.T.feeders[fid].mainEls.slice(2));
        if (!this.elEnergized(el)) return;
        const f = this.createFault(el, false, this.pick(['temporary', 'lightning'] as Cause[]), false);
        this.applyFault(f); break;
      }
      case 'single': {
        const lid = this.pick(energizedLoads.filter(l => this.T.loads[l].cls === 'res'));
        if (lid) this.schedule(5, 'call', { load: lid, kind: 'single' });
        break;
      }
      case 'comm': {
        const scada = this.T.switchable.filter(x => this.dev(x).scada && this.dev(x).type !== 'breaker' && this.s.dev[x].comm);
        const d = this.pick(scada);
        if (d) this.handleDevComm(d, false);
        break;
      }
      case 'mainline': {
        const fid = this.pick(this.T.feederIds);
        const els = this.T.feeders[fid].mainEls.slice(3).filter(e => this.elEnergized(e));
        const el = this.pick(els); if (!el) return;
        const f = this.createFault(el, false, this.pick(['tree_primary', 'insulator'] as Cause[]), true, this.rand() < 0.4);
        this.applyFault(f); break;
      }
    }
  }

  /** Mainline line element between two devices on a feeder (used by scenarios). */
  // ══ CAMPUS OPS LIVE ACTIONS ═══════════════════════════════
  // Real people do the work on real radios; the operator records it here.
  private unitName(id: string) { return this.s.trucks[id]?.crew || id; }

  /** Record a field operation the instructor reported by radio. */
  liveOperate(id: string, action: 'open' | 'close', unit: string): string | null {
    const r = this.operate(id, action, { by: unit || 'Operator' });
    if (!r.ok) { this.log('DISPATCH', 'warn', `Not recorded: ${r.reason}`); this.bump(); return r.reason ?? 'Rejected'; }
    this.decision(`${action === 'open' ? 'Opened' : 'Closed'} ${id}${unit ? ` (${this.unitName(unit)})` : ''}`);
    this.bump(); return null;
  }

  /** Switching order: instructor reported the step complete. */
  liveStepDone(oid: string): string | null {
    const o = this.s.orders[oid];
    const st = o?.steps[o.cur];
    if (!o || !st || st.status !== 'InProgress') return 'No step in progress';
    const tr = this.truck(st.exec);
    const r = this.operate(st.dev, st.action, { by: st.exec, loopOk: st.loop, order: oid });
    if (!r.ok) { st.status = 'Failed'; st.note = r.reason; if (tr) { tr.sw = null; this.restoreTruckStatus(tr); } this.bump(); return r.reason ?? 'Failed'; }
    st.status = 'Done'; st.doneT = this.s.t;
    if (tr) { tr.sw = null; if (!tr.clearance) tr.status = tr.task ? 'Working' : 'Available'; }
    this.log('DISPATCH', 'good', `${oid} step ${o.cur + 1} complete — ${st.dev} ${st.action === 'open' ? 'OPEN' : 'CLOSED'} (${tr?.crew ?? st.exec})`);
    this.advanceOrder(o);
    this.bump(); return null;
  }

  /** Issue a clearance to an instructor on the section around a device or line. */
  liveClearance(unit: string, elId: string, purpose: string): string | null {
    const tr = this.truck(unit);
    if (!tr) return 'Pick who the clearance is issued to';
    if (tr.clearance) return `${tr.crew} already holds ${tr.clearance}`;
    const r = this.request('clearance', unit, purpose || 'Work on section', { dev: elId });
    const err = this.issueClearance(r);
    if (err) { r.status = 'Denied'; this.bump(); return err; }
    this.bump(); return null;
  }

  /** Holder released the clearance by radio. */
  liveRelease(clId: string): string | null {
    const cl = this.s.clearances[clId];
    if (!cl || cl.status !== 'Active') return 'No active clearance';
    this.request('release', cl.truck, `Release of ${cl.id}`, { devs: cl.devs });
    const err = this.releaseClearance(cl.id, false);
    const tr = this.truck(cl.truck);
    if (!err && tr) tr.status = tr.task ? 'Working' : 'Available';
    this.bump(); return err;
  }

  /** Unit board status (instructor reported it by radio). */
  liveUnitStatus(id: string, status: CrewStatus): string | null {
    const tr = this.truck(id);
    if (!tr) return 'Unknown unit';
    if (status === 'Available' && tr.clearance) return `${tr.crew} still holds clearance ${tr.clearance}`;
    const prev = tr.status;
    tr.status = status;
    tr.route = null;
    const wo = tr.task?.kind === 'workorder' ? this.s.workorders[tr.task.id] : undefined;
    if ((status === 'On Scene' || status === 'Working') && wo) tr.pos = wo.pos;
    if (status === 'Available' || status === 'Off Duty') { if (tr.task?.kind === 'workorder' && wo && !['Done', 'Canceled'].includes(wo.status)) { /* keep order open, unit just freed */ wo.truck = undefined; wo.status = 'Open'; this.woLog(wo, 'Operator', `${tr.crew} cleared — order back to Open`); } tr.task = null; tr.sw = null; tr.pos = tr.home; }
    if (prev !== status) this.log('DISPATCH', 'info', `${tr.crew}: ${prev} → ${status}`);
    this.bump(); return null;
  }

  private woLog(wo: WorkOrder, by: string, text: string) { (wo.history ??= []).push({ t: this.s.t, by, text }); }

  /** Create a work order from a radio call or typed request. */
  liveWoCreate(d: { issue: string; priority?: WoPriority; item?: string | null; pos?: LatLng | null; loc?: string; assignee?: string; caller?: string; by?: string; source?: 'radio' | 'typed' }): string | null {
    const issue = (d.issue || '').trim();
    if (!issue) return 'Issue is required';
    const id = this.nextId('WO', 1000);
    const pos: LatLng = d.pos ?? SERVICE_CENTER;
    const wo: WorkOrder = {
      id, type: issue.slice(0, 60), issue, pos, loc: d.loc || nearestName(pos), dur: 0, status: 'Open',
      priority: d.priority ?? 'Routine', item: d.item ?? null, caller: (d.caller || '').trim(), createdT: this.s.t,
      createdBy: (d.by || 'Operator').trim(), source: d.source ?? 'typed', history: [],
    };
    this.s.workorders[id] = wo;
    this.woLog(wo, wo.createdBy!, `Created (${wo.source === 'radio' ? 'radio call' : 'typed'})${wo.caller ? ` — called in by ${wo.caller}` : ''}`);
    this.log('OMS', wo.priority === 'Emergency' ? 'alarm' : wo.priority === 'Urgent' ? 'warn' : 'info', `${id} ${(wo.priority ?? "Routine").toUpperCase()} — ${wo.loc}: ${issue}`);
    if (wo.priority === 'Emergency') this.alarm(`wo:${id}`, `EMERGENCY work order ${id} — ${wo.loc}: ${issue}`, 1);
    if (d.assignee) this.liveWoUpdate(id, { assignee: d.assignee }, wo.createdBy);
    this.bump();
    return id;
  }

  liveWoUpdate(id: string, ch: { status?: string; priority?: WoPriority; assignee?: string; note?: string; issue?: string }, by = 'Operator'): string | null {
    const wo = this.s.workorders[id];
    if (!wo) return 'Unknown work order';
    if (ch.issue !== undefined && ch.issue.trim() && ch.issue.trim() !== wo.issue) { wo.issue = ch.issue.trim(); wo.type = wo.issue.slice(0, 60); this.woLog(wo, by, 'Issue edited'); }
    if (ch.priority && ch.priority !== wo.priority) {
      this.woLog(wo, by, `Priority: ${wo.priority} → ${ch.priority}`); wo.priority = ch.priority;
      if (ch.priority === 'Emergency') this.alarm(`wo:${id}`, `EMERGENCY work order ${id} — ${wo.loc}: ${wo.issue}`, 1); else this.clearAlarm(`wo:${id}`);
    }
    if (ch.assignee !== undefined && ch.assignee !== (wo.truck ?? '')) {
      const old = wo.truck ? this.truck(wo.truck) : undefined;
      if (old && old.task?.kind === 'workorder' && old.task.id === id) { old.task = null; if (!old.clearance && !old.sw) { old.status = 'Available'; old.pos = old.home; } }
      if (ch.assignee) {
        const tr = this.truck(ch.assignee);
        if (!tr) return 'Unknown unit';
        if (tr.task?.kind === 'workorder' && tr.task.id !== id) { const prev = this.s.workorders[tr.task.id]; if (prev) { prev.truck = undefined; if (!['Done', 'Canceled'].includes(prev.status)) prev.status = 'Open'; this.woLog(prev, by, `${tr.crew} reassigned to ${id}`); } }
        tr.task = { kind: 'workorder', id }; tr.tok++;
        if (!tr.clearance && !tr.sw) tr.status = 'Dispatched';
        wo.truck = tr.id;
        if (wo.status === 'Open') wo.status = 'Assigned';
        this.woLog(wo, by, `Assigned to ${tr.crew}`);
        this.log('DISPATCH', 'info', `${id} assigned to ${tr.crew}`);
      } else { wo.truck = undefined; if (wo.status === 'Assigned') wo.status = 'Open'; this.woLog(wo, by, 'Unassigned'); }
    }
    if (ch.status && ch.status !== wo.status) {
      this.woLog(wo, by, `Status: ${wo.status} → ${ch.status}`);
      wo.status = ch.status as WorkOrder['status'];
      const tr = wo.truck ? this.truck(wo.truck) : undefined;
      if (tr && tr.task?.kind === 'workorder' && tr.task.id === id) {
        if (wo.status === 'In Progress' && !tr.clearance && !tr.sw) { tr.status = 'Working'; tr.pos = wo.pos; }
        if (wo.status === 'Done' || wo.status === 'Canceled') { tr.task = null; if (!tr.clearance && !tr.sw) { tr.status = 'Available'; tr.pos = tr.home; } }
      }
      if (wo.status === 'Done') { wo.doneT = this.s.t; this.clearAlarm(`wo:${id}`); this.log('OMS', 'good', `${id} complete — ${wo.loc}`); }
      if (wo.status === 'Canceled') { this.clearAlarm(`wo:${id}`); this.log('OMS', 'info', `${id} canceled`); }
      if (wo.status !== 'Done') wo.doneT = undefined;
    }
    if (ch.note && ch.note.trim()) this.woLog(wo, by, `Note: ${ch.note.trim()}`);
    this.bump();
    return null;
  }

  liveClearEmergency(): string | null {
    if (!this.s.scen.flags.emergencyTraffic) return null;
    this.s.scen.flags.emergencyTraffic = false;
    this.log('RADIO', 'good', 'Emergency traffic cleared — normal traffic resumes');
    this.bump(); return null;
  }

  /** Log a radio transmission (what the operator heard or said on the real radio). */
  liveRadio(unit: string, text: string, fromControl: boolean): string | null {
    const t = (text || '').trim();
    if (!t) return null;
    this.s.radio.push({ id: ++this.s.seq, t: this.s.t, from: fromControl ? CONTROL : (unit ? this.unitName(unit).toUpperCase() : 'FIELD'), to: fromControl ? (unit ? this.unitName(unit).toUpperCase() : 'ALL') : CONTROL, text: t, kind: fromControl ? 'operator' : 'routine', unit });
    if (this.s.radio.length > 400) this.s.radio.splice(0, this.s.radio.length - 400);
    this.bump(); return null;
  }

  mainElAfter(devId: string, offset = 1): string {
    const d = this.dev(devId);
    const n = d.to;
    const F = this.T.feeders[d.feeder];
    const idx = F.mainEls.findIndex(e => (this.T.els[e] as LineEl).from === n);
    return F.mainEls[Math.max(0, idx) + offset - 1];
  }
}

export type { SwStep };
