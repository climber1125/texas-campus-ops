// Voice-radio helpers: when talk-back is on, radio actions are spoken —
// buttons are replaced by the phrase to say, so the operator learns the
// phraseology. SCADA and phone actions stay as buttons.
import { useRef, type ReactNode } from 'react';
import { useCtx } from './ctx';

export function SayOr({ phrase, children }: { phrase: string; children: ReactNode }) {
  const { voiceReq } = useCtx();
  if (!voiceReq) return <>{children}</>;
  return <span className="say" title="Voice radio is on: hold Space (or the TALK button) and say this">🎙 “{phrase}”</span>;
}

export function PttBar() {
  const { ptt, voiceReq, e } = useCtx();
  const down = useRef(0);
  const latched = useRef(false);
  if (!ptt.supported && !voiceReq) return null;
  return (
    <div className={`pttbar ${ptt.active ? 'live' : ''}`}>
      {ptt.supported ? (
        <button
          className={`btn ptt ${ptt.active ? 'on' : ''}`}
          onPointerDown={ev => {
            ev.preventDefault();
            if (latched.current) { latched.current = false; ptt.stop(); return; }
            try { ev.currentTarget.setPointerCapture(ev.pointerId); } catch { /* ignore */ }
            down.current = Date.now(); ptt.start();
          }}
          onPointerUp={() => { if (Date.now() - down.current < 450) latched.current = true; else ptt.stop(); }}
          onPointerCancel={() => { if (!latched.current) ptt.stop(); }}
        >{ptt.active ? (latched.current ? '● TALKING — TAP TO SEND' : '● TRANSMITTING') : 'HOLD TO TALK'}</button>
      ) : null}
      <div className="pttline">
        {ptt.active ? <span className="interim">{ptt.interim || 'Listening…'}</span>
          : ptt.error ? <span className="c-red">{ptt.error}</span>
          : e.live ? <span className="dim">Hold <b>Space</b> or the button (or tap once, tap again to stop) and repeat the call — the words land in the box below.</span> : <span className="dim">Hold <b>Space</b> or the button, or tap once to talk and again to send. Start with the unit: “Truck {Object.keys(e.s.trucks)[0] ?? '233'}, Campus Control…”</span>}
      </div>
    </div>
  );
}

export function TypeTx() {
  const { ptt } = useCtx();
  return (
    <form className="typetx" onSubmit={ev => { ev.preventDefault(); const f = ev.currentTarget; const i = f.elements.namedItem('tx') as HTMLInputElement; if (i.value.trim()) { ptt.send(i.value); i.value = ''; } }}>
      <input name="tx" placeholder="Type a transmission (no mic): Truck 233, respond to INC-4102" autoComplete="off" />
      <button className="btn sm" type="submit">Send</button>
    </form>
  );
}

/** One-click phrases: pick a truck, click a chip, it transmits "Truck N, Campus Control, …". */
export function PhraseChips({ unit }: { unit: string }) {
  const { ptt, e } = useCtx();
  const u = unit === '249' ? 'Supervisor 249' : `Truck ${unit}`;
  const inc = e.openIncidents().filter(i => i.status !== 'Restored' && !i.crew).sort((a, b) => a.priority - b.priority || a.t - b.t)[0];
  const chips: [string, string][] = [
    ['Status?', 'status'],
    ...(inc ? [[`Respond to ${inc.id}`, `respond to ${inc.id}`] as [string, string]] : []),
    ['Permission granted', 'permission granted to close'],
    ['Hold / stand by', 'hold, stand by'],
    ['Clearance issued', 'clearance is issued on that section'],
    ['Copy', 'copy'],
    ['Correct', 'that is correct, proceed'],
    ['Negative', 'negative, say again'],
    ['Return to the shop', 'return to the shop'],
  ];
  return (
    <div className="chips">
      <span className="dim" style={{ fontSize: 10 }}>SAY TO {unit}</span>
      {chips.map(([label, tail]) => <button key={label} className="btn sm chip" onClick={() => ptt.send(`${u}, Campus Control, ${tail}`)}>{label}</button>)}
    </div>
  );
}

const SHEET: [string, string[]][] = [
  ['Always start with the unit', ['“Truck 233, Campus Control.” (answer: “233, go ahead”)', 'Supervisor: “Supervisor 249, Campus Control…”']],
  ['Dispatch & status', ['“Truck 233, respond to incident 4101.”', '“Truck 233, go check S 2114.” (device instead of incident)', '“Truck 233, status?” / “what’s your 20?”', '“Truck 233, return to the shop.”']],
  ['Crew requests', ['Close fuse: “Permission granted to close.” or “Hold, stand by.”', 'Clearance: “Clearance is issued on that section.” or “Unable, stand by.”', 'Release: “Copy, clearance released.”', 'Hot-line: “Hot-line tag is on, you’re clear for energized work.”']],
  ['Switching orders', ['“Truck 230, open switch 2 1 1 4.” (must match the active order step)', 'Crew repeats it back → “Correct, proceed.” or “Negative, say again.”']],
  ['Emergency', ['“All units, Campus Control, emergency traffic only.”', 'Then: “R 2125 is open and locked out, the line is dead.”', 'Use the ☎ 911 button for EMS.']],
  ['Welfare', ['“Truck 230, check on Truck 233.”']],
  ['Number tips', ['Say numbers like a dispatcher: “twenty one fourteen”, “two thirty three”.', 'Prefixes: switch, tie switch, recloser, breaker, fuse, transformer, incident.', 'Feeders: Cedar Hollow, Ironwood, Bluestem.']],
];

export function CheatSheet({ onClose }: { onClose(): void }) {
  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal cheat" onClick={ev => ev.stopPropagation()} style={{ maxWidth: 640, maxHeight: '85vh', overflow: 'auto' }}>
        <div className="ph" style={{ display: 'flex', justifyContent: 'space-between' }}><b>RADIO CHEAT SHEET</b><span><button className="btn sm" onClick={() => window.print()}>Print</button> <button className="btn sm" onClick={onClose}>Close</button></span></div>
        {SHEET.map(([h, lines]) => <div key={h}><div className="sec-t">{h}</div><ul style={{ margin: '2px 0 6px 16px', padding: 0, fontSize: 12, lineHeight: 1.5 }}>{lines.map(l => <li key={l}>{l}</li>)}</ul></div>)}
      </div>
    </div>
  );
}
