// Network editor — tie the Pole Yard items together the way the yard is
// actually strung, mark the source, and put switches / fuses / reclosers on
// spans. Save applies it for every screen (the page reloads).
import { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import { CAMPUS } from '../sim/topology';
import { draftNetwork, ELECTRIC, itemPos, label, inPoly, suggestAreas, AREA_COLORS, type NetCfg, type NetLink, type LinkDev, type YardItem, type YardArea } from '../sim/campus';
import { lerp } from '../sim/geo';
import { putJson, ACCESS } from '../live/access';

type Mode = 'link' | 'source' | 'pick' | 'area';
const DEV_COLOR: Record<LinkDev, string> = { switch: '#d64545', fuse: '#e3a53c', recloser: '#c98bb9' };

export function NetEditor({ onClose }: { onClose(): void }) {
  const items = useMemo(() => (CAMPUS?.items ?? []).filter(i => i.itemType !== 'span'), []);
  const byId = useMemo(() => new Map(items.map(i => [i.id, i])), [items]);
  const [cfg, setCfg] = useState<NetCfg>(() => JSON.parse(JSON.stringify(CAMPUS?.cfg ?? { v: 1, source: null, links: [] })));
  const [hist, setHist] = useState<NetCfg[]>([]);
  const [mode, setMode] = useState<Mode>('link');
  const [anchor, setAnchor] = useState<string | null>(null);
  const [selLink, setSelLink] = useState<number | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [draw, setDraw] = useState<{ pts: [number, number][]; redo?: string } | null>(null);
  const [selArea, setSelArea] = useState<string | null>(null);
  const divRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layer = useRef<{ lines: L.LayerGroup; devs: L.LayerGroup; marks: L.LayerGroup; areas: L.LayerGroup; items: Map<string, L.Marker> } | null>(null);
  const st = useRef({ cfg, mode, anchor, selLink, draw }); st.current = { cfg, mode, anchor, selLink, draw };
  const addPt = (p: L.LatLng) => { const d = st.current.draw ?? { pts: [] }; const n = { ...d, pts: [...d.pts, [p.lat, p.lng] as [number, number]] }; st.current.draw = n; setDraw(n); };

  const change = (fn: (c: NetCfg) => NetCfg) => { const c = st.current.cfg; setHist(h => [...h.slice(-40), c]); const n = fn(JSON.parse(JSON.stringify(c))); st.current.cfg = n; setCfg(n); setDirty(true); };
  const key = (a: string, b: string) => (a < b ? a + '|' + b : b + '|' + a);

  const clickItem = (id: string) => {
    const { mode: m, anchor: a, cfg: c } = st.current;
    const it = byId.get(id); if (!it || !ELECTRIC(it)) return;
    if (m === 'source') { change(x => ({ ...x, source: id })); setMode('link'); setMsg(`Source set to ${label(it)}`); return; }
    if (!a || a === id) { setAnchor(a === id ? null : id); setSelLink(null); return; }
    const k = key(a, id);
    const idx = c.links.findIndex(l => key(l.a, l.b) === k);
    if (idx >= 0) { change(x => ({ ...x, links: x.links.filter((_, i) => i !== idx) })); setMsg(`Removed span ${label(byId.get(a)!)} – ${label(it)}`); setAnchor(id); }
    else { change(x => ({ ...x, links: [...x.links, { a, b: id }] })); setMsg(`Added span ${label(byId.get(a)!)} – ${label(it)}`); setAnchor(id); }
    setSelLink(null);
  };

  // map setup
  useEffect(() => {
    const map = L.map(divRef.current!, { preferCanvas: true, minZoom: 15, maxZoom: 22, zoomSnap: 0.25 }).fitBounds(CAMPUS?.bounds ?? [[33.1915, -97.178], [33.1955, -97.1745]]);
    mapRef.current = map;
    (window as any).__netMap = map; // test hook
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', { maxZoom: 22, maxNativeZoom: 19, className: 'sat-dim', attribution: 'Imagery © Esri' }).addTo(map);
    const rLines = L.canvas({ padding: 0.5, tolerance: 6 } as any);
    map.createPane('areas').style.zIndex = '350';
    const areasL = L.layerGroup().addTo(map);
    const lines = L.layerGroup().addTo(map), devs = L.layerGroup().addTo(map), marks = L.layerGroup().addTo(map);
    const itemsM = new Map<string, L.Marker>();
    for (const it of items) {
      const el = ELECTRIC(it);
      const t = it.itemType === 'transformer' ? 'pad' : it.itemType === 'pedestal' ? 'ped' : !el ? 'bld' : '';
      const m = L.marker(itemPos(it), { interactive: el, keyboard: false, icon: L.divIcon({ className: '', html: `<div class="ne-it ${t}"></div>`, iconSize: [0, 0] }) });
      if (el) { m.on('click', ev => { L.DomEvent.stopPropagation(ev); clickItem(it.id); }); m.bindTooltip(label(it), { direction: 'top', offset: [0, -6] }); }
      m.addTo(marks); itemsM.set(it.id, m);
    }
    layer.current = { lines, devs, marks, areas: areasL, items: itemsM };
    (map as any)._rLines = rLines;
    map.on('click', ev => { if (st.current.mode === 'area') { if (st.current.draw) addPt(ev.latlng); else setSelArea(null); return; } setAnchor(null); setSelLink(null); });
    return () => { map.remove(); mapRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // redraw links / devices / highlights
  const tied = useMemo(() => { const s = new Set<string>(); for (const l of cfg.links) { s.add(l.a); s.add(l.b); } return s; }, [cfg]);
  const reach = useMemo(() => {
    const adj = new Map<string, string[]>();
    for (const l of cfg.links) { if (!adj.has(l.a)) adj.set(l.a, []); if (!adj.has(l.b)) adj.set(l.b, []); adj.get(l.a)!.push(l.b); adj.get(l.b)!.push(l.a); }
    const seen = new Set<string>(); if (!cfg.source) return seen;
    const q = [cfg.source]; seen.add(cfg.source);
    while (q.length) { const u = q.pop()!; for (const v of adj.get(u) ?? []) if (!seen.has(v)) { seen.add(v); q.push(v); } }
    return seen;
  }, [cfg]);
  useEffect(() => {
    const map = mapRef.current, ly = layer.current; if (!map || !ly) return;
    ly.lines.clearLayers(); ly.devs.clearLayers();
    const r = (map as any)._rLines;
    cfg.links.forEach((l, i) => {
      const a = byId.get(l.a), b = byId.get(l.b); if (!a || !b) return;
      const pa = itemPos(a), pb = itemPos(b);
      const on = reach.has(l.a);
      const ln = L.polyline([pa, pb], { renderer: r, color: i === selLink ? '#ffffff' : on ? '#4e9ad6' : '#cf4a4a', weight: i === selLink ? 5 : 3, opacity: 0.95, dashArray: !ELECTRIC(a) || a.itemType !== 'pole' || b.itemType !== 'pole' ? '5 4' : undefined });
      ln.on('click', ev => { L.DomEvent.stopPropagation(ev); if (st.current.mode === 'area') { if (st.current.draw) addPt(ev.latlng); return; } setSelLink(i); setAnchor(null); });
      ln.addTo(ly.lines);
      if (l.dev) {
        const atB = l.dev.at === l.b;
        const p = lerp(atB ? pb : pa, atB ? pa : pb, 0.16);
        L.circleMarker(p, { radius: l.dev.type === 'fuse' ? 3.5 : 5.5, weight: 2, color: l.dev.no ? '#34b36e' : '#ffd0d0', fillColor: l.dev.no ? '#08100c' : DEV_COLOR[l.dev.type], fillOpacity: 1, interactive: false }).addTo(ly.devs);
      }
    });
    for (const [id, m] of ly.items) {
      const it = byId.get(id)!;
      if (!ELECTRIC(it)) continue;
      const div = m.getElement()?.querySelector('.ne-it');
      if (!div) continue;
      div.classList.toggle('src', id === cfg.source);
      div.classList.toggle('anchor', id === anchor);
      div.classList.toggle('loose', !tied.has(id) && id !== cfg.source);
    }
  }, [cfg, selLink, anchor, reach, tied, byId]);

  useEffect(() => {
    const ly = layer.current; if (!ly) return;
    ly.areas.clearLayers();
    const on = mode === 'area';
    (cfg.areas ?? []).forEach(a => {
      if (draw?.redo === a.id) return;
      const c = a.color || '#3fb6d3';
      const pg = L.polygon(a.poly, { pane: 'areas', color: c, weight: a.id === selArea ? 3 : 1.5, fillColor: c, fillOpacity: a.id === selArea ? 0.28 : on ? 0.16 : 0.08, dashArray: on ? undefined : '4 3', interactive: on });
      pg.bindTooltip(a.name, { permanent: true, direction: 'center', className: 'area-tip' });
      pg.on('click', ev => { L.DomEvent.stopPropagation(ev); if (st.current.draw) addPt(ev.latlng); else setSelArea(a.id); });
      pg.addTo(ly.areas);
    });
    if (draw && draw.pts.length) {
      L.polyline(draw.pts, { pane: 'areas', color: '#ffffff', weight: 2, dashArray: '5 4', interactive: false }).addTo(ly.areas);
      draw.pts.forEach((p, i) => {
        const m = L.circleMarker(p, { pane: 'areas', radius: i === 0 ? 7 : 4, color: '#fff', weight: 2, fillColor: i === 0 ? '#34b36e' : '#fff', fillOpacity: 1, interactive: i === 0 });
        if (i === 0) m.on('click', ev => { L.DomEvent.stopPropagation(ev); finishDraw(); });
        m.addTo(ly.areas);
      });
    }
  }, [cfg, mode, draw, selArea]); // eslint-disable-line react-hooks/exhaustive-deps

  const finishDraw = () => {
    const d = st.current.draw; if (!d) return;
    if (d.pts.length < 3) { setMsg('An area needs at least 3 corners.'); return; }
    if (d.redo) { const id = d.redo; change(x => ({ ...x, areas: (x.areas ?? []).map(a => a.id === id ? { ...a, poly: d.pts } : a) })); setSelArea(id); }
    else {
      const have = st.current.cfg.areas ?? [];
      const a: YardArea = { id: 'A' + Date.now().toString(36), name: `Area ${have.length + 1}`, poly: d.pts, color: AREA_COLORS[have.length % AREA_COLORS.length] };
      change(x => ({ ...x, areas: [...(x.areas ?? []), a] })); setSelArea(a.id);
      setMsg('Area added — give it a name.');
    }
    st.current.draw = null; setDraw(null);
  };
  const setArea = (id: string, ch: Partial<YardArea>) => change(x => ({ ...x, areas: (x.areas ?? []).map(a => a.id === id ? { ...a, ...ch } : a) }));
  const areaCount = (a: YardArea) => items.filter(i => ELECTRIC(i) && inPoly(itemPos(i) as [number, number], a.poly)).length;

  useEffect(() => {
    const k = (ev: KeyboardEvent) => {
      if (['INPUT', 'SELECT', 'TEXTAREA'].includes((ev.target as HTMLElement)?.tagName)) return;
      if (ev.key === 'Escape') { setAnchor(null); setSelLink(null); st.current.draw = null; setDraw(null); }
      if (ev.key === 'Enter' && st.current.draw) finishDraw();
      if ((ev.key === 'Delete' || ev.key === 'Backspace') && st.current.selLink != null) { const i = st.current.selLink; change(x => ({ ...x, links: x.links.filter((_, j) => j !== i) })); setSelLink(null); }
      if ((ev.ctrlKey || ev.metaKey) && ev.key === 'z') undo();
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  });

  const undo = () => setHist(h => { if (!h.length) return h; setCfg(h[h.length - 1]); setSelLink(null); return h.slice(0, -1); });
  const setDev = (i: number, d: NetLink['dev'] | undefined) => change(x => { const l = x.links[i]; if (d) l.dev = d; else delete l.dev; return x; });
  const elecCount = items.filter(ELECTRIC).length;
  const loose = items.filter(i => ELECTRIC(i) && !tied.has(i.id) && i.id !== cfg.source).length;
  const unreached = items.filter(i => ELECTRIC(i) && tied.has(i.id) && !reach.has(i.id)).length;
  const save = async () => {
    setSaving(true); setMsg('Saving…');
    const r = await putJson('/api/network', { ...cfg, draft: undefined, updatedBy: ACCESS.name || 'Operator' });
    setSaving(false);
    if (!r.ok) { setMsg(r.status === 403 ? 'Operator code required to save.' : `Save failed (${r.status || 'offline'}).`); return; }
    setMsg('Saved — reloading…'); setDirty(false);
    setTimeout(() => location.reload(), 400);
  };
  const L0 = selLink != null ? cfg.links[selLink] : null;
  const ia = L0 ? byId.get(L0.a) : undefined, ib = L0 ? byId.get(L0.b) : undefined;

  return (
    <div className="neted">
      <div className="bar">
        <b className="mono" style={{ color: 'var(--cyan)' }}>EDIT NETWORK</b>
        <span className="tb-sep" />
        <button className={`btn ${mode === 'link' ? 'on' : ''}`} onClick={() => setMode('link')}>Spans</button>
        <button className={`btn ${mode === 'source' ? 'on' : ''}`} onClick={() => setMode('source')}>Set source</button>
        <button className={`btn ${mode === 'area' ? 'on' : ''}`} onClick={() => { setMode('area'); setAnchor(null); setSelLink(null); }}>Areas</button>
        <span className="tb-sep" />
        <button className="btn" disabled={!hist.length} onClick={undo}>Undo</button>
        <button className="btn" onClick={() => { if (confirm('Replace every span with a fresh auto-draft?')) { change(() => draftNetwork(items as YardItem[])); setMsg('Auto-draft loaded — check it, then save.'); } }}>Auto-draft</button>
        <button className="btn danger" onClick={() => { if (confirm('Remove every span?')) change(x => ({ ...x, links: [] })); }}>Clear all</button>
        <span className="tb-sep" />
        <span className="mono dim" style={{ fontSize: 10.5 }}>{cfg.links.length} spans · {elecCount} items · <span className={loose ? 'c-amber' : ''}>{loose} not tied</span> · <span className={unreached ? 'c-red' : ''}>{unreached} cut off from source</span></span>
        <span style={{ flex: 1 }} />
        <span className="c-cyan" style={{ fontSize: 11 }}>{msg}</span>
        <button className="btn pri" disabled={saving} onClick={save}>{dirty ? 'Save & apply' : 'Save'}</button>
        <button className="btn" onClick={() => { if (!dirty || confirm('Discard your changes?')) onClose(); }}>Close</button>
      </div>
      <div className="help">
        {mode === 'area' ? (draw ? <>Click the map to place each corner of the area. Click the <b style={{ color: '#34b36e' }}>green</b> first corner (or press <b>Enter</b>) to finish. <b>Esc</b> cancels.</> : 'Areas are named sections of the yard. Draw one, or start from the 20-pole grids, then name them. Instructors are assigned to areas on M5 Roster.')
          : mode === 'source' ? 'Click the pole or riser the yard is fed from.'
          : anchor ? <>From <b>{label(byId.get(anchor)!)}</b>: click the next item to add a span (click an existing span's far end to remove it). Keep clicking to run a line down a row. <b>Esc</b> to stop.</>
          : 'Click an item to start a span, then the next item. Click a span to put a switch / fuse / recloser on it or delete it. Amber rings = not tied in. Red spans = cut off from the source.'}
      </div>
      <div className={`map ${mode === 'area' ? 'areamode' : ''}`}>
        <div ref={divRef} style={{ position: 'absolute', inset: 0 }} />
        {mode === 'area' && (
          <div className="inspector" style={{ right: 10, top: 10, maxHeight: 'calc(100% - 20px)', overflow: 'auto' }}>
            <div className="ih"><span className="id">Yard areas</span><span style={{ flex: 1 }} /><span className="dim mono" style={{ fontSize: 10 }}>{(cfg.areas ?? []).length}</span></div>
            <div className="ib">
              <div className="acts" style={{ marginTop: 0 }}>
                {draw ? <><button className="btn pri sm" disabled={draw.pts.length < 3} onClick={finishDraw}>Finish ({draw.pts.length})</button><button className="btn sm" onClick={() => { st.current.draw = null; setDraw(null); }}>Cancel</button></>
                  : <><button className="btn pri sm" onClick={() => { const n = { pts: [] }; st.current.draw = n; setDraw(n); setSelArea(null); }}>＋ Draw area</button>
                    <button className="btn sm" title="One box around each 20-pole grid" onClick={() => { const add = suggestAreas(items as YardItem[], CAMPUS?.grids ?? [], cfg.areas ?? []); if (!add.length) { setMsg('No new grid areas to add.'); return; } change(x => ({ ...x, areas: [...(x.areas ?? []), ...add] })); setMsg(`Added ${add.length} grid areas — rename them.`); }}>From grids</button></>}
              </div>
              {(cfg.areas ?? []).map(a => (
                <div key={a.id} className={`area-row ${a.id === selArea ? 'sel' : ''}`} onClick={() => setSelArea(a.id)}>
                  <input type="color" value={a.color || '#3fb6d3'} onChange={ev => setArea(a.id, { color: ev.target.value })} title="Color" />
                  <input className="area-name" value={a.name} onChange={ev => setArea(a.id, { name: ev.target.value.slice(0, 40) })} onFocus={() => setSelArea(a.id)} />
                  <span className="dim mono" style={{ fontSize: 10, width: 26, textAlign: 'right' }} title="Items inside">{areaCount(a)}</span>
                  {a.id === selArea && <>
                    <button className="btn sm" title="Zoom to" onClick={() => mapRef.current?.fitBounds(L.latLngBounds(a.poly), { maxZoom: 20, padding: [40, 40] })}>⌖</button>
                    <button className="btn sm" title="Redraw the outline" onClick={() => { const n = { pts: [], redo: a.id }; st.current.draw = n; setDraw(n); }}>✎</button>
                    <button className="btn sm danger" title="Delete area" onClick={() => { if (confirm(`Delete area ${a.name}?`)) { change(x => ({ ...x, areas: (x.areas ?? []).filter(z => z.id !== a.id) })); setSelArea(null); } }}>✕</button>
                  </>}
                </div>
              ))}
              {!(cfg.areas ?? []).length && <div className="dim" style={{ fontSize: 11, marginTop: 6 }}>No areas yet.</div>}
              <div className="dim" style={{ fontSize: 10.5, marginTop: 8 }}>Save &amp; apply when done. Work orders take the area they fall in, and suggest that area's instructor.</div>
            </div>
          </div>
        )}
        {mode !== 'area' && L0 && ia && ib && (
          <div className="inspector" style={{ right: 10, top: 10 }}>
            <div className="ih"><span className="id">{label(ia)} – {label(ib)}</span><span style={{ flex: 1 }} /><button className="btn sm" onClick={() => setSelLink(null)}>✕</button></div>
            <div className="ib">
              <div className="sec-t" style={{ marginTop: 0 }}>Device on this span</div>
              <div className="form-row">
                {(['none', 'switch', 'fuse', 'recloser'] as const).map(t => (
                  <button key={t} className={`btn sm ${(L0.dev?.type ?? 'none') === t ? 'on' : ''}`} onClick={() => setDev(selLink!, t === 'none' ? undefined : { ...(L0.dev ?? {}), type: t })}>{t}</button>
                ))}
              </div>
              {L0.dev && <>
                <div className="form-row" style={{ marginTop: 6 }}>
                  <span className="dim" style={{ fontSize: 10.5 }}>At</span>
                  <button className={`btn sm ${L0.dev.at !== L0.b ? 'on' : ''}`} onClick={() => setDev(selLink!, { ...L0.dev!, at: L0.a })}>{label(ia)}</button>
                  <button className={`btn sm ${L0.dev.at === L0.b ? 'on' : ''}`} onClick={() => setDev(selLink!, { ...L0.dev!, at: L0.b })}>{label(ib)}</button>
                </div>
                <div className="form-row" style={{ marginTop: 6 }}>
                  <input placeholder={`ID (auto: ${L0.dev.type[0].toUpperCase()}-${label(L0.dev.at === L0.b ? ib : ia)})`} value={L0.dev.id ?? ''} onChange={ev => setDev(selLink!, { ...L0.dev!, id: ev.target.value.toUpperCase().slice(0, 16) || undefined })} style={{ flex: 1 }} />
                </div>
                <label style={{ display: 'flex', gap: 4, alignItems: 'center', marginTop: 6, fontSize: 11 }}><input type="checkbox" checked={!!L0.dev.no} onChange={ev => setDev(selLink!, { ...L0.dev!, no: ev.target.checked || undefined })} /> Normally OPEN (open point / tie)</label>
              </>}
              <div className="acts" style={{ marginTop: 8 }}>
                <button className="btn danger" onClick={() => { const i = selLink!; change(x => ({ ...x, links: x.links.filter((_, j) => j !== i) })); setSelLink(null); }}>Delete span</button>
              </div>
              <div className="dim" style={{ fontSize: 10.5, marginTop: 6 }}>Spans that close a loop become normally-open ties automatically.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
