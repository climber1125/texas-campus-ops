// MONITOR 4 — Radio log. The real radios are on the operator's desk;
// this panel is where the operator logs what was heard / said. Push-to-talk
// (Space or HOLD TO TALK) transcribes the operator repeating the call into
// the capture box, then: Log it, or turn it into a work order.
import { useEffect, useRef, useState } from 'react';
import { useCtx } from './ctx';
import { PttBar } from './VoiceUi';
import { ACCESS } from '../live/access';

export function RadioPanel({ keyed: _k, voiceOn: _v, setVoiceOn: _sv, audioOn: _a, talkBack, setTalkBack, aiAvail: _ai, aiOn: _ao, setAiOn: _sa }: {
  keyed: string | null; voiceOn: boolean; setVoiceOn(v: boolean): void; audioOn: boolean; talkBack: boolean; setTalkBack(v: boolean): void; aiAvail: boolean; aiOn: boolean; setAiOn(v: boolean): void;
}) {
  const { e, flash, ptt, readOnly, radioDraft, newWo } = useCtx();
  const [unit, setUnit] = useState('');
  const [dir, setDir] = useState<'from' | 'to'>('from');
  const [text, setText] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const msgs = e.s.radio.slice(-200);
  const lastId = msgs.at(-1)?.id ?? 0;
  useEffect(() => { const b = box.current; if (b && stick.current) b.scrollTop = b.scrollHeight; }, [lastId]);
  useEffect(() => { if (radioDraft.n) setText(t => (t ? t + ' ' : '') + radioDraft.text); }, [radioDraft.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const trucks = Object.values(e.s.trucks).sort((a, b) => a.crew.localeCompare(b.crew));
  const F = e.s.scen.flags;
  const run = (err: string | null | undefined) => { if (err) flash(err, 'warn'); };
  const log = () => {
    if (!text.trim()) return;
    run(e.liveRadio(unit, text, dir === 'to'));
    setText('');
  };
  const toWo = () => {
    const t = text.trim();
    if (!t) return;
    if (dir === 'from') e.liveRadio(unit, t, false);
    newWo({ text: t, caller: unit ? (e.s.trucks[unit]?.crew ?? '') : '', source: 'radio' });
    setText('');
  };

  return (
    <div className="panel" style={{ flex: 1 }}>
      <div className="ph">
        <span className="mon">M4</span><span className="ttl">Radio</span>
        <span className="sp" />
        {!readOnly && <label className="aa" title="Push-to-talk speech-to-text: repeat the call and it is typed for you">
          <input type="checkbox" checked={talkBack} onChange={ev => setTalkBack(ev.target.checked)} /> Voice capture
        </label>}
      </div>
      <div className="radio-head">
        <span className={`lamp ${ptt.active ? 'tx' : ''}`} title="Capturing" /><span className="dim" style={{ fontSize: 10 }}>MIC</span>
        <span className="chan">OPS-1 · CAMPUS{F.emergencyTraffic ? <span className="badge red" style={{ marginLeft: 6 }}>EMERGENCY TRAFFIC</span> : ''}</span>
        <span style={{ flex: 1 }} />
        {!readOnly && <button className={`btn danger sm ${F.emergencyTraffic ? 'on' : ''}`} onClick={() => run(F.emergencyTraffic ? e.liveClearEmergency() : e.declareEmergency())}>{F.emergencyTraffic ? 'Clear emergency traffic' : 'Emergency traffic'}</button>}
        {!readOnly && <button className="btn danger sm" title="Log that 911 / EMS was called (call them on a real phone)" onClick={() => { run(e.notify911()); flash('Logged: 911 called — make the call on your phone', 'alarm'); }}>☎ 911</button>}
      </div>
      <div className="transcript" ref={box} onScroll={ev => { const b = ev.currentTarget; stick.current = b.scrollHeight - b.scrollTop - b.clientHeight < 30; }}>
        {msgs.length === 0 && <div className="empty">No traffic logged yet.</div>}
        {msgs.map(m => (
          <div key={m.id} className={`tx-line ${m.kind === 'operator' ? 'ctl' : ''} ${m.kind}`}>
            <span className="tt">{e.hhmmss(m.t).slice(0, 8)}</span>
            <span className="who">{m.kind === 'operator' ? `CONTROL → ${m.to || 'ALL'}` : m.from}</span>
            <span className="msg">{m.text}</span>
          </div>
        ))}
      </div>
      {!readOnly && <>
        {talkBack && <PttBar />}
        <div className="typetx" style={{ flexWrap: 'wrap', gap: 4 }}>
          <textarea value={text} onChange={ev => setText(ev.target.value)} rows={2} placeholder={ptt.supported ? 'Hold Space and repeat the call, or type it here' : 'Type what was said'} style={{ flex: 1, minWidth: 180, font: 'inherit', resize: 'vertical' }}
            onKeyDown={ev => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); log(); } }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <button className="btn sm" disabled={!text.trim()} onClick={log}>Log</button>
            <button className="btn pri sm" disabled={!text.trim()} onClick={toWo}>→ Work order</button>
          </div>
        </div>
      </>}
      <div className="unitbar">
        {!readOnly && <>
          <button className={`btn sm ${dir === 'from' ? 'on' : ''}`} onClick={() => setDir('from')}>Heard from</button>
          <button className={`btn sm ${dir === 'to' ? 'on' : ''}`} onClick={() => setDir('to')}>Said to</button>
          <span style={{ width: 4 }} />
        </>}
        {trucks.map(t => <button key={t.id} className={`btn sm ${unit === t.id ? 'on' : ''}`} onClick={() => setUnit(unit === t.id ? '' : t.id)}>{t.crew.split(' ')[0]}</button>)}
        {!trucks.length && <span className="dim" style={{ fontSize: 10 }}>Add instructors on the M5 Roster tab.</span>}
        <span style={{ flex: 1 }} />
        <span className="dim" style={{ fontSize: 10 }}>{ACCESS.role === 'staff' ? 'view only' : unit ? (dir === 'from' ? `from ${e.s.trucks[unit]?.crew}` : `to ${e.s.trucks[unit]?.crew}`) : 'pick who'}</span>
      </div>
    </div>
  );
}
