// ─────────────────────────────────────────────────────────────
// NLC CAMPUS OPS — no road network on the yard. Units travel in a
// straight line at walking/cart speed; location names come from the
// nearest pole / pad-mount label (see campus.ts).
// ─────────────────────────────────────────────────────────────
import type { LatLng } from './types';
import { dist } from './geo';
import { campusName } from './campus';

export interface RoadDef { name: string; short: string; cls: 'hwy' | 'art' | 'col'; pts: LatLng[]; }
export interface Zone { name: string; cls: string; b: [number, number, number, number]; }
export const ROADS: RoadDef[] = [];
export const ZONES: Zone[] = [];
export const CREEK: LatLng[] = [];
export function zoneAt(_p: LatLng): Zone | null { return null; }
export function localStreets(): LatLng[][] { return []; }
export function nearestName(p: LatLng): string { return campusName(p); }

export interface RouteResult { pts: LatLng[]; cumT: number[]; total: number; }
/** Straight-line move across the yard at ~2.5 m/s. */
export function route(a: LatLng, b: LatLng): RouteResult {
  const d = dist(a, b);
  return { pts: [a, b], cumT: [0, d / 2.5], total: d / 2.5 };
}

/** Ops office / unit staging point. Set at startup from the yard model. */
export let SERVICE_CENTER: LatLng = [33.1935, -97.1760];
export function setServiceCenter(p: LatLng) { SERVICE_CENTER = p; }
