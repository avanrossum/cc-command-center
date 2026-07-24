# Fleet views — seeing many sessions at once

The three views for looking across the whole fleet instead of one session at a time: the full-screen Overview grid, the Activity panel, and the Timeline swimlanes.

Most of the app is built around one open session in a real terminal. The fleet views answer the questions that span sessions: what is everything doing right now, what background work is running, and how has each session's state moved over the last few minutes.

---

## Overview grid (the 50,000-foot view)

A full-screen grid of every active session across the whole fleet, each shown as a terminal thumbnail outlined in its state color. Use it to answer "what are all my Claudes doing right now" in one glance, without clicking through sessions one by one.

### Opening and closing

- **Open:** press `⌘⇧E`, or click **Show all** (the `▦` button) in the beacon bar at the top.
- **Toggle:** `⌘⇧E` and the Show all button both toggle, so the same action closes it.
- **Close:** press `Esc`, click **Close ✕** in the grid header, or click any empty area of the backdrop.

The shortcut is `⌘⇧E` specifically. `⌘E` alone is left free because it is a common global shortcut in other apps.

### What appears in the grid

The grid is fleet-wide and ignores the category you currently have selected. A session appears when it is live and either doing something or waiting on you — states `working`, `your turn`, `needs approval`, `blocked`, and `done`. "Done" only appears for a session that finished after your last-viewed watermark and that you are not currently looking at. Idle, already-seen, and dormant sessions are left out by default.

- **Show idle toggle:** the **show idle** checkbox in the header adds live-idle sessions to the grid. It is off by default and the setting is remembered. Turn it on to see the entire live fleet including sessions sitting quiet.
- **Overflow cap:** the grid shows at most 24 tiles. Any beyond that are reported as a `+N more` count in the header rather than rendered, so a busy fleet stays legible.

### Reading a tile

Each tile carries, across its top row, the session's category swatch (color plus emoji), the session name, and its current state label. The tile's outline is the state color. A session that asked you a direct question also shows a `?` badge and its label reads **Asked you** instead of the plain state.

The tile body is a terminal thumbnail. These are periodic snapshots, refreshed roughly every 1.8 seconds, not live-streaming terminals. The app streams only the one terminal you have attached; rendering many live terminals at once would stutter. The parts you triage on — the outline color and the tile's position in the sort — ride the app's 1.5-second scan and are effectively real-time. The picture itself being a second or two stale does not affect a "who needs me" glance. Because the thumbnail is raw output from a full-screen terminal UI, a frame can begin mid-sequence and look briefly imperfect.

### Sort order

Tiles sort most-urgent-first and animate to their new position when a session changes state, so the sessions that most need you settle into the top-left. The order is:

1. Needs approval (a permission gate)
2. Working
3. Asked you a direct question
4. Your turn (a soft turn-end, no explicit question)
5. Blocked (a parent waiting on an unfinished child)
6. Done

A direct question sorts ahead of a soft your-turn because it is genuinely waiting on your answer. Ties break alphabetically by name.

### Diving in

Click a tile (or press `Enter`/`Space` on a focused tile) to close the grid and drop into that live session. The app switches to the session's category and highlights its row. The grid is a launchpad back into a session, not a place you stay.

When nothing qualifies, the grid shows "Nothing active right now — every session is idle or waiting to resume."

---

## Activity panel (subagents, workflows, background tasks)

A collapsible **activity** section in the companion sidebar (the right-hand panel). It aggregates the background work each session has spawned — subagents, workflow runs, and background shell tasks — grouped by the session that owns them. Use it when several sessions are working at once and you need to know what is running underneath them, so a session that is busy running a build or a workflow does not read to you as idle.

### What it shows

- **Header rollup:** the section header summarizes the whole scope as `N running · M failed`, or `no activity`, or `idle`.
- **Per-session groups:** each owning session is a group. Active subagents show as individual rows (the live signal); finished ones collapse into an `N done` count so a 40-agent run does not flood the panel.
- **Workflows:** a running workflow shows as a row with its progress, for example `8/19`, and a `wf` badge. Finished workflows fold into the done count.
- **Source badges:** rows are tagged by where the work came from — `wf` (workflow), `sh` (shell), `bg` (background task).
- **Failed work:** shown as its own soft row for awareness. It is never treated as something you must clear.

A group with only finished or failed work lingers for about 15 minutes so a just-failed task stays visible long enough to notice, then drops. Groups with live work always show.

### Open-session priority

The session you currently have open gets its full activity ledger at the top of the panel. Every other session with background work collapses to a one-line rollup chip showing `⚙ running`, `⚠ failed`, or an `N done` count. Click a chip to switch to that session. Detail follows your attention while the rest stays a compact glance.

### Scope

The panel follows the companion sidebar's scope toggle at the top of the sidebar: **This category** limits it to the selected category, **All** shows every session in the fleet.

The open/closed state of the section is remembered across restarts.

**Caveat:** activity is detected passively from each session's transcript and a shallow scan of its working directory. It reflects what Claude Code records about the background work a session started. It reads that data rather than instrumenting the session, so what shows here depends on the transcript format Claude Code writes, which is not a public API and can change between Claude Code releases.

---

## Timeline / Strip (per-session swimlanes)

A collapsible **timeline** section in the companion sidebar. Each live session in scope gets a horizontal lane showing how its coarse state has moved over a recent window, colored by state. Use it to see at a glance how long a session has been working, when it flipped to your-turn, or how much it has been bouncing between states.

### Reading a lane

Each lane is labeled with the session name and filled with colored segments, one per state the session was in. Segment width is proportional to how long the session held that state within the window. Segments are right-aligned at the current moment, so the right edge is "now" and older history runs left. A session with little history leaves the left end of its lane empty rather than stretching to fill it.

Lanes are ordered most-urgent-first, the same order the Overview grid uses, and are capped at 24. Click a lane to open that session.

### Window

Pick the window with the `5m` / `10m` / `25m` buttons in the section header. The choice is remembered. The underlying buffer always keeps the largest window (25 minutes), so switching to a wider window reveals history already captured rather than starting from an empty left edge.

### Scope

Like the activity panel, the lanes follow the companion sidebar's scope toggle — **This category** or **All**.

**Caveat:** the timeline is built in memory from the app's 1.5-second scans and is not persisted. It records only state change-points, and it is lost on restart. When you relaunch, lanes start fresh and fill in as new scans arrive.

---

## Popping out a panel

The Timeline and Activity panels each have a pop-out control (`⇱`) that lifts the panel into a draggable floating card. A popped panel lives at the app root, so it stays visible even when you hide the companion sidebar. Its position is remembered. Use the return control on the floating card to dock it back into the sidebar.

---

## Which view for which question

| Question | View |
| --- | --- |
| What is every session doing right now? | Overview grid (`⌘⇧E`) |
| Which sessions need me, and what do they want? | The needs-you board in the companion sidebar (between Timeline and Activity) |
| Is that "quiet" session actually running a build or a workflow? | Activity panel |
| How long has this session been working / when did it flip? | Timeline |
| I hid the sidebar but want to keep watching activity | Pop out the Activity panel |

The Overview grid is fleet-wide and momentary. The Timeline and Activity panels sit in the sidebar alongside the needs-you board, scoped by the sidebar's category/all toggle, and give the recent history and the background detail that a single snapshot leaves out.

---

*macOS on Apple Silicon, active beta. The fleet views read Claude Code's transcript, session registry, and terminal output, none of which are a public API, so behavior can shift after an upstream Claude Code release.*
