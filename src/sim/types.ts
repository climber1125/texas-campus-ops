// ─────────────────────────────────────────────────────────────
// GRID OPS — shared simulation types
// Static topology (built once from code) + serializable SimState
// ─────────────────────────────────────────────────────────────

export type LatLng = [number, number];

export type DevType = 'breaker' | 'recloser' | 'switch' | 'tie' | 'fuse' | 'xfmr';
export type LoadClass = 'res' | 'apt' | 'com' | 'ind' | 'critical';

export interface NetNode { id: string; pos: LatLng; }

export interface LineEl {
  id: string; kind: 'line'; from: string; to: string; feeder: string;
  len: number; ug: boolean; lateral: boolean; tie: boolean; path: LatLng[];
}
export interface DevEl {
  id: string; kind: 'device'; from: string; to: string; feeder: string;
  type: DevType; scada: boolean; normalOpen: boolean; pos: LatLng; loc: string;
}
export type El = LineEl | DevEl;

export interface Load {
  id: string; node: string; feeder: string; customers: number; kwPer: number;
  cls: LoadClass; name?: string; pos: LatLng; xfmr: string; lateral?: string;
  kva: number; addr: string;
}

export interface Substation { id: string; name: string; pos: LatLng; bus: string; mva: number; feeders: string[]; }

export interface SchItem { kind: 'dev' | 'lat' | 'load' | 'tie'; id: string; f: number; node: string; }

export interface FeederInfo {
  id: string; sub: string; color: string; ratingA: number; length: number;
  breaker: string; mainEls: string[]; end: string; sch: SchItem[];
  vertNodes: { pos: LatLng; node: string }[]; ties: string[];
}

export interface Lateral { fuse: string; feeder: string; els: string[]; loads: string[]; street: string; }

export interface Topology {
  nodes: Record<string, NetNode>;
  els: Record<string, El>;
  adj: Record<string, string[]>;
  loads: Record<string, Load>;
  loadIds: string[];
  subs: Record<string, Substation>;
  feeders: Record<string, FeederInfo>;
  feederIds: string[];
  laterals: Record<string, Lateral>;
  devIds: string[];            // all devices incl. xfmr
  switchable: string[];        // breakers, reclosers, switches, ties, fuses
  ties: string[];
  normParent: Record<string, string | undefined>;
  normFeeder: Record<string, string>;
  loadAnc: Record<string, string[]>; // device ancestors of each load (nearest first)
  devLoads: Record<string, string[]>; // loads normally downstream of device
  devCust: Record<string, number>;
  totalCustomers: number;
}

// ── Dynamic state ────────────────────────────────────────────

export interface DevState {
  open: boolean; lockout: boolean; tags: string[]; comm: boolean; ops: number; nonReclose?: boolean;
  tripFault?: string; lastT?: number;
}

export type Cause =
  | 'animal' | 'tree_lateral' | 'xfmr_failure' | 'tree_primary' | 'insulator'
  | 'vehicle' | 'lightning' | 'temporary' | 'planned' | 'contact';

export interface Fault {
  id: string; el: string; onLoad: boolean; cause: Cause; permanent: boolean;
  active: boolean; found: boolean; t: number; pos: LatLng; hazard: boolean;
  desc: string; incident?: string;
}

export type CrewStatus =
  | 'Available' | 'Dispatched' | 'En Route' | 'On Scene' | 'Working'
  | 'Standing By' | 'Switching' | 'Out of Contact' | 'Off Duty';

export interface Route { pts: LatLng[]; cumT: number[]; total: number; t0: number; tok: number; purpose: string; }

export type Task =
  | { kind: 'incident'; id: string; stage: string }
  | { kind: 'workorder'; id: string }
  | { kind: 'planned'; id: string }
  | { kind: 'welfare'; target: string }
  | { kind: 'home' };

export interface Truck {
  id: string; crew: string; type: string; pos: LatLng; heading: number;
  status: CrewStatus; route: Route | null; task: Task | null; tok: number;
  comm: boolean; home: LatLng;
  sw: { order: string; idx: number } | null;
  waitIso: { inc: string; devs: string[]; purpose: string } | null;
  clearance: string | null;
}

export type IncStatus =
  | 'New' | 'Dispatched' | 'En Route' | 'On Scene' | 'Working'
  | 'Partially Restored' | 'Restored' | 'Closed';

export interface Incident {
  id: string; t: number; kind: 'outage' | 'single'; source: 'SCADA' | 'Calls' | 'AMI' | 'Planned';
  truthDev: string | null; predDev: string; feeder: string; loadId?: string;
  status: IncStatus; priority: 1 | 2 | 3; critical: boolean; hazard: boolean;
  calls: string[]; callLoads: string[]; crew: string | null; crewHistory: string[];
  etr: number | null; cause: string | null; faults: string[];
  timeline: { t: number; text: string }[]; custOut: number; peak: number;
  stage: 'Assess' | 'Isolate' | 'Repair' | 'Restore' | 'Verify' | 'Done';
  isolation: string[]; firstDispatchT: number | null; restoredT: number | null; closedT: number | null;
  onSceneT?: number | null; cmi?: number;
}

export interface Call {
  id: string; t: number; load: string; pos: LatLng; addr: string; remark: string;
  hazard: boolean; incident: string | null; kind: 'outage' | 'momentary' | 'single';
}

export interface Alarm {
  id: string; key: string; t: number; text: string; pri: 1 | 2 | 3; dev?: string;
  acked: boolean; active: boolean;
}

export interface Soe { t: number; text: string; dev?: string; kind: 'trip' | 'close' | 'open' | 'alarm' | 'info' | 'reclose'; }

export interface RadioMsg { id: number; t: number; from: string; to: string; text: string; kind: 'routine' | 'switching' | 'emergency' | 'system' | 'operator'; unit: string; audio?: string; dur?: number; }

export interface LogEntry { id: number; t: number; cat: 'SCADA' | 'OMS' | 'DISPATCH' | 'RADIO' | 'SYSTEM' | 'SAFETY' | 'SCENARIO'; level: 'info' | 'warn' | 'alarm' | 'good'; text: string; }

export type ReqType = 'close' | 'clearance' | 'release' | 'pressure' | 'hotline';
export interface Request {
  id: string; t: number; type: ReqType; truck: string; inc?: string; dev?: string; devs?: string[];
  text: string; status: 'Pending' | 'Approved' | 'Denied' | 'Done';
}

export type StepStatus = 'Pending' | 'Issued' | 'RepeatBack' | 'InProgress' | 'Done' | 'Failed';
export interface SwStep {
  dev: string; action: 'open' | 'close'; exec: string; // 'SCADA' or truck id
  loop: boolean; status: StepStatus; rbDev?: string; rbAction?: 'open' | 'close'; note?: string; doneT?: number;
  injectError?: boolean; injectErrorDev?: string;
}
export interface SwitchingOrder {
  id: string; title: string; steps: SwStep[]; status: 'Draft' | 'Active' | 'Complete' | 'Cancelled';
  cur: number; created: number; holdAfter?: number; // hold point (step index) until clearance released
}

export interface Clearance {
  id: string; truck: string; devs: string[]; nodes: string[]; issued: number; released: number | null;
  status: 'Active' | 'Released'; purpose: string; inc?: string;
}

export type WoPriority = 'Emergency' | 'Urgent' | 'Routine';
export type WoStatus = 'Open' | 'Assigned' | 'In Progress' | 'On Hold' | 'Done' | 'Canceled';
export interface WorkOrder {
  id: string; type: string; pos: LatLng; loc: string; dur: number; status: WoStatus; truck?: string;
  // Campus Ops live fields
  issue?: string; priority?: WoPriority; item?: string | null; caller?: string; createdT?: number; createdBy?: string;
  source?: 'radio' | 'typed'; doneT?: number; history?: { t: number; by: string; text: string }[];
}

export interface Violation { t: number; code: string; text: string; }
export interface Decision { t: number; text: string; good?: boolean; }

export interface ObjState { status: 'pending' | 'pass' | 'fail'; t?: number; note?: string; }

export interface QItem { t: number; seq: number; kind: string; data: any; }

export interface SimState {
  version: 2;
  seed: number; scenario: string; t: number; startEpoch: number;
  speed: number; paused: boolean; rng: number; seq: number;
  queue: QItem[];
  dev: Record<string, DevState>;
  faults: Record<string, Fault>;
  loadOutSince: Record<string, number>;
  planned: Record<string, true>;
  trucks: Record<string, Truck>;
  incidents: Record<string, Incident>;
  calls: Record<string, Call>;
  callOrder: string[];
  alarms: Alarm[];
  soe: Soe[];
  radio: RadioMsg[];
  log: LogEntry[];
  requests: Request[];
  orders: Record<string, SwitchingOrder>;
  clearances: Record<string, Clearance>;
  workorders: Record<string, WorkOrder>;
  metrics: { cmi: number; ci: number; momentary: number; violations: Violation[]; decisions: Decision[]; dispatchTimes: number[]; contacts: number; };
  scen: { id: string; obj: Record<string, ObjState>; flags: Record<string, any>; done: boolean; startT: number; aarShown: boolean };
  autoAssist: boolean;
  voiceRadio?: boolean; radioCtx?: { unit: string; t: number } | null;
  weather: { text: string; level: 'normal' | 'watch' | 'warning' };
  loopSince: number | null;
  ids: Record<string, number>;
}

export interface FeederReading {
  kw: number; amps: number; ia: number; ib: number; ic: number; pct: number; vEnd: number;
  cust: number; custOut: number; src: string;
}
