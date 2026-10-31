// MONITOR 3 — Campus Ops work orders (replaces the OMS incident list).
// Radio call or typed request → work order on a pole / pad-mount, with
// priority, assignee, status and a timestamped history.
import { useEffect, useMemo, useState } from 'react';
import { useCtx, age } from './ctx';
import { CAMPUS } from '../sim/topology';
import { itemPos, label, type YardItem } from '../sim/campus';
import { parseCall, normId } from '../live/parse';
import { ACCESS } from '../live/access';
import type { WorkOrder, WoPriority, WoStatus } from '../sim/types';

const PRI: WoPriority[] = ['Emergency', 'Urgent', 'Routine'];
const STATUSES: WoStatus[] = ['Open', 'Assigned', 'In Progress', 'On Hold', 'Done', 'Canceled'];
const RANK: Record<string, number> = { Emergency: 0, Urgent: 1, Routine: 2 };
export const woOpen = (w: WorkOrder) => !['Done', 'Canceled'].includes(w.status);
export const priCls = (p?: string) => (p === 'Emergency' ? 'p1' : p === 'Urgent' ? 'p2' : 'p3');

export function itemsList(): YardItem[] { return (CAMPUS?.items ?? []).filter(i => i.itemType !== 'span'); }
export function itemById(id?: string | null): YardItem | undefined { return id ? CAMPUS?.items.find(i => i.id === id) : undefined; }
export function itemByLabel(text: string): YardItem | undefined { const n = normId(text); if (!n) return undefined; const hits = itemsList().filter(i => normId(i.poleId) === n); return hits.length === 1 ? hits[0] : undefined; }

export function OrdersPanel() {
  const { e, sel, setSel, flyTo, woDraft, readOnly } = useCtx();
  const [tab, setTab] = useState<'open' | 'closed' | 'new'>('open');
  const [q, setQ] = useState('');
  useEffect(() => { if (woDraft && !readOnly) setTab('new'); }, [woDraft?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = Object.values(e.s.workorders).filter(w => w.issue !== undefined);
  const open = all.filter(woOpen).sort((a, b) => RANK[a.priority ?? 'Routine'] - RANK[b.priority ?? 'Routine'] || (b.createdT ?? 0) - (a.createdT ?? 0));
  const closed = all.filter(w => !woOpen(w)).sort((a, b) => (b.doneT ?? b.createdT ?? 0) - (a.doneT ?? a.createdT ?? 0));
  const ql = q.trim().toLowerCase();
  const list = (tab === 'closed' ? closed : open).filter(w => !ql || [w.id, w.loc, w.issue, w.caller, w.truck && e.s.trucks[w.truck]?.crew, w.status, w.priority].join(' ').toLowerCase().includes(ql));
  const selWo = sel?.kind === 'wo' ? e.s.workorders[sel.id] : undefined;
  const emg = open.some(w => w.priority === 'Emergency');

  return (
    <div className="panel" style={{ flex: 1.15 }}>
      <div className="ph">
        <span className="mon">M3</span><span className="ttl">Work Orders</span>
        <div className="tabs" style={{ marginLeft: 6 }}>
          <button className={`tab ${tab === 'open' ? 'on' : ''}`} onClick={() => setTab('open')}>Open<span className={`badge ${emg ? 'red' : ''}`}>{open.length}</span></button>
          <button className={`tab ${tab === 'closed' ? 'on' : ''}`} onClick={() => setTab('closed')}>Closed</button>
          {!readOnly && <button className={`tab ${tab === 'new' ? 'on' : ''}`} onClick={() => setTab('new')}>＋ New</button>}
        </div>
        <span className="sp" />
        {tab !== 'new' && <input placeholder="search" value={q} onChange={ev => setQ(ev.target.value)} style={{ width: 110, fontSize: 10.5 }} />}
      </div>
      <div className="pb">
        {tab === 'new' ? <WoForm onDone={id => { setTab('open'); if (id) setSel({ kind: 'wo', id }); }} /> : (
          <>
            {list.length ? (
              <table className="grid">
                <thead><tr><th>Pri</th><th>WO</th><th>Location</th><th>Issue</th><th>Status</th><th>Assigned</th><th>Age</th></tr></thead>
                <tbody>
                  {list.map(w => (
                    <tr key={w.id} className={`row ${selWo?.id === w.id ? 'sel' : ''}`} onClick={() => { setSel({ kind: 'wo', id: w.id }); flyTo(w.pos, 19); }}>
                      <td><span className={`badge ${priCls(w.priority)}`}>{(w.priority ?? 'Routine').slice(0, 3).toUpperCase()}</span></td>
                      <td className="mono">{w.id}</td>
                      <td className="mono">{w.loc}</td>
                      <td style={{ maxWidth: 220, overflow: 'hidden', textOverflow: 'ellipsis' }}>{w.issue}</td>
                      <td>{w.status}</td>
                      <td className="mono">{w.truck ? (e.s.trucks[w.truck]?.crew ?? w.truck) : <span className="c-amber">—</span>}</td>
                      <td className="num dim">{age(e.s.t - (w.createdT ?? e.s.t))}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : <div className="empty">{tab === 'open' ? (readOnly ? 'No open work orders.' : 'No open work orders. Use ＋ New, a radio call (M4), or a pole on the map.') : 'Nothing closed yet.'}</div>}
            {selWo && <WoDetail wo={selWo} />}
          </>
        )}
      </div>
    </div>
  );
}

export function WoDetail({ wo }: { wo: WorkOrder }) {
  const { e, flash, readOnly, flyTo, setSel } = useCtx();
  const [status, setStatus] = useState<WoStatus>(wo.status);
  const [pri, setPri] = useState<WoPriority>(wo.priority ?? 'Routine');
  const [asg, setAsg] = useState(wo.truck ?? '');
  const [note, setNote] = useState('');
  useEffect(() => { setStatus(wo.status); setPri(wo.priority ?? 'Routine'); setAsg(wo.truck ?? ''); setNote(''); }, [wo.id, wo.status, wo.priority, wo.truck]);
  const units = Object.values(e.s.trucks).sort((a, b) => a.crew.localeCompare(b.crew));
  const save = () => {
    if (status === 'Canceled' && wo.status !== 'Canceled' && !confirm(`Cancel ${wo.id}? It stays in the history.`)) return;
    const err = e.liveWoUpdate(wo.id, { status, priority: pri, assignee: asg, note }, ACCESS.name || 'Operator');
    if (err) flash(err, 'warn'); else { flash(`${wo.id} updated`, 'good'); setNote(''); }
  };
  const item = itemById(wo.item);
  return (
    <div style={{ padding: '6px 8px', borderTop: '1px solid var(--line)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <b className="mono">{wo.id}</b><span className={`pri-${wo.priority}`}>{wo.priority}</span><span className="dim">· {wo.status} · {wo.source === 'radio' ? '🎙 radio call' : '⌨ typed'}</span>
        <span style={{ flex: 1 }} />
        {item && <button className="btn sm" onClick={() => { flyTo(itemPos(item), 20); setSel({ kind: 'pole', id: item.id }); }}>Map</button>}
        <button className="btn sm" onClick={() => printWo(e, wo)}>Print</button>
        <button className="btn sm" onClick={() => setSel(null)}>✕</button>
      </div>
      <div style={{ fontSize: 12.5, margin: '4px 0' }}>{wo.issue}</div>
      <div className="dim" style={{ fontSize: 10.5 }}>{wo.loc} · opened {e.hhmm(wo.createdT ?? 0)} by {wo.createdBy}{wo.caller ? ` · called in by ${wo.caller}` : ''}</div>
      {!readOnly && (
        <div className="form-row" style={{ marginTop: 6, flexWrap: 'wrap' }}>
          <select value={status} onChange={ev => setStatus(ev.target.value as WoStatus)}>{STATUSES.map(s => <option key={s}>{s}</option>)}</select>
          <select value={pri} onChange={ev => setPri(ev.target.value as WoPriority)}>{PRI.map(s => <option key={s}>{s}</option>)}</select>
          <select value={asg} onChange={ev => setAsg(ev.target.value)}><option value="">— unassigned —</option>{units.map(u => <option key={u.id} value={u.id}>{u.crew} · {u.status}</option>)}</select>
          <input placeholder="note (optional)" value={note} onChange={ev => setNote(ev.target.value)} style={{ flex: 1, minWidth: 120 }} />
          <button className="btn pri" onClick={save}>Save</button>
        </div>
      )}
      <div className="wo-hist">{[...(wo.history ?? [])].reverse().map((h, i) => <div key={i}><span className="mono dim">{e.hhmm(h.t)}</span> <span className="dim">{h.by}</span> — {h.text}</div>)}</div>
    </div>
  );
}

export function WoForm({ onDone }: { onDone(id: string | null): void }) {
  const { e, flash, woDraft, ptt } = useCtx();
  const units = Object.values(e.s.trucks).sort((a, b) => a.crew.localeCompare(b.crew));
  const items = useMemo(() => itemsList(), []);
  const [heard, setHeard] = useState('');
  const [itemText, setItemText] = useState('');
  const [issue, setIssue] = useState('');
  const [pri, setPri] = useState<WoPriority>('Routine');
  const [asg, setAsg] = useState('');
  const [caller, setCaller] = useState('');
  const [note, setNote] = useState('');
  const [source, setSource] = useState<'radio' | 'typed'>('typed');
  const fill = (text: string) => {
    const r = parseCall(text, items, units.map(u => ({ id: u.id, crew: u.crew })));
    if (r.itemText) setItemText(r.item ? label(r.item) : r.itemText);
    setIssue(r.issue); setPri(r.priority);
    if (r.assignee) setAsg(r.assignee);
    if (r.caller) setCaller(r.caller);
    setNote(r.notes.join(' '));
    setSource('radio');
  };
  useEffect(() => {
    if (!woDraft) return;
    setHeard(woDraft.text ?? '');
    const it = itemById(woDraft.item);
    setItemText(it ? label(it) : ''); setIssue(''); setPri(woDraft.priority ?? 'Routine'); setAsg(woDraft.assignee ?? ''); setCaller(woDraft.caller ?? ''); setNote(''); setSource(woDraft.source ?? 'typed');
    if (woDraft.text) fill(woDraft.text);
    if (woDraft.item && woDraft.text) setItemText(it ? label(it) : '');
  }, [woDraft?.n]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = () => {
    if (!issue.trim()) { flash('Issue is required', 'warn'); return; }
    const it = itemText.trim() ? itemByLabel(itemText) : undefined;
    if (itemText.trim() && !it && !confirm(`"${itemText}" isn't a single item on the map. Save it as a text location?`)) return;
    const r = e.liveWoCreate({
      issue, priority: pri, item: it?.id ?? null, pos: it ? itemPos(it) : null, loc: it ? label(it) : itemText.trim() || undefined,
      assignee: asg, caller, by: ACCESS.name || 'Operator', source,
    });
    if (!r || !r.startsWith('WO-')) { flash(r ?? 'Not saved', 'warn'); return; }
    flash(`${r} created${it ? ' — ' + label(it) : ''}`, 'good');
    setHeard(''); setItemText(''); setIssue(''); setPri('Routine'); setAsg(''); setCaller(''); setNote(''); setSource('typed');
    onDone(r);
  };
  return (
    <div className="wo-form" style={{ padding: 8 }}>
      <label>What was said (radio call) — optional</label>
      <div className="form-row">
        <textarea value={heard} onChange={ev => setHeard(ev.target.value)} placeholder='e.g. "This is Mike, NLC 12 has a cracked crossarm, urgent, send Andrew"' style={{ flex: 1 }} />
      </div>
      <div className="form-row" style={{ marginTop: 3 }}>
        <button className="btn" disabled={!heard.trim()} onClick={() => fill(heard)}>⤵ Fill from call</button>
        {ptt.supported && <span className="dim" style={{ fontSize: 10.5 }}>or hold <b>Space</b> / HOLD TO TALK in M4 — the words land here.</span>}
      </div>
      <div className="parsenote">{note}</div>
      <div className="row2">
        <div><label>Pole / item</label><input list="yard-items" value={itemText} onChange={ev => setItemText(ev.target.value)} placeholder="NLC-12 (blank = no pole)" autoCapitalize="characters" /></div>
        <div><label>Called in by</label><input list="unit-names" value={caller} onChange={ev => setCaller(ev.target.value)} placeholder="who radioed it" /></div>
      </div>
      <label>Issue</label>
      <textarea value={issue} onChange={ev => setIssue(ev.target.value)} placeholder="Cracked crossarm, south side" />
      <div className="row2">
        <div><label>Priority</label>
          <div className="form-row">{PRI.map(p => <button key={p} className={`btn sm ${pri === p ? (p === 'Emergency' ? 'danger on' : p === 'Urgent' ? 'warn on' : 'on') : ''}`} onClick={() => setPri(p)}>{p}</button>)}</div>
        </div>
        <div><label>Assign to</label>
          <select value={asg} onChange={ev => setAsg(ev.target.value)}><option value="">— unassigned —</option>{units.map(u => <option key={u.id} value={u.id}>{u.crew} · {u.status}</option>)}</select>
        </div>
      </div>
      <div className="form-row" style={{ marginTop: 8 }}>
        <button className="btn pri" onClick={save}>Save work order</button>
        <button className="btn" onClick={() => onDone(null)}>Cancel</button>
        {!units.length && <span className="c-amber" style={{ fontSize: 10.5 }}>Add instructors on the M5 Roster tab to assign orders.</span>}
      </div>
      <datalist id="yard-items">{items.map(i => <option key={i.id} value={label(i)}>{i.itemType ?? 'pole'}</option>)}</datalist>
      <datalist id="unit-names">{units.map(u => <option key={u.id} value={u.crew} />)}</datalist>
    </div>
  );
}

export function printWo(e: any, wo: WorkOrder) {
  const esc = (s: string) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
  const asg = wo.truck ? (e.s.trucks[wo.truck]?.crew ?? wo.truck) : '—';
  const rows: [string, string][] = [['Work Order', wo.id], ['Pole / Item', wo.loc], ['Priority', wo.priority ?? 'Routine'], ['Status', wo.status], ['Assigned To', asg], ['Called In By', wo.caller || '—'], ['Opened', `${e.hhmm(wo.createdT ?? 0)} ${e.clock(wo.createdT ?? 0).toLocaleDateString()} by ${wo.createdBy}`], ['GPS', `${wo.pos[0].toFixed(6)}, ${wo.pos[1].toFixed(6)}`]];
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>${esc(wo.id)}</title><style>body{font-family:Arial,sans-serif;margin:28px;color:#111}h1{margin:0 0 4px;font-size:22px}.sub{color:#555;font-size:12px;margin-bottom:16px}table{width:100%;border-collapse:collapse;margin-bottom:16px}td{border:1px solid #999;padding:8px;font-size:14px}td:first-child{width:28%;font-weight:bold;background:#f2f2f2}.box{border:1px solid #999;padding:10px;min-height:60px;font-size:14px;white-space:pre-wrap;margin-bottom:16px}h3{font-size:14px;margin:12px 0 6px}.h div{font-size:12px;margin-bottom:4px}</style></head><body>
<h1>NLC Campus Ops — Work Order</h1><div class="sub">Printed ${esc(new Date().toLocaleString())}</div>
<table>${rows.map(r => `<tr><td>${esc(r[0])}</td><td>${esc(r[1])}</td></tr>`).join('')}</table>
<h3>Issue</h3><div class="box">${esc(wo.issue ?? wo.type)}</div><h3>Work performed / notes</h3><div class="box" style="min-height:120px"></div><h3>Completed by / date</h3><div class="box" style="min-height:30px"></div>
<h3>History</h3><div class="h">${(wo.history ?? []).map(h => `<div>${esc(e.hhmm(h.t))} — ${esc(h.by)}: ${esc(h.text)}</div>`).join('')}</div>
<script>window.onload=()=>setTimeout(()=>window.print(),250)<\/script></body></html>`;
  const w = window.open('', '_blank'); if (!w) return; w.document.write(html); w.document.close();
}
