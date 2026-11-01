import React, { useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import './ui/styles.css';
import { ACCESS, setKey, whoami, type Access } from './live/access';
import { boot } from './live/boot';
import { registerSW } from './live/comms';

const VIEW_KEY = 'campusOpsView';
function crewView(): boolean {
  const q = new URLSearchParams(location.search).get('mode');
  if (q === 'crew') return true;
  if (q === 'board' || new URLSearchParams(location.search).get('mon')) return false;
  try { const v = localStorage.getItem(VIEW_KEY); if (v) return v === 'crew'; } catch { /* none */ }
  return window.innerWidth < 900;
}

type Phase = { k: 'check' } | { k: 'login'; msg?: string } | { k: 'loading' } | { k: 'ready'; App: React.ComponentType } | { k: 'crew'; Crew: React.ComponentType<{ onFullBoard(): void }>; App: React.ComponentType } | { k: 'error'; msg: string };

function Gate() {
  const [ph, setPh] = useState<Phase>({ k: 'check' });
  const [code, setCode] = useState('');
  const start = async (role: Access) => {
    ACCESS.role = role;
    setPh({ k: 'loading' });
    try {
      await boot();
      registerSW();
      const mod = await import('./ui/App');
      if (role === 'staff' && crewView()) { const c = await import('./ui/CrewApp'); setPh({ k: 'crew', Crew: c.default, App: mod.default }); }
      else setPh({ k: 'ready', App: mod.default });
    } catch (err) { setPh({ k: 'error', msg: String(err) }); }
  };
  const check = async () => {
    const r = await whoami();
    if (r === 'offline') {
      // offline with a remembered code: run from the last cached data
      if (ACCESS.key) { await start(localStorage.getItem('campusOpsLastRole') === 'operator' ? 'operator' : 'staff'); return; }
      setPh({ k: 'login', msg: 'Server unreachable — check the connection.' }); return;
    }
    if (r === 'viewer') { setPh({ k: 'login', msg: ACCESS.key ? 'Code not recognized.' : undefined }); return; }
    try { localStorage.setItem('campusOpsLastRole', r); } catch { /* none */ }
    await start(r);
  };
  useEffect(() => { check(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  if (ph.k === 'ready') return <ph.App />;
  if (ph.k === 'crew') { const App = ph.App; return <ph.Crew onFullBoard={() => { try { localStorage.setItem(VIEW_KEY, 'board'); } catch { /* none */ } setPh({ k: 'ready', App }); }} />; }
  return (
    <div className="gate">
      <div className="gate-box">
        <div className="brand" style={{ marginBottom: 14 }}><div className="mark">NLC</div><div><div className="n1">NLC CAMPUS OPS</div><div className="n2">LIVE SYSTEM OPERATIONS · TEXAS CAMPUS</div></div></div>
        {ph.k === 'check' && <div className="mono dim">Checking access…</div>}
        {ph.k === 'loading' && <div className="mono c-cyan">Loading yard, network and ops board…</div>}
        {ph.k === 'error' && <div className="warnbox">Startup failed: {ph.msg}</div>}
        {ph.k === 'login' && (
          <form onSubmit={ev => { ev.preventDefault(); if (!code.trim()) return; setKey(code.trim()); setCode(''); setPh({ k: 'check' }); check(); }}>
            <div className="sec-t" style={{ marginTop: 0 }}>Access code</div>
            <input autoFocus type="password" value={code} onChange={ev => setCode(ev.target.value)} placeholder="Operator or staff code" style={{ width: '100%', fontSize: 15, padding: '8px 10px' }} autoComplete="current-password" />
            {ph.msg && <div className="c-amber" style={{ fontSize: 11, marginTop: 6 }}>{ph.msg}</div>}
            <button className="btn pri" style={{ width: '100%', marginTop: 10, padding: '8px 0' }} type="submit">Sign in</button>
            <div className="dim" style={{ fontSize: 10.5, marginTop: 10, lineHeight: 1.5 }}>Operator code runs the desk. Staff code shows the same screens, view only.</div>
          </form>
        )}
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><Gate /></React.StrictMode>);
