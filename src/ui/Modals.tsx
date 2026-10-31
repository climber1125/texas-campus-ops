import { useEffect, useState } from 'react';
import { useCtx, age, type SboReq } from './ctx';
import type { DevEl } from '../sim/types';
import { SCENARIOS, SCENARIO_LIST } from '../sim/scenarios';
import { devWord } from '../sim/radio';

// Select-before-operate SCADA control dialog
export function SboModal({ req, onClose }: { req: SboReq; onClose(): void }) {
  const { e, flash } = useCtx();
  const [armedAt, setArmedAt] = useState<number | null>(null);
  const [unit, setUnit] = useState('');
  const [, force] = useState(0);
  useEffect(() => { const id = setInterval(() => force(x => x + 1), 500); return () => clearInterval(id); }, []);
  const d = e.T.els[req.dev] as DevEl;
  const st = e.s.dev[req.dev];
  const lo = req.action === 'lockout';
  const pv = e.preview(req.dev, lo ? 'open' : (req.action as 'open' | 'close'));
  const left = armedAt ? Math.max(0, 30 - Math.floor((Date.now() - armedAt) / 1000)) : 0;
  useEffect(() => { if (armedAt && left === 0) setArmedAt(null); }, [left, armedAt]);
  const order = req.order ? e.s.orders[req.order] : undefined;
  const stepLoop = order ? order.steps[order.cur]?.loop : false;
  const blockers: string[] = [];
  if (!e.live && !d.scada) blockers.push('Device is not SCADA controllable.');
  if (!e.live && !st.comm) blockers.push('RTU communication failure — control unavailable.');
  if (req.action === 'close' && st.tags.length) blockers.push(`HOLD tag ${st.tags.join(', ')} — close prohibited.`);
  if (pv.loop && !stepLoop) blockers.push(`Would parallel ${pv.parallelSubs ? 'two substations' : 'two feeders'} — only allowed as a LOOP step of an active switching order.`);
  const exec = () => {
    const err = lo ? e.lockoutDevice(req.dev) : req.viaOrder && req.order ? e.issueStep(req.order) : e.live ? e.liveOperate(req.dev, req.action as 'open' | 'close', unit) : (e.scadaControl(req.dev, req.action as 'open' | 'close').reason ?? null);
    if (err) flash(err, 'warn'); else flash(`${req.dev} ${lo ? 'OPENED & LOCKED OUT' : req.action === 'open' ? 'OPENED' : 'CLOSED'}${e.live ? ' — recorded' : ' via SCADA'}`, 'good');
    onClose();
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" onClick={ev => ev.stopPropagation()}>
        <div className="mh"><span className="t">{e.live ? 'Record field operation — select before operate' : 'SCADA Control — Select Before Operate'}</span><span style={{ flex: 1 }} /><button className="btn sm" onClick={onClose}>✕</button></div>
        <div className="mb">
          <div className="kv">
            <span className="k">Device</span><span className="v"><b>{req.dev}</b> — {devWord(d)} · {d.feeder}</span>
            <span className="k">Location</span><span className="v">{d.loc}</span>
            {e.live && !lo && !req.viaOrder && <><span className="k">Operated by</span><span className="v"><select value={unit} onChange={ev => setUnit(ev.target.value)}><option value="">— operator record —</option>{Object.values(e.s.trucks).sort((a, b) => a.crew.localeCompare(b.crew)).map(t => <option key={t.id} value={t.id}>{t.crew}</option>)}</select> <span className="dim">who reported it on the radio</span></span></>}
            <span className="k">Present state</span><span className="v"><span className={`state ${st.open ? 'open' : 'closed'}`}>{st.lockout ? 'LOCKOUT' : st.open ? 'OPEN' : 'CLOSED'}</span></span>
            <span className="k">Command</span><span className="v"><span className={`state ${req.action === 'close' ? 'closed' : 'open'}`}>{lo ? 'OPEN + LOCK OUT' : req.action.toUpperCase()}</span>{lo ? <span className="dim"> · applies OPR-LO do-not-close tag; reclosing and all close commands blocked until removed</span> : order ? <span className="dim"> · {order.id} step {order.cur + 1}{stepLoop ? ' (LOOP)' : ''}</span> : <span className="c-amber"> · direct control (no switching order)</span>}</span>
          </div>
          <div className="sec-t">Predicted result (connectivity model)</div>
          {pv.lose > 0 && <div className="warnbox">{pv.lose.toLocaleString()} {e.live ? 'service point(s) go out of service' : 'customers will lose power'}{pv.critLose ? ` — includes ${pv.critLose} CRITICAL customer(s)` : ''}.</div>}
          {pv.gain > 0 && <div className="okbox">{pv.gain.toLocaleString()} {e.live ? 'service point(s) back in service' : 'customers will be restored'}.</div>}
          {pv.knownFault && <div className="warnbox">Energizes a KNOWN FAULTED section. This is a safety violation.</div>}
          {pv.unknownFault && <div className="warnbox" style={{ borderColor: '#6d5121', background: '#1f180b', color: '#ffd28a' }}>Energizes a section with an un-located fault — expect protection to operate.</div>}
          {pv.loop && <div className="warnbox" style={{ borderColor: '#6d5121', background: '#1f180b', color: '#ffd28a' }}>Creates a loop / parallel between sources.</div>}
          {!pv.lose && !pv.gain && !pv.loop && <div className="dim">{e.live ? 'No service points change state.' : 'No customer impact predicted.'}</div>}
          {blockers.map(b => <div key={b} className="warnbox">BLOCKED: {b}</div>)}
          {armedAt && !blockers.length && <div className="sbo-arm">SELECTED {req.dev} for {req.action.toUpperCase()} — execute within {left}s</div>}
        </div>
        <div className="mf">
          <button className="btn" onClick={onClose}>Cancel</button>
          {!armedAt
            ? <button className="btn warn" disabled={blockers.length > 0} onClick={() => setArmedAt(Date.now())}>SELECT</button>
            : <button className={`btn ${req.action === 'close' ? 'good' : 'danger'}`} onClick={exec}>EXECUTE {lo ? 'LOCKOUT' : req.action.toUpperCase()}</button>}
        </div>
      </div>
    </div>
  );
}

export function ScenarioModal({ current, onStart, onClose, saved, onResume, onLoadManual }: {
  current: string; onStart(id: string, seed: number, emg?: number): void; onClose(): void;
  saved: { autosave?: number; manual?: number }; onResume(): void; onLoadManual(): void;
}) {
  const [sel, setSel] = useState(current);
  const [seed, setSeed] = useState(String(1000 + Math.floor(Math.random() * 9000)));
  const [emgOn, setEmgOn] = useState(false);
  const [emgWhen, setEmgWhen] = useState('900');
  const sc = SCENARIOS[sel];
  const emgDelay = () => (emgWhen === 'rand' ? 300 + Math.floor(Math.random() * 2100) : Number(emgWhen));
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide" onClick={ev => ev.stopPropagation()}>
        <div className="mh"><span className="t">Training scenarios — Sparks Municipal Electric</span><span style={{ flex: 1 }} /><button className="btn sm" onClick={onClose}>✕</button></div>
        <div className="mb">
          <div className="scen-grid">
            {SCENARIO_LIST.map(id => (
              <div key={id} className={`scen-card ${sel === id ? 'on' : ''}`} onClick={() => setSel(id)}>
                <div className="sn"><span className="badge cyan">{id}</span> {SCENARIOS[id].name}</div>
                <div className="sb">{SCENARIOS[id].brief.slice(0, 150)}…</div>
              </div>
            ))}
          </div>
          <div className="sec-t">Briefing — {sc.name}</div>
          <div style={{ fontSize: 12 }}>{sc.brief}</div>
          <div className="sec-t">Add an emergency</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
            <label><input type="checkbox" checked={emgOn} onChange={ev => setEmgOn(ev.target.checked)} /> A crew member gets hurt during this scenario</label>
            {emgOn && <>
              <span className="dim">strikes</span>
              <select value={emgWhen} onChange={ev => setEmgWhen(ev.target.value)}>
                <option value="300">after 5 min</option><option value="900">after 15 min</option><option value="1800">after 30 min</option><option value="rand">at a random time (5–40 min)</option>
              </select>
              <span className="dim">You won't be told when. Emergency traffic, 911 and a second unit are on you.</span>
            </>}
          </div>
          <div className="sec-t">Objectives</div>
          {sc.objectives.map(o => <div key={o.id} className="obj"><span className="dim mono">{o.id}</span>{o.text}</div>)}
        </div>
        <div className="mf" style={{ justifyContent: 'space-between' }}>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            {saved.autosave && <button className="btn" onClick={onResume}>Resume autosave ({new Date(saved.autosave).toLocaleTimeString()})</button>}
            {saved.manual && <button className="btn" onClick={onLoadManual}>Load saved ({new Date(saved.manual).toLocaleTimeString()})</button>}
          </div>
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <span className="dim">Seed</span><input value={seed} onChange={ev => setSeed(ev.target.value.replace(/\D/g, ''))} style={{ width: 80 }} className="mono" />
            <button className="btn pri" onClick={() => onStart(sel, Number(seed) || 1, emgOn ? emgDelay() : undefined)}>Start scenario {sel}{emgOn ? ' + emergency' : ''}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function AarModal({ onClose, onNew }: { onClose(): void; onNew(): void }) {
  const { e } = useCtx();
  const m = e.s.metrics;
  const sc = e.scen;
  const incs = Object.values(e.s.incidents);
  const dts = m.dispatchTimes.filter(x => x > 0);
  const avgDisp = dts.length ? dts.reduce((a, b) => a + b, 0) / dts.length : 0;
  const passed = Object.values(e.s.scen.obj).filter(o => o.status === 'pass').length;
  const exportJson = () => {
    const blob = new Blob([JSON.stringify({ scenario: sc.name, seed: e.s.seed, simTime: e.s.t, objectives: e.s.scen.obj, metrics: m, incidents: incs }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = `gridops-aar-${sc.id}-${e.s.seed}.json`; a.click();
  };
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal wide" onClick={ev => ev.stopPropagation()}>
        <div className="mh"><span className="t">After-action review — Scenario {sc.id}: {sc.name}</span><span className="badge cyan">{passed}/{sc.objectives.length} objectives</span><span style={{ flex: 1 }} /><button className="btn sm" onClick={onClose}>✕</button></div>
        <div className="mb">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6 }}>
            <div className="metric"><div className="k">Exercise time</div><div className="v">{age(e.s.t)}</div></div>
            <div className="metric"><div className="k">Cust. interrupted</div><div className="v">{m.ci.toLocaleString()}</div></div>
            <div className="metric"><div className="k">Cust.-minutes</div><div className="v">{Math.round(m.cmi).toLocaleString()}</div></div>
            <div className="metric"><div className="k">Avg dispatch</div><div className="v">{dts.length ? age(avgDisp) : '—'}</div></div>
            <div className="metric"><div className="k">Momentary cust.</div><div className="v">{m.momentary.toLocaleString()}</div></div>
            <div className="metric"><div className="k">Violations</div><div className="v" style={{ color: m.violations.length ? 'var(--red)' : 'var(--green)' }}>{m.violations.length}</div></div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 6, marginTop: 6 }}>
            {(() => { const r = e.reliability(); const mm = (x: number | null) => (x == null ? '—' : `${(x / 60).toFixed(1)}m`); return ([
              ['SAIDI', `${r.saidi.toFixed(2)}m`], ['SAIFI', r.saifi.toFixed(3)], ['CAIDI', `${r.caidi.toFixed(1)}m`], ['MAIFI', r.maifi.toFixed(3)], ['Avg response', mm(r.avgResp)], ['Avg restore', mm(r.avgRestore)],
            ] as [string, string][]).map(([k, v]) => <div key={k} className="metric"><div className="k">{k}</div><div className="v">{v}</div></div>); })()}
          </div>
          <div className="aar-grid" style={{ marginTop: 10 }}>
            <div>
              <div className="sec-t">Objectives</div>
              {sc.objectives.map(o => { const st = e.s.scen.obj[o.id]; return (
                <div key={o.id} className="obj"><span className={`badge ${st.status === 'pass' ? 'green' : st.status === 'fail' ? 'red' : 'amber'}`}>{st.status.toUpperCase()}</span><span>{o.text}{st.note ? <span className="dim"> — {st.note}</span> : null}{st.t !== undefined ? <span className="dim mono"> @{e.hhmm(st.t)}</span> : null}</span></div>); })}
              <div className="sec-t">Safety</div>
              {m.violations.length ? m.violations.map((v, i) => <div key={i} className="c-red" style={{ fontSize: 11 }}><span className="mono">{e.hhmm(v.t)}</span> {v.text}</div>) : <div className="c-green">No safety violations recorded.</div>}
              <div className="sec-t">Incidents</div>
              <table className="grid"><thead><tr><th>ID</th><th>Device</th><th>Peak</th><th>Dispatch</th><th>Response</th><th>Restored</th><th>Cust-min</th><th>Status</th></tr></thead><tbody>
                {incs.map(i => <tr key={i.id}><td className="mono">{i.id}</td><td className="mono">{i.predDev}</td><td className="num">{i.peak}</td><td className="num">{i.firstDispatchT !== null ? age(i.firstDispatchT - i.t) : '—'}</td><td className="num">{i.onSceneT != null ? age(i.onSceneT - i.t) : '—'}</td><td className="num">{i.restoredT !== null ? age(i.restoredT - i.t) : '—'}</td><td className="num">{Math.round(i.cmi ?? 0).toLocaleString()}</td><td>{i.status}</td></tr>)}
              </tbody></table>
            </div>
            <div>
              <div className="sec-t">Decision log</div>
              <div style={{ maxHeight: 380, overflow: 'auto', fontSize: 11 }}>
                {m.decisions.map((d, i) => <div key={i} style={{ padding: '1px 0', color: d.good === true ? 'var(--green)' : d.good === false ? 'var(--red)' : undefined }}><span className="mono dim">{e.hhmm(d.t)}</span> {d.text}</div>)}
              </div>
            </div>
          </div>
        </div>
        <div className="mf">
          <button className="btn" onClick={exportJson}>Export AAR (JSON)</button>
          <button className="btn" onClick={onClose}>Continue running</button>
          <button className="btn pri" onClick={onNew}>New scenario…</button>
        </div>
      </div>
    </div>
  );
}
