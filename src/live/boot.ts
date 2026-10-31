// Startup: pull the live Pole Yard inventory, the saved network and the
// shared ops board, build the campus model and install it before the
// engine exists.
import { buildCampus, type NetCfg, type YardItem, type CampusModel } from '../sim/campus';
import { installCampus, TOPO } from '../sim/topology';
import type { SimState, DevEl } from '../sim/types';
import { getJson, cacheGet, cacheSet } from './access';

export interface BootData {
  model: CampusModel;
  netSaved: boolean;
  polesLive: boolean;
  state: { s: SimState; readings: any; devKw: any; client: string; at: number } | null;
}
export const BOOT: { data: BootData | null } = { data: null };

const POLES_CACHE = 'campusOpsPoles', NET_CACHE = 'campusOpsNet';

export async function boot(): Promise<BootData> {
  const [pr, nr, sr] = await Promise.all([
    getJson<YardItem[]>('/api/poles'),
    getJson<NetCfg>('/api/network'),
    getJson<BootData['state']>('/api/state'),
  ]);
  let items: YardItem[] = pr.ok && Array.isArray(pr.data) ? pr.data : (cacheGet<YardItem[]>(POLES_CACHE) ?? []);
  if (pr.ok && Array.isArray(pr.data)) cacheSet(POLES_CACHE, pr.data);
  items = items.filter(i => i && i.id && i.lat != null && i.lng != null);
  let cfg: NetCfg | null = null;
  if (nr.ok) { cfg = nr.data; cacheSet(NET_CACHE, cfg); }
  else if (nr.status !== 404) cfg = cacheGet<NetCfg>(NET_CACHE);
  const model = buildCampus(items, cfg);
  installCampus(model);
  const data: BootData = { model, netSaved: !!cfg, polesLive: pr.ok, state: sr.ok && sr.data?.s ? sr.data : null };
  BOOT.data = data;
  if (data.state) data.state.s = reconcile(data.state.s);
  return data;
}

/** Make a saved board fit the current network (devices added / removed since it was saved). */
export function reconcile(s: SimState): SimState {
  const TT = TOPO;
  s.scenario = 'LIVE';
  for (const id of TT.devIds) if (!s.dev[id]) s.dev[id] = { open: (TT.els[id] as DevEl).normalOpen, lockout: false, tags: [], comm: true, ops: 0 };
  for (const id of Object.keys(s.dev)) if (!TT.els[id]) delete s.dev[id];
  for (const id of Object.keys(s.loadOutSince)) if (!TT.loads[id]) delete s.loadOutSince[id];
  for (const id of Object.keys(s.planned)) if (!TT.loads[id]) delete s.planned[id];
  s.faults = {}; s.calls = {}; s.callOrder = []; s.queue = s.queue.filter(q => q.kind === 'radio');
  return s;
}
