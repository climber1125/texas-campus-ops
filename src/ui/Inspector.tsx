// Equipment / pole / unit / work-order inspector — floats over the active monitor.
// Campus Ops: device operations are RECORDED (the instructor operates in the field
// and reports by radio); clearances are issued to an instructor by name.
import { useState, Fragment } from 'react';
import { useCtx, age } from './ctx';
import type { DevEl, LineEl, CrewStatus } from '../sim/types';
import { sectionAround } from '../sim/network';
import { devWord } from '../sim/radio';
import { SUB_SPECS, CAMPUS } from '../sim/topology';
import { itemPos, label } from '../sim/campus';
import { itemById, WoDetail, woOpen, notifyAssign } from './Orders';
import { tellUnit } from '../live/comms';

const STATUSES: CrewStatus[] = ['Available', 'Dispatched', 'En Route', 'On Scene', 'Working', 'Standing By', 'Off Duty'];

export function Inspector() {
  const { e, sel, setSel } = useCtx();
  if (!sel || sel.kind === 'wo' && !e.s.workorders[sel.id]) return null;
  return (
    <div className="inspector">
      <div className="ih">
        <span className="id">{title(sel.kind, sel.id, e)}</span>
        <span className="dim" style={{ fontSize: 10, textTransform: 'uppercase' }}>{sub(sel.kind, sel.id, e)}</span>
        <span style={{ flex: 1 }} />
        <button className="btn sm" onClick={() => setSel(null)}>✕</button>
      </div>
      <div className="ib">
        {sel.kind === 'dev' && <DevView id={sel.id} />}
        {sel.kind === 'load' && <LoadView id={sel.id} />}
        {sel.kind === 'truck' && <TruckView id={sel.id} />}
        {sel.kind === 'line' && <LineView id={sel.id} />}
        {sel.kind === 'sub' && <SubView id={sel.id} />}
        {sel.kind === 'pole' && <PoleView id={sel.id} />}
        {sel.kind === 'wo' && <WoDetail wo={e.s.workorders[sel.id]} />}
      </div>
    </div>
  );
}

function title(k: string, id: string, e: any) {
  if (k === 'truck') return (e.s.trucks[id]?.crew ?? id).toUpperCase();
  if (k === 'sub') return SUB_SPECS.find(s => s.id === id)?.name ?? id;
  if (k === 'pole') { const it = itemById(id); return it ? label(it) : id; }
  return id;
}
function sub(k: string, id: string, e: any) {
  if (k === 'dev') { const d = e.T.els[id] as DevEl; return `${devWord(d)} · ${d.feeder}`; }
  if (k === 'load') return 'transformer / service point';
  if (k === 'line') return 'span';
  if (k === 'wo') return 'work order';
  if (k === 'pole') return itemById(id)?.itemType ?? 'pole';
  if (k === 'truck') return e.s.trucks[id]?.type ?? 'unit';
  return '';
}

/** Issue a clearance to an instructor on the section around this element. */
function ClearanceBox({ elId }: { elId: string }) {
  const { e, flash, readOnly } = useCtx();
  const [unit, setUnit] = useState('');
  const [why, setWhy] = useState('');
  if (readOnly) return null;
  const units = Object.values(e.s.trucks).filter(t => !t.clearance).sort((a, b) => a.crew.localeCompare(b.crew));
  const sec = sectionAround(e.T, elId);
  return (
    <>
      <div className="sec-t">Clearance on this section</div>
      <div className="dim" style={{ fontSize: 10.5 }}>Bounded by {sec.bounds.join(', ') || '—'}. Every boundary must be open; HOLD tags go on all of them.</div>
      <div className="form-row" style={{ marginTop: 4 }}>
        <select value={unit} onChange={ev => setUnit(ev.target.value)}><option value="">— issue to —</option>{units.map(u => <option key={u.id} value={u.id}>{u.crew}</option>)}</select>
        <input placeholder="purpose" value={why} onChange={ev => setWhy(ev.target.value)} style={{ flex: 1, minWidth: 90 }} />
        <button className="btn warn" disabled={!unit} onClick={() => { const err = e.liveClearance(unit, elId, why); if (err) flash(err, 'warn'); else { flash('Clearance issued — HOLD tags applied', 'good'); const cl = e.s.trucks[unit]?.clearance; if (cl) tellUnit(e, unit, `Clearance ${cl} issued to you — HOLD tags on ${sec.bounds.join(', ')}. ${why || ''}`.trim()); setUnit(''); setWhy(''); } }}>Issue</button>
      </div>
    </>
  );
}

function DevView({ id }: { id: string }) {
  const { e, openSbo, setTab, setSwPrefill, flyTo, flash, readOnly, newWo } = useCtx();
  const d = e.T.els[id] as DevEl;
  const st = e.s.dev[id];
  if (!d || !st) return <div className="empty">Device not in the current network.</div>;
  const en = e.nodeEn(d.from) || e.nodeEn(d.to);
  const outUnder = e.T.devLoads[id].filter(l => !e.loadEn(l)).length;
  const lastSoe = e.s.soe.filter(x => x.dev === id).slice(-5).reverse();
  return (
    <>
      <div className="kv">
        <span className="k">Status</span>
        <span className="v">
          <span className={`state ${st.lockout ? 'lockout' : st.open ? 'open' : 'closed'}`}>{st.lockout ? 'LOCKOUT' : st.open ? 'OPEN' : 'CLOSED'}</span>
          {st.tags.map(t => <span key={t} className={`badge ${t === 'OPR-LO' ? 'red' : 'amber'}`} style={{ marginLeft: 4 }}>{t === 'OPR-LO' ? 'OPERATOR LOCKOUT' : `HOLD ${t}`}</span>)}
        </span>
        <span className="k">Normal</span><span className="v">{d.normalOpen ? 'Normally OPEN' : 'Normally CLOSED'}{st.open !== d.normalOpen ? <span className="c-amber"> · ABNORMAL</span> : null}</span>
        <span className="k">Location</span><span className="v">{d.loc}</span>
        <span className="k">Control</span><span className="v">Field — operator records it</span>
        <span className="k">Section</span><span className="v">{en ? <span className="c-green">IN SERVICE</span> : <span className="c-red">OUT OF SERVICE</span>}</span>
        <span className="k">Downstream</span><span className="v">{e.T.devCust[id]} service point(s){outUnder ? <span className="c-red"> · {outUnder} out</span> : null}</span>
        <span className="k">Operations</span><span className="v">{st.ops}</span>
      </div>
      {!readOnly && <div className="acts">
        {d.type !== 'xfmr' && <>
          <button className="btn danger" disabled={st.open} onClick={() => openSbo({ dev: id, action: 'open' })}>Record OPEN</button>
          <button className="btn good" disabled={!st.open} onClick={() => openSbo({ dev: id, action: 'close' })}>Record CLOSE</button>
        </>}
        {(d.type === 'breaker' || d.type === 'recloser') && (!st.tags.includes('OPR-LO')
          ? <button className="btn danger" title="Open (if closed) and apply a do-not-close tag" onClick={() => openSbo({ dev: id, action: 'lockout' })}>LOCK OUT</button>
          : <button className="btn warn" onClick={() => { const er = e.releaseLockout(id); if (er) flash(er, 'warn'); }}>Remove lockout</button>)}
        {d.type !== 'fuse' && d.type !== 'xfmr' && <button className="btn" onClick={() => { setSwPrefill({ dev: id, action: st.open ? 'close' : 'open' }); setTab('sw'); }}>Add to switching order</button>}
        <button className="btn" onClick={() => newWo({ text: `${id} `, item: CAMPUS?.nodeItem[d.from] ?? CAMPUS?.nodeItem[d.to] ?? null })}>Work order</button>
        <button className="btn" onClick={() => flyTo(d.pos, 20)}>Zoom</button>
      </div>}
      {d.type !== 'xfmr' && <ClearanceBox elId={id} />}
      {lastSoe.length > 0 && <><div className="sec-t">Recent events</div>
        {lastSoe.map((x, i) => <div key={i} style={{ fontSize: 10.5 }}><span className="mono dim">{e.hhmmss(x.t)}</span> {x.text}</div>)}</>}
    </>
  );
}

function PoleView({ id }: { id: string }) {
  const { e, flyTo, newWo, readOnly, setSel } = useCtx();
  const it = itemById(id);
  if (!it) return <div className="empty">Item not found.</div>;
  const node = CAMPUS?.itemNode[id];
  const inNet = !!node && (e.T.adj[node]?.length ?? 0) > 0;
  const en = node ? e.nodeEn(node) : false;
  const wos = Object.values(e.s.workorders).filter(w => w.item === id);
  const open = wos.filter(woOpen);
  const els = node ? e.T.adj[node] : [];
  const devs = els.map(x => e.T.els[x]).filter(x => x?.kind === 'device' && (x as DevEl).type !== 'breaker') as DevEl[];
  return (
    <>
      <div className="kv">
        <span className="k">Type</span><span className="v">{it.itemType ?? 'pole'}</span>
        {it.itemType !== 'building' && <><span className="k">Section</span><span className="v">{!inNet ? <span className="dim">not tied in</span> : en ? <span className="c-green">IN SERVICE</span> : <span className="c-red">OUT OF SERVICE</span>}</span></>}
        {(it.components ?? []).length > 0 && <><span className="k">On it</span><span className="v" style={{ whiteSpace: 'normal' }}>{it.components!.join(', ')}</span></>}
        {devs.length > 0 && <><span className="k">Devices</span><span className="v">{devs.map(d => <a key={d.id} style={{ color: 'var(--cyan)', cursor: 'pointer', marginRight: 6 }} onClick={() => setSel({ kind: 'dev', id: d.id })}>{d.id}</a>)}</span></>}
        {it.notes && <><span className="k">Notes</span><span className="v" style={{ whiteSpace: 'normal' }}>{it.notes}</span></>}
        <span className="k">GPS</span><span className="v">{Number(it.gpsLat ?? it.lat).toFixed(6)}, {Number(it.gpsLng ?? it.lng).toFixed(6)}{it.gpsLat != null ? <span className="dim"> · shown on an even grid</span> : null}</span>
        <span className="k">Work orders</span><span className="v">{open.length} open · {wos.length} total</span>
      </div>
      {open.map(w => <div key={w.id} className="row" style={{ fontSize: 11, padding: '3px 0', cursor: 'pointer' }} onClick={() => setSel({ kind: 'wo', id: w.id })}><span className={`pri-${w.priority}`}>{w.id}</span> {w.status} — {w.issue}</div>)}
      <div className="acts">
        {!readOnly && <button className="btn pri" onClick={() => newWo({ item: id })}>＋ Work order here</button>}
        <button className="btn" onClick={() => flyTo(itemPos(it), 20.5)}>Zoom</button>
      </div>
      {inNet && els.find(x => e.T.els[x]?.kind === 'line') && <ClearanceBox elId={els.find(x => e.T.els[x]?.kind === 'line')!} />}
    </>
  );
}

function LoadView({ id }: { id: string }) {
  const { e, flyTo } = useCtx();
  const L = e.T.loads[id];
  if (!L) return null;
  const en = e.loadEn(id);
  return (
    <>
      <div className="kv">
        <span className="k">Service</span><span className="v">{en ? <span className="c-green">IN SERVICE</span> : <span className="c-red">OUT {e.s.loadOutSince[id] !== undefined ? age(e.s.t - e.s.loadOutSince[id]) : ''}</span>}</span>
        <span className="k">Item</span><span className="v">{L.addr}</span>
        <span className="k">Transformer</span><span className="v">{L.id} · {L.kva} kVA (nominal)</span>
        <span className="k">Circuit</span><span className="v">{L.feeder}</span>
        {L.lateral && <><span className="k">Fuse</span><span className="v">{L.lateral}</span></>}
        <span className="k">Protection path</span><span className="v" style={{ whiteSpace: 'normal' }}>{e.T.loadAnc[id].slice(0, 5).join(' → ')}</span>
      </div>
      <div className="acts"><button className="btn" onClick={() => flyTo(L.pos, 20)}>Zoom</button></div>
    </>
  );
}

function LineView({ id }: { id: string }) {
  const { e, setSel, newWo, readOnly } = useCtx();
  const el = e.T.els[id] as LineEl;
  if (!el) return null;
  const en = e.elEnergized(id);
  const sec = sectionAround(e.T, id);
  const ends = [CAMPUS?.nodeItem[el.from], CAMPUS?.nodeItem[el.to]].filter(Boolean) as string[];
  return (
    <>
      <div className="kv">
        <span className="k">State</span><span className="v">{en ? <span className="c-green">IN SERVICE</span> : <span className="c-red">OUT OF SERVICE</span>}</span>
        <span className="k">Circuit</span><span className="v">{el.feeder}</span>
        <span className="k">Construction</span><span className="v">{el.ug ? 'Underground' : 'Overhead'}{el.tie ? ' · tie' : el.lateral ? ' · fused tap' : ''}</span>
        <span className="k">Length</span><span className="v">{Math.round(el.len)} m · {Math.round(el.len * 3.281)} ft</span>
        <span className="k">Ends</span><span className="v">{ends.map(x => <a key={x} style={{ color: 'var(--cyan)', cursor: 'pointer', marginRight: 6 }} onClick={() => setSel({ kind: 'pole', id: x })}>{label(itemById(x)!)}</a>)}</span>
        <span className="k">Section bounds</span><span className="v" style={{ whiteSpace: 'normal' }}>{sec.bounds.map(b => <a key={b} style={{ color: 'var(--cyan)', cursor: 'pointer', marginRight: 6 }} onClick={() => setSel({ kind: 'dev', id: b })}>{b}</a>)}</span>
      </div>
      {!readOnly && <div className="acts"><button className="btn" onClick={() => newWo({ item: ends[0] ?? null, text: ends.length === 2 ? `Span ${label(itemById(ends[0])!)} to ${label(itemById(ends[1])!)}: ` : '' })}>Work order on span</button></div>}
      <ClearanceBox elId={id} />
    </>
  );
}

function SubView({ id }: { id: string }) {
  const { e, setTab } = useCtx();
  const s = e.T.subs[id];
  return (
    <>
      <div className="kv">
        <span className="k">Source</span><span className="v">Yard source (training — not energized)</span>
        {s.feeders.map(f => <Fragment key={f}><span className="k">{f}</span><span className="v">{e.s.dev[e.T.feeders[f].breaker]?.open ? <span className="c-red">breaker OPEN</span> : <span className="c-green">in service</span>} · {e.readings[f]?.cust ?? 0} pts</span></Fragment>)}
      </div>
      <div className="acts"><button className="btn pri" onClick={() => setTab('scada')}>Open one-line</button></div>
    </>
  );
}

export function TruckView({ id }: { id: string }) {
  const { e, flyTo, flash, readOnly, setSel } = useCtx();
  const tr = e.s.trucks[id];
  const [wo, setWo] = useState('');
  if (!tr) return <div className="empty">Not on the board</div>;
  const task = tr.task?.kind === 'workorder' ? tr.task.id : null;
  const openWos = Object.values(e.s.workorders).filter(w => woOpen(w) && w.issue !== undefined);
  const run = (err: string | null | undefined) => { if (err) flash(err, 'warn'); };
  return (
    <>
      <div className="kv">
        <span className="k">Status</span><span className="v"><span className={`chip ${tr.status.replace(/\s+/g, '')}`}>{tr.status}</span></span>
        <span className="k">Name</span><span className="v">{tr.crew}</span>
        <span className="k">Role</span><span className="v">{tr.type}</span>
        <span className="k">Assignment</span><span className="v" style={{ whiteSpace: 'normal' }}>{task ? <a style={{ color: 'var(--cyan)', cursor: 'pointer' }} onClick={() => setSel({ kind: 'wo', id: task })}>{task} — {e.s.workorders[task]?.issue}</a> : '—'}</span>
        {tr.sw && <><span className="k">Switching</span><span className="v">{tr.sw.order} step {tr.sw.idx + 1}</span></>}
        {tr.clearance && <><span className="k">Clearance</span><span className="v c-amber">{tr.clearance}</span></>}
        <span className="k">Location</span><span className="v">{e.locOf(tr.pos)}</span>
      </div>
      {!readOnly && <>
        <div className="sec-t">Status (as reported)</div>
        <div className="form-row" style={{ flexWrap: 'wrap' }}>
          {STATUSES.map(s => <button key={s} className={`btn sm ${tr.status === s ? 'on' : ''}`} onClick={() => run(e.liveUnitStatus(id, s))}>{s}</button>)}
        </div>
        <div className="sec-t">Assign work order</div>
        <div className="form-row">
          <select value={wo} onChange={ev => setWo(ev.target.value)} style={{ flex: 1 }}>
            <option value="">— select —</option>
            {openWos.map(w => <option key={w.id} value={w.id}>{w.priority?.slice(0, 3).toUpperCase()} {w.id} {w.loc}</option>)}
          </select>
          <button className="btn pri" disabled={!wo} onClick={() => { const err = e.liveWoUpdate(wo, { assignee: id }); run(err); if (!err) notifyAssign(e, wo, flash); setWo(''); }}>Assign</button>
        </div>
      </>}
      <div className="acts"><button className="btn" onClick={() => flyTo(tr.pos, 20)}>Zoom</button></div>
    </>
  );
}
