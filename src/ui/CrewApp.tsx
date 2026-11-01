// Crew phone screen — the instructor's "radio". Signed in with the crew code.
// My work orders with one-tap status, a channel to Control (hold-to-talk voice
// clips with a transcript, or text), and lock-screen alerts.
import { useEffect, useMemo, useRef, useState } from 'react';
import { getJson, setKey } from '../live/access';
import { BOOT } from '../live/boot';
import type { SimState, WorkOrder, Truck } from '../sim/types';
import { sendMsg, fetchMsgs, uploadAudio, audioUrl, Recorder, enablePush, pushState, chime, unlockChime, STATUS_TAPS, type ChanMsg } from '../live/comms';

const UNIT_KEY = 'campusOpsUnit';
const RANK: Record<string, number> = { Emergency: 0, Urgent: 1, Routine: 2 };
const hhmm = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const open = (w: WorkOrder) => w.issue !== undefined && !['Done', 'Canceled'].includes(w.status);

export default function CrewApp({ onFullBoard }: { onFullBoard(): void }) {
  const [s, setS] = useState<SimState | null>(() => BOOT.data?.state?.s ?? null);
  const [unit, setUnitRaw] = useState<string>(() => { try { return localStorage.getItem(UNIT_KEY) || ''; } catch { return ''; } });
  const setUnit = (u: string) => { setUnitRaw(u); try { if (u) localStorage.setItem(UNIT_KEY, u); else localStorage.removeItem(UNIT_KEY); } catch { /* none */ } };
  const [tab, setTab] = useState<'orders' | 'chan'>('orders');
  const [msgs, setMsgs] = useState<ChanMsg[]>([]);
  const [unread, setUnread] = useState(0);
  const [online, setOnline] = useState(true);
  const [alerts, setAlerts] = useState<string>('off');
  const [toast, setToast] = useState<{ t: string; bad?: boolean } | null>(null);
  const [text, setText] = useState('');
  const [rec, setRec] = useState<'idle' | 'rec' | 'send'>('idle');
  const [interim, setInterim] = useState('');
  const [autoPlay, setAutoPlay] = useState(() => { try { return localStorage.getItem('campusOpsAutoPlay') !== '0'; } catch { return true; } });
  const recRef = useRef<Recorder | null>(null);
  const lastTs = useRef(Date.now() - 6 * 3600 * 1000);
  const first = useRef(true);
  const tabRef = useRef(tab); tabRef.current = tab;
  const unitRef = useRef(unit); unitRef.current = unit;
  const listRef = useRef<HTMLDivElement>(null);
  const say = (t: string, bad = false) => { setToast({ t, bad }); setTimeout(() => setToast(x => (x?.t === t ? null : x)), 3500); };

  // board (roster + orders)
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      const r = await getJson<{ s: SimState }>('/api/state');
      if (stop) return;
      setOnline(r.ok || r.status === 404);
      if (r.ok && r.data?.s) setS(r.data.s);
    };
    poll(); const id = setInterval(poll, 4000);
    return () => { stop = true; clearInterval(id); };
  }, []);

  // channel
  useEffect(() => {
    let stop = false;
    const poll = async () => {
      const m = await fetchMsgs(lastTs.current);
      if (stop || !m) return;
      if (!m.length) { first.current = false; return; }
      lastTs.current = Math.max(lastTs.current, ...m.map(x => x.ts));
      setMsgs(prev => { const seen = new Set(prev.map(x => x.id)); return [...prev, ...m.filter(x => !seen.has(x.id))].slice(-300); });
      const me = unitRef.current;
      const forMe = m.filter(x => x.from === 'CONTROL' && (x.to === me || x.to === 'ALL'));
      if (!first.current && forMe.length) {
        chime(forMe.some(x => x.kind === 'emergency' || x.priority === 'Emergency'));
        if (tabRef.current !== 'chan') setUnread(n => n + forMe.length);
        const clip = forMe.filter(x => x.audio).at(-1);
        if (clip && document.visibilityState === 'visible' && localStorage.getItem('campusOpsAutoPlay') !== '0') { try { void new Audio(audioUrl(clip.audio!)).play().catch(() => undefined); } catch { /* none */ } }
      }
      first.current = false;
    };
    poll(); const id = setInterval(poll, 2500);
    const vis = () => { if (document.visibilityState === 'visible') poll(); };
    document.addEventListener('visibilitychange', vis);
    return () => { stop = true; clearInterval(id); document.removeEventListener('visibilitychange', vis); };
  }, []);
  useEffect(() => { pushState().then(setAlerts); }, [unit]);
  useEffect(() => { if (tab === 'chan') { setUnread(0); setTimeout(() => { const b = listRef.current; if (b) b.scrollTop = b.scrollHeight; }, 30); } }, [tab, msgs.length]);

  const units: Truck[] = useMemo(() => Object.values(s?.trucks ?? {}).sort((a, b) => a.crew.localeCompare(b.crew)), [s]);
  const me = unit ? s?.trucks[unit] : undefined;
  const myName = me?.crew ?? unit;
  const wos = Object.values(s?.workorders ?? {}).filter(open);
  const mine = wos.filter(w => w.truck === unit).sort((a, b) => RANK[a.priority ?? 'Routine'] - RANK[b.priority ?? 'Routine']);
  const others = wos.filter(w => w.truck !== unit);
  const chan = msgs.filter(m => m.from === unit || m.to === unit || (m.from === 'CONTROL' && m.to === 'ALL'));

  const send = async (m: Parameters<typeof sendMsg>[0], okText?: string) => {
    unlockChime();
    const r = await sendMsg(m, unit, myName);
    if (typeof r === 'string') { say(r, true); return false; }
    setMsgs(prev => (prev.some(x => x.id === r.id) ? prev : [...prev, r]));
    lastTs.current = Math.max(lastTs.current, r.ts - 1);
    if (okText) say(okText);
    return true;
  };
  const tapStatus = (w: WorkOrder | null, k: string) => {
    const t = STATUS_TAPS.find(x => x.k === k)!;
    const where = w ? `${w.id} ${w.loc}` : '';
    send({ to: 'CONTROL', kind: 'status', status: k, wo: w?.id, text: `${t.label}${where ? ' — ' + where : ''}` }, `${t.label} sent to Control`);
  };
  const pttDown = async () => {
    if (rec !== 'idle') return;
    unlockChime();
    const r = new Recorder(); recRef.current = r;
    r.onInterim = setInterim;
    const err = await r.start();
    if (err) { say(err, true); recRef.current = null; return; }
    setInterim(''); setRec('rec');
    try { navigator.vibrate?.(40); } catch { /* none */ }
  };
  const pttUp = async () => {
    const r = recRef.current; if (!r || rec !== 'rec') return;
    recRef.current = null; setRec('send');
    const clip = await r.stop();
    if (!clip) { setRec('idle'); say('Too short — hold the button while you talk', true); return; }
    const id = await uploadAudio(clip.blob);
    if (!id) { setRec('idle'); say('Voice clip did not upload — check signal', true); return; }
    await send({ to: 'CONTROL', audio: id, dur: Math.round(clip.dur), text: clip.text }, 'Sent to Control');
    setInterim(''); setRec('idle');
  };

  const alertsBtn = async () => {
    unlockChime();
    const err = await enablePush(unit);
    if (err) say(err, true); else { say('Alerts on for this phone'); setAlerts('on'); }
  };

  if (!unit || !me) {
    return (
      <div className="crew">
        <div className="crew-top"><div className="brand"><div className="mark">NLC</div><div><div className="n1">CAMPUS OPS</div><div className="n2">CREW PHONE</div></div></div><span style={{ flex: 1 }} /><button className="btn sm" onClick={onFullBoard}>Full board</button></div>
        <div className="crew-body">
          <h2 className="crew-h">Who are you?</h2>
          {units.length ? units.map(u => (
            <button key={u.id} className="crew-pick" onClick={() => { setUnit(u.id); unlockChime(); }}><b>{u.crew}</b><span className="dim">{u.type}</span></button>
          )) : <div className="warnbox">Nobody is on the board yet. Ask the operator to add you (M5 → Roster), then pull down to refresh.</div>}
          {!online && <div className="warnbox" style={{ marginTop: 10 }}>No connection to the server.</div>}
        </div>
      </div>
    );
  }

  return (
    <div className="crew">
      <div className="crew-top">
        <div style={{ minWidth: 0 }}>
          <div className="crew-name">{myName}</div>
          <div className="dim" style={{ fontSize: 11 }}><span className={`chip ${me.status.replace(/\s+/g, '')}`}>{me.status}</span>{me.clearance ? <span className="badge amber" style={{ marginLeft: 4 }}>{me.clearance}</span> : null}{!online ? <span className="c-red"> · offline</span> : null}</div>
        </div>
        <span style={{ flex: 1 }} />
        {alerts !== 'on' && <button className="btn sm warn" onClick={alertsBtn}>🔔 Alerts</button>}
        <button className="btn sm" onClick={() => { if (confirm('Switch person on this phone?')) setUnit(''); }}>⇄</button>
      </div>

      <div className="crew-tabs">
        <button className={tab === 'orders' ? 'on' : ''} onClick={() => setTab('orders')}>My orders{mine.length ? <span className="badge">{mine.length}</span> : null}</button>
        <button className={tab === 'chan' ? 'on' : ''} onClick={() => setTab('chan')}>Radio{unread ? <span className="badge red">{unread}</span> : null}</button>
      </div>

      {tab === 'orders' ? (
        <div className="crew-body">
          {alerts === 'install' && <div className="warnbox info" style={{ marginBottom: 8 }}>For alerts on iPhone: tap <b>Share → Add to Home Screen</b>, open Campus Ops from the new icon, then tap 🔔 Alerts.</div>}
          {!mine.length && <div className="empty">No work orders assigned to you.</div>}
          {mine.map(w => (
            <div key={w.id} className={`crew-wo pri-b-${w.priority}`}>
              <div className="crew-wo-h"><b className="mono">{w.id}</b><span className={`pri-${w.priority}`}>{w.priority}</span><span className="dim">· {w.status}</span></div>
              <div className="crew-wo-loc">{w.loc}</div>
              <div className="crew-wo-iss">{w.issue}</div>
              {w.caller ? <div className="dim" style={{ fontSize: 11 }}>Called in by {w.caller}</div> : null}
              <div className="crew-taps">{STATUS_TAPS.map(t => <button key={t.k} className={`btn ${t.k === 'complete' ? 'good' : ''}`} onClick={() => tapStatus(w, t.k)}>{t.label}</button>)}</div>
            </div>
          ))}
          <div className="sec-t">My status</div>
          <div className="crew-taps">
            <button className="btn" onClick={() => send({ to: 'CONTROL', kind: 'status', status: 'available', text: 'Available' }, 'Available sent')}>Available</button>
            <button className="btn" onClick={() => tapStatus(null, 'enroute')}>En route</button>
            <button className="btn" onClick={() => tapStatus(null, 'onscene')}>On scene</button>
            <button className="btn" onClick={() => send({ to: 'CONTROL', kind: 'status', status: 'offduty', text: 'Off duty' }, 'Off duty sent')}>Off duty</button>
          </div>
          {others.length > 0 && <>
            <div className="sec-t">Other open orders</div>
            {others.map(w => <div key={w.id} className="crew-mini"><span className={`pri-${w.priority}`}>{(w.priority ?? 'Routine').slice(0, 3).toUpperCase()}</span> <b className="mono">{w.id}</b> {w.loc} — {w.issue}<span className="dim"> · {w.truck ? (s?.trucks[w.truck]?.crew ?? w.truck) : 'unassigned'}</span></div>)}
          </>}
          <div style={{ display: 'flex', gap: 6, marginTop: 14 }}>
            <button className="btn sm" onClick={onFullBoard}>Full board (view)</button>
            <button className="btn sm" onClick={() => { if (confirm('Sign out of Campus Ops on this phone?')) { setKey(''); setUnit(''); location.reload(); } }}>Sign out</button>
          </div>
        </div>
      ) : (
        <div className="crew-chan">
          <div className="crew-msgs" ref={listRef}>
            {!chan.length && <div className="empty">No traffic yet. Hold the big button and talk to Control.</div>}
            {chan.map(m => {
              const mine2 = m.from === unit;
              return (
                <div key={m.id} className={`crew-msg ${mine2 ? 'out' : 'in'} ${m.kind}`}>
                  <div className="who">{mine2 ? 'You → Control' : m.to === 'ALL' ? 'Control → all units' : 'Control'} <span className="dim">{hhmm(m.ts)}</span></div>
                  {m.audio && <audio controls preload="none" src={audioUrl(m.audio)} />}
                  {m.text && <div className="txt">{m.text}</div>}
                </div>
              );
            })}
          </div>
          <div className="crew-quick">
            <button className="btn sm" onClick={() => send({ to: 'CONTROL', text: `Requesting a clearance${mine[0] ? ' for ' + mine[0].id + ' ' + mine[0].loc : ''}` }, 'Sent')}>Need clearance</button>
            <button className="btn sm" onClick={() => send({ to: 'CONTROL', text: 'Clear — grounds off, crew clear' }, 'Sent')}>Clear / grounds off</button>
            <button className="btn sm danger" onClick={() => { if (confirm('Send EMERGENCY to Control?')) send({ to: 'CONTROL', kind: 'emergency', priority: 'Emergency', text: `EMERGENCY — ${myName} needs help${mine[0] ? ' at ' + mine[0].loc : ''}` }, 'EMERGENCY sent'); }}>🚨 Emergency</button>
            <label className="dim" style={{ fontSize: 11, display: 'flex', alignItems: 'center', gap: 3, marginLeft: 'auto' }}><input type="checkbox" checked={autoPlay} onChange={ev => { setAutoPlay(ev.target.checked); try { localStorage.setItem('campusOpsAutoPlay', ev.target.checked ? '1' : '0'); } catch { /* none */ } }} />auto-play</label>
          </div>
          {rec !== 'idle' && <div className="crew-interim">{rec === 'rec' ? (interim || 'Recording… talk now') : 'Sending…'}</div>}
          <button
            className={`crew-ptt ${rec}`}
            disabled={!Recorder.supported() || rec === 'send'}
            onPointerDown={ev => { ev.preventDefault(); try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* none */ } pttDown(); }}
            onPointerUp={() => pttUp()} onPointerCancel={() => pttUp()} onContextMenu={ev => ev.preventDefault()}
          >{!Recorder.supported() ? 'Voice not supported here' : rec === 'rec' ? '● RELEASE TO SEND' : rec === 'send' ? 'SENDING…' : 'HOLD TO TALK'}</button>
          <form className="crew-type" onSubmit={async ev => { ev.preventDefault(); if (!text.trim()) return; if (await send({ to: 'CONTROL', text: text.trim() })) setText(''); }}>
            <input value={text} onChange={ev => setText(ev.target.value)} placeholder="Type to Control" enterKeyHint="send" />
            <button className="btn pri" type="submit" disabled={!text.trim()}>Send</button>
          </form>
        </div>
      )}
      {toast && <div className={`crew-toast ${toast.bad ? 'bad' : ''}`}>{toast.t}</div>}
    </div>
  );
}
