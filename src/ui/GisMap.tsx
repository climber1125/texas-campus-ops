// MONITOR 1 — GIS / System Map. Leaflet with a fully offline vector
// basemap (zones, roads, creek) plus an optional online OSM layer.
// Network styling is driven entirely by the engine's connectivity solve.
import { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useCtx, type Sel } from './ctx';
import { ROADS, ZONES, CREEK, localStreets } from '../sim/roads';
import { SUB_SPECS, CAMPUS } from '../sim/topology';
import { itemPos, label } from '../sim/campus';
import type { DevEl, LineEl, LatLng } from '../sim/types';
import type { Engine } from '../sim/engine';

const campusBounds = (): L.LatLngBoundsExpression => (CAMPUS?.bounds ?? [[33.1915, -97.1780], [33.1955, -97.1745]]);
const ZONE_FILL: Record<string, string> = { res: '#0f1722', com: '#161d2a', ind: '#1c1a15', campus: '#11202a', med: '#1d1624', park: '#0e1d17' };

interface Layers {
  lines: Map<string, L.Polyline>;
  devs: Map<string, L.CircleMarker>;
  xfmrs: Map<string, L.CircleMarker>;
  xfmrGroup: L.LayerGroup; devGroup: L.LayerGroup; fuseGroup: L.LayerGroup; lineGroup: L.LayerGroup;
  devLabels: L.LayerGroup; fuseLabels: L.LayerGroup; roadLabels: L.LayerGroup; zoneLabels: L.LayerGroup;
  tags: L.LayerGroup; trucks: Map<string, L.Marker>; truckGroup: L.LayerGroup; routes: Map<string, { tok: number; line: L.Polyline }>;
  calls: L.LayerGroup; incidents: L.LayerGroup; faults: L.LayerGroup; crit: Map<string, L.Marker>;
  selRing: L.CircleMarker; osm: L.TileLayer;
  poles: Map<string, L.Marker>; poleGroup: L.LayerGroup; poleLabels: L.LayerGroup; wos: L.LayerGroup;
}

export interface Toggles { feeders: boolean; devices: boolean; xfmrs: boolean; calls: boolean; trucks: boolean; labels: boolean; osm: boolean; }

export function GisMap({ visible, apiRef }: { visible: boolean; apiRef: React.MutableRefObject<{ flyTo(p: LatLng, z?: number): void } | null> }) {
  const ctx = useCtx();
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const lyr = useRef<Layers | null>(null);
  const eRef = useRef<Engine>(ctx.e);
  const selRef = useRef<Sel>(ctx.sel);
  const setSelRef = useRef(ctx.setSel);
  eRef.current = ctx.e; selRef.current = ctx.sel; setSelRef.current = ctx.setSel;
  const [tg, setTg] = useState<Toggles>(() => { try { const v = JSON.parse(localStorage.getItem('campusOpsMapTg') || 'null'); if (v) return v; } catch { /* none */ } return { feeders: true, devices: true, xfmrs: true, calls: true, trucks: true, labels: true, osm: true }; });
  useEffect(() => { try { localStorage.setItem('campusOpsMapTg', JSON.stringify(tg)); } catch { /* none */ } }, [tg]);
  const tgRef = useRef(tg); tgRef.current = tg;
  const last = useRef({ netVer: -1, incKey: '', callKey: '', faultKey: '', tagKey: '', e: null as Engine | null, sel: '', woKey: '' });

  useEffect(() => {
    const T = eRef.current.T;
    const map = L.map(divRef.current!, { preferCanvas: true, minZoom: 15, maxZoom: 22, zoomSnap: 0.25, zoomDelta: 0.5, wheelPxPerZoomLevel: 90 }).fitBounds(campusBounds(), { padding: [10, 10] });
    mapRef.current = map;
    (window as any).__gisMap = map; // test hook
    map.attributionControl.setPrefix('NLC CAMPUS OPS — training yard, nothing energized');
    const mkPane = (n: string, z: number, noPtr = false) => { const p = map.createPane(n); p.style.zIndex = String(z); if (noPtr) p.style.pointerEvents = 'none'; return p; };
    mkPane('base', 210, true); mkPane('roads', 260, true); mkPane('rlbl', 300, true); mkPane('net', 420); mkPane('xf', 430); mkPane('dev', 450); mkPane('lbl', 520, true); mkPane('ev', 600); mkPane('trk', 640); mkPane('selp', 660, true);
    const rBase = L.canvas({ pane: 'base', padding: 0.5 }), rRoads = L.canvas({ pane: 'roads', padding: 0.5 }), rNet = L.canvas({ pane: 'net', padding: 0.5, tolerance: 4 } as any),
      rXf = L.canvas({ pane: 'xf', padding: 0.5 }), rDev = L.canvas({ pane: 'dev', padding: 0.5, tolerance: 3 } as any), rEv = L.canvas({ pane: 'ev', padding: 0.5 });

    const osm = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 22, maxNativeZoom: 19, className: 'sat-dim', attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' });

    // Offline basemap
    for (const z of ZONES) L.rectangle([[z.b[0], z.b[1]], [z.b[2], z.b[3]]], { renderer: rBase, stroke: z.cls === 'park', color: '#1c3a2c', weight: 1, fillColor: ZONE_FILL[z.cls], fillOpacity: 1, interactive: false }).addTo(map);
    const zoneLabels = L.layerGroup();
    for (const z of ZONES) {
      if (z.cls === 'park' && (z.b[2] - z.b[0]) < 0.006) continue;
      L.marker([(z.b[0] + z.b[2]) / 2, (z.b[1] + z.b[3]) / 2], { pane: 'rlbl', interactive: false, icon: L.divIcon({ className: '', html: `<div class="zlabel" style="transform:translate(-50%,-50%)">${z.name}</div>`, iconSize: [0, 0] }) }).addTo(zoneLabels);
    }
    for (const s of localStreets()) L.polyline(s, { renderer: rBase, color: '#152030', weight: 1, interactive: false }).addTo(map);
    L.polyline(CREEK, { renderer: rBase, color: '#1b4660', weight: 2.5, opacity: 0.8, interactive: false }).addTo(map);
    const roadLabels = L.layerGroup();
    for (const r of ROADS) {
      const w = r.cls === 'hwy' ? 7 : r.cls === 'art' ? 4.5 : 3.2;
      L.polyline(r.pts, { renderer: rRoads, color: r.cls === 'hwy' ? '#33465f' : r.cls === 'art' ? '#243447' : '#1e2b3a', weight: w, interactive: false, lineCap: 'butt' }).addTo(map);
      if (r.cls === 'hwy') L.polyline(r.pts, { renderer: rRoads, color: '#556d8c', weight: 1, dashArray: '6 8', interactive: false }).addTo(map);
      const a = r.pts[0], b = r.pts[r.pts.length - 1];
      const ns = Math.abs(b[0] - a[0]) > Math.abs(b[1] - a[1]) * 1.2 && r.cls !== 'hwy';
      const spots = r.cls === 'hwy' ? [0.35, 0.8] : [0.13, 0.62];
      for (const f of spots) {
        const p: LatLng = r.pts.length > 2 ? r.pts[Math.floor(f * (r.pts.length - 1))] : [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
        L.marker(p, { pane: 'rlbl', interactive: false, icon: L.divIcon({ className: '', html: `<div class="rlabel ${ns ? 'ns' : ''} ${r.cls === 'hwy' ? 'hwy' : ''}" style="transform:translate(${ns ? '4px,-50%' : '-50%,-120%'})">${r.name}</div>`, iconSize: [0, 0] }) }).addTo(roadLabels);
      }
    }

    // Network lines
    const lines = new Map<string, L.Polyline>();
    const lineGroup = L.layerGroup().addTo(map);
    for (const id of Object.keys(T.els)) {
      const el = T.els[id];
      if (el.kind !== 'line') continue;
      const ln = L.polyline((el as LineEl).path, { renderer: rNet, weight: el.lateral ? 1.6 : el.tie ? 2.4 : 3.4, color: '#555', lineCap: 'round' });
      ln.on('click', (ev) => { L.DomEvent.stopPropagation(ev); setSelRef.current({ kind: 'line', id }); });
      ln.addTo(lineGroup); lines.set(id, ln);
    }
    // Transformers
    const xfmrs = new Map<string, L.CircleMarker>();
    const xfmrGroup = L.layerGroup();
    for (const lid of T.loadIds) {
      const L0 = T.loads[lid];
      if (L0.cls === 'critical') continue;
      const m = L.circleMarker(L0.pos, { renderer: rXf, radius: L0.cls === 'com' || L0.cls === 'ind' ? 3.2 : 2.4, weight: 1, color: '#0a1018', fillOpacity: 1, fillColor: '#6b86a3' });
      m.on('click', (ev) => { L.DomEvent.stopPropagation(ev); setSelRef.current({ kind: 'load', id: lid }); });
      m.addTo(xfmrGroup); xfmrs.set(lid, m);
    }
    // Devices
    const devs = new Map<string, L.CircleMarker>();
    const devGroup = L.layerGroup().addTo(map), fuseGroup = L.layerGroup();
    const devLabels = L.layerGroup(), fuseLabels = L.layerGroup();
    for (const id of T.switchable) {
      const d = T.els[id] as DevEl;
      const r = d.type === 'breaker' ? 6.5 : d.type === 'recloser' ? 6 : d.type === 'tie' ? 5.5 : d.type === 'switch' ? 4.8 : 2.8;
      const m = L.circleMarker(d.pos, { renderer: rDev, radius: r, weight: d.type === 'fuse' ? 1 : 2 });
      m.on('click', (ev) => { L.DomEvent.stopPropagation(ev); setSelRef.current({ kind: 'dev', id }); });
      m.addTo(d.type === 'fuse' ? fuseGroup : devGroup); devs.set(id, m);
      const lblHtml = `<div class="dlabel" data-dev="${id}" style="transform:translate(8px,-50%)">${id}</div>`;
      if (d.type !== 'breaker') L.marker(d.pos, { pane: 'lbl', interactive: false, icon: L.divIcon({ className: '', html: lblHtml, iconSize: [0, 0] }) }).addTo(d.type === 'fuse' ? fuseLabels : devLabels);
    }
    // Substations
    for (const s of SUB_SPECS) {
      const m = L.marker(s.pos, { pane: 'dev', icon: L.divIcon({ className: 'sub-ic', html: s.id, iconSize: [26, 26] }) }).addTo(map);
      m.on('click', () => setSelRef.current({ kind: 'sub', id: s.id }));
      L.marker(s.pos, { pane: 'lbl', interactive: false, icon: L.divIcon({ className: '', html: `<div class="sub-name" style="transform:translate(16px,-50%)">${s.name} SUB</div>`, iconSize: [0, 0] }) }).addTo(map);
    }
    // Yard items (poles, pad-mounts, pedestals, buildings) from Pole Yard
    const poles = new Map<string, L.Marker>();
    const poleGroup = L.layerGroup().addTo(map), poleLabels = L.layerGroup();
    for (const it of CAMPUS?.items ?? []) {
      if (it.itemType === 'span') continue;
      const cls = it.itemType === 'transformer' ? 'pad' : it.itemType === 'pedestal' ? 'ped' : it.itemType === 'building' || it.itemType === 'pit' ? 'bld' : '';
      const m = L.marker(itemPos(it), { pane: 'xf', icon: L.divIcon({ className: '', html: `<div class="pole-ic ${cls}"></div>`, iconSize: [0, 0] }) });
      const id = it.id;
      m.on('click', () => setSelRef.current({ kind: 'pole', id }));
      m.addTo(poleGroup); poles.set(id, m);
      L.marker(itemPos(it), { pane: 'lbl', interactive: false, icon: L.divIcon({ className: '', html: `<div class="plabel" style="transform:translate(7px,-50%)">${label(it).replace(/</g, '&lt;')}</div>`, iconSize: [0, 0] }) }).addTo(poleLabels);
    }
    const wos = L.layerGroup().addTo(map);
    // Critical facilities
    const crit = new Map<string, L.Marker>();
    for (const lid of T.loadIds) {
      const L0 = T.loads[lid];
      if (!L0.name) continue;
      const sym = L0.name.includes('MEDICAL') || L0.name.includes('HOSPITAL') ? 'H' : L0.name.includes('911') ? '9' : L0.name.includes('WATER') ? 'W' : L0.name.includes('FIRE') ? 'F' : L0.name.includes('SENIOR') ? 'S' : 'C';
      const m = L.marker(L0.pos, { pane: 'ev', icon: L.divIcon({ className: 'crit-ic', html: sym, iconSize: [16, 16] }) }).addTo(map);
      m.on('click', () => setSelRef.current({ kind: 'load', id: lid }));
      crit.set(lid, m);
      L.marker(L0.pos, { pane: 'lbl', interactive: false, icon: L.divIcon({ className: '', html: `<div class="crit-name" style="transform:translate(11px,-50%)">${L0.name}</div>`, iconSize: [0, 0] }) }).addTo(roadLabels);
    }

    const truckGroup = L.layerGroup().addTo(map);
    const calls = L.layerGroup().addTo(map), incidents = L.layerGroup().addTo(map), faults = L.layerGroup().addTo(map), tags = L.layerGroup().addTo(map);
    const selRing = L.circleMarker([0, 0], { pane: 'selp', radius: 13, color: '#3fb6d3', weight: 2, dashArray: '4 3', fill: false, interactive: false });

    lyr.current = { lines, devs, xfmrs, xfmrGroup, devGroup, fuseGroup, lineGroup, devLabels, fuseLabels, roadLabels, zoneLabels, tags, trucks: new Map(), truckGroup, routes: new Map(), calls, incidents, faults, crit, selRing, osm, poles, poleGroup, poleLabels, wos };
    void rEv;

    const zoomVis = () => {
      const z = map.getZoom(), t = tgRef.current, l = lyr.current!;
      const show = (g: L.Layer, on: boolean) => { if (on && !map.hasLayer(g)) g.addTo(map); if (!on && map.hasLayer(g)) map.removeLayer(g); };
      show(l.xfmrGroup, t.xfmrs && z >= 19);
      show(l.poleLabels, t.labels && z >= 19.25);
      styleXfmrs();
      show(l.fuseGroup, t.devices && z >= 17);
      show(l.devGroup, t.devices);
      show(l.devLabels, t.labels && t.devices && z >= 18);
      show(l.fuseLabels, t.labels && t.devices && z >= 18.5);
      show(l.roadLabels, t.labels && z >= 13.5);
      show(l.zoneLabels, t.labels && z >= 13.5 && z < 16);
      show(l.lineGroup, t.feeders);
      show(l.calls, t.calls); show(l.wos, t.calls); show(l.truckGroup, t.trucks);
      show(l.osm, t.osm);
    };
    map.on('zoomend', zoomVis);
    zoomVis();
    (map as any)._zoomVis = zoomVis;

    apiRef.current = { flyTo: (p, z) => map.flyTo(p, z ?? Math.max(map.getZoom(), 15.5), { duration: 0.6 }) };

    // Refit the system view whenever the map pane is resized (focus mode, window resize, compact layout)
    let lastW = map.getSize().x, lastH = map.getSize().y;
    const ro = new ResizeObserver(() => {
      map.invalidateSize();
      const n = map.getSize();
      if (n.x < 50 || n.y < 50) return;
      if (Math.abs(n.x - lastW) > 80 || Math.abs(n.y - lastH) > 80) { lastW = n.x; lastH = n.y; map.fitBounds(campusBounds(), { padding: [6, 6] }); }
    });
    ro.observe(divRef.current!);

    const id = setInterval(() => update(), 150);
    return () => { ro.disconnect(); clearInterval(id); map.remove(); mapRef.current = null; lyr.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { const m = mapRef.current as any; if (m?._zoomVis) m._zoomVis(); }, [tg]);
  useEffect(() => { if (visible) setTimeout(() => mapRef.current?.invalidateSize(), 30); }, [visible]);

  function styleXfmrs() {
    const map = mapRef.current, l = lyr.current;
    if (!map || !l) return;
    const e = eRef.current, z = map.getZoom();
    for (const [lid, m] of l.xfmrs) {
      const en = e.loadEn(lid), L0 = e.T.loads[lid];
      const base = L0.cls === 'com' || L0.cls === 'ind' ? 3.2 : 2.4;
      m.setRadius(en ? (z >= 19 ? base : 0) : z >= 19 ? base + 1 : 3.4);
      m.setStyle({ fillColor: en ? '#6b86a3' : e.s.planned[lid] ? '#b08a3e' : '#ff5a5a', weight: en && z < 19 ? 0 : 1 });
    }
  }

  function update() {
    const map = mapRef.current, l = lyr.current;
    if (!map || !l) return;
    const e = eRef.current, T = e.T;
    const engineChanged = last.current.e !== e;
    if (engineChanged) { last.current = { netVer: -1, incKey: '', callKey: '', faultKey: '', tagKey: '', e, sel: '', woKey: '' }; for (const m of l.trucks.values()) l.truckGroup.removeLayer(m); l.trucks.clear(); for (const r of l.routes.values()) map.removeLayer(r.line); l.routes.clear(); }

    // Network style
    if (last.current.netVer !== e.netVer) {
      last.current.netVer = e.netVer;
      for (const [id, ln] of l.lines) {
        const el = T.els[id] as LineEl;
        const en = e.elEnergized(id);
        const src = e.net.src.get(el.to) || e.net.src.get(el.from);
        const planned = !en && T.normFeeder[el.to] && Object.keys(e.s.planned).length > 0 && isPlannedLine(e, el);
        const color = en ? (T.feeders[src!]?.color ?? '#888') : planned ? '#8a6d33' : '#cf4a4a';
        ln.setStyle({ color, opacity: en ? 0.95 : 0.95, dashArray: el.ug ? '5 4' : !en ? '4 3' : undefined, weight: el.lateral ? (en ? 1.6 : 2.4) : el.tie ? 2.4 : 3.6 });
      }
      for (const [id, m] of l.devs) {
        const st = e.s.dev[id], d = T.els[id] as DevEl;
        const en = e.nodeEn(d.from) || e.nodeEn(d.to);
        if (st.open) m.setStyle({ color: st.lockout ? '#ff5050' : !st.comm ? '#e3a53c' : '#34b36e', fillColor: st.lockout ? '#5a0f0f' : '#08100c', fillOpacity: 1, weight: st.lockout ? 2.5 : d.type === 'fuse' ? 1.2 : 2 });
        else m.setStyle({ color: !st.comm ? '#e3a53c' : en ? '#ffd0d0' : '#7a4040', fillColor: '#d64545', fillOpacity: en ? 1 : 0.5, weight: d.type === 'fuse' ? 0.8 : 1.5 });
      }
      styleXfmrs();
      for (const [iid, m] of l.poles) {
        const div = m.getElement()?.querySelector('.pole-ic');
        const node = CAMPUS?.itemNode[iid];
        if (div && node) div.classList.toggle('dead', (T.adj[node]?.length ?? 0) > 0 && !e.nodeEn(node));
      }
      for (const [lid, m] of l.crit) {
        const el = m.getElement();
        if (el) el.classList.toggle('out', !e.loadEn(lid));
      }
      // device label states
      for (const g of [l.devLabels, l.fuseLabels]) g.eachLayer((mk: any) => {
        const div: HTMLElement | null = mk.getElement()?.querySelector('.dlabel');
        if (!div) return;
        const id = div.dataset.dev!;
        const st = e.s.dev[id];
        div.className = 'dlabel' + (st.tags.length ? ' tag' : st.open ? ' open' : '');
        div.textContent = id + (st.lockout ? ' LO' : '') + (!st.comm ? ' ?' : '');
      });
    }

    // Tags
    const tagKey = T.switchable.filter(id => e.s.dev[id].tags.length).map(id => id + e.s.dev[id].tags.join()).join('|');
    if (tagKey !== last.current.tagKey) {
      last.current.tagKey = tagKey;
      l.tags.clearLayers();
      for (const id of T.switchable) {
        const st = e.s.dev[id];
        if (!st.tags.length) continue;
        L.marker((T.els[id] as DevEl).pos, { pane: 'ev', interactive: false, icon: L.divIcon({ className: '', html: `<div class="tagbadge" style="transform:translate(-50%,-185%)">HOLD ${st.tags.join(',')}</div>`, iconSize: [0, 0] }) }).addTo(l.tags);
      }
    }

    // Trucks
    const s = selRef.current;
    for (const tr of Object.values(e.s.trucks)) {
      let m = l.trucks.get(tr.id);
      const cls = `trk s-${tr.status.replace(/\s+/g, '')}${s?.kind === 'truck' && s.id === tr.id ? ' sel' : ''}`;
      const html = `<div class="b">${tr.id}</div><div class="h" style="transform:rotate(${Math.round(tr.heading)}deg)"></div>`;
      if (!m) {
        m = L.marker(tr.pos, { pane: 'trk', icon: L.divIcon({ className: cls, html, iconSize: [Math.max(34, 10 + tr.id.length * 7), 18] }) });
        const id = tr.id;
        m.on('click', () => setSelRef.current({ kind: 'truck', id }));
        (m as any)._cls = cls;
        m.addTo(l.truckGroup); l.trucks.set(tr.id, m);
      } else {
        m.setLatLng(tr.pos);
        const el = m.getElement();
        if (el) {
          const prev: string = (m as any)._cls ?? '';
          if (prev !== cls) { if (prev) el.classList.remove(...prev.split(' ')); el.classList.add(...cls.split(' ')); (m as any)._cls = cls; }
          const h = el.querySelector('.h') as HTMLElement | null;
          if (h) h.style.transform = `rotate(${Math.round(tr.heading)}deg)`;
        }
      }
      const rt = l.routes.get(tr.id);
      if (tr.route && (!rt || rt.tok !== tr.route.tok)) {
        if (rt) map.removeLayer(rt.line);
        const line = L.polyline(tr.route.pts, { pane: 'ev', color: '#3fb6d3', weight: 2, opacity: 0.55, dashArray: '3 6', interactive: false }).addTo(map);
        l.routes.set(tr.id, { tok: tr.route.tok, line });
      } else if (!tr.route && rt) { map.removeLayer(rt.line); l.routes.delete(tr.id); }
    }

    // Calls (open, last 90 min)
    const openCalls = e.s.callOrder.map(c => e.s.calls[c]).filter(c => c && c.kind !== 'momentary' && e.s.t - c.t < 5400 && (!c.incident || !['Closed', 'Restored'].includes(e.s.incidents[c.incident]?.status)));
    const callKey = openCalls.length + ':' + (openCalls.at(-1)?.id ?? '');
    if (callKey !== last.current.callKey) {
      last.current.callKey = callKey;
      l.calls.clearLayers();
      for (const c of openCalls) {
        const m = L.circleMarker(c.pos, { pane: 'ev', radius: c.hazard ? 6 : 4, color: c.hazard ? '#ff5a5a' : '#ffcf73', weight: 1.5, fillColor: c.hazard ? '#ff5a5a' : '#e3a53c', fillOpacity: 0.55 });
        m.bindTooltip(`${c.id} ${e.hhmm(c.t)} — ${c.addr}<br>${c.remark}`, { className: '' });
        if (c.incident) { const inc = c.incident; m.on('click', () => setSelRef.current({ kind: 'inc', id: inc })); }
        m.addTo(l.calls);
      }
    }

    // Incidents
    const incs = e.openIncidents();
    const incKey = incs.map(i => i.id + i.predDev + i.priority + i.status).join('|');
    if (incKey !== last.current.incKey) {
      last.current.incKey = incKey;
      l.incidents.clearLayers();
      for (const inc of incs) {
        if (inc.status === 'Restored') continue;
        const pos = inc.kind === 'single' ? T.loads[inc.loadId!].pos : (T.els[inc.predDev] as DevEl).pos;
        const m = L.marker(pos, { pane: 'ev', icon: L.divIcon({ className: `inc-ic p${inc.priority}`, html: `<div class="t"></div><div class="l">${inc.id}${inc.hazard ? ' ⚠' : ''}</div>`, iconSize: [0, 0] }) });
        m.on('click', () => setSelRef.current({ kind: 'inc', id: inc.id }));
        m.addTo(l.incidents);
      }
    }
    // Campus work orders
    const openWos = Object.values(e.s.workorders).filter(w => w.issue !== undefined && !['Done', 'Canceled'].includes(w.status));
    const woKey = openWos.map(w => w.id + w.priority + w.status + w.pos.join()).join('|');
    if (woKey !== last.current.woKey) {
      last.current.woKey = woKey;
      l.wos.clearLayers();
      for (const w of openWos) {
        const p = w.priority === 'Emergency' ? 'p1' : w.priority === 'Urgent' ? 'p2' : 'p3';
        const m = L.marker(w.pos, { pane: 'ev', icon: L.divIcon({ className: '', html: `<div class="wo-ic ${p}"><div class="l">${w.id}</div><div class="t"></div></div>`, iconSize: [0, 0] }) });
        m.bindTooltip(`${w.id} · ${w.priority} · ${w.status}<br>${w.loc}: ${String(w.issue).replace(/</g, '&lt;')}`);
        const id = w.id;
        m.on('click', () => setSelRef.current({ kind: 'wo', id }));
        m.addTo(l.wos);
      }
    }
    // Found faults
    const fl = Object.values(e.s.faults).filter(f => f.active && f.found);
    const fKey = fl.map(f => f.id).join();
    if (fKey !== last.current.faultKey) {
      last.current.faultKey = fKey;
      l.faults.clearLayers();
      for (const f of fl) L.marker(f.pos, { pane: 'ev', icon: L.divIcon({ className: 'flt-ic', html: '✕', iconSize: [18, 18] }) }).bindTooltip(`${f.id}: ${f.desc}`).addTo(l.faults);
    }

    // Selection ring
    const sk = s ? s.kind + s.id : '';
    const pos = s ? selPos(e, s) : null;
    if (pos) { l.selRing.setLatLng(pos); if (!map.hasLayer(l.selRing)) l.selRing.addTo(map); }
    else if (map.hasLayer(l.selRing)) map.removeLayer(l.selRing);
    last.current.sel = sk;
  }

  const set = (k: keyof Toggles) => setTg(t => ({ ...t, [k]: !t[k] }));
  return (
    <div className="mapwrap" style={{ display: visible ? 'block' : 'none' }}>
      <div ref={divRef} style={{ position: 'absolute', inset: 0 }} />
      <div className="mapctl">
        {(['feeders', 'devices', 'xfmrs', 'calls', 'trucks', 'labels', 'osm'] as (keyof Toggles)[]).map(k => (
          <label key={k}><input type="checkbox" checked={tg[k]} onChange={() => set(k)} />{({ feeders: 'lines', devices: 'devices', xfmrs: 'transformers', calls: 'work orders', trucks: 'instructors', labels: 'labels', osm: 'satellite' } as Record<string, string>)[k]}</label>
        ))}
        <button className="btn sm" onClick={() => mapRef.current?.flyToBounds(campusBounds(), { duration: 0.5, padding: [10, 10] })}>Yard view</button>
      </div>
      <div className="legend">
        <span><i style={{ background: '#4e9ad6' }} />In service (circuit color)</span>
        <span><i style={{ background: '#cf4a4a' }} />Out of service</span>
        <span><i className="dot" style={{ background: '#d64545', display: 'inline-block' }} />Device closed</span>
        <span><i className="dot" style={{ border: '2px solid #34b36e', display: 'inline-block', width: 8, height: 8 }} />Device open</span>
        <span><i style={{ background: 'repeating-linear-gradient(90deg,#9b86d1 0 5px,transparent 5px 9px)' }} />Underground</span>
        <span><i className="dot" style={{ background: '#e3a53c', display: 'inline-block' }} />Work order</span>
      </div>
    </div>
  );
}

function isPlannedLine(e: Engine, el: LineEl): boolean {
  // a de-energized line feeding only planned loads (cheap check via nearest load on lateral / section)
  const lat = el.lateral ? e.T.laterals[el.id.split('-L')[0]] : null;
  if (lat) return lat.loads.every(l => e.s.planned[l]);
  return Object.values(e.s.clearances).some(c => c.status === 'Active' && c.nodes.includes(el.to));
}

export function selPos(e: Engine, s: NonNullable<Sel>): LatLng | null {
  const T = e.T;
  switch (s.kind) {
    case 'dev': return (T.els[s.id] as DevEl)?.pos ?? null;
    case 'load': return T.loads[s.id]?.pos ?? null;
    case 'truck': return e.s.trucks[s.id]?.pos ?? null;
    case 'inc': { const i = e.s.incidents[s.id]; if (!i) return null; return i.kind === 'single' ? T.loads[i.loadId!].pos : (T.els[i.predDev] as DevEl).pos; }
    case 'line': { const el = T.els[s.id] as LineEl; return el ? el.path[Math.floor(el.path.length / 2)] : null; }
    case 'sub': return SUB_SPECS.find(x => x.id === s.id)?.pos ?? null;
    case 'pole': { const it = CAMPUS?.items.find(i => i.id === s.id); return it ? itemPos(it) : null; }
    case 'wo': return e.s.workorders[s.id]?.pos ?? null;
  }
  return null;
}
