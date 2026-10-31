import { createContext, useContext } from 'react';
import type { Engine } from '../sim/engine';
import type { LatLng } from '../sim/types';

export type Sel = { kind: 'dev' | 'load' | 'truck' | 'inc' | 'line' | 'sub' | 'pole' | 'wo'; id: string } | null;
export interface SboReq { dev: string; action: 'open' | 'close' | 'lockout'; order?: string; viaOrder?: boolean; }

export interface Ptt { supported: boolean; active: boolean; interim: string; error: string | null; start(): void; stop(): void; send(text: string): void | Promise<void>; }

/** Prefill for a new Campus Ops work order. */
export interface WoDraft { text?: string; item?: string | null; priority?: 'Emergency' | 'Urgent' | 'Routine'; assignee?: string; caller?: string; source?: 'radio' | 'typed'; n: number; }

export interface Ctx {
  e: Engine;
  sel: Sel;
  setSel(s: Sel): void;
  openSbo(r: SboReq): void;
  flyTo(pos: LatLng, zoom?: number): void;
  setTab(t: 'gis' | 'scada' | 'sw'): void;
  swPrefill: { dev: string; action: 'open' | 'close' } | null;
  setSwPrefill(p: { dev: string; action: 'open' | 'close' } | null): void;
  flash(text: string, level?: 'info' | 'warn' | 'alarm' | 'good'): void;
  /** Voice radio is on and working: radio traffic must be spoken, not clicked. */
  voiceReq: boolean;
  ptt: Ptt;
  // ── Campus Ops ──
  /** true for staff screens and for an operator screen that is following another desk */
  readOnly: boolean;
  woDraft: WoDraft | null;
  newWo(d?: Omit<WoDraft, 'n'>): void;
  radioDraft: { text: string; n: number };
  setRadioDraft(text: string): void;
  openNet(): void;
}

export const EngineCtx = createContext<Ctx>(null as unknown as Ctx);
export const useCtx = () => useContext(EngineCtx);

export function age(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`;
}

export const statusCls = (s: string) => s.replace(/\s+/g, '');
