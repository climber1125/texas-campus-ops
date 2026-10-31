import { readFileSync } from 'node:fs';
import { buildCampus, draftNetwork } from '../src/sim/campus';
import { solve } from '../src/sim/network';
if (!process.argv[2]) { console.log('usage: npm run campustest -- poles.json   (save https://poleyard.netlify.app/api/poles to a file first)'); process.exit(0); }
const items = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const cfg = draftNetwork(items);
console.log('links', cfg.links.length, 'source', items.find((i: any) => i.id === cfg.source)?.poleId);
const m = buildCampus(items, cfg);
const T = m.T;
console.log('nodes', Object.keys(T.nodes).length, 'els', Object.keys(T.els).length, 'devs', T.devIds.length, 'loads', T.loadIds.length, 'feeders', T.feederIds.map(f => `${f}:${T.feeders[f].sch.length}sch,${Math.round(T.feeders[f].length)}m`).join(' '));
const dev: any = {}; for (const id of T.devIds) dev[id] = { open: (T.els[id] as any).normalOpen };
const net = solve(T, dev);
const el = items.filter((i: any) => ['pole','transformer','pedestal'].includes(i.itemType));
const dead = el.filter((i: any) => !net.en.has(m.itemNode[i.id]));
console.log('energized items', el.length - dead.length, '/', el.length, 'dead', dead.map((d: any) => d.poleId).slice(0, 10), 'orphans', m.orphans.length, 'loops', net.loops.length);
// with a fuse + switch
const c2 = { ...cfg, links: cfg.links.map((l, i) => i === 5 ? { ...l, dev: { type: 'fuse' as const } } : i === 20 ? { ...l, dev: { type: 'switch' as const } } : l) };
c2.links.push({ a: items[3].id, b: items[40].id });
const m2 = buildCampus(items, c2);
console.log('with devs: switchable', m2.T.switchable.join(','), 'ties', m2.T.ties, 'laterals', Object.keys(m2.T.laterals), 'sch', m2.T.feeders['CKT-1'].sch.map(s => s.kind + ':' + s.id).join(' '));
