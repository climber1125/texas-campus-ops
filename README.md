# NLC Campus Ops

Live system operations for the NLC Texas campus. Same look and screens as GRID OPS (GIS map, one-line, switching & clearances, work orders, radio log, unit board, alarms, status wall, multi-monitor), built on the real Pole Yard inventory.

- **Nothing on the yard is energized.** "In service / out of service" is the training model: open a device and everything past it shows out of service, exactly like GRID OPS.
- **Real people, real radios.** Nothing is simulated. The operator records what instructors report.
- **GRID OPS is separate** (`climber1125/grid-ops`) and unchanged. **Pole Yard is separate** (`poleyard.netlify.app`) and unchanged. This app only reads it.

## Access

| Code (Netlify env var) | Screen | Can do |
|---|---|---|
| `ADMIN_KEY` | **Operator** | Everything: network, work orders, device records, clearances, switching, roster |
| `CREW_KEY` | **Staff** | Same screens, view only, updates every 4 s |
| none | Sign-in screen only | — |

If **neither** variable is set, everyone is operator. Set both (mark them secret, scope must include Functions), then redeploy.

Only **one operator console** runs the desk at a time. A second operator device opens as **FOLLOWING** (view only) with a **Take over here** button. Linked monitor windows on the same computer are part of the same desk.

## First-time setup

1. Netlify → site `texascampusops` → Environment variables: `ADMIN_KEY`, `CREW_KEY` (optional `POLE_SOURCE_URL`, default `https://poleyard.netlify.app`). Trigger a deploy.
2. Sign in with the operator code.
3. **Edit network** (top bar). The lines start as an auto-draft from the Pole Yard map. Fix them:
   - Click an item, then the next item → adds a span. Keep clicking to run a row. Click the far end of an existing span → removes it. `Esc` stops.
   - Click a span → put a **switch / fuse / recloser** on it, pick which end, give it an ID, mark it normally open.
   - **Set source** → click the riser/pole the yard is fed from. Each span leaving the source becomes a circuit with its own breaker (CB-1, CB-2…).
   - A span that closes a loop becomes a normally-open tie automatically.
   - **Save & apply** reloads every screen with the new network.
4. **M5 → Roster**: add the instructors working today.

## Running the desk

- **Radio call → work order:** hold **Space** (or HOLD TO TALK) and repeat the call, or type it. Pick who called (Heard from). **→ Work order** fills pole, issue, priority, assignee and caller ("This is Mike, NLC 12 has a cracked crossarm, urgent, send Andrew"). Check the amber note, then save.
- **Work orders (M3):** Open / Closed / ＋ New. Click one for status, priority, reassign, notes, print and history. Clicking a pole on the map → **＋ Work order here**.
- **Instructors:** click a name (map or M5) → set status as reported (En Route, On Scene, Working…), assign an order.
- **Devices:** click a device → **Record OPEN / CLOSE** (select-before-operate, pick who reported it). Breakers/reclosers can be locked out.
- **Clearances:** select a device, span or pole → *Clearance on this section* → issue to an instructor. All boundaries must be open; HOLD tags go on. Release under Switching → **Released by holder**.
- **Switching orders:** write steps (device, open/close, who), approve, **Issued on the radio** → confirm their repeat-back → **Reported complete** when they report it done.
- **Emergency:** declare emergency traffic, log 911, open an EMERGENCY work order. The app does not call anyone.
- **Monitors:** same multi-window war-room setup as GRID OPS (status wall, map, one-line, ops desk).

## Data

- Poles: live from Pole Yard through `/api/poles` (last good copy is cached if Pole Yard is down). Edit poles in Pole Yard; reload Campus Ops to pick them up.
- Network, ops board (work orders, roster, device states, clearances, logs): Netlify Blobs on this site (`/api/network`, `/api/state`). The last 10 network saves are kept.
- Each browser also keeps a local backup (IndexedDB) every 30 s.

## Develop

```
npm install
npm run build          # type-check + production build into dist/
npm run campustest -- poles.json   # check the network model against a saved /api/poles file
```

```
src/sim/campus.ts      yard items + saved network → GRID OPS topology (auto-draft, circuits, devices, ties)
src/sim/engine.ts      GRID OPS engine + LIVE mode (real time, no simulated faults or crew chatter, live actions)
src/live/              access codes, startup, radio-call parser
src/ui/                GRID OPS screens; Orders.tsx (M3), Radio.tsx (M4 log), NetEditor.tsx
netlify/functions/     poles (read-only proxy + role check), network, state
```
