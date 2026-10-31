// ─────────────────────────────────────────────────────────────
// Audio: alarm tones, radio squelch, crew voices (text-to-speech) and
// operator push-to-talk (speech-to-text).
//
// Crew voices use the browser's speech engine and pick the most natural
// voices installed: Microsoft Edge ships free neural "Natural" voices;
// Chrome has Google voices; Windows/macOS add their own. Each truck keeps
// its own voice. Voice providers implement RadioVoice, so recorded clips or
// a local TTS server can be swapped in later.
// ─────────────────────────────────────────────────────────────
import type { RadioMsg } from '../sim/types';
import { speakable } from '../sim/radio';

export interface RadioVoice { name: string; available(): boolean; speak(msg: RadioMsg, text: string): Promise<void>; cancel(): void; }

let ctx: AudioContext | null = null;
function ac(): AudioContext | null {
  if (!ctx) { try { ctx = new (window.AudioContext || (window as any).webkitAudioContext)(); } catch { ctx = null; } }
  if (ctx?.state === 'suspended') ctx.resume();
  return ctx;
}

export function unlockAudio() { ac(); try { speechSynthesis.getVoices(); } catch { /* none */ } }

function tone(freq: number, start: number, dur: number, gain = 0.08, type: OscillatorType = 'square') {
  const c = ac(); if (!c) return;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0, c.currentTime + start);
  g.gain.linearRampToValueAtTime(gain, c.currentTime + start + 0.01);
  g.gain.setValueAtTime(gain, c.currentTime + start + dur - 0.02);
  g.gain.linearRampToValueAtTime(0, c.currentTime + start + dur);
  o.connect(g).connect(c.destination);
  o.start(c.currentTime + start); o.stop(c.currentTime + start + dur + 0.02);
}

export function alarmTone(pri: number) {
  if (pri === 1) { tone(880, 0, 0.16); tone(660, 0.2, 0.16); tone(880, 0.4, 0.16); tone(660, 0.6, 0.16); }
  else { tone(740, 0, 0.12, 0.05); tone(740, 0.3, 0.12, 0.05); }
}
/** Emergency-traffic alert: three long high tones. */
export function emergencyTone() { tone(1250, 0, 0.45, 0.07, 'sine'); tone(1250, 0.6, 0.45, 0.07, 'sine'); tone(1250, 1.2, 0.45, 0.07, 'sine'); }
/** Talk-permit chirp when the operator keys up. */
export function keyChirp() { tone(1450, 0, 0.06, 0.05, 'sine'); tone(1850, 0.07, 0.07, 0.05, 'sine'); }

/** Short filtered noise burst = radio squelch tail / key-up. */
export function squelch() {
  const c = ac(); if (!c) return;
  const len = Math.floor(c.sampleRate * 0.09);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource(); src.buffer = buf;
  const f = c.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 0.7;
  const g = c.createGain(); g.gain.value = 0.05;
  src.connect(f).connect(g).connect(c.destination); src.start();
}

// ── Voice ranking ────────────────────────────────────────────
function score(v: SpeechSynthesisVoice): number {
  const n = v.name;
  let s = 0;
  if (/Natural|Neural|Online/i.test(n)) s += 100;           // Edge neural voices
  if (/Google/i.test(n)) s += 60;
  if (/Premium|Enhanced/i.test(n)) s += 50;                  // macOS high quality
  if (/^en-US/i.test(v.lang)) s += 20; else if (/^en/i.test(v.lang)) s += 10;
  if (/espeak|robot|novelty|whisper|bells|bad news|boing|bubbles|cellos|zarvox|trinoids|albert|jester|organ|superstar/i.test(n)) s -= 200;
  return s;
}
const MALE = /Guy|Davis|Christopher|Eric|Roger|Steffan|Brian|Andrew|Tony|Jason|Ryan|Thomas|David|Mark|Alex|Daniel|Fred|Tom|Aaron|Male|Rishi|Arthur|Oliver|Liam|William|Ethan|James/i;

export function rankedVoices(): SpeechSynthesisVoice[] {
  try { return speechSynthesis.getVoices().filter(v => /^en/i.test(v.lang)).sort((a, b) => score(b) - score(a)); } catch { return []; }
}
export function voiceQuality(): 'natural' | 'standard' | 'none' {
  const vs = rankedVoices();
  if (!vs.length) return 'none';
  return score(vs[0]) >= 100 ? 'natural' : 'standard';
}

class SpeechVoice implements RadioVoice {
  name = 'Browser speech synthesis';
  private assigned = new Map<string, { voice?: SpeechSynthesisVoice; pitch: number; rate: number }>();
  available() { return typeof window !== 'undefined' && 'speechSynthesis' in window; }
  private pick(from: string) {
    const hit = this.assigned.get(from);
    if (hit) return hit;
    const vs = rankedVoices();
    const good = vs.filter(v => score(v) >= (score(vs[0] ?? v) >= 100 ? 100 : 0));
    const pool = good.length ? good : vs;
    const male = pool.filter(v => MALE.test(v.name));
    const crewPool = male.length >= 2 ? male : pool;
    let h = 0; for (const ch of from) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const isControl = from === 'CAMPUS CONTROL';
    const voice = isControl ? pool[0] : crewPool[(this.assigned.size + h) % Math.max(1, crewPool.length)];
    // Natural voices sound wrong when pitch-shifted, so only vary pitch on standard voices.
    const natural = voice ? score(voice) >= 100 : false;
    const v = { voice, pitch: natural ? 1 : 0.8 + (h % 5) * 0.08, rate: natural ? 1.04 + (h % 3) * 0.03 : 1.05 + (h % 3) * 0.05 };
    this.assigned.set(from, v);
    return v;
  }
  speak(msg: RadioMsg, text: string) {
    return new Promise<void>(res => {
      const u = new SpeechSynthesisUtterance(text);
      const p = this.pick(msg.from);
      if (p.voice) u.voice = p.voice;
      u.pitch = p.pitch; u.rate = msg.kind === 'emergency' ? p.rate * 1.12 : p.rate; u.volume = 0.95;
      u.onend = () => res(); u.onerror = () => res();
      speechSynthesis.speak(u);
      setTimeout(res, 20000);
    });
  }
  cancel() { try { speechSynthesis.cancel(); } catch { /* none */ } }
}

export const VOICES: RadioVoice[] = [new SpeechVoice()];

/** Sequential radio playback queue. Drops backlog so audio never lags far behind the sim. */
export class RadioPlayer {
  private q: RadioMsg[] = [];
  private busy = false;
  private held = false;
  enabled = false;
  voice: RadioVoice = VOICES[0];
  onKey?: (from: string | null) => void;

  push(msgs: RadioMsg[], speed: number) {
    const speakable = msgs.filter(m => m.kind !== 'operator' && m.kind !== 'system');
    if (!this.enabled || !this.voice.available()) return;
    for (const m of speakable) if (speed <= 1 || m.kind !== 'routine') this.q.push(m);
    if (this.q.length > 4) this.q.splice(0, this.q.length - 3);
    this.pump();
  }
  /** Operator keyed up: stop talking immediately and wait. */
  hold(on: boolean) {
    this.held = on;
    if (on) { this.voice.cancel(); this.busy = false; this.onKey?.(null); }
    else setTimeout(() => this.pump(), 400);
  }
  private async pump() {
    if (this.busy || this.held) return;
    const m = this.q.shift(); if (!m) return;
    this.busy = true;
    this.onKey?.(m.from);
    squelch();
    await this.voice.speak(m, speakable(m.text));
    if (!this.held) squelch();
    this.onKey?.(null);
    this.busy = false;
    setTimeout(() => this.pump(), 250);
  }
  stop() { this.q = []; this.voice.cancel(); this.busy = false; this.onKey?.(null); }
}

// ── Push-to-talk speech recognition ──────────────────────────
export function speechRecognitionSupported(): boolean {
  return typeof window !== 'undefined' && !!((window as any).SpeechRecognition || (window as any).webkitSpeechRecognition);
}

export interface PttHandlers { onInterim(text: string): void; onFinal(text: string): void; onError(err: string): void; onEnd(): void; }

/** One push-to-talk transmission. start() when keyed, stop() when released; the final transcript arrives via onFinal. */
export class PttSession {
  private rec: any;
  private finalText = '';
  private interim = '';
  private stopped = false;
  constructor(private h: PttHandlers) {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    this.rec = new SR();
    this.rec.lang = 'en-US';
    this.rec.continuous = true;
    this.rec.interimResults = true;
    this.rec.maxAlternatives = 1;
    this.rec.onresult = (ev: any) => {
      let fin = '', inter = '';
      for (let i = 0; i < ev.results.length; i++) {
        const r = ev.results[i];
        if (r.isFinal) fin += r[0].transcript + ' '; else inter += r[0].transcript + ' ';
      }
      this.finalText = fin.trim(); this.interim = inter.trim();
      this.h.onInterim((this.finalText + ' ' + this.interim).trim());
    };
    this.rec.onerror = (ev: any) => { if (ev.error !== 'no-speech' && ev.error !== 'aborted') this.h.onError(ev.error); };
    this.rec.onend = () => {
      const text = (this.finalText + ' ' + this.interim).trim();
      if (text) this.h.onFinal(text);
      this.h.onEnd();
    };
  }
  start() { try { this.rec.start(); } catch (e) { this.h.onError(String(e)); } }
  stop() { if (this.stopped) return; this.stopped = true; try { this.rec.stop(); } catch { /* ended */ } }
}
