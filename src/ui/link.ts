// ─────────────────────────────────────────────────────────────
// Multi-window link. One window (the "main console") runs the engine
// and broadcasts state ~4×/s on a BroadcastChannel. Other windows hold a
// replica engine, render from it, and forward every operator action to
// the main console. Selection is shared so clicking an incident in the
// OMS window flies the map window to it. If the main console closes, a
// linked window takes over with the last state. Same-browser only.
// ─────────────────────────────────────────────────────────────
import type { Engine } from '../sim/engine';
import type { Sel } from './ctx';

export type View = 'all' | 'wall' | 'gis' | 'scada' | 'sw' | 'ops' | 'oms' | 'radio' | 'crew' | 'alarms' | 'rel';
export const VIEWS: [View, string][] = [
  ['all', 'Full console'], ['wall', 'Status wall (big screen / projector)'], ['gis', 'GIS map'], ['scada', 'SCADA'], ['sw', 'Switching'], ['ops', 'Ops desk (OMS · radio · units · alarms)'],
  ['oms', 'OMS'], ['radio', 'Radio'], ['crew', 'Units'], ['alarms', 'Alarms'], ['rel', 'Reliability'],
];

/** Engine methods that change simulation state — forwarded to the main console from linked windows. */
export const ACTIONS = new Set([
  'ackAlarm', 'ackAll', 'scadaControl', 'dispatch', 'recall', 'statusCheck', 'cellCall', 'welfareCheck',
  'approve', 'deny', 'releaseClearance', 'newOrder', 'addStep', 'removeStep', 'activateOrder', 'cancelOrder',
  'issueStep', 'confirmRepeat', 'verifyIncident', 'decision', 'setSpeed', 'setPaused', 'setAutoAssist',
  'rosterAdd', 'rosterEdit', 'rosterRemove', 'lockoutDevice', 'releaseLockout', 'setNonReclose', 'notify911',
  'declareEmergency', 'crewDownDrill', 'confirmDead', 'setVoiceRadio', 'voiceTx', 'setTutStep',
  'liveOperate', 'liveStepDone', 'liveClearance', 'liveRelease', 'liveUnitStatus', 'liveUnitArea', 'liveWoCreate', 'liveWoUpdate', 'liveRadio', 'liveClearEmergency', 'liveIncoming',
]);

export type Msg =
  | { type: 'state'; from: string; gen: number; s: any; readings: any; devKw: any }
  | { type: 'hello'; from: string; view: View; master: boolean }
  | { type: 'bye'; from: string }
  | { type: 'act'; from: string; method: string; args: any[] }
  | { type: 'result'; to: string; text: string }
  | { type: 'sel'; from: string; sel: Sel }
  | { type: 'goto'; to: string; tab: 'gis' | 'scada' | 'sw'; prefill: { dev: string; action: 'open' | 'close' } | null }
  | { type: 'start'; from: string; id: string; seed: number; emg?: number }
  | { type: 'load'; from: string; state: any };

export const WIN_ID = Math.random().toString(36).slice(2, 10);

export function openChannel(): BroadcastChannel | null {
  try { return new BroadcastChannel('gridops-link'); } catch { return null; }
}

/** Wrap a replica engine so action calls are posted to the main console instead of run locally. */
export function remoteEngine(e: Engine, post: (m: Msg) => void): Engine {
  return new Proxy(e, {
    get(t, p, r) {
      if (typeof p === 'string' && ACTIONS.has(p)) {
        return (...args: any[]) => {
          post({ type: 'act', from: WIN_ID, method: p, args });
          if (p === 'newOrder') return { id: t.peekId('SO', 1040) };
          if (p === 'liveWoCreate') return t.peekId('WO', 1000);
          if (p === 'scadaControl') return { ok: true };
          return null;
        };
      }
      return Reflect.get(t, p, r);
    },
  });
}

export function viewUrl(v: View): string {
  const u = new URL(window.location.href);
  u.searchParams.set('mon', v);
  return u.toString();
}

export function initialView(): View {
  const v = new URLSearchParams(window.location.search).get('mon') as View | null;
  return v && VIEWS.some(x => x[0] === v) ? v : 'all';
}

/** Staff / follower screens: every state-changing call is refused. */
export function readOnlyEngine(e: Engine, onBlocked: () => void): Engine {
  return new Proxy(e, {
    get(t, p, r) {
      if (typeof p === 'string' && ACTIONS.has(p)) return () => { onBlocked(); return p === 'scadaControl' ? { ok: false, reason: 'View only' } : 'View only'; };
      return Reflect.get(t, p, r);
    },
  });
}
