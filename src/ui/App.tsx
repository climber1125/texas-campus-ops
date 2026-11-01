// GRID OPS operator workstation shell: top bar, monitors, modals,
// real-time loop, audio, toasts, autosave, and multi-window linking.
//
// Multi-window: exactly one window (the MAIN console) runs the engine.
// Leadership uses the browser's Web Locks API, which is immune to the
// timer throttling browsers apply to background/minimized windows —
// so a hidden main window is never mistaken for a closed one. Linked
// windows only take over when the main window is actually closed.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Engine } from '../sim/engine';
import { EngineCtx, type Ctx, type Sel, type SboReq } from './ctx';
import { GisMap, selPos } from './GisMap';
import { ScadaView } from './Scada';
import { SwitchingView } from './Switching';
import { OrdersPanel } from './Orders';
import { NetEditor } from './NetEditor';
import { RadioPanel } from './Radio';
import { CrewBoard, AlarmPanel } from './Bottom';
import { Inspector } from './Inspector';
import { SboModal } from './Modals';
import { StatusWall, applyRoster } from './Fleet';
import { RadioPlayer, alarmTone, unlockAudio, keyChirp, PttSession, speechRecognitionSupported } from './audio';
import { saveState, loadState } from '../sim/persist';
import { openChannel, remoteEngine, readOnlyEngine, initialView, viewUrl, VIEWS, WIN_ID, type Msg, type View } from './link';
import { ACCESS, getJson, putJson, setKey } from '../live/access';
import { BOOT, reconcile } from '../live/boot';
import { CAMPUS } from '../sim/topology';
import type { WoDraft } from './ctx';
import { fetchMsgs, chime, beep, audioUrl, livePoll } from '../live/comms';
import type { LatLng } from '../sim/types';

interface Toast { id: number; text: string; level: string; t: string; born: number; }
type Tab = 'gis' | 'scada' | 'sw';
type Mon = 'gis' | 'scada' | 'sw' | 'oms' | 'radio' | 'crew' | 'alarms';
type Role = 'pending' | 'master' | 'replica';
type Theme = 'dark' | 'light';
interface Peer { view: View; master: boolean; t: number; }
type Prefill = { dev: string; action: 'open' | 'close' } | null;
type Desk = 'operator' | 'staff' | 'follow';
const PUSH_MS = 4000, POLL_MS = 4000, HOLD_MS = 25000;

function initialEngine(): Engine {
  const b = BOOT.data;
  if (b?.state?.s) {
    try { const ne = new Engine(b.state.s); if (b.state.readings) ne.readings = b.state.readings; if (b.state.devKw) ne.devKw = b.state.devKw; return ne; } catch (err) { console.error('saved board unusable', err); }
  }
  return Engine.create('LIVE', 1);
}
function initialDesk(): Desk {
  if (ACCESS.role !== 'operator') return 'staff';
  const st = BOOT.data?.state;
  return st && st.client !== ACCESS.client && Date.now() - st.at < HOLD_MS ? 'follow' : 'operator';
}

const LOCK = 'gridops-main';
const locksApi: any = typeof navigator !== 'undefined' ? (navigator as any).locks : undefined;
const HAS_LOCKS = !!locksApi?.request;

const themeKey = (v: View) => `gridops-theme-${v}`;
function loadTheme(v: View): Theme { try { return localStorage.getItem(themeKey(v)) === 'light' ? 'light' : 'dark'; } catch { return 'dark'; } }

function makeTicker(fn: () => void): () => void {
  // A dedicated worker keeps ticking at full rate when this window is in the background.
  try {
    const url = URL.createObjectURL(new Blob(['setInterval(function(){postMessage(0)},100)'], { type: 'text/javascript' }));
    const w = new Worker(url);
    w.onmessage = fn;
    return () => { w.terminate(); URL.revokeObjectURL(url); };
  } catch {
    const id = setInterval(fn, 100);
    return () => clearInterval(id);
  }
}

export default function App() {
  const [e, setE] = useState<Engine>(() => initialEngine());
  const [desk, setDesk] = useState<Desk>(initialDesk);
  const deskRef = useRef(desk); deskRef.current = desk;
  const readOnly = desk !== 'operator';
  const [sync, setSync] = useState<{ ok: boolean; at: number; text: string }>({ ok: true, at: 0, text: 'connecting' });
  const [netChanged, setNetChanged] = useState(false);
  const [showNet, setShowNet] = useState(false);
  const [woDraft, setWoDraft] = useState<WoDraft | null>(null);
  const [radioDraft, setRadioDraftRaw] = useState({ text: '', n: 0 });
  const eRef = useRef(e); eRef.current = e;
  const [, setVer] = useState(0);

  // ── Window role & view ─────────────────────────────────────
  const chan = useMemo(() => (ACCESS.role === 'operator' ? openChannel() : null), []);
  const [role, setRole] = useState<Role>(chan ? 'pending' : 'master');
  const roleRef = useRef(role); roleRef.current = role;
  const gotState = useRef(false);
  const [view, setViewRaw] = useState<View>(initialView);
  const viewRef = useRef(view); viewRef.current = view;
  const [theme, setTheme] = useState<Theme>(() => loadTheme(initialView()));
  const peers = useRef(new Map<string, Peer>());
  const [peerCount, setPeerCount] = useState(0);
  const lastHeard = useRef(Date.now());
  const post = (m: Msg) => { try { chan?.postMessage(m); } catch { /* closed */ } };
  const setView = (v: View) => {
    setViewRaw(v);
    setTheme(loadTheme(v));
    if (v === 'gis' || v === 'scada' || v === 'sw') setTabRaw(v);
    try { history.replaceState(null, '', viewUrl(v)); } catch { /* file:// quirks */ }
    post({ type: 'hello', from: WIN_ID, view: v, master: roleRef.current === 'master' });
  };
  useEffect(() => { document.documentElement.dataset.theme = theme; }, [theme]);
  const toggleTheme = () => { const t: Theme = theme === 'dark' ? 'light' : 'dark'; setTheme(t); try { localStorage.setItem(themeKey(view), t); } catch { /* none */ } };

  const [tab, setTabRaw] = useState<Tab>(() => (['gis', 'scada', 'sw'].includes(initialView()) ? initialView() as Tab : 'gis'));
  const [mon, setMon] = useState<Mon>('gis');
  const [narrow, setNarrow] = useState(() => window.innerWidth < 1280);
  const [focus, setFocus] = useState(false);
  useEffect(() => { const f = () => setNarrow(window.innerWidth < 1280); window.addEventListener('resize', f); return () => window.removeEventListener('resize', f); }, []);

  const [sel, setSelLocal] = useState<Sel>(null);
  const [sbo, setSbo] = useState<SboReq | null>(null);
  const [showScen, setShowScen] = useState(false);
  const [showAar, setShowAar] = useState(false);
  const [showMon, setShowMon] = useState(false);
  const [showEmg, setShowEmg] = useState(false);
  const [showObj, setShowObj] = useState(true);
  const [audioOn, setAudioOn] = useState(false);
  const [voiceOn, setVoiceOn] = useState(true);
  const [talkBack, setTalkBackRaw] = useState<boolean>(() => { try { return localStorage.getItem('gridops-talkback') !== '0'; } catch { return true; } });
  const setTalkBack = (v: boolean) => { setTalkBackRaw(v); try { localStorage.setItem('gridops-talkback', v ? '1' : '0'); } catch { /* ignore */ } };
  const [aiAvail, setAiAvail] = useState(false);
  const [aiOn, setAiOnRaw] = useState<boolean>(() => { try { return localStorage.getItem('gridops-ai') !== '0'; } catch { return true; } });
  const setAiOn = (v: boolean) => { setAiOnRaw(v); try { localStorage.setItem('gridops-ai', v ? '1' : '0'); } catch { /* ignore */ } };
  const aiOnRef = useRef(aiOn); aiOnRef.current = aiOn;
  useEffect(() => {
    if (!/^https?:/.test(location.protocol)) return;
    fetch('/.netlify/functions/interpret').then(r => r.ok ? r.json() : null).then(j => setAiAvail(!!j?.enabled)).catch(() => setAiAvail(false));
  }, []);
  const [pttActive, setPttActive] = useState(false);
  const [pttInterim, setPttInterim] = useState('');
  const [pttError, setPttError] = useState<string | null>(null);
  const pttRef = useRef<PttSession | null>(null);
  const pttSupported = useMemo(() => speechRecognitionSupported(), []);
  const [silenced, setSilenced] = useState(false);
  const [keyed, setKeyed] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [swPrefill, setSwPrefillState] = useState<Prefill>(null);
  const prefillRef = useRef<Prefill>(null);
  const [saved, setSaved] = useState<{ autosave?: number; manual?: number }>({});
  const [pendingWins, setPendingWins] = useState<{ v: View; label: string; feat: string }[]>([]);
  const mapApi = useRef<{ flyTo(p: LatLng, z?: number): void } | null>(null);
  const player = useRef(new RadioPlayer());
  const seen = useRef({ radio: 0, log: 0, alarmCount: 0, lastTone: 0 });

  const isMaster = role === 'master';
  const mapVisible = view === 'gis' || (view === 'all' && tab === 'gis' && (!narrow || mon === 'gis'));
  const mapVisRef = useRef(mapVisible); mapVisRef.current = mapVisible;
  const ce = useMemo(() => (readOnly ? readOnlyEngine(e, () => flash(desk === 'follow' ? 'View only — another operator console is running the desk' : 'View only — staff access', 'warn')) : role === 'replica' ? remoteEngine(e, post) : e), [e, role, readOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const flash = (text: string, level: 'info' | 'warn' | 'alarm' | 'good' = 'info') => setToasts(t => [...t, { id: Date.now() + Math.random(), text, level, t: eRef.current.hhmm(), born: Date.now() }].slice(-5));

  const start = (id: string, seed: number, emg?: number) => {
    if (roleRef.current === 'replica') { post({ type: 'start', from: WIN_ID, id, seed, emg }); setShowScen(false); return; }
    const ne = Engine.create(id, seed); applyRoster(ne); if (emg && emg > 0) ne.scheduleDrill(emg);
    setE(ne); setShowScen(false); setShowAar(false); if (viewRef.current === 'all') setTabRaw('gis');
  };
  const loadInto = (state: any) => {
    if (roleRef.current === 'replica') { post({ type: 'load', from: WIN_ID, state }); return; }
    const ne = new Engine(state); ne.s.paused = false; setE(ne);
  };
  const resume = async (key: string) => { const v = await loadState(key); if (v) { loadInto(v.state); setShowScen(false); flash(`Session restored (${key})`, 'good'); } };

  function becomeMaster() {
    if (roleRef.current === 'master') return;
    if (gotState.current) {
      // Main console was closed: continue the same simulation from the last state we mirrored.
      const ne = new Engine(eRef.current.s);
      setE(ne);
      flash('Main console closed — this window took over the simulation', 'warn');
    } else {
      applyRoster(eRef.current);
    }
    roleRef.current = 'master';
    setRole('master');
  }

  function broadcast() {
    if (roleRef.current !== 'master' || !chan) return;
    const en = eRef.current;
    post({ type: 'state', from: WIN_ID, gen: 0, s: en.s, readings: en.readings, devKw: en.devKw });
  }

  // ── Leader election ────────────────────────────────────────
  useEffect(() => {
    if (!chan) { applyRoster(eRef.current); return; }
    if (HAS_LOCKS) {
      let release: (() => void) | null = null;
      let alive = true;
      locksApi.query().then((q: any) => {
        const held = (q.held ?? []).some((l: any) => l.name === LOCK);
        if (held && alive && roleRef.current === 'pending') { roleRef.current = 'replica'; setRole('replica'); }
      }).catch(() => undefined);
      // Waits (without timers) until no other window holds the lock — i.e. the main console is closed.
      locksApi.request(LOCK, () => new Promise<void>(res => { release = res; if (alive) becomeMaster(); else res(); })).catch(() => undefined);
      return () => { alive = false; release?.(); };
    }
    // Fallback (no Web Locks): generous timers.
    const t = setTimeout(() => { if (roleRef.current === 'pending') becomeMaster(); }, 2000);
    return () => clearTimeout(t);
  }, [chan]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Link: message handling ─────────────────────────────────
  useEffect(() => {
    if (!chan) return;
    const handle = (ev: MessageEvent<Msg>) => {
      const m = ev.data;
      const me = roleRef.current;
      switch (m.type) {
        case 'state': {
          if (m.from === WIN_ID || me === 'master') {
            if (me === 'master' && !HAS_LOCKS && m.from < WIN_ID) { roleRef.current = 'replica'; setRole('replica'); eRef.current.syncFrom(m.s, m.readings, m.devKw); }
            return;
          }
          lastHeard.current = Date.now();
          eRef.current.syncFrom(m.s, m.readings, m.devKw);
          gotState.current = true;
          if (me === 'pending') { roleRef.current = 'replica'; setRole('replica'); }
          setVer(v => v + 1);
          break;
        }
        case 'hello': {
          if (m.from === WIN_ID) return;
          const isNew = !peers.current.has(m.from);
          peers.current.set(m.from, { view: m.view, master: m.master, t: Date.now() });
          if (me === 'master' && isNew) broadcast();
          break;
        }
        case 'act': {
          if (me !== 'master') return;
          const fn = (eRef.current as any)[m.method];
          if (typeof fn !== 'function') return;
          let r: any;
          try { r = fn.apply(eRef.current, m.args); } catch (err) { r = String(err); }
          const text = typeof r === 'string' ? r : r && r.ok === false ? r.reason : null;
          if (text) post({ type: 'result', to: m.from, text });
          broadcast(); setVer(v => v + 1);
          break;
        }
        case 'bye': peers.current.delete(m.from); setPeerCount(peers.current.size); break;
        case 'result': if (m.to === WIN_ID) flash(m.text, 'warn'); break;
        case 'sel': {
          if (m.from === WIN_ID) return;
          setSelLocal(m.sel);
          if (m.sel && mapVisRef.current) { const p = selPos(eRef.current, m.sel); if (p) mapApi.current?.flyTo(p); }
          break;
        }
        case 'goto': {
          if (m.to !== WIN_ID) return;
          if (viewRef.current === 'all') setTabRaw(m.tab); else setView(m.tab);
          if (m.prefill) { prefillRef.current = m.prefill; setSwPrefillState(m.prefill); }
          window.focus();
          break;
        }
        case 'start': if (me === 'master') start(m.id, m.seed, m.emg); break;
        case 'load': if (me === 'master') loadInto(m.state); break;
      }
    };
    chan.addEventListener('message', handle);
    post({ type: 'hello', from: WIN_ID, view: viewRef.current, master: false });
    const bye = () => post({ type: 'bye', from: WIN_ID });
    window.addEventListener('pagehide', bye);
    return () => { chan.removeEventListener('message', handle); window.removeEventListener('pagehide', bye); };
  }, [chan]); // eslint-disable-line react-hooks/exhaustive-deps

  // Heartbeat + peer list (+ timer takeover only when Web Locks are unavailable)
  useEffect(() => {
    if (!chan) return;
    const hb = setInterval(() => {
      post({ type: 'hello', from: WIN_ID, view: viewRef.current, master: roleRef.current === 'master' });
      const now = Date.now();
      for (const [id, p] of peers.current) if (now - p.t > 65000) peers.current.delete(id); // background windows may only beat once a minute
      setPeerCount(peers.current.size);
      if (!HAS_LOCKS && roleRef.current === 'replica' && gotState.current && now - lastHeard.current > 10000) becomeMaster();
    }, 1000);
    return () => clearInterval(hb);
  }, [chan]); // eslint-disable-line react-hooks/exhaustive-deps

  // Main console clock: worker-driven so it keeps full speed in the background.
  useEffect(() => {
    if (!isMaster || desk !== 'operator') return;
    let last = performance.now(), lastRender = 0, lastBc = 0;
    return makeTicker(() => {
      const now = performance.now();
      eRef.current.tick(now - last); last = now;
      if (now - lastBc > 250) { lastBc = now; broadcast(); }
      if (now - lastRender > 240) { lastRender = now; setVer(v => v + 1); }
    });
  }, [isMaster, desk]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Shared board: operator pushes, staff / follower polls ──
  const forceNext = useRef(false);
  useEffect(() => {
    if (!isMaster || desk !== 'operator') return;
    let lastVer = -1, lastPush = 0, busy = false;
    const push = async () => {
      if (busy) return;
      const en = eRef.current;
      if (en.ver === lastVer && Date.now() - lastPush < 15000) return;
      busy = true;
      const r = await putJson('/api/state', { client: ACCESS.client, s: en.s, readings: en.readings, devKw: en.devKw, net: CAMPUS?.cfg.updatedAt ?? null, force: forceNext.current });
      busy = false;
      if (r.ok) { forceNext.current = false; lastVer = en.ver; lastPush = Date.now(); setSync({ ok: true, at: Date.now(), text: 'synced' }); }
      else if (r.status === 409) { setDesk('follow'); flash('Another operator console took the desk — this screen is now view only', 'warn'); }
      else if (r.status === 403) { setSync({ ok: false, at: Date.now(), text: 'code rejected' }); }
      else setSync({ ok: false, at: Date.now(), text: r.status ? `sync error ${r.status}` : 'offline — saving locally' });
    };
    push();
    const id = setInterval(push, PUSH_MS);
    return () => clearInterval(id);
  }, [isMaster, desk]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (desk === 'operator') return;
    let lastAt = 0;
    const poll = async () => {
      const r = await getJson<{ s: any; readings: any; devKw: any; at: number; client: string; net?: string | null }>('/api/state');
      if (!r.ok) { setSync({ ok: false, at: Date.now(), text: r.status === 404 ? 'no board yet' : r.status ? `error ${r.status}` : 'offline' }); return; }
      setSync({ ok: true, at: Date.now(), text: deskRef.current === 'follow' && Date.now() - r.data.at > HOLD_MS ? 'other desk idle' : 'live' });
      if ((r.data.net ?? null) !== (CAMPUS?.cfg.updatedAt ?? null) && r.data.net) setNetChanged(true);
      if (r.data.at === lastAt) return;
      lastAt = r.data.at;
      eRef.current.syncFrom(reconcile(r.data.s), r.data.readings ?? {}, r.data.devKw ?? {});
      broadcast();
      setVer(v => v + 1);
    };
    poll();
    const id = setInterval(poll, POLL_MS);
    return () => clearInterval(id);
  }, [desk]); // eslint-disable-line react-hooks/exhaustive-deps
  // ── Crew phones → operator desk: pick up channel traffic and apply it ──
  useEffect(() => {
    if (!isMaster || desk !== 'operator') return;
    const lp = livePoll(async () => {
      const F = eRef.current.s.scen.flags;
      const since = Math.max(F.lastMsgTs ?? 0, Date.now() - 3600 * 1000) - 1;
      const m = await fetchMsgs(since);
      if (!m) return false;
      const seen = new Set<string>(F.seenMsg ?? []);
      const fresh = m.filter(x => x.from !== 'CONTROL' && !seen.has(x.id)).sort((a, b) => a.ts - b.ts);
      if (!fresh.length) return false;
      for (const x of fresh) eRef.current.liveIncoming(x);
      const urgent = fresh.some(x => x.kind === 'emergency');
      if (urgent) chime(true); else beep('rx');
      for (const x of fresh.slice(-3)) flash(`${eRef.current.s.trucks[x.from]?.crew ?? x.fromName ?? x.from}: ${x.text || '🎙 voice'}`, x.kind === 'emergency' ? 'alarm' : 'info');
      const clip = fresh.filter(x => x.audio).at(-1);
      try { if (clip && localStorage.getItem('campusOpsOpAutoPlay') !== '0') void new Audio(audioUrl(clip.audio!)).play().catch(() => undefined); } catch { /* none */ }
      broadcast(); setVer(v => v + 1);
      return true;
    }, 1000, 2000);
    return () => lp.stop();
  }, [isMaster, desk]); // eslint-disable-line react-hooks/exhaustive-deps
  const takeOver = async () => {
    const r = await getJson<{ s: any; readings: any; devKw: any }>('/api/state');
    if (r.ok) { const ne = new Engine(reconcile(r.data.s)); ne.readings = r.data.readings ?? ne.readings; ne.devKw = r.data.devKw ?? ne.devKw; setE(ne); }
    forceNext.current = true;
    setDesk('operator');
    flash('This console now runs the desk', 'good');
  };

  // Reset watchers when the engine instance changes
  useEffect(() => {
    seen.current.radio = e.s.radio.at(-1)?.id ?? 0;
    seen.current.log = e.s.log.at(-1)?.id ?? 0;
    seen.current.alarmCount = e.s.alarms.length;
    player.current.stop();
    setSelLocal(null); setToasts([]);
  }, [e]);

  useEffect(() => { player.current.onKey = setKeyed; }, []);
  useEffect(() => { player.current.enabled = audioOn && voiceOn && isMaster; if (!voiceOn || !isMaster) player.current.stop(); }, [audioOn, voiceOn, isMaster]);

  // Per-render side effects: radio audio, alarm tones (main console only), toasts, AAR
  const s = e.s;
  useEffect(() => {
    const newMsgs = s.radio.filter(m => m.id > seen.current.radio);
    if (newMsgs.length) { seen.current.radio = newMsgs.at(-1)!.id; if (isMaster) player.current.push(newMsgs, s.paused ? 1 : s.speed); }
    if (s.alarms.length > seen.current.alarmCount) { seen.current.alarmCount = s.alarms.length; setSilenced(false); }
    const unack = s.alarms.filter(a => !a.acked && a.active && a.pri <= 2);
    if (isMaster && audioOn && !silenced && unack.length && Date.now() - seen.current.lastTone > 6000) { seen.current.lastTone = Date.now(); alarmTone(Math.min(...unack.map(a => a.pri))); }
    const newLog = s.log.filter(l => l.id > seen.current.log);
    if (newLog.length) {
      seen.current.log = newLog.at(-1)!.id;
      const add = newLog.filter(l => l.level !== 'info' && l.cat !== 'RADIO').slice(-4).map(l => ({ id: l.id, text: l.text, level: l.level, t: e.hhmm(l.t), born: Date.now() }));
      if (add.length && view !== 'wall') setToasts(t => [...t, ...add].slice(-5));
    }
    if (isMaster && s.scen.done && !s.scen.aarShown) { s.scen.aarShown = true; setShowAar(true); }
  });
  useEffect(() => { const id = setInterval(() => setToasts(t => t.filter(x => Date.now() - x.born < 7000)), 1000); return () => clearInterval(id); }, []);

  // Autosave every 30 s (main console only)
  useEffect(() => {
    const id = setInterval(() => { if (roleRef.current === 'master') saveState('autosave', eRef.current.s).catch(() => undefined); }, 30000);
    Promise.all([loadState('autosave'), loadState('manual')]).then(([a, m]) => setSaved({ autosave: a?.savedAt, manual: m?.savedAt })).catch(() => undefined);
    return () => clearInterval(id);
  }, []);

  // ── Context for panels ─────────────────────────────────────
  const peerShowing = (t: Tab) => {
    for (const [id, p] of peers.current) if (p.view === t) return id;
    for (const [id, p] of peers.current) if (p.view === 'all') return id;
    return null;
  };
  const setTab = (t: Tab) => {
    if (viewRef.current === 'all') { setTabRaw(t); setMon(t); return; }
    if (viewRef.current === t) return;
    const peer = peerShowing(t);
    if (peer) { post({ type: 'goto', to: peer, tab: t, prefill: prefillRef.current }); prefillRef.current = null; setSwPrefillState(null); return; }
    if (viewRef.current === 'gis' || viewRef.current === 'scada' || viewRef.current === 'sw') setView(t);
    else window.open(viewUrl(t), `gridops-${t}-${Date.now()}`, 'popup,width=1400,height=900');
  };
  // ── Push-to-talk ───────────────────────────────────────────
  const voiceReq = talkBack && pttSupported && !e.live;
  const sendTx = async (text: string) => {
    if (eRef.current.live) { setRadioDraftRaw(d => ({ text, n: d.n + 1 })); return; }
    let line = text;
    if (aiAvail && aiOnRef.current) {
      try {
        const r = await fetch('/.netlify/functions/interpret', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, context: eRef.current.aiContext() }), signal: AbortSignal.timeout(5000) });
        if (r.ok) { const j = await r.json(); if (typeof j.line === 'string' && j.line.trim()) line = j.line; }
      } catch { /* fall back to the built-in parser */ }
    }
    const eng = eRef.current;
    if (aiAvail && aiOnRef.current && roleRef.current === 'master') {
      // AI crew voice: the sim acts first (authoritative), the AI words the replies.
      const { err, lines } = eng.voiceTxHeld(line, line === text ? undefined : text);
      const unit = eng.s.radioCtx?.unit ?? null;
      try {
        const r = await fetch('/.netlify/functions/crew', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ said: text, line, engineLines: lines.map(l => ({ unit: l.unit, text: l.text })), engineError: err, context: { units: Object.keys(eng.s.trucks), ...eng.aiCrewContext(unit) } }), signal: AbortSignal.timeout(7000) });
        const j = r.ok ? await r.json() : null;
        if (j && Array.isArray(j.replies)) {
          const kind = lines[0]?.kind ?? 'routine';
          for (const x of j.replies) eng.crewSay(x.unit, x.text, kind);
          if (!j.replies.length) eng.emitHeld([]);
          if (err) flash(err, 'warn');
          setVer(v => v + 1);
          return;
        }
      } catch { /* fall through to built-in replies */ }
      eng.emitHeld(lines);
      if (err) flash(err, 'warn');
      return;
    }
    const r: any = line === text ? (ceRef.current as any).voiceTx(text) : (ceRef.current as any).voiceTx(line, text);
    const msg = typeof r === 'string' ? r : r && r.ok === false ? r.reason : null;
    if (msg) flash(msg, 'warn');
  };
  const pttStart = () => {
    if (!pttSupported || pttRef.current) return;
    unlockAudio(); setPttError(null); setPttInterim('');
    keyChirp(); player.current.hold(true);
    const sess = new PttSession({
      onInterim: t => setPttInterim(t),
      onFinal: t => sendTx(t),
      onError: er => setPttError(er === 'not-allowed' || er === 'service-not-allowed' ? 'Microphone blocked — allow the mic for this site (padlock in the address bar), or use Type instead.' : `Voice input error: ${er}. Use Type instead.`),
      onEnd: () => { pttRef.current = null; setPttActive(false); player.current.hold(false); },
    });
    pttRef.current = sess; setPttActive(true); sess.start();
  };
  const pttStop = () => { pttRef.current?.stop(); };
  const ceRef = useRef(ce); ceRef.current = ce;
  const pttFns = useRef({ start: pttStart, stop: pttStop }); pttFns.current = { start: pttStart, stop: pttStop };
  useEffect(() => {
    if (!talkBack || !pttSupported || readOnly) return;
    const inField = (t: EventTarget | null) => { const el = t as HTMLElement | null; return !!el && (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || el.isContentEditable); };
    const dn = (ev: KeyboardEvent) => { if (ev.code === 'Space' && !ev.repeat && !inField(ev.target)) { ev.preventDefault(); pttFns.current.start(); } };
    const up = (ev: KeyboardEvent) => { if (ev.code === 'Space' && pttRef.current) { ev.preventDefault(); pttFns.current.stop(); } };
    window.addEventListener('keydown', dn); window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', dn); window.removeEventListener('keyup', up); };
  }, [talkBack, pttSupported, readOnly]);
  // Engine voice-radio mode follows the setting (main console owns the engine state).
  useEffect(() => { if (isMaster && e.s.voiceRadio !== voiceReq) e.setVoiceRadio(voiceReq); });
  useEffect(() => { if (!isMaster && ce.s.voiceRadio !== voiceReq) (ce as any).setVoiceRadio(voiceReq); }, [voiceReq, isMaster, e.s.voiceRadio]); // eslint-disable-line react-hooks/exhaustive-deps

  (window as any).__ops = { e: ce, setSel: (x: Sel) => setSelLocal(x) }; // test / support hook
  const ctx: Ctx = {
    e: ce, sel,
    setSel: (x: Sel) => { setSelLocal(x); post({ type: 'sel', from: WIN_ID, sel: x }); },
    openSbo: r => setSbo(r),
    flyTo: (p, z) => { if (!mapVisRef.current) return; mapApi.current?.flyTo(p, z); },
    setTab,
    swPrefill,
    setSwPrefill: (p: Prefill) => { prefillRef.current = p; setSwPrefillState(p); },
    flash,
    voiceReq,
    ptt: { supported: pttSupported && !readOnly, active: pttActive, interim: pttInterim, error: pttError, start: pttStart, stop: pttStop, send: sendTx },
    readOnly,
    woDraft,
    newWo: d => { if (readOnly) { flash('View only', 'warn'); return; } setWoDraft({ ...(d ?? {}), n: Date.now() }); if (compact) setMon('oms'); },
    radioDraft,
    setRadioDraft: (text: string) => setRadioDraftRaw(d => ({ text, n: d.n + 1 })),
    openNet: () => setShowNet(true),
  };

  // ── Monitor launcher ───────────────────────────────────────
  const openWin = (v: View, feat = 'popup,width=1400,height=900') => window.open(viewUrl(v), `gridops-${v}-${Date.now()}`, feat);
  const spread = async () => {
    const w = window as any;
    if (!('getScreenDetails' in w)) { flash('This browser cannot place windows on screens automatically — use Chrome or Edge, or open windows and drag them.', 'warn'); return; }
    let sd: any;
    try { sd = await w.getScreenDetails(); } catch { flash('Window placement permission denied — open windows from the list and drag them to each screen.', 'warn'); return; }
    const others: any[] = sd.screens.filter((x: any) => x !== sd.currentScreen);
    if (!others.length) { flash('Only one screen detected. Connect and extend a second display first.', 'warn'); return; }
    // Largest screen (TV / projector) gets the status wall when there is room for one.
    others.sort((a, b) => b.width * b.height - a.width * a.height);
    let plan: View[];
    if (others.length === 1) plan = ['gis'];
    else if (others.length === 2) plan = ['wall', 'gis'];
    else if (others.length === 3) plan = ['wall', 'gis', 'scada'];
    else plan = ['wall', 'gis', 'scada', 'ops'];
    const queue = plan.map((v, i) => {
      const sc = others[i];
      return { v, label: `${VIEWS.find(x => x[0] === v)![1]} → ${sc.label || `screen ${i + 2}`}`, feat: `popup,left=${sc.availLeft},top=${sc.availTop},width=${sc.availWidth},height=${sc.availHeight}` };
    });
    setView('all'); setTabRaw(plan.includes('scada') ? 'sw' : 'scada');
    const left: typeof queue = [];
    for (const q of queue) { const win = openWin(q.v, q.feat); if (!win) left.push(q); }
    setPendingWins(left);
    if (left.length) flash('Browser allowed only one new window per click — use “Open next” for the rest.', 'warn');
    else setShowMon(false);
  };

  // ── Header data ────────────────────────────────────────────
  const out = e.customersOut();
  const served = e.T.totalCustomers - out;
  const liveWos = Object.values(s.workorders).filter(w => w.issue !== undefined && !['Done', 'Canceled'].includes(w.status));
  const openInc = liveWos.length;
  const emgWo = liveWos.some(w => w.priority === 'Emergency');
  const abnormal = e.T.switchable.filter(id => s.dev[id] && s.dev[id].open !== (e.T.els[id] as any).normalOpen).length;
  const activeClr = Object.values(s.clearances).filter(c => c.status === 'Active').length;
  const unackAl = s.alarms.filter(a => !a.acked).length;
  const pendReq = s.requests.filter(r => r.status === 'Pending').length;
  const d = e.clock();
  const tzAbbr = (() => { try { return new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d).find(p => p.type === 'timeZoneName')?.value ?? ''; } catch { return ''; } })();
  const days = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'], mons = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

  const emgActive = !!s.scen.flags.emergencyTraffic || emgWo;
  const compact = view === 'all' && narrow;
  const wsCls = view === 'all' ? `ws ${compact ? 'compact' : ''} ${focus && !narrow ? 'focus' : ''}` : `ws single v-${view}`;
  const showMain = view === 'all' || view === 'gis' || view === 'scada' || view === 'sw';
  const curTab: Tab = view === 'gis' || view === 'scada' || view === 'sw' ? view : tab;
  const pickTab = (t: Tab) => (view === 'all' ? (setTabRaw(t), setMon(t)) : setView(t));

  const radio = <RadioPanel keyed={keyed} voiceOn={voiceOn} setVoiceOn={setVoiceOn} audioOn={audioOn && isMaster} talkBack={talkBack} setTalkBack={setTalkBack} aiAvail={aiAvail} aiOn={aiOn} setAiOn={setAiOn} />;
  const alarms = <AlarmPanel silenced={silenced} setSilenced={setSilenced} />;
  const waiting = role === 'pending' || (role === 'replica' && !gotState.current);

  return (
    <EngineCtx.Provider value={ctx}>
      <div className={wsCls}>
        <div className="topbar">
          <div className="brand"><div className="mark">NLC</div><div><div className="n1">NLC CAMPUS OPS</div><div className="n2">LIVE SYSTEM OPERATIONS · TEXAS CAMPUS</div></div></div>
          <div className="tb-sep" />
          <div><div className="clock">{e.hhmmss()}</div></div>
          <div className="clockdate">{days[d.getDay()]} {String(d.getDate()).padStart(2, '0')} {mons[d.getMonth()]}<br />{d.getFullYear()} {tzAbbr}</div>
          <div className="tb-sep" />
          <div className="stat" title="Service points (pad-mounts, pedestals, transformer poles) in service"><span className="k">In service</span><span className="v c-green">{served.toLocaleString()}</span></div>
          <div className="stat"><span className="k">Out</span><span className={`v ${out ? 'c-red' : ''}`}>{out.toLocaleString()}</span></div>
          <div className="stat"><span className="k">Work orders</span><span className={`v ${emgWo ? 'c-red' : openInc ? 'c-amber' : ''}`}>{openInc}</span></div>
          <div className="stat"><span className="k">Alarms</span><span className={`v ${unackAl ? 'c-red' : ''}`}>{unackAl}</span></div>
          <div className="stat" title="Devices not in their normal position"><span className="k">Off normal</span><span className={`v ${abnormal ? 'c-amber' : ''}`}>{abnormal}</span></div>
          <div className="stat"><span className="k">Clearances</span><span className={`v ${activeClr ? 'c-amber' : ''}`}>{activeClr}</span></div>
          <div className="tb-sep" />
          <div className={`weather ${s.scen.flags.emergencyTraffic ? 'warning' : 'normal'}`}>{s.scen.flags.emergencyTraffic ? 'EMERGENCY TRAFFIC · OPS-1' : 'LIVE · training yard · nothing energized'}</div>
          <span style={{ flex: 1 }} />
          <span className={`deskpill ${desk === 'operator' ? 'op' : desk === 'staff' ? 'staff' : 'follow'}`} title={desk === 'operator' ? 'This console runs the desk and updates every screen' : desk === 'staff' ? 'Staff access — view only' : 'Another operator console is running the desk'}>{desk === 'operator' ? 'OPERATOR' : desk === 'staff' ? 'STAFF · VIEW' : 'FOLLOWING'}</span>
          <span className={`syncdot ${sync.ok ? 'ok' : 'bad'}`} title={sync.at ? `Last sync ${new Date(sync.at).toLocaleTimeString()}` : ''}>● {sync.text}</span>
          {chan && <span className={`linkpill ${isMaster ? 'main' : role === 'replica' ? 'rep' : ''}`} title={isMaster ? 'Main window for this desk; linked monitor windows mirror it' : 'Mirroring the main window — actions are sent to it'}>
            {role === 'pending' ? 'CONNECTING…' : isMaster ? `MAIN${peerCount ? ` · ${peerCount} LINKED` : ''}` : 'LINKED'}
          </span>}
          {isMaster && (!audioOn ? <button className="btn pri audio-cta" onClick={() => { unlockAudio(); setAudioOn(true); }}>Enable audio</button>
            : <button className="btn on" onClick={() => { setAudioOn(false); player.current.stop(); }}>Audio on</button>)}
          {view === 'all' && !narrow && <button className={`btn ${focus ? 'on' : ''}`} onClick={() => setFocus(!focus)}>{focus ? 'All panels' : 'Map focus'}</button>}
          {!readOnly && <button className="btn" onClick={() => setShowNet(true)} title="Tie poles together, set the source, place switches and fuses">Edit network</button>}
          {!readOnly && <button className={`btn danger ${emgActive ? 'emg-live' : ''}`} onClick={() => setShowEmg(!showEmg)} title="Emergency traffic and 911 log">⚠ EMERGENCY</button>}
          {ACCESS.role === 'staff' && <button className="btn" title="Phone screen: my orders + talk to Control" onClick={() => { try { localStorage.setItem('campusOpsView', 'crew'); } catch { /* none */ } location.reload(); }}>📱 Crew phone</button>}
          <button className={`btn ${showMon ? 'on' : ''}`} onClick={() => setShowMon(!showMon)}>Monitors</button>
          <button className="btn" title={theme === 'dark' ? 'Light mode (projectors / bright rooms)' : 'Dark mode (monitors)'} onClick={toggleTheme}>{theme === 'dark' ? '☀' : '☾'}</button>
          <button className="btn" title="Full screen this window" onClick={() => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => undefined); }}>⛶</button>
          <button className="btn" title="Sign out of this browser" onClick={() => { if (confirm('Sign out? You will need the access code again.')) { setKey(''); location.reload(); } }}>⏻</button>
        </div>

        {compact && (
          <div className="monbar">
            {([['gis', 'Map'], ['scada', 'One-line'], ['sw', 'Switching'], ['oms', 'Orders'], ['radio', 'Radio'], ['crew', 'Units'], ['alarms', 'Alarms']] as [Mon, string][]).map(([k, label]) => {
              const badge = k === 'oms' ? openInc : k === 'radio' ? 0 : k === 'alarms' ? unackAl : 0;
              return <button key={k} className={`btn ${mon === k ? 'on' : ''}`} onClick={() => { setMon(k); if (k === 'gis' || k === 'scada' || k === 'sw') setTabRaw(k); }}>{label}{badge ? <span className={`badge ${k === 'alarms' || k === 'radio' ? 'red' : 'amber'}`} style={{ marginLeft: 4 }}>{badge}</span> : null}</button>;
            })}
          </div>
        )}

        {showMain && (
          <div className="panel mainpane" style={compact && !['gis', 'scada', 'sw'].includes(mon) ? { display: 'none' } : undefined}>
            <div className="ph">
              <div className="tabs">
                <button className={`tab ${curTab === 'gis' ? 'on' : ''}`} onClick={() => pickTab('gis')}>M1 · GIS / System map</button>
                <button className={`tab ${curTab === 'scada' ? 'on' : ''}`} onClick={() => pickTab('scada')}>M2 · One-line{s.alarms.some(a => !a.acked && a.pri === 1) ? <span className="badge red">!</span> : null}</button>
                <button className={`tab ${curTab === 'sw' ? 'on' : ''}`} onClick={() => pickTab('sw')}>Switching &amp; clearances{s.requests.some(r => r.status === 'Pending' && (r.type === 'clearance' || r.type === 'release')) ? <span className="badge amber">!</span> : null}</button>
              </div>
              <span className="sp" />
              <span className="mono dim" style={{ fontSize: 10 }}>{CAMPUS?.items.length ?? 0} YARD ITEMS · {e.T.feederIds.length} CIRCUIT{e.T.feederIds.length === 1 ? '' : 'S'} · {e.T.switchable.length} DEVICES{BOOT.data && !BOOT.data.netSaved ? ' · AUTO-DRAFT' : ''}{BOOT.data && !BOOT.data.polesLive ? ' · POLES FROM CACHE' : ''}</span>
            </div>
            <div className="pb" style={{ position: 'relative', overflow: 'hidden' }}>
              <GisMap visible={mapVisible} apiRef={mapApi} />
              {curTab === 'scada' && <div style={{ position: 'absolute', inset: 0 }}><ScadaView /></div>}
              {curTab === 'sw' && <div style={{ position: 'absolute', inset: 0 }}><SwitchingView /></div>}
              {curTab !== 'sw' && <Inspector />}
              {curTab === 'gis' && desk === 'follow' && <div className="banner">Another operator console is running the desk{sync.text === 'other desk idle' ? ' (idle)' : ''}. This screen is view only. <button className="btn sm warn" onClick={takeOver}>Take over here</button></div>}
              {curTab === 'gis' && desk !== 'follow' && netChanged && <div className="banner info">The network was edited on another screen. <button className="btn sm" onClick={() => location.reload()}>Reload</button></div>}
              {curTab === 'gis' && desk === 'operator' && BOOT.data && !BOOT.data.netSaved && <div className="banner info">Lines are an auto-draft from the Pole Yard map. <button className="btn sm pri" onClick={() => setShowNet(true)}>Check &amp; save the network</button></div>}
              <div className="toasts">
                {toasts.map(t => <div key={t.id} className={`toast ${t.level}`}><span className="tt">{t.t}</span>{t.text}</div>)}
              </div>
            </div>
          </div>
        )}

        {view === 'all' && !compact && (
          <>
            <div className="rightcol"><OrdersPanel />{radio}</div>
            <div className="bottomrow"><CrewBoard />{alarms}</div>
          </>
        )}
        {compact && (
          <>
            {mon === 'oms' && <div className="monwrap"><OrdersPanel /></div>}
            {mon === 'radio' && <div className="monwrap">{radio}</div>}
            {mon === 'crew' && <div className="monwrap"><CrewBoard /></div>}
            {mon === 'alarms' && <div className="monwrap">{alarms}</div>}
          </>
        )}
        {view === 'wall' && <div className="monwrap"><StatusWall /></div>}
        {view === 'ops' && <div className="opsgrid"><OrdersPanel />{radio}<CrewBoard />{alarms}</div>}
        {view === 'oms' && <div className="monwrap"><OrdersPanel /></div>}
        {view === 'radio' && <div className="monwrap">{radio}</div>}
        {view === 'crew' && <div className="monwrap"><CrewBoard /></div>}
        {view === 'rel' && <div className="monwrap"><CrewBoard initial="rel" /></div>}
        {view === 'alarms' && <div className="monwrap">{alarms}</div>}
        {!showMain && toasts.length > 0 && <div className="toasts fixed">{toasts.map(t => <div key={t.id} className={`toast ${t.level}`}><span className="tt">{t.t}</span>{t.text}</div>)}</div>}

        {showEmg && (
          <div className="monmenu emgmenu">
            <div className="sec-t" style={{ marginTop: 0 }}>Emergency</div>
            <div className="monbtns" style={{ gridTemplateColumns: '1fr' }}>
              {!s.scen.flags.emergencyTraffic
                ? <button className="btn danger" onClick={() => { const r = (ce as any).declareEmergency(); if (typeof r === 'string') flash(r, 'warn'); setShowEmg(false); }}>Declare emergency traffic (log it, then announce on the radio)</button>
                : <button className="btn warn" onClick={() => { (ce as any).liveClearEmergency(); setShowEmg(false); }}>Clear emergency traffic</button>}
              <button className="btn danger" onClick={() => { (ce as any).notify911(); flash('Logged: 911 called — make the call on a phone', 'alarm'); setShowEmg(false); }}>☎ Log 911 / EMS called</button>
              <button className="btn warn" onClick={() => { ctx.newWo({ priority: 'Emergency', source: 'radio' }); setShowEmg(false); }}>New EMERGENCY work order</button>
            </div>
            <div className="dim" style={{ fontSize: 10.5, marginTop: 6, lineHeight: 1.45 }}>This app does not call anyone. Use the radio and a phone; log what you did here so the timeline is complete.</div>
          </div>
        )}

        {showMon && (
          <div className="monmenu">
            <div className="sec-t" style={{ marginTop: 0 }}>This window shows</div>
            <select value={view} onChange={ev => setView(ev.target.value as View)} style={{ width: '100%' }}>
              {VIEWS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
            <div className="sec-t">Open a linked window</div>
            {!chan ? <div className="warnbox">{ACCESS.role === 'operator' ? 'This browser blocks window linking here. Use Chrome or Edge.' : 'Staff screens show one view per window — open more tabs with ?mon= in the address to pick a view.'}</div> : (
              <div className="monbtns">
                {VIEWS.map(([v, l]) => <button key={v} className="btn" onClick={() => openWin(v)}>{l}</button>)}
              </div>
            )}
            {chan && <>
              <div className="sec-t">Auto-arrange</div>
              <button className="btn pri" style={{ width: '100%' }} onClick={spread}>Spread across all screens</button>
              {pendingWins.length > 0 && (
                <button className="btn warn" style={{ width: '100%', marginTop: 4 }} onClick={() => { const [q, ...rest] = pendingWins; if (openWin(q.v, q.feat)) setPendingWins(rest); }}>Open next: {pendingWins[0].label}</button>
              )}
              <div className="dim" style={{ fontSize: 10.5, marginTop: 6, lineHeight: 1.45 }}>
                This window stays the full console. Largest extra screen gets the status wall; then map, SCADA, Ops desk.<br />Press ⛶ in each window for full screen, ☀ for light mode on a projector.
              </div>
            </>}
            <div className="sec-t">Linked windows</div>
            <div style={{ fontSize: 11 }}>
              <div><span className="mono">{isMaster ? 'MAIN' : 'LINKED'}</span> · this window · {VIEWS.find(x => x[0] === view)![1]}</div>
              {[...peers.current.entries()].map(([id, p]) => <div key={id} className="dim"><span className="mono">{p.master ? 'MAIN' : 'LINKED'}</span> · {VIEWS.find(x => x[0] === p.view)?.[1] ?? p.view}</div>)}
            </div>
          </div>
        )}
      </div>

      {waiting && <div className="modal-bg"><div className="mono" style={{ color: 'var(--cyan)', textAlign: 'center' }}>{role === 'pending' ? 'Connecting to the Campus Ops console…' : 'Waiting for the main console window…'}<div className="dim" style={{ fontSize: 11, marginTop: 6 }}>If the main window is minimized this can take a few seconds.</div></div></div>}
      {sbo && <SboModal req={sbo} onClose={() => setSbo(null)} />}
      {showNet && !readOnly && <NetEditor onClose={() => setShowNet(false)} />}
    </EngineCtx.Provider>
  );
}
