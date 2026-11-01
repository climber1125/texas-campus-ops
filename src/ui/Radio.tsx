// MONITOR 4 — Radio log. The real radios are on the operator's desk;
// this panel is where the operator logs what was heard / said. Push-to-talk
// (Space or HOLD TO TALK) transcribes the operator repeating the call into
// the capture box, then: Log it, or turn it into a work order.
import { useEffect, useRef, useState } from 'react';
import { useCtx } from './ctx';
import { PttBar } from './VoiceUi';
import { ACCESS } from '../live/access';
import { tellUnit, audioUrl, Recorder, uploadAudio, enablePush, pushState, unlockChime } from '../live/comms';

export function RadioPanel({ keyed: _k, voiceOn: _v, setVoiceOn: _sv, audioOn: _a, talkBack, setTalkBack, aiAvail: _ai, aiOn: _ao, setAiOn: _sa }: {
  keyed: string | null; voiceOn: boolean; setVoiceOn(v: boolean): void; audioOn: boolean; talkBack: boolean; setTalkBack(v: boolean): void; aiAvail: boolean; aiOn: boolean; setAiOn(v: boolean): void;
}) {
  const { e, flash, ptt, readOnly, radioDraft, newWo } = useCtx();
  const [unit, setUnit] = useState('');
  const [dir, setDir] = useState<'from' | 'to'>('from');
  const [text, setText] = useState('');
  const [vrec, setVrec] = useState<'idle' | 'rec' | 'send'>('idle');
  const vref = useRef<Recorder | null>(null);
  const [opAuto, setOpAuto] = useState(() => { try { return localStorage.getItem('campusOpsOpAutoPlay') !== '0'; } catch { return true; } });
  const [alertsOn, setAlertsOn] = useState(true);
  useEffect(() => { pushState().then(st => setAlertsOn(st === 'on' || st === 'unsupported')); }, []);
  const voiceDown = async () => {
    if (vrec !== 'idle' || readOnly) return;
    unlockChime();
    const r = new Recorder(); vref.current = r;
    const err = await r.start();
    if (err) { flash(err, 'warn'); vref.current = null; return; }
    setVrec('rec');
  };
  const voiceUp = async () => {
    const r = vref.current; if (!r || vrec !== 'rec') return;
    vref.current = null; setVrec('send');
    const clip = await r.stop();
    if (!clip) { setVrec('idle'); flash('Too short — hold while you talk', 'warn'); return; }
    const id = await uploadAudio(clip.blob);
    if (!id) { setVrec('idle'); flash('Voice clip did not upload', 'warn'); return; }
    const err = await tellUnit(e, unit, clip.text, { audio: id, dur: Math.round(clip.dur) });
    setVrec('idle');
    if (err) flash(err, 'warn'); else flash(`Voice sent to ${unit ? e.s.trucks[unit]?.crew ?? unit : 'all units'}`, 'good');
  };
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const msgs = e.s.radio.slice(-200);
  const lastId = msgs.at(-1)?.id ?? 0;
  useEffect(() => { const b = box.current; if (b && stick.current) b.scrollTop = b.scrollHeight; }, [lastId]);
  useEffect(() => { if (radioDraft.n) setText(t => (t ? t + ' ' : '') + radioDraft.text); }, [radioDraft.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const trucks = Object.values(e.s.trucks).sort((a, b) => a.crew.localeCompare(b.crew));
  const F = e.s.scen.flags;
  const run = (err: string | null | undefined) => { if (err) flash(err, 'warn'); };
  const log = async () => {
    const t = text.trim();
    if (!t) return;
    setText('');
    if (dir === 'to') {
      const err = await tellUnit(e, unit, t);
      if (err) { flash(err, 'warn'); setText(t); } else flash(`Sent to ${unit ? e.s.trucks[unit]?.crew ?? unit : 'all units'}`, 'good');
    } else run(e.liveRadio(unit, t, false));
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
        {!readOnly && <label className="aa" title="Play voice clips from crew phones as they arrive"><input type="checkbox" checked={opAuto} onChange={ev => { setOpAuto(ev.target.checked); try { localStorage.setItem('campusOpsOpAutoPlay', ev.target.checked ? '1' : '0'); } catch { /* none */ } }} /> Auto-play</label>}
        {!readOnly && !alertsOn && <button className="btn sm warn" title="Lock-screen / background alerts on this computer when crew phones call" onClick={async () => { const err = await enablePush(''); if (err) flash(err, 'warn'); else { setAlertsOn(true); flash('Alerts on for this console', 'good'); } }}>🔔 Alerts</button>}
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
            <span className="msg">{m.text}{m.audio && <audio className="clip" controls preload="none" src={audioUrl(m.audio)} />}</span>
          </div>
        ))}
      </div>
      {!readOnly && <>
        {talkBack && <PttBar />}
        <div className="typetx" style={{ flexWrap: 'wrap', gap: 4 }}>
          <textarea value={text} onChange={ev => setText(ev.target.value)} rows={2} placeholder={ptt.supported ? 'Hold Space and repeat the call, or type it here' : 'Type what was said'} style={{ flex: 1, minWidth: 180, font: 'inherit', resize: 'vertical' }}
            onKeyDown={ev => { if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); log(); } }} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <button className="btn sm" disabled={!text.trim()} onClick={log}>{dir === 'to' ? 'Send' : 'Log'}</button>
            {Recorder.supported() && <button className={`btn sm ${vrec === 'rec' ? 'danger on' : ''}`} title="Hold to record a voice message to the selected instructor (or all units)" disabled={vrec === 'send'}
              onPointerDown={ev => { ev.preventDefault(); try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* none */ } voiceDown(); }} onPointerUp={() => voiceUp()} onPointerCancel={() => voiceUp()}>{vrec === 'rec' ? '● Recording' : vrec === 'send' ? 'Sending…' : '🎙 Voice'}</button>}
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
        <span className="dim" style={{ fontSize: 10 }}>{ACCESS.role === 'staff' ? 'view only' : dir === 'to' ? `to ${unit ? e.s.trucks[unit]?.crew : 'ALL units'} · phones` : unit ? `from ${e.s.trucks[unit]?.crew}` : 'pick who'}</span>
      </div>
    </div>
  );
}
