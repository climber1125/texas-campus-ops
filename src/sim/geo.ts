import type { LatLng } from './types';

const M_PER_DEG = 111320;

/** Equirectangular distance in meters (accurate enough at city scale). */
export function dist(a: LatLng, b: LatLng): number {
  const la = ((a[0] + b[0]) / 2) * Math.PI / 180;
  const dx = (b[1] - a[1]) * M_PER_DEG * Math.cos(la);
  const dy = (b[0] - a[0]) * M_PER_DEG;
  return Math.sqrt(dx * dx + dy * dy);
}

export function offset(p: LatLng, east: number, north: number): LatLng {
  return [p[0] + north / M_PER_DEG, p[1] + east / (M_PER_DEG * Math.cos(p[0] * Math.PI / 180))];
}

export function lerp(a: LatLng, b: LatLng, f: number): LatLng {
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
}

/** Bearing in degrees, 0 = north, clockwise. */
export function bearing(a: LatLng, b: LatLng): number {
  const dx = (b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180);
  const dy = b[0] - a[0];
  return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
}

export function cumLen(pts: LatLng[]): number[] {
  const c = [0];
  for (let i = 1; i < pts.length; i++) c.push(c[i - 1] + dist(pts[i - 1], pts[i]));
  return c;
}

export function pointAt(pts: LatLng[], cum: number[], d: number): LatLng {
  if (d <= 0) return pts[0];
  for (let i = 1; i < pts.length; i++) {
    if (cum[i] >= d) {
      const seg = cum[i] - cum[i - 1];
      return lerp(pts[i - 1], pts[i], seg > 0 ? (d - cum[i - 1]) / seg : 0);
    }
  }
  return pts[pts.length - 1];
}

/** Unit direction (east, north) of the path segment containing d. */
export function dirAt(pts: LatLng[], cum: number[], d: number): [number, number] {
  let i = 1;
  while (i < pts.length - 1 && cum[i] < d) i++;
  const a = pts[i - 1], b = pts[i];
  const e = (b[1] - a[1]) * Math.cos(a[0] * Math.PI / 180), n = b[0] - a[0];
  const m = Math.hypot(e, n) || 1;
  return [e / m, n / m];
}

export function subPath(pts: LatLng[], cum: number[], d0: number, d1: number): LatLng[] {
  const out: LatLng[] = [pointAt(pts, cum, d0)];
  for (let i = 0; i < pts.length; i++) if (cum[i] > d0 + 0.5 && cum[i] < d1 - 0.5) out.push(pts[i]);
  out.push(pointAt(pts, cum, d1));
  return out;
}

export function inBox(p: LatLng, b: [number, number, number, number]): boolean {
  return p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3];
}
