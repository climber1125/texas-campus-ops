# NLC Campus Ops

Live work orders for the Texas campus, built on a copy of the NLC Pole Yard app.

- **Poles are read-only here.** They load live from the original Pole Yard site (`poleyard.netlify.app`). Add, edit and test poles in the Pole Yard app; changes show up here within 2 minutes. If the Pole Yard site is down, the last good copy is used.
- **Work orders live here only.** Nothing is ever written to the Pole Yard site.

## Access codes

| Role | How | Can do |
|---|---|---|
| Viewer | just the link | See the map and pole details. No work orders. |
| Staff | ☰ → Access → `CREW_KEY` | See work orders (list, map rings, on each pole). |
| Operator | ☰ → Access → `ADMIN_KEY` | Create and update work orders, 🎙 Radio Call. |

Codes are checked on the server. **If neither code is set, everyone is operator** — set both before sharing the link.

## Setup (Netlify)

1. Add new site → Import from GitHub → `texas-campus-ops`. Leave build settings as-is.
2. Site configuration → Environment variables:
   - `ADMIN_KEY` — operator code
   - `CREW_KEY` — staff code
   - `POLE_SOURCE_URL` — optional, defaults to `https://poleyard.netlify.app`
3. Deploys → Trigger deploy (env vars only apply after a redeploy).
4. Open the site → ☰ → Access → enter the operator code. Badge reads OPERATOR.

## Operator workflow

1. Call comes in on the radio.
2. Tap **🎙 Radio Call**. The mic starts. Repeat the call (or type it): *"This is Mike, CA 14 has a cracked crossarm, urgent, assign to Andrew."*
3. Tap the mic to stop. The form fills in: pole, issue, priority, assignee, caller. Check it — the yellow note flags anything it wasn't sure about.
4. **Save Work Order.** It gets a number (WO-1001…), a ring on the map, and a history log.
5. Tap 📋 in the top bar to see open orders. Tap an order to change status, reassign, add a note, or print.

Statuses: New → Assigned → In Progress → On Hold → Complete / Canceled. Orders are never deleted; cancel them instead.

Map rings: red = Emergency, amber = Urgent, blue dashed = Routine.

## Notes

- Voice needs Chrome, Edge or Safari, mic permission, and an internet connection (Chrome sends audio to Google for speech-to-text). Typing always works.
- Staff screens refresh work orders every 15 seconds.
- Storage is Netlify Blobs, last-write-wins. With one operator this is a non-issue; if two operators edit the same order at the same moment, one edit is lost (the history shows what landed).
- The 🖨 Training Trouble Order button on a pole is the original Pole Yard print form, unchanged.

## Files

```
index.html                       the app
netlify.toml                     publish + functions folder
package.json                     @netlify/blobs
netlify/functions/poles.mjs      read-only proxy to Pole Yard + role check
netlify/functions/policies.mjs   read-only proxy to Pole Yard policies
netlify/functions/workorders.mjs work orders (create / update / history)
```
