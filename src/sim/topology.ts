// ─────────────────────────────────────────────────────────────
// NLC CAMPUS OPS — the active topology. Built at startup from the
// live Pole Yard inventory + the saved network (see campus.ts), then
// installed here before the engine is created. Every module that
// imports TOPO / SUB_SPECS sees the installed model (live bindings).
// ─────────────────────────────────────────────────────────────
import type { Topology, LatLng } from './types';
import type { CampusModel } from './campus';
import { setServiceCenter } from './roads';

export let TOPO: Topology = {
  nodes: {}, els: {}, adj: {}, loads: {}, loadIds: [], subs: {}, feeders: {}, feederIds: [], laterals: {},
  devIds: [], switchable: [], ties: [], normParent: {}, normFeeder: {}, loadAnc: {}, devLoads: {}, devCust: {}, totalCustomers: 0,
};
export let SUB_SPECS: { id: string; name: string; pos: LatLng; bus: LatLng; mva: number }[] = [];
export let CAMPUS: CampusModel | null = null;

export function installCampus(m: CampusModel) {
  TOPO = m.T;
  SUB_SPECS = m.subs;
  CAMPUS = m;
  setServiceCenter(m.home);
}
