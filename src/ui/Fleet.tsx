// Crew roster, reliability indices, and the big-screen status wall.
import { useState } from 'react';
import { useCtx, age } from './ctx';
import type { Engine } from '../sim/engine';
import { areas } from '../sim/campus';
import { tellUnit } from '../live/comms';
/** Set someone's area and tell their phone. */
export function assignArea(e: Engine, id: string, areaId: string, flash: (t: string, l?: any) => void) {
  const err = e.liveUnitArea(id, areaId);
  if (err) { flash(err, 'warn'); return; }
  const n = areaName(areaId);
  tellUnit(e, id, n ? `You're assigned to ${n}` : 'Area assignment cleared').then(x => { if (x) flash(`Phone not notified: ${x}`, 'warn'); });
}
export const areaName = (id?: string) => (id ? areas().find(a => a.id === id)?.name ?? '' : '');
function AreaPick({ id, area, disabled }: { id: string; area?: string; disabled?: boolean }) {
  const { e, flash } = useCtx();
  const list = areas();
  if (disabled) return <span>{areaName(area) || <span className="dim">—</span>}</span>;
  return <select value={area ?? ''} onChange={ev => assignArea(e, id, ev.target.value, flash)} title={list.length ? 'Yard area this person covers' : 'Draw areas first: Edit network → Areas'}>
    <option value="">{list.length ? '— none —' : 'no areas yet'}</option>
    {list.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
  </select>;
}
const RANK: Record<string, number> = { Emergency: 0, Urgent: 1, Routine: 2 };

// ── Roster preferences (persist your own trucks across scenarios) ──
export interface RosterPrefs { extra: { id: string; crew: string; type: string }[]; removed: string[]; names: Record<string, { crew: string; type: string }>; }
const KEY = 'gridops-roster';
export function loadRoster(): RosterPrefs {
  try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v && Array.isArray(v.extra)) return { extra: v.extra, removed: v.removed ?? [], names: v.names ?? {} }; } catch { /* none */ }
  return { extra: [], removed: [], names: {} };
}
function saveRoster(p: RosterPrefs) { try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* none */ } }

/** Apply saved roster to a freshly created scenario (main console only). Quiet: no radio check-ins. */
export function applyRoster(e: Engine) {
  if (e.live) return; // Campus Ops: the board lives in the shared state
  const p = loadRoster();
  for (const id of p.removed) if (e.s.trucks[id]) e.rosterRemove(id);
  for (const [id, n] of Object.entries(p.names)) if (e.s.trucks[id]) e.rosterEdit(id, n.crew, n.type);
  for (const t of p.extra) if (!e.s.trucks[t.id]) e.rosterAdd(t.id, t.crew, t.type, true);
}

const ROLES = ['Instructor', 'Lead Instructor', 'Staff', 'Student crew', 'Visitor'];

export function RosterPanel() {
  const { e, flash, readOnly } = useCtx();
  const [name, setName] = useState('');
  const [role, setRole] = useState(ROLES[0]);
  const [edit, setEdit] = useState<string | null>(null);
  const [eName, setEName] = useState('');
  const [eRole, setERole] = useState('');
  const units = Object.values(e.s.trucks).sort((a, b) => a.crew.localeCompare(b.crew));
  const add = () => {
    const full = name.trim();
    if (!full) return;
    let id = full.split(/\s+/)[0].toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 8);
    if (e.s.trucks[id]) { const parts = full.split(/\s+/); id = (parts[0][0] + (parts[1] ?? '2')).toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 8); }
    const err = e.rosterAdd(id, full, role);
    if (err) { flash(err, 'warn'); return; }
    setName('');
  };
  const remove = (id: string) => {
    const tr = e.s.trucks[id];
    if (tr?.clearance) { flash(`${tr.crew} holds clearance ${tr.clearance} — release it first`, 'warn'); return; }
    if (tr?.sw) { flash(`${tr.crew} is in the middle of switching`, 'warn'); return; }
    if (!confirm(`Take ${tr?.crew ?? id} off the board? Any order they have goes back to Open.`)) return;
    const err = e.rosterRemove(id); if (err) flash(err, 'warn');
  };
  return (
    <div style={{ padding: 8 }}>
      {!readOnly && <div className="form-row">
        <input placeholder="Instructor name (e.g. Andrew Pool)" value={name} onChange={ev => setName(ev.target.value)} onKeyDown={ev => { if (ev.key === 'Enter') add(); }} style={{ flex: 1, minWidth: 160 }} />
        <select value={role} onChange={ev => setRole(ev.target.value)}>{ROLES.map(t => <option key={t}>{t}</option>)}</select>
        <button className="btn pri" disabled={!name.trim()} onClick={add}>Add to board</button>
      </div>}
      <table className="grid" style={{ marginTop: 4 }}>
        <thead><tr><th>Call</th><th>Name</th><th>Role</th><th>Area</th><th>Status</th><th></th></tr></thead>
        <tbody>
          {units.map(t => edit === t.id ? (
            <tr key={t.id}>
              <td className="mono"><b>{t.id}</b></td>
              <td><input value={eName} onChange={ev => setEName(ev.target.value)} style={{ width: '100%' }} /></td>
              <td><select value={eRole} onChange={ev => setERole(ev.target.value)}>{[...new Set([eRole, ...ROLES])].map(x => <option key={x}>{x}</option>)}</select></td>
              <td />
              <td />
              <td><button className="btn good sm" onClick={() => { e.rosterEdit(t.id, eName, eRole); setEdit(null); }}>Save</button> <button className="btn sm" onClick={() => setEdit(null)}>Cancel</button></td>
            </tr>
          ) : (
            <tr key={t.id}>
              <td className="mono"><b>{t.id}</b></td>
              <td>{t.crew}</td>
              <td className="dim">{t.type}</td>
              <td><AreaPick id={t.id} area={t.area} disabled={readOnly} /></td>
              <td><span className={`chip ${t.status.replace(/\s+/g, '')}`}>{t.status}</span></td>
              <td>{!readOnly && <><button className="btn sm" onClick={() => { setEdit(t.id); setEName(t.crew); setERole(t.type); }}>Edit</button> <button className="btn danger sm" onClick={() => remove(t.id)}>Remove</button></>}</td>
            </tr>
          ))}
          {!units.length && <tr><td colSpan={6} className="empty">No one on the board yet. Add the instructors and staff working today.</td></tr>}
        </tbody>
      </table>
      {areas().length > 0 && <>
        <div className="sec-t" style={{ marginTop: 10 }}>Yard areas</div>
        <table className="grid">
          <thead><tr><th>Area</th><th>Instructor(s)</th><th>Open orders</th></tr></thead>
          <tbody>
            {areas().map(a => { const who = units.filter(t => t.area === a.id); const n = Object.values(e.s.workorders).filter(w => w.area === a.id && !['Done', 'Canceled'].includes(w.status)).length; return (
              <tr key={a.id}>
                <td><span className="area-chip" style={{ color: a.color || '#3fb6d3' }}>{a.name}</span></td>
                <td>{who.length ? who.map(t => t.crew).join(', ') : <span className="c-amber">nobody assigned</span>}</td>
                <td className="mono">{n || <span className="dim">0</span>}</td>
              </tr>); })}
          </tbody>
        </table>
      </>}
      <div className="dim" style={{ fontSize: 10.5, marginTop: 6 }}>Pick each person's area in the Area column (draw and name areas under Edit network → Areas). The board is shared — everyone signed in sees it. Anyone holding a clearance or mid-switching can't be removed until they're clear.</div>
    </div>
  );
}

// ── Reliability ──────────────────────────────────────────────
const mins = (sec: number | null) => (sec == null ? '—' : `${(sec / 60).toFixed(1)}m`);

export function ReliabilityPanel() {
  const { e, setSel } = useCtx();
  const r = e.reliability();
  const incs = Object.values(e.s.incidents).sort((a, b) => b.t - a.t);
  return (
    <div style={{ padding: 8 }}>
      <div className="relgrid">
        <div className="metric"><div className="k">SAIDI</div><div className="v">{r.saidi.toFixed(2)}<small> min</small></div><div className="h">cust-min ÷ cust served</div></div>
        <div className="metric"><div className="k">SAIFI</div><div className="v">{r.saifi.toFixed(3)}</div><div className="h">cust interrupted ÷ served</div></div>
        <div className="metric"><div className="k">CAIDI</div><div className="v">{r.caidi.toFixed(1)}<small> min</small></div><div className="h">avg restore per cust</div></div>
        <div className="metric"><div className="k">MAIFI</div><div className="v">{r.maifi.toFixed(3)}</div><div className="h">momentaries ÷ served</div></div>
        <div className="metric"><div className="k">Avg dispatch</div><div className="v">{mins(r.avgDispatch)}</div><div className="h">report → crew assigned</div></div>
        <div className="metric"><div className="k">Avg response</div><div className="v">{mins(r.avgResp)}</div><div className="h">report → crew on scene</div></div>
        <div className="metric"><div className="k">Avg restore</div><div className="v">{mins(r.avgRestore)}</div><div className="h">report → power on</div></div>
        <div className="metric"><div className="k">Cust-minutes</div><div className="v">{Math.round(r.cmi).toLocaleString()}</div><div className="h">{r.ci.toLocaleString()} cust interrupted · {r.mom.toLocaleString()} momentary</div></div>
      </div>
      <table className="grid" style={{ marginTop: 8 }}>
        <thead><tr><th>Incident</th><th>Device</th><th>Peak</th><th>Dispatch</th><th>Response</th><th>Restore</th><th>Cust-min</th><th>Status</th></tr></thead>
        <tbody>
          {incs.map(i => (
            <tr key={i.id} className="row" onClick={() => setSel({ kind: 'inc', id: i.id })}>
              <td className="mono">{i.id}</td>
              <td className="mono">{i.kind === 'single' ? 'SINGLE' : i.predDev}</td>
              <td className="num">{i.peak}</td>
              <td className="num">{i.firstDispatchT != null ? mins(i.firstDispatchT - i.t) : <span className="c-amber">{age(e.s.t - i.t)}…</span>}</td>
              <td className="num">{i.onSceneT != null ? mins(i.onSceneT - i.t) : '—'}</td>
              <td className="num">{i.restoredT != null ? mins(i.restoredT - i.t) : '—'}</td>
              <td className="num">{Math.round(i.cmi ?? 0).toLocaleString()}</td>
              <td>{i.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="dim" style={{ fontSize: 10.5, marginTop: 6 }}>Indices cover this exercise only, over {r.N.toLocaleString()} customers served. Every interruption is counted as sustained; momentaries are recloser operations that cleared.</div>
    </div>
  );
}

// ── Status wall (big screen / projector) ─────────────────────
export function StatusWall() {
  const { e } = useCtx();
  const s = e.s;
  const out = e.customersOut();
  const N = e.T.totalCustomers;
  const wos = Object.values(s.workorders).filter(w => w.issue !== undefined);
  const open = wos.filter(w => !['Done', 'Canceled'].includes(w.status)).sort((a, b) => RANK[a.priority ?? 'Routine'] - RANK[b.priority ?? 'Routine'] || (a.createdT ?? 0) - (b.createdT ?? 0));
  const emg = open.filter(w => w.priority === 'Emergency').length;
  const unack = s.alarms.filter(a => !a.acked);
  const lastP1 = s.alarms.filter(a => a.active && a.pri === 1).at(-1);
  const units = Object.values(s.trucks).sort((a, b) => a.crew.localeCompare(b.crew));
  const lastRadio = s.radio.slice(-3);
  const day = 86400;
  const doneToday = wos.filter(w => w.status === 'Done' && w.doneT != null && s.t - w.doneT < day);
  const assignT = wos.map(w => { const h = (w.history ?? []).find(x => x.text.startsWith('Assigned')); return h ? h.t - (w.createdT ?? h.t) : null; }).filter((x): x is number => x != null);
  const doneT = doneToday.map(w => w.doneT! - (w.createdT ?? w.doneT!));
  const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
  const clr = Object.values(s.clearances).filter(c => c.status === 'Active');
  const ords = Object.values(s.orders).filter(o => o.status === 'Active');
  const abnormal = e.T.switchable.filter(id => s.dev[id].open !== (e.T.els[id] as any).normalOpen).length;
  return (
    <div className="wall">
      <div className="wall-hero">
        <div className="wtile big">
          <div className="k">Open work orders</div>
          <div className={`v ${emg ? 'c-red' : open.length ? 'c-amber' : 'c-green'}`}>{open.length}</div>
          <div className="sub">{emg ? <span className="c-red">{emg} EMERGENCY</span> : `${open.filter(w => w.priority === 'Urgent').length} urgent · ${open.filter(w => !w.truck).length} unassigned`}</div>
        </div>
        <div className="wtile"><div className="k">Out of service</div><div className={`v ${out ? 'c-red' : ''}`}>{out}<small>/{N}</small></div><div className="sub">{abnormal ? `${abnormal} device(s) off normal` : 'all devices normal'}</div></div>
        <div className="wtile"><div className="k">Unack alarms</div><div className={`v ${unack.length ? 'c-red' : ''}`}>{unack.length}</div><div className="sub">{lastP1 ? lastP1.text.slice(0, 40) : 'none active P1'}</div></div>
        <div className="wtile"><div className="k">Available</div><div className="v">{units.filter(t => t.status === 'Available').length}<small>/{units.length}</small></div><div className="sub">{units.filter(t => t.status === 'Off Duty').length} off duty</div></div>
      </div>
      <div className="wall-rel">
        {([['Clearances', String(clr.length)], ['Switching', String(ords.length)], ['Done today', String(doneToday.length)], ['Avg to assign', mins(avg(assignT))], ['Avg to complete', mins(avg(doneT))], ['Emergency', s.scen.flags.emergencyTraffic ? 'TRAFFIC' : '—']] as [string, string][]).map(([k, v]) => (
          <div key={k} className="wtile sm"><div className="k">{k}</div><div className={`v ${k === 'Emergency' && v !== '—' ? 'c-red' : ''}`}>{v}</div></div>
        ))}
      </div>
      <div className="wall-main">
        <div className="wpanel">
          <div className="wh">Open work orders</div>
          {open.length === 0 && <div className="wempty">All clear</div>}
          {open.slice(0, 8).map(w => (
            <div key={w.id} className={`wrow ${w.priority === 'Emergency' ? 'p1' : w.priority === 'Urgent' ? 'p2' : 'p3'}`}>
              <span className={`badge ${w.priority === 'Emergency' ? 'p1' : w.priority === 'Urgent' ? 'p2' : 'p3'}`}>{(w.priority ?? 'Routine').slice(0, 3).toUpperCase()}</span>
              <span className="mono">{w.id}</span>
              <span className="grow">{w.area ? <b>{areaName(w.area)} · </b> : ''}{w.loc} · {w.issue}</span>
              <span className="mono">{w.truck ? (s.trucks[w.truck]?.crew.split(' ')[0] ?? w.truck) : <span className="c-amber">—</span>}</span>
              <span className="mono dim">{w.status} · {age(s.t - (w.createdT ?? s.t))}</span>
            </div>
          ))}
        </div>
        <div className="wpanel">
          <div className="wh">Instructors</div>
          {units.length === 0 && <div className="wempty">No one on the board</div>}
          {units.map(t => (
            <div key={t.id} className="wrow">
              <span className="mono"><b>{t.crew}</b></span>
              <span className={`chip ${t.status.replace(/\s+/g, '')}`}>{t.status}</span>
              <span className="grow">{t.task?.kind === 'workorder' ? `${t.task.id} · ${s.workorders[t.task.id]?.loc ?? ''}` : ''}{t.sw ? ` · ${t.sw.order}` : ''}{t.clearance ? ` · ${t.clearance}` : ''}</span>
              <span className="dim">{areaName(t.area) || e.locOf(t.pos)}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="wall-foot">
        <div className="wpanel feeders">
          {e.T.feederIds.map(f => { const rd = e.readings[f]; const tot = (rd?.cust ?? 0) + (rd?.custOut ?? 0); const pct = tot ? (rd.cust / tot) : (e.s.dev[e.T.feeders[f].breaker]?.open ? 0 : 1); return (
            <div key={f} className="fbar">
              <span className="mono">{f}</span>
              <div className="track"><div className="fill" style={{ width: `${pct * 100}%`, background: pct < 1 ? 'var(--amber)' : e.T.feeders[f].color }} /></div>
              <span className="mono">{e.s.dev[e.T.feeders[f].breaker]?.open ? 'OPEN' : 'IN'}</span>
              <span className={`mono ${rd?.custOut ? 'c-red' : 'dim'}`}>{rd?.custOut ? `${rd.custOut} out` : ''}</span>
            </div>); })}
        </div>
        <div className="wpanel radio">
          {lastRadio.map(m => <div key={m.id} className="wradio"><span className="mono dim">{e.hhmm(m.t)}</span> <b>{m.from}:</b> {m.text}</div>)}
        </div>
      </div>
    </div>
  );
}
