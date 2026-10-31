// MONITOR 2 — Distribution SCADA: substation one-lines + feeder schematics.
// Utility convention: RED = CLOSED, GREEN = OPEN.
import { useState } from 'react';
import { useCtx } from './ctx';
import type { DevEl, SchItem } from '../sim/types';

const X0 = 200, X1 = 1000;

export function ScadaView() {
  const { e, sel, setSel } = useCtx();
  const [sub, setSub] = useState(() => Object.keys(e.T.subs)[0] ?? 'NLC');
  const S = e.T.subs[sub];
  const feeders = S.feeders;
  const H = 120 + feeders.length * 245;
  const mw = (f: string[]) => f.reduce((a, x) => a + e.readings[x].kw, 0) / 1000;
  const subMw = mw(feeders);
  const busKv = 12.47 * (1.021 - 0.012 * subMw / S.mva);
  const pts = feeders.flatMap(f => e.T.feeders[f].sch.filter(i => i.kind === 'dev' || i.kind === 'tie').map(i => i.id)).filter(id => e.live || (e.T.els[id] as DevEl).scada);
  const uniq = [...new Set(pts)];

  return (
    <div className="scada">
      <div className="scada-side">
        {Object.values(e.T.subs).map(s => {
          const m = mw(s.feeders);
          const alarms = e.s.alarms.filter(a => a.active && a.dev && s.feeders.includes((e.T.els[a.dev] as DevEl)?.feeder)).length;
          return (
            <button key={s.id} className={`subbtn ${s.id === sub ? 'on' : ''}`} onClick={() => setSub(s.id)}>
              <div className="n">{s.name} {alarms ? <span className="badge red">{alarms}</span> : null}</div>
              <div className="m">{m.toFixed(2)} MW · {Math.round(m / 0.95 / s.mva * 100)}% T1</div>
              {s.feeders.map(f => <div key={f} className="m" style={{ color: e.s.dev[e.T.feeders[f].breaker].open ? 'var(--red)' : undefined }}>{f} {e.readings[f].amps.toFixed(0)}A {e.s.dev[e.T.feeders[f].breaker].lockout ? 'LOCKOUT' : ''}</div>)}
            </button>
          );
        })}
        <div className="sec-t">Legend</div>
        <div style={{ fontSize: 10, color: 'var(--text2)', lineHeight: 1.6 }}>
          <div><span className="state closed">■</span> Closed (red)</div>
          <div><span className="state open">□</span> Open (green)</div>
          <div><span className="state lockout">LO</span> Lockout</div>
          <div><span className="badge amber">HOLD</span> Clearance tag</div>
          <div><span className="c-amber">?</span> RTU comm fail (stale)</div>
          <div className="dim" style={{ marginTop: 4 }}>Amps, MW and end-of-line voltage are simplified training estimates, not a validated power flow.</div>
        </div>
      </div>

      <div className="scada-main">
      <div className="scada-svg">
        <svg width="100%" height={H} viewBox={`0 0 ${X1 + 40} ${H}`} preserveAspectRatio="xMinYMin meet" style={{ minWidth: 820 }}>
          {/* Source & transformer */}
          <text x={22} y={18} fill="#7d93b0" fontSize={10}>{e.live ? 'YARD SOURCE — TRAINING, NOT ENERGIZED' : '138 kV TRANSMISSION'}</text>
          <line x1={70} y1={24} x2={70} y2={46} stroke="#c8d3df" strokeWidth={2} />
          <circle cx={70} cy={58} r={13} fill="none" stroke="#c8d3df" strokeWidth={2} />
          <circle cx={70} cy={76} r={13} fill="none" stroke="#c8d3df" strokeWidth={2} />
          <text x={92} y={60} fill="#c8d3df" fontSize={11}>T1 138/12.47 kV {S.mva} MVA</text>
          <text x={92} y={75} fill="#3fb6d3" fontSize={11}>{subMw.toFixed(2)} MW · {(subMw / 0.95).toFixed(2)} MVA · {Math.round(subMw / 0.95 / S.mva * 100)}%</text>
          <line x1={70} y1={89} x2={70} y2={110} stroke="#c8d3df" strokeWidth={2} />
          <line x1={70} y1={110} x2={70} y2={H - 30} stroke="#e6edf4" strokeWidth={5} />
          <text x={22} y={128} fill="#c8d3df" fontSize={10}>12.47 kV</text>
          <text x={22} y={141} fill="#3ec27f" fontSize={10}>{busKv.toFixed(2)} kV</text>
          {feeders.map((f, i) => <FeederStrip key={f} fid={f} y={205 + i * 245} sel={sel?.kind === 'dev' ? sel.id : ''} onSel={id => setSel({ kind: 'dev', id })} />)}
        </svg>
      </div>

      <div className="scada-bottom">
        <div className="scroll">
        <div className="ph"><span className="ttl">{e.live ? 'Device points' : 'SCADA points'} — {S.name}</span></div>
        <table className="grid">
          <thead><tr><th>Point</th><th>State</th><th>Amps</th><th>Comm</th><th>Tags</th></tr></thead>
          <tbody>
            {uniq.map(id => {
              const st = e.s.dev[id], d = e.T.els[id] as DevEl;
              const en = e.nodeEn(d.from) || e.nodeEn(d.to);
              return (
                <tr key={id} className={`row ${sel?.kind === 'dev' && sel.id === id ? 'sel' : ''}`} onClick={() => setSel({ kind: 'dev', id })}>
                  <td className="mono">{id}</td>
                  <td><span className={`state ${st.lockout ? 'lockout' : st.open ? 'open' : 'closed'}`}>{st.lockout ? 'LO' : st.open ? 'OPEN' : 'CLSD'}</span></td>
                  <td className="num">{st.comm ? (en && !st.open ? e.devAmps(id).toFixed(0) : '0') : '???'}</td>
                  <td>{st.comm ? <span className="c-green">OK</span> : <span className="c-amber">FAIL</span>}</td>
                  <td>{st.tags.join(',')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        </div>
        <div className="scroll">
        <div className="ph"><span className="ttl">{e.live ? 'Circuits' : 'Feeder metering (est.)'}</span></div>
        <table className="grid">
          <thead><tr><th>Feeder</th><th>A</th><th>MW</th><th>%</th><th>V end</th><th>Out</th></tr></thead>
          <tbody>{e.T.feederIds.map(f => { const r = e.readings[f]; return (
            <tr key={f}><td className="mono">{f}</td><td className="num">{r.amps.toFixed(0)}</td><td className="num">{(r.kw / 1000).toFixed(2)}</td>
              <td className={`num ${r.pct > 1 ? 'c-red' : r.pct > 0.9 ? 'c-amber' : ''}`}>{Math.round(r.pct * 100)}</td>
              <td className={`num ${r.vEnd && r.vEnd < 0.95 ? 'c-red' : ''}`}>{r.vEnd ? r.vEnd.toFixed(3) : '—'}</td>
              <td className={`num ${r.custOut ? 'c-red' : ''}`}>{r.custOut}</td></tr>); })}</tbody>
        </table>
        </div>
      </div>
      </div>
    </div>
  );
}

function FeederStrip({ fid, y, sel, onSel }: { fid: string; y: number; sel: string; onSel(id: string): void }) {
  const { e } = useCtx();
  const F = e.T.feeders[fid];
  const r = e.readings[fid];
  const items = F.sch;
  const xOf = (it: SchItem) => X0 + 30 + it.f * (X1 - X0 - 60);
  const segColor = (node: string) => {
    if (!e.nodeEn(node)) return '#6a2a2a';
    const src = e.net.src.get(node);
    return e.T.feeders[src ?? '']?.color ?? '#9aa';
  };
  const bkr = F.breaker;
  const segs: JSX.Element[] = [];
  let prevX = X0 + 22, prevNode = items[0].node;
  for (let i = 1; i < items.length; i++) {
    const it = items[i];
    const x = xOf(it);
    const c = segColor(prevNode);
    segs.push(<line key={'s' + i} x1={prevX} y1={y} x2={x} y2={y} stroke={c} strokeWidth={3} strokeDasharray={e.nodeEn(prevNode) ? undefined : '5 4'} />);
    prevX = x;
    if (it.kind === 'dev') prevNode = it.node;
    else if (it.kind === 'tie' && it.f >= 0.999) prevNode = it.node;
  }
  return (
    <g>
      {/* bus tap + breaker */}
      <line x1={70} y1={y} x2={X0 - 12} y2={y} stroke="#e6edf4" strokeWidth={2} />
      <DevSym id={bkr} x={X0} y={y} sel={sel === bkr} onSel={onSel} big />
      <text x={X0 - 110} y={y - 84} fill="#e6edf4" fontSize={13} fontWeight={700}>{fid}</text>
      <text x={X0 - 110} y={y - 70} fill="#9fb0c2" fontSize={10}>Ia {r.ia.toFixed(0)}  Ib {r.ib.toFixed(0)}  Ic {r.ic.toFixed(0)} A</text>
      <text x={X0 + 120} y={y - 84} fill={r.pct > 1 ? '#e25555' : r.pct > 0.9 ? '#e3a53c' : '#3fb6d3'} fontSize={11}>{(r.kw / 1000).toFixed(2)} MW · {Math.round(r.pct * 100)}% of {F.ratingA} A</text>
      <text x={X0 + 120} y={y - 70} fill="#9fb0c2" fontSize={10}>V end (est) {r.vEnd ? r.vEnd.toFixed(3) + ' pu' : '—'} · {r.cust.toLocaleString()} cust served · {r.custOut} out</text>
      {segs}
      {items.slice(1).map((it, i) => {
        const x = xOf(it);
        if (it.kind === 'dev') return <DevSym key={it.id} id={it.id} x={x} y={y} sel={sel === it.id} onSel={onSel} />;
        if (it.kind === 'tie') {
          const d = e.T.els[it.id] as DevEl;
          const other = d.feeder === fid ? Object.values(e.T.feeders).find(f => f.id !== fid && f.ties.includes(it.id))?.id : d.feeder;
          const end = it.f >= 0.999;
          return (
            <g key={it.id + i}>
              {!end && <line x1={x} y1={y} x2={x} y2={y + 66} stroke="#7d93b0" strokeWidth={1.5} strokeDasharray="3 3" />}
              <DevSym id={it.id} x={x} y={end ? y : y + 75} sel={sel === it.id} onSel={onSel} />
              <text x={x + 12} y={end ? y - 10 : y + 74} fill="#9fb0c2" fontSize={10}>{end ? '→ ' : '← '}{other}</text>
            </g>
          );
        }
        if (it.kind === 'lat') {
          const st = e.s.dev[it.id];
          const lat = e.T.laterals[it.id];
          const cust = lat.loads.reduce((a, l) => a + e.T.loads[l].customers, 0);
          const out = lat.loads.filter(l => !e.loadEn(l)).reduce((a, l) => a + e.T.loads[l].customers, 0);
          const down = (i % 2 === 0);
          const dy = down ? 1 : -1;
          return (
            <g key={it.id} className="clk" onClick={() => onSel(it.id)}>
              <line x1={x} y1={y} x2={x} y2={y + dy * 34} stroke={out ? '#a33' : '#66788c'} strokeWidth={1.2} />
              <rect x={x - 3} y={y + dy * 12 - (down ? 0 : 10)} width={6} height={10} fill={st.open ? '#0a1018' : '#d64545'} stroke={st.open ? '#34b36e' : '#d64545'} strokeWidth={1.2} />
              <text x={x} y={y + dy * 46 + (down ? 0 : 6)} textAnchor="middle" fill={out ? '#ff8080' : '#7d8b9b'} fontSize={8.5}>{it.id.slice(2)}</text>
              <text x={x} y={y + dy * 57 + (down ? 0 : 6)} textAnchor="middle" fill={out ? '#ff8080' : '#5d6e80'} fontSize={8.5}>{out ? `${out}/${cust}` : cust}c</text>
            </g>
          );
        }
        if (it.kind === 'load') {
          const L = e.T.loads[it.id];
          const en = e.loadEn(it.id);
          return (
            <g key={it.id}>
              <line x1={x} y1={y} x2={x} y2={y + 40} stroke="#9fb0c2" strokeWidth={1.2} />
              <rect x={x - 34} y={y + 40} width={68} height={16} fill={en ? '#1a2a3a' : '#5a1414'} stroke={en ? '#7d93b0' : '#ff6b6b'} />
              <text x={x} y={y + 52} textAnchor="middle" fill="#fff" fontSize={9} fontWeight={700}>{(L.name ?? '').split(' ').slice(1, 3).join(' ').slice(0, 12)}</text>
            </g>
          );
        }
        return null;
      })}
    </g>
  );
}

function DevSym({ id, x, y, sel, onSel, big }: { id: string; x: number; y: number; sel: boolean; onSel(id: string): void; big?: boolean }) {
  const { e } = useCtx();
  const d = e.T.els[id] as DevEl, st = e.s.dev[id];
  const fill = st.open ? '#081008' : '#d64545';
  const stroke = !st.comm ? '#e3a53c' : st.open ? '#34b36e' : '#ff9e9e';
  const s = big ? 22 : d.type === 'recloser' || d.type === 'tie' ? 18 : 14;
  const amps = d.scada && st.comm && !st.open && (e.nodeEn(d.to) || e.nodeEn(d.from)) ? `${e.devAmps(id).toFixed(0)}A` : '';
  return (
    <g className="clk" onClick={() => onSel(id)}>
      {sel && <rect x={x - s / 2 - 5} y={y - s / 2 - 5} width={s + 10} height={s + 10} fill="none" stroke="#3fb6d3" strokeDasharray="3 2" />}
      {d.type === 'switch'
        ? <circle cx={x} cy={y} r={s / 2} fill={fill} stroke={stroke} strokeWidth={2} />
        : <rect x={x - s / 2} y={y - s / 2} width={s} height={s} fill={st.lockout ? '#5a0f0f' : fill} stroke={st.lockout ? '#ff5050' : stroke} strokeWidth={2} />}
      {(d.type === 'recloser' || d.type === 'breaker') && <text x={x} y={y + 4} textAnchor="middle" fill="#fff" fontSize={big ? 10 : 9} fontWeight={700}>{d.type === 'recloser' ? 'R' : 'CB'}</text>}
      {d.type === 'tie' && <text x={x} y={y + 3} textAnchor="middle" fill="#fff" fontSize={7} fontWeight={700}>NO</text>}
      <text x={x + s / 2 + 3} y={y + s / 2 + 11} fill={st.tags.length ? '#ffb347' : '#e6edf4'} fontSize={10} fontWeight={600}>{id}{!st.comm ? ' ?' : ''}</text>
      {d.scada && <text x={x + s / 2 + 3} y={y + s / 2 + 22} fill="#3fb6d3" fontSize={9}>{amps || 'SCADA'}</text>}
      {st.lockout && <text x={x} y={y - s / 2 - 6} textAnchor="middle" fill="#ff6b6b" fontSize={10} fontWeight={700}>LOCKOUT</text>}
      {st.tags.length > 0 && <g><rect x={x + s / 2 + 2} y={y - 7} width={30} height={12} fill="#ffb347" /><text x={x + s / 2 + 17} y={y + 2} textAnchor="middle" fill="#241400" fontSize={8} fontWeight={700}>HOLD</text></g>}
    </g>
  );
}
