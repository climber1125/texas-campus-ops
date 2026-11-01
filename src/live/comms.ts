// Campus Ops comms: the phone-as-radio channel (text, voice clips, status taps) + lock-screen alerts.
import { ACCESS, hdr } from './access';

export interface ChanMsg {
  id: string; ts: number; from: string; fromName?: string; to: string; text?: string; audio?: string; dur?: number;
  kind: 'msg' | 'status' | 'assign' | 'emergency'; wo?: string; status?: string; priority?: string;
}

export async function sendMsg(m: { to: string; text?: string; audio?: string; dur?: number; kind?: ChanMsg['kind']; wo?: string; status?: string; priority?: string }, unit?: string, name?: string): Promise<ChanMsg | string> {
  try {
    const r = await fetch('/api/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...hdr(), ...(unit ? { 'x-unit': unit } : {}) },
      body: JSON.stringify({ ...m, fromName: name }),
      signal: AbortSignal.timeout(15000),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return j.error || `Send failed (${r.status})`;
    return j as ChanMsg;
  } catch { return 'No connection — not sent'; }
}

export async function fetchMsgs(since: number): Promise<ChanMsg[] | null> {
  try {
    const r = await fetch(`/api/messages?since=${since}`, { headers: hdr(), cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!r.ok) return null;
    return await r.json() as ChanMsg[];
  } catch { return null; }
}

export async function uploadAudio(b: Blob): Promise<string | null> {
  try {
    const r = await fetch('/api/audio', { method: 'POST', headers: { 'Content-Type': b.type || 'audio/webm', ...hdr() }, body: b, signal: AbortSignal.timeout(30000) });
    if (!r.ok) return null;
    return (await r.json()).id as string;
  } catch { return null; }
}
export const audioUrl = (id: string) => `/api/audio/${id}`;

// ── Hold-to-talk recorder: audio clip + best-effort transcript ──
export interface Clip { blob: Blob; dur: number; text: string; }
export class Recorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  private sr: any = null;
  private text = '';
  private t0 = 0;
  onInterim?: (t: string) => void;
  static supported() { return typeof window !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof (window as any).MediaRecorder !== 'undefined'; }
  async start(): Promise<string | null> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch (e: any) { return e?.name === 'NotAllowedError' ? 'Microphone blocked — allow the mic for this site' : 'No microphone available'; }
    const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus'];
    const type = types.find(t => (window as any).MediaRecorder.isTypeSupported?.(t)) ?? '';
    this.rec = new MediaRecorder(this.stream, type ? { mimeType: type, audioBitsPerSecond: 24000 } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = ev => { if (ev.data.size) this.chunks.push(ev.data); };
    this.rec.start(250);
    this.t0 = Date.now();
    // transcript alongside (Chrome / Android / Safari); if it can't run, the clip still sends
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    this.text = '';
    if (SR) {
      try {
        this.sr = new SR(); this.sr.lang = 'en-US'; this.sr.continuous = true; this.sr.interimResults = true;
        this.sr.onresult = (ev: any) => { let f = '', i = ''; for (let k = 0; k < ev.results.length; k++) { const r = ev.results[k]; if (r.isFinal) f += r[0].transcript + ' '; else i += r[0].transcript + ' '; } this.text = (f + i).trim(); this.onInterim?.(this.text); };
        this.sr.onerror = () => undefined;
        this.sr.start();
      } catch { this.sr = null; }
    }
    return null;
  }
  stop(): Promise<Clip | null> {
    return new Promise(res => {
      const rec = this.rec;
      try { this.sr?.stop(); } catch { /* ended */ }
      if (!rec) { res(null); return; }
      rec.onstop = () => {
        this.stream?.getTracks().forEach(t => t.stop());
        const dur = (Date.now() - this.t0) / 1000;
        const blob = new Blob(this.chunks, { type: rec.mimeType || 'audio/webm' });
        this.rec = null;
        // give the recogniser a moment to deliver its final words
        setTimeout(() => res(dur < 0.6 || !blob.size ? null : { blob, dur, text: this.text }), 350);
      };
      try { rec.stop(); } catch { res(null); }
    });
  }
}

// ── Lock-screen alerts (Web Push) ────────────────────────────
export const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export const isStandalone = () => (window.matchMedia?.('(display-mode: standalone)').matches) || (navigator as any).standalone === true;
export const pushSupported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function b64ToBytes(b64: string) {
  const p = '='.repeat((4 - (b64.length % 4)) % 4);
  const s = atob((b64 + p).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(s, c => c.charCodeAt(0));
}

export async function registerSW(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator) || !/^https?:/.test(location.protocol)) return null;
  try { return await navigator.serviceWorker.register('/sw.js'); } catch { return null; }
}

export async function pushState(): Promise<'on' | 'off' | 'blocked' | 'unsupported' | 'install'> {
  if (isIOS() && !isStandalone()) return 'install';
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'blocked';
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  return sub && Notification.permission === 'granted' ? 'on' : 'off';
}

/** Must be called from a tap. unit = this phone's unit id ('' for the operator console). */
export async function enablePush(unit: string): Promise<string | null> {
  if (isIOS() && !isStandalone()) return 'On iPhone: tap Share → Add to Home Screen, open Campus Ops from that icon, then turn alerts on.';
  if (!pushSupported()) return 'This browser cannot do lock-screen alerts. Use Chrome on Android, or Safari from the Home Screen icon on iPhone.';
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return 'Notifications were not allowed. Turn them on for this site in the phone settings.';
  const reg = (await navigator.serviceWorker.getRegistration()) ?? (await registerSW());
  if (!reg) return 'Could not start the alert service';
  await navigator.serviceWorker.ready;
  const k = await fetch('/api/push', { headers: hdr() }).then(r => (r.ok ? r.json() : null)).catch(() => null);
  if (!k?.publicKey) return 'Server did not answer — check the connection';
  let sub = await reg.pushManager.getSubscription();
  if (sub) { try { await sub.unsubscribe(); } catch { /* none */ } }
  try { sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(k.publicKey) }); }
  catch { return 'This device refused the alert subscription'; }
  const r = await fetch('/api/push', { method: 'POST', headers: { 'Content-Type': 'application/json', ...hdr() }, body: JSON.stringify({ subscription: sub.toJSON(), unit }) }).catch(() => null);
  if (!r || !r.ok) return 'Could not register this device for alerts';
  try { localStorage.setItem('campusOpsPushUnit', unit); } catch { /* none */ }
  return null;
}
export async function disablePush(): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await fetch('/api/push', { method: 'DELETE', headers: { 'Content-Type': 'application/json', ...hdr() }, body: JSON.stringify({ endpoint: sub.endpoint }) }).catch(() => null);
  await sub.unsubscribe().catch(() => undefined);
}

// ── In-app alert sound / vibration ───────────────────────────
let actx: AudioContext | null = null;
export function chime(urgent = false) {
  try {
    actx = actx ?? new (window.AudioContext || (window as any).webkitAudioContext)();
    const ctx = actx!;
    const notes = urgent ? [880, 660, 880, 660] : [660, 990];
    notes.forEach((f, i) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, ctx.currentTime + i * 0.16);
      g.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + i * 0.16 + 0.15);
      o.connect(g).connect(ctx.destination); o.start(ctx.currentTime + i * 0.16); o.stop(ctx.currentTime + i * 0.16 + 0.16);
    });
  } catch { /* no audio */ }
  try { navigator.vibrate?.(urgent ? [300, 120, 300, 120, 300] : [120, 80, 120]); } catch { /* none */ }
}
export function unlockChime() { try { actx = actx ?? new (window.AudioContext || (window as any).webkitAudioContext)(); actx!.resume(); } catch { /* none */ } }

export const STATUS_TAPS: { k: string; label: string; unit?: string; wo?: string }[] = [
  { k: 'ack', label: 'Acknowledge' },
  { k: 'enroute', label: 'En route', unit: 'En Route' },
  { k: 'onscene', label: 'On scene', unit: 'On Scene' },
  { k: 'working', label: 'Working', unit: 'Working', wo: 'In Progress' },
  { k: 'complete', label: 'Complete', wo: 'Done' },
];
void ACCESS;

/** Operator → field: send on the channel and log it on the radio. */
export async function tellUnit(e: { liveRadio(unit: string, text: string, fromControl: boolean, audio?: string, dur?: number): string | null; s: any }, unit: string, text: string, extra: { kind?: ChanMsg['kind']; wo?: string; priority?: string; audio?: string; dur?: number } = {}): Promise<string | null> {
  const to = unit || 'ALL';
  const r = await sendMsg({ to, text, ...extra });
  if (typeof r === 'string') return r;
  e.liveRadio(unit, text, true, extra.audio, extra.dur);
  return null;
}
