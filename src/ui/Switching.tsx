// Switching orders & clearances — written, approved, issued step-by-step
// with three-part communication (issue → repeat-back → confirm).
import { useEffect, useState, Fragment } from 'react';
import { useCtx } from './ctx';
import type { DevEl } from '../sim/types';
import { devWord } from '../sim/radio';
import { SayOr } from './VoiceUi';

export function SwitchingView() {
  const { e, swPrefill, setSwPrefill, openSbo, flash, setSel, readOnly } = useCtx();
  const who = (x: string) => (x === 'SCADA' ? 'SCADA' : e.live ? (e.s.trucks[x]?.crew ?? x) : `Truck ${x}`);
  const orders = Object.values(e.s.orders).sort((a, b) => b.created - a.created);
  const [cur, setCur] = useState<string>(orders.find(o => o.status === 'Active' || o.status === 'Draft')?.id ?? orders[0]?.id ?? '');
  const [title, setTitle] = useState('');
  const [dev, setDev] = useState('');
  const [action, setAction] = useState<'open' | 'close'>('open');
  const [exec, setExec] = useState(e.live ? '' : 'SCADA');
  const [loop, setLoop] = useState(false);
  const o = e.s.orders[cur];
  const devList = e.T.switchable.filter(id => (e.T.els[id] as DevEl).type !== 'fuse');

  useEffect(() => {
    if (!swPrefill) return;
    setDev(swPrefill.dev); setAction(swPrefill.action);
    setExec((e.T.els[swPrefill.dev] as DevEl).scada ? 'SCADA' : Object.keys(e.s.trucks)[0] ?? (e.live ? '' : 'SCADA'));
    if (!o || o.status === 'Complete' || o.status === 'Cancelled') { const n = e.newOrder(`Switching — ${swPrefill.dev}`); setCur(n.id); }
    setSwPrefill(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swPrefill]);

  const [err, setErr] = useState('');
  useEffect(() => setErr(''), [cur, o?.cur]);
  const run = (er: string | null | undefined) => { if (er) { flash(er, 'warn'); setErr(er); } else setErr(''); };
  const step = o?.steps[o.cur];
  const clrs = Object.values(e.s.clearances).filter(c => c.status === 'Active');

  return (
    <div className="sw">
      <div className="sw-list">
        <div className="ph"><span className="ttl">Switching orders</span></div>
        <div className="form-row" style={{ padding: '0 8px' }}>
          <input placeholder="New order title" value={title} onChange={ev => setTitle(ev.target.value)} style={{ flex: 1 }} />
          <button className="btn pri" onClick={() => { const n = e.newOrder(title || 'Switching order'); setCur(n.id); setTitle(''); }}>New</button>
        </div>
        {orders.map(x => (
          <div key={x.id} className={`sw-item ${x.id === cur ? 'on' : ''}`} onClick={() => setCur(x.id)}>
            <div className="mono"><b>{x.id}</b> <span className={`badge ${x.status === 'Active' ? 'cyan' : x.status === 'Complete' ? 'green' : x.status === 'Cancelled' ? '' : 'amber'}`}>{x.status}</span></div>
            <div style={{ fontSize: 11, color: 'var(--text2)' }}>{x.title}</div>
            <div className="dim" style={{ fontSize: 10 }}>{x.steps.length} steps · {x.steps.filter(s => s.status === 'Done').length} done</div>
          </div>
        ))}
        <div className="ph" style={{ marginTop: 8 }}><span className="ttl">Active clearances</span></div>
        {clrs.length === 0 && <div className="empty">None</div>}
        {clrs.map(c => (
          <div key={c.id} className="sw-item">
            <div className="mono"><b className="c-amber">{c.id}</b> → {who(c.truck)}</div>
            <div style={{ fontSize: 10.5 }}>HOLD: {c.devs.join(', ')}</div>
            <div className="dim" style={{ fontSize: 10 }}>Issued {e.hhmm(c.issued)} · {c.purpose}</div>
            {e.live ? (!readOnly && <button className="btn good sm" style={{ marginTop: 3 }} onClick={() => { if (confirm(`${who(c.truck)} released ${c.id} on the radio — grounds off, crew clear? Remove the HOLD tags.`)) run(e.liveRelease(c.id)); }}>Released by holder</button>)
              : <button className="btn danger sm" style={{ marginTop: 3 }} onClick={() => { if (confirm(`Force-release ${c.id} without a release from Truck ${c.truck}? This is a serious safety violation and will be recorded.`)) run(e.releaseClearance(c.id, true)); }}>Force release…</button>}
          </div>
        ))}
      </div>

      <div className="sw-main">
        {!o ? <div className="empty">Create a switching order, or use “Add to switching order” from any device.</div> : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <b className="mono" style={{ fontSize: 14 }}>{o.id}</b>
              <span>{o.title}</span>
              <span className={`badge ${o.status === 'Active' ? 'cyan' : o.status === 'Complete' ? 'green' : 'amber'}`}>{o.status}</span>
              <span style={{ flex: 1 }} />
              {o.status === 'Draft' && <button className="btn pri" onClick={() => run(e.activateOrder(o.id))}>Approve &amp; activate</button>}
              {(o.status === 'Draft' || o.status === 'Active') && <button className="btn" onClick={() => e.cancelOrder(o.id)}>Cancel order</button>}
            </div>
            <table className="grid" style={{ marginTop: 8 }}>
              <thead><tr><th>#</th><th>Action</th><th>Device</th><th>Location</th><th>By</th><th>Loop</th><th>Status</th><th>Time</th><th></th></tr></thead>
              <tbody>
                {o.steps.map((s, i) => {
                  const d = e.T.els[s.dev] as DevEl;
                  return (
                    <Fragment key={i}>
                      <tr className={`steprow ${i === o.cur && o.status === 'Active' ? 'cur' : ''} ${s.status === 'Done' ? 'done' : ''}`}>
                        <td className="mono">{i + 1}</td>
                        <td><span className={`state ${s.action === 'open' ? 'open' : 'closed'}`}>{s.action.toUpperCase()}</span></td>
                        <td className="mono"><a style={{ cursor: 'pointer', color: 'var(--cyan)' }} onClick={() => setSel({ kind: 'dev', id: s.dev })}>{s.dev}</a> <span className="dim">{devWord(d)}</span></td>
                        <td>{d.loc}</td>
                        <td className="mono">{who(s.exec)}</td>
                        <td>{s.loop ? <span className="badge amber">LOOP</span> : ''}</td>
                        <td>{s.status}{s.note ? <div className="c-red" style={{ fontSize: 10, whiteSpace: 'normal', maxWidth: 260 }}>{s.note}</div> : null}</td>
                        <td className="mono dim">{s.doneT ? e.hhmm(s.doneT) : ''}</td>
                        <td>{o.status !== 'Complete' && s.status === 'Pending' && i >= o.cur && <button className="btn sm" onClick={() => e.removeStep(o.id, i)}>✕</button>}</td>
                      </tr>
                      {o.holdAfter === i && <tr className="hold"><td colSpan={9}>HOLD POINT — work under clearance. Continue only after the crew releases the clearance.</td></tr>}
                    </Fragment>
                  );
                })}
                {o.steps.length === 0 && <tr><td colSpan={9} className="empty">No steps yet.</td></tr>}
              </tbody>
            </table>

            {o.status === 'Active' && step && (
              <div className="rbbox">
                {step.status === 'RepeatBack' ? (
                  <>
                    <div className="dim">{e.live ? `Listen for ${who(step.exec)}'s repeat-back of step ${o.cur + 1}. It must match:` : `Truck ${step.exec} repeat-back for step ${o.cur + 1}:`}</div>
                    <div className="q">{step.rbAction?.toUpperCase()} {step.rbDev} — {devWord(e.T.els[step.rbDev!] as DevEl)} at {(e.T.els[step.rbDev!] as DevEl).loc}</div>
                    <div className="dim" style={{ marginBottom: 6 }}>Order says: <b className="mono">{step.action.toUpperCase()} {step.dev}</b>. Compare carefully before confirming.</div>
                    <div className="acts">
                      <SayOr phrase="That's correct, perform"><button className="btn good" onClick={() => run(e.confirmRepeat(o.id, true))}>“That's correct — perform”</button></SayOr>
                      <SayOr phrase={`Negative. Step ${o.cur + 1}: ${step.action} ${step.dev}. Repeat.`}><button className="btn danger" onClick={() => run(e.confirmRepeat(o.id, false))}>“Negative — repeat”</button></SayOr>
                    </div>
                  </>
                ) : step.status === 'Pending' || step.status === 'Failed' ? (
                  <div className="acts" style={{ alignItems: 'center' }}>
                    <span>Next: step {o.cur + 1} — <b className="mono">{step.action.toUpperCase()} {step.dev}</b> by {who(step.exec)}</span>
                    {step.exec === 'SCADA'
                      ? <button className="btn pri" onClick={() => openSbo({ dev: step.dev, action: step.action, order: o.id, viaOrder: true })}>Select / operate…</button>
                      : <SayOr phrase={`Truck ${step.exec}, ${o.id} step ${o.cur + 1}: ${step.action} ${devWord(e.T.els[step.dev] as DevEl)} ${step.dev}${step.loop ? ', loop close' : ''}`}><button className="btn pri" disabled={readOnly} onClick={() => run(e.issueStep(o.id))}>{e.live ? 'Issued on the radio' : 'Issue by radio'}</button></SayOr>}
                    {err && <div className="c-red" style={{ width: '100%', fontSize: 11 }}>{err}</div>}
                  </div>
                ) : e.live && step.status === 'InProgress' ? (
                  <div className="acts" style={{ alignItems: 'center' }}>
                    <span>Step {o.cur + 1}: {who(step.exec)} performing <b className="mono">{step.action.toUpperCase()} {step.dev}</b> — wait for their report.</span>
                    {!readOnly && <button className="btn good" onClick={() => run(e.liveStepDone(o.id))}>Reported complete</button>}
                  </div>
                ) : (
                  <div className="dim">Step {o.cur + 1}: {step.status === 'Issued' ? 'awaiting repeat-back…' : `${who(step.exec)} performing ${step.action} ${step.rbDev} — wait for report.`}</div>
                )}
              </div>
            )}

            {(o.status === 'Draft' || o.status === 'Active') && (
              <>
                <div className="sec-t">Add step</div>
                <div className="form-row">
                  <select value={action} onChange={ev => setAction(ev.target.value as any)}><option value="open">OPEN</option><option value="close">CLOSE</option></select>
                  <input list="devlist" placeholder="Device ID" value={dev} onChange={ev => setDev(ev.target.value.toUpperCase())} style={{ width: 110 }} />
                  <datalist id="devlist">{devList.map(id => <option key={id} value={id}>{(e.T.els[id] as DevEl).loc}</option>)}</datalist>
                  <select value={exec} onChange={ev => setExec(ev.target.value)}>
                    {e.live ? <option value="">— by —</option> : <option value="SCADA">SCADA</option>}
                    {Object.keys(e.s.trucks).map(t => <option key={t} value={t}>{who(t)}</option>)}
                  </select>
                  <label style={{ display: 'flex', gap: 3, alignItems: 'center' }}><input type="checkbox" checked={loop} onChange={ev => setLoop(ev.target.checked)} />Loop close (planned parallel)</label>
                  <button className="btn" onClick={() => { if (e.live && !exec) { run('Pick who performs the step'); return; } run(e.addStep(o.id, dev, action, exec, loop)); setLoop(false); }}>Add</button>
                </div>
                {dev && e.T.els[dev] && <div className="dim" style={{ fontSize: 10.5 }}>{dev}: {devWord(e.T.els[dev] as DevEl)} at {(e.T.els[dev] as DevEl).loc} · currently {e.s.dev[dev].open ? 'OPEN' : 'CLOSED'}{(e.T.els[dev] as DevEl).scada ? ' · SCADA' : ' · field'}{e.s.dev[dev].tags.length ? ` · HOLD ${e.s.dev[dev].tags.join(',')}` : ''}</div>}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
