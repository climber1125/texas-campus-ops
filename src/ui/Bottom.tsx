// MONITOR 5 — Dispatch / Crew board, and SCADA alarm summary + event logs
import { useState } from 'react';
import { useCtx, age } from './ctx';
import { RosterPanel, ReliabilityPanel } from './Fleet';

export function CrewBoard({ initial = 'units' }: { initial?: 'units' | 'wo' | 'roster' | 'rel' }) {
  const { e, sel, setSel, flyTo } = useCtx();
  const [tab, setTab] = useState<'units' | 'wo' | 'roster' | 'rel'>(initial);
  const trucks = Object.values(e.s.trucks).sort((a, b) => a.id.localeCompare(b.id));
  const wos = Object.values(e.s.workorders).filter(w => !['Done', 'Canceled'].includes(w.status));
  return (
    <div className="panel">
      <div className="ph">
        <span className="mon">M5</span><span className="ttl">{e.live ? 'Instructors' : 'Field Units'}</span>
        <div className="tabs" style={{ marginLeft: 6 }}>
          <button className={`tab ${tab === 'units' ? 'on' : ''}`} onClick={() => setTab('units')}>Units<span className="badge">{trucks.length}</span></button>
          <button className={`tab ${tab === 'wo' ? 'on' : ''}`} onClick={() => setTab('wo')}>Work orders<span className="badge">{wos.length}</span></button>
          <button className={`tab ${tab === 'roster' ? 'on' : ''}`} onClick={() => setTab('roster')}>Roster</button>
          {!e.live && <button className={`tab ${tab === 'rel' ? 'on' : ''}`} onClick={() => setTab('rel')}>Reliability</button>}
        </div>
        <span className="sp" />
        <span className="dim avail" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>Avail {trucks.filter(t => t.status === 'Available').length}/{trucks.length}</span>
      </div>
      <div className="pb">
        {tab === 'units' ? (
          <table className="grid">
            <thead><tr><th>Call</th><th>{e.live ? 'Name' : 'Crew'}</th><th>Status</th><th>Assignment</th><th>Location</th>{!e.live && <><th>ETA</th><th>GPS</th><th>Radio</th></>}</tr></thead>
            <tbody>
              {trucks.map(t => {
                const eta = e.eta(t);
                const asg = t.sw ? `${t.sw.order} step ${t.sw.idx + 1}` : t.task?.kind === 'incident' ? `${t.task.id} · ${t.task.stage}` : t.task?.kind === 'workorder' ? `${t.task.id} ${e.live ? (e.s.workorders[t.task.id]?.loc ?? '') + ' — ' + (e.s.workorders[t.task.id]?.issue ?? '') : e.s.workorders[t.task.id]?.type ?? ''}` : t.task?.kind === 'planned' ? `Planned ${t.task.id}` : t.task?.kind === 'welfare' ? `Welfare → ${t.task.target}` : t.task?.kind === 'home' ? 'To service center' : '—';
                return (
                  <tr key={t.id} className={`row ${sel?.kind === 'truck' && sel.id === t.id ? 'sel' : ''}`} onClick={() => { setSel({ kind: 'truck', id: t.id }); flyTo(t.pos); }}>
                    <td className="mono"><b>{t.id}</b></td>
                    <td className="dim">{t.crew}</td>
                    <td><span className={`chip ${t.status.replace(/\s+/g, '')}`}>{t.status}</span>{t.clearance ? <span className="badge amber" style={{ marginLeft: 3 }}>{t.clearance}</span> : null}</td>
                    <td className="mono" style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{asg}</td>
                    <td>{e.locOf(t.pos)}</td>
                    {!e.live && <><td className="mono">{eta ? `${e.hhmm(eta)} (${age(eta - e.s.t)})` : '—'}</td>
                    <td className="mono dim">{t.pos[0].toFixed(4)},{t.pos[1].toFixed(4)}</td>
                    <td>{t.comm ? <span className="c-green">●</span> : <span className="c-red">NO CONTACT</span>}</td></>}
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : tab === 'roster' ? <RosterPanel /> : tab === 'rel' ? <ReliabilityPanel /> : (
          <table className="grid">
            <thead><tr><th>WO</th><th>{e.live ? 'Pri' : 'Type'}</th><th>Location</th><th>{e.live ? 'Issue' : 'Est.'}</th><th>Status</th><th>{e.live ? 'Assigned' : 'Unit'}</th></tr></thead>
            <tbody>{wos.map(w => <tr key={w.id} className="row" onClick={() => { if (e.live) setSel({ kind: 'wo', id: w.id }); flyTo(w.pos, e.live ? 19 : 16); }}><td className="mono">{w.id}</td><td className={e.live ? `pri-${w.priority}` : ''}>{e.live ? w.priority : w.type}</td><td>{w.loc}</td><td className={e.live ? '' : 'num'} style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{e.live ? w.issue : `${Math.round(w.dur / 60)}m`}</td><td>{w.status}</td><td className="mono">{w.truck ? (e.live ? e.s.trucks[w.truck]?.crew ?? w.truck : w.truck) : '—'}</td></tr>)}
              {!wos.length && <tr><td colSpan={6} className="empty">No open work orders.</td></tr>}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}

export function AlarmPanel({ silenced, setSilenced }: { silenced: boolean; setSilenced(v: boolean): void }) {
  const { e, setSel, flyTo } = useCtx();
  const [tab, setTab] = useState<'alarms' | 'soe' | 'log'>('alarms');
  const alarms = e.s.alarms.slice().reverse().slice(0, 120);
  const unack = e.s.alarms.filter(a => !a.acked).length;
  return (
    <div className="panel">
      <div className="ph">
        <span className="mon">M2</span><span className="ttl">SCADA Alarms</span>
        <div className="tabs" style={{ marginLeft: 6 }}>
          <button className={`tab ${tab === 'alarms' ? 'on' : ''}`} onClick={() => setTab('alarms')}>Alarms{unack ? <span className="badge red">{unack}</span> : null}</button>
          <button className={`tab ${tab === 'soe' ? 'on' : ''}`} onClick={() => setTab('soe')}>SOE</button>
          <button className={`tab ${tab === 'log' ? 'on' : ''}`} onClick={() => setTab('log')}>Ops log</button>
        </div>
        <span className="sp" />
        <button className={`btn sm ${silenced ? 'on' : ''}`} onClick={() => setSilenced(!silenced)}>{silenced ? 'Silenced' : 'Silence'}</button>
        <button className="btn sm" disabled={!unack} onClick={() => e.ackAll()}>Ack all</button>
      </div>
      <div className="pb">
        {tab === 'alarms' && (alarms.length ? <table className="grid"><thead><tr><th>Time</th><th>P</th><th>Alarm</th><th></th></tr></thead><tbody>
          {alarms.map(a => (
            <tr key={a.id} className={`row alarm-row ${!a.acked ? 'unack' : ''} p${a.pri} ${!a.active ? 'rtn' : ''}`} onClick={() => { if (a.dev) { setSel({ kind: 'dev', id: a.dev }); const d: any = e.T.els[a.dev]; if (d?.pos) flyTo(d.pos); } }}>
              <td className="mono">{e.hhmmss(a.t)}</td>
              <td><span className={`badge ${a.pri === 1 ? 'p1' : a.pri === 2 ? 'p2' : 'p3'}`}>{a.pri}</span></td>
              <td style={{ whiteSpace: 'normal' }}>{a.text}{!a.active ? <span className="dim"> (RTN)</span> : null}</td>
              <td>{!a.acked && <button className="btn sm" onClick={ev => { ev.stopPropagation(); e.ackAlarm(a.id); }}>Ack</button>}</td>
            </tr>
          ))}</tbody></table> : <div className="empty">No alarms.</div>)}
        {tab === 'soe' && <table className="grid"><thead><tr><th>Time</th><th>Sequence of events</th></tr></thead><tbody>
          {e.s.soe.slice(-200).reverse().map((x, i) => <tr key={i} className={x.dev ? 'row' : ''} onClick={() => x.dev && setSel({ kind: 'dev', id: x.dev })}><td className="mono">{e.hhmmss(x.t)}</td><td className={`mono ${x.kind === 'trip' ? 'c-red' : x.kind === 'close' ? 'c-green' : x.kind === 'alarm' ? 'c-amber' : ''}`}>{x.text}</td></tr>)}
        </tbody></table>}
        {tab === 'log' && <table className="grid"><thead><tr><th>Time</th><th>Cat</th><th>Entry</th></tr></thead><tbody>
          {e.s.log.slice(-250).reverse().map(x => <tr key={x.id}><td className="mono">{e.hhmmss(x.t)}</td><td className="mono dim">{x.cat}</td><td className={x.level === 'alarm' ? 'c-red' : x.level === 'warn' ? 'c-amber' : x.level === 'good' ? 'c-green' : ''} style={{ whiteSpace: 'normal' }}>{x.text}</td></tr>)}
        </tbody></table>}
      </div>
    </div>
  );
}
