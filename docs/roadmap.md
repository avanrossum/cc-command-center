# Claude Command Center — Roadmap

Riskiest-first. The two biggest unknowns (does the Claude TUI render cleanly through our terminal host, and does the state engine produce correct coarse status on real sessions without a daemon) are proven before any app scaffolding is built. Each phase lists a goal, concrete deliverables, and a definition of done. A detailed v0 task checklist follows the phase list.

---

## Phase 0 — Terminal-host spike (riskiest unknown first)

**Goal.** Prove one live `claude` session renders cleanly in `@xterm/xterm` 6.0.0 (WebGL) over `node-pty`, with the resize→`SIGWINCH` contract, before building anything else. If this fails, the whole architecture assumption is wrong, and it should fail on day one, not in week six.

**Deliverables.**
- A throwaway single-window Electron 42.x app.
- `@xterm/xterm` 6.0.0 + `@xterm/addon-webgl` 0.19.0 + `@xterm/addon-fit` 0.11.0 in the renderer.
- `node-pty` 1.1.0 in the main process spawning a real `claude` with `TERM=xterm-256color`.
- On every `FitAddon` fit, compute cols/rows and call `pty.resize()` (raises `SIGWINCH`).
- `node-pty` rebuilt via `@electron/rebuild` against Electron 42.x.
- In the same spike: spawn one `claude` with our `@modelcontextprotocol/sdk` 1.29.0 channel server + `--dangerously-load-development-channels`, and prove an inbound notification lands in-session and `cc_ack` round-trips (this directly tests bug #71792).

**Definition of done.**
- The Claude Code TUI renders with no scroll or garble: spinner animates correctly, alt-screen works, and a window resize reflows cleanly (cols/rows recomputed, `SIGWINCH` delivered).
- `@electron/rebuild` produces a loadable `node-pty` for Electron 42.x, and the app launches without an ABI error.
- Channels verdict recorded: either an inbound notification demonstrably lands in-session and `cc_ack` round-trips, or #71792 blocks it and v1 ships on send-keys. This decision is written down before Phase 5.

---

## Phase 1 — State-engine truth on live data

**Goal.** Prove coarse WORKING / WAITING / IDLE / STUCK is correct on the ~19 real sessions on this machine, for both a tool-launched session (hooks fire) and an adopted session (transcript-only). This validates that adoption works without a daemon — the core bet.

**Deliverables.**
- The transcript-tail watcher: `chokidar` v4, `~/.claude/projects`, `depth:2`, 150 ms per-file debounce, read last 64 KB, per-line try/catch, backward-scan to the last real conversation record, skip `isSidechain:true`, mtime staleness clock.
- The unix-socket hook endpoint (`~/.claude/ccc/engine.sock`) and the fail-open disk-spool shim `ccc-emit.sh` (200 ms budget, `exit 0` fast, spool to `~/.claude/ccc/events/<sid>.ndjson`, drain on start).
- The fusion core (hooks own the WORKING rising edge with an 8000 ms hold; transcript owns the falling edge; precedence WAITING_PERMISSION > WAITING_INPUT > WORKING > IDLE) and the STUCK watchdog (1 s tick, `STUCK_MS=30000`, mtime-stale + no Stop).
- The cache scanner with the `ps -p <pid> -o comm=` PID-reuse guard and the args-regex claude matcher.

**Definition of done.**
- Run against the live ~19 sessions: the reported coarse state matches ground truth for a spot-checked sample spanning tool-launched and adopted sessions.
- A working-edge from a tool-launched session appears in < 100 ms; a transcript falling edge appears within ~0.5 s; a synthetically stalled session reads STUCK within `STUCK_MS` + 1 s.
- Killing the engine and firing a hook loses no event: the spool file holds it and the engine drains it on next start.
- No transcript-parser exception takes the board dark; a forced parse failure degrades one node to UNKNOWN (mtime-only) and the rest stay live.

---

## Phase 2 — Registry foundation

**Goal.** Persist everything through one schema. Everything downstream depends on it.

**Deliverables.**
- `better-sqlite3` 12.x WAL database in `userData` with the PRAGMAs.
- Tables: `session`, `edge`, `category`, `handoff_note`, `scrollback_snapshot`, `status_event`, with the indexes.
- The node-id vs `claude_session_id` split.
- `PRAGMA user_version` migration runner (ordered steps).
- Single-writer rule enforced (main process only).
- `better-sqlite3` added to the `@electron/rebuild` step.

**Definition of done.**
- Schema creates from empty, and a migration step bumps `user_version` and runs exactly once.
- A round-trip test writes and reads back a node, a typed edge, a category, and a scrollback blob.
- The partial unique index on `edge.child_id` rejects a second parent for a child.
- The status-board query (`WHERE category_id = ? AND last_status = ?`) uses the index.

---

## Phase 3 — Adoption pipeline

**Goal.** Make the ~19 appear. Highest user-visible value, and it exercises the no-daemon adoption path end to end.

**Deliverables.**
- `ps` discovery with the args regex, Electron-helper exclusion, and the `procStart`/`lstart` PID-reuse guard.
- `sessions/<pid>.json` reconciliation into cache∩process / process-only / stale-cache buckets.
- Transcript self-identification (`sessionId`, `cwd`, `version` from inline records) when the cache is missing.
- Degraded-mode adopted nodes created parentless/category-less in a holding zone.
- A periodic rescan while the app is open (catches sessions started in iTerm meanwhile).
- Category assignment (required) and optional parent/edge assignment after the fact.

**Definition of done.**
- On launch, the ~19 live sessions appear as adopted nodes with correct `cwd`, `claude_session_id`, and coarse status.
- A session started in iTerm while the app is open appears on the next rescan without a restart.
- A stale `<pid>.json` for a dead PID does not create a phantom node (PID-reuse guard rejects it).
- Each adopted node is marked `origin='adopted'`, `send_capability='external-degraded'`, and sits in the holding zone until categorized.

---

## Phase 4 — Resume, scrollback snapshot, and reconnect

**Goal.** Prove requirement 5 and the spool-drain path: close the app and reopen to the same layout, tree, and repainted panes.

**Model refinement (2026-07-08, roadmap — not yet built).** Distinguish a session that was still *open* at quit from one the user *exited*:
- **Open** (not exited, not removed) → the app **auto-resumes** its terminal on next launch (all previously-open sessions, not just the last-active one), and tracks a `last_interacted` timestamp (real user input/focus, distinct from the last file-scan time) so "how long since I actually touched this" is truthful.
- **Exited** (the terminal was closed / `/exit`) or **removed** → marked *dead* → enters the **7-day dormant decay** (resumable on click, but not auto-resumed).
Today only the *last-active* session auto-restores and every not-live node is treated identically as dormant; this refinement separates "carry my workspace back" from "let old sessions fade."

**Deliverables.**
- Scrollback capture via `@xterm/addon-serialize` (1000-line cap), captured on idle-debounce and on quit, stored in `scrollback_snapshot`.
- Reconcile-then-relaunch: attach if the PID is still alive after a mere app-restart; otherwise `claude --resume <claude_session_id>`.
- Layout/tree/category rebuild from the registry; xterm + PTY instantiated only for visible panes (WebGL cap).
- Static snapshot painted into each visible pane before the resumed claude repaints its alt-screen.
- Deleted/corrupt-transcript recovery: `stat` pre-check, keep node + snapshot, null `claude_session_id`, one-click "start fresh here."

**Definition of done.**
- Quit and relaunch: the tree, categories, layout, and per-pane scrollback snapshot are restored, and each node resumes via `claude --resume` (or attaches if the PID survived an app-only restart).
- A node whose transcript was deleted keeps its snapshot and layout and offers "start fresh here," binding a new claude session to the same node id.
- The spool drains on this launch and no hook events are lost across the close/open cycle.

---

## Phase 5 — Managed-launch and cross-session send

**Sequencing (2026-07-08).** The managed-launch half is largely done (＋New session, spawn-child with typed edge + handoff note, resume). The **cross-session send half is deferred to AFTER Phase 6** (UI shell + the Claude Design ui-kit lands first), per the user. When it resumes, the send surfaces are already designed (README "Planned surfaces": inject / broadcast / copy / handoff with `◷ queued` / `✓ delivered` / `⚠ failed`).

**Goal.** Spawn under management, wire the channel path, and ship a verified send with a fallback.

**Deliverables.**
- The managed-launch path shared by spawn / resume / adopt-restart: the additive `settings.json` hook merge (backup + atomic rename + `ccc-emit.sh` idempotency tag), plus a per-session Channels server on a token-gated unix socket (`CC_CHANNEL_SOCKET`, `CC_CHANNEL_TOKEN`, `0600`).
- The tiered `send()` dispatcher on `send_capability`: Channels primary with `cc_ack` round-trip, send-keys inject-then-verify fallback.
- BROADCAST across many targets (queues per Channels contract; "queued" vs "delivered" surfaced).
- COPY (read out via xterm buffer / `capture-pane`) and SHARE (handoff file + delivered reference).
- The one-way tier gate surfaced in the UI (Tier C/B → A needs relaunch); one-click "restart under management."
- In-tool spawn captures the typed edge exactly (`source='inferred'`, `type` by which button) and optionally pre-seeds a `handoff_note` delivered at child launch, marked `delivered` only after confirmation.

**Definition of done.**
- A tool-spawned session receives an injected prompt over Channels and `cc_ack` confirms receipt; a broadcast reaches multiple targets and each is marked queued/delivered.
- A `pty-sendkeys` target receives an injected prompt and inject-then-verify confirms the text landed; a failed verify surfaces plainly and does not silently no-op.
- The hook merge leaves the user's existing `dirty-tree-guard`, `usage-governor`, statusline, and `mcpServers` intact; re-install replaces only our tagged groups.
- A `restart-under-management` on an adopted node upgrades it from `external-degraded` to `channel` with history preserved.

---

## Phase 6 — UI shell and navigation

**Goal.** The full four-region interface with keyboard-first navigation.

**Deliverables.**
- The React 19 / Zustand shell.
- The beacon bar: global cross-category board (counts + a live list of every waiting/stuck node anywhere), always visible, never scrolls away.
- The category rail: hard-separated collections, one icon each, per-category waiting pip; selecting one swaps the tree + terminal below without changing the beacon bar.
- The indented task tree with typed-edge rendering (solid amber `├─●` blocking, dotted slate `└╌○` tangential), the blocked-parent banner ("⛔ sf-sync blocked, waiting on → schema-fix"), collapse/expand with worst-descendant status roll-up, persisted collapse state.
- Keyboard-first navigation (jump to next waiting, focus pane, palette), then drag-to-reparent (drop onto body → blocking child; drop between → tangential).
- The WebGL visible-only render budget enforced in the UI (instantiate visible panes only).

**Definition of done.**
- A waiting session in a non-focused category is visible in the beacon bar without switching categories.
- Categories never bleed: switching the rail swaps tree + terminal but not the beacon bar.
- Blocking vs tangential edges are visually distinct; a blocked parent shows the banner and its status reads `blocked`, not `idle`.
- Keyboard nav reaches every node and the "jump next waiting" affordance works; drag-to-reparent sets the correct edge type by drop position and updates the registry.
- With 19+ nodes, only visible panes hold WebGL contexts and the app stays within the ~16-context cap.

---

## Phase 7 — Precision status add-ons (M2)

**Goal.** Split `WAITING_PERMISSION` out of `WAITING`, and add confirm-only out-of-tool parent inference. Additive, no state-machine rewrite.

**Deliverables.**
- `WAITING_PERMISSION` split from `WAITING` via `Notification:permission_prompt` fast edges plus an on-demand PTY-scrape tie-breaker.
- A versioned config for the M2 PTY-scrape pattern table (permission-dialog / elicitation glyphs), captured from real dialogs across the 2.1.x spread.
- Out-of-tool ppid-chain parent inference surfaced as confirm-only suggestions (never auto-applied).
- **Beacon "NEEDS YOU" triage (user, 2026-07-09).** The beacon flag must be high-signal, not "any idle session." A session blocked on a **permission prompt** (`WAITING_PERMISSION`, e.g. the "allow Claude to edit its own settings" gate) or a genuine question (`WAITING_INPUT`) = **needs you**. A child that just **replied to its parent and went idle**, or is merely idle/working, does **not**. This is the mechanistic version; the control agent (Future) can layer smarter triage on top, consuming the same signal.

**Definition of done.**
- A session blocked on a permission dialog reads `WAITING_PERMISSION`, distinct from `WAITING_INPUT` and `IDLE`.
- The PTY-scrape pattern table is version-gated and degrades to coarse `WAITING` when a glyph is unrecognized.
- A child launched from within another session outside the tool produces a confirm-only parent suggestion the user can accept or dismiss.

---

## Phase 8 — Polish and hardening

**Goal.** Make it a daily driver.

**Deliverables.**
- Login-item registration via `SMAppService`.
- Startup ABI self-check with a clear remediation message.
- **Auto-updater** — `electron-updater` (or Electron `autoUpdater`) against signed/notarized release artifacts, wired to the "Check for Updates…" menu item (currently a disabled placeholder) and a background update check. Requires code signing + notarization and a release-artifact host (GitHub Releases on the private repo, or an S3/generic feed). The versioning system (`gen-version.mjs` / `bump.mjs` / git tags, shipped pre-Phase-8) already produces the `MAJOR.MINOR.PATCH-<hash>` build identity the updater compares against.
- Broadcast/handoff audit surfaces (delivered/undelivered), COPY/SHARE ergonomics.
- Performance pass at 19+ nodes: memory, WebGL context churn, DB write cadence.
- Error surfaces for degraded sessions, unreachable send targets, and format-drift UNKNOWN nodes.

**Definition of done.**
- The app registers as a Login Item and relaunches cleanly to the restored layout after a reboot.
- A native-module ABI mismatch produces a readable remediation message rather than a silent crash.
- The app checks for updates, surfaces an available update, and applies it on relaunch against a signed/notarized artifact; the "Check for Updates…" menu item is live.
- At 19+ nodes the app stays responsive and within the WebGL context cap, and no send silently no-ops.

---

## Phase 9 — Agent-to-agent messaging (the no-skills message bus)

**Goal.** Let a parent and child session *talk* to each other autonomously, without installing any skill, MCP server, or Channels dependency into the sessions. The command center is the bus: it already reads every session (transcript tail) and can write to any managed session (send-keys), and the typed edge graph is the address book. Sessions use only their native capabilities (produce text, write files, receive input) plus a convention delivered as text.

**Deliverables.**
- A transport for a session to express send-intent, chosen skill-free: a **filesystem mailbox** (managed launch sets `CC_OUTBOX`/`CC_INBOX`/`CC_PEER`; the session writes with its normal Write/Bash; the app watches the file) — with a lightweight transcript-marker convention (`@parent:` / `@child:`) as a fallback/interim.
- A router that resolves `parent`/`child`/named targets via the edge graph and moves the payload.
- **State-aware delivery**: hold a message and inject it as a new turn only when the target is at `WAITING`/`IDLE` (uses the existing state engine), never mid-work.
- The convention taught via the spawn preamble / handoff note (not a skill) — one-time instruction text.
- Safety: a **human-approve-before-send gate** by default (surfaced as queued/delivered/failed), a **hop-count loop guard**, and an opt-in fully-autonomous mode once trusted.

**Definition of done.**
- A child writes to its outbox; the parent receives it as an injected turn when the parent is next idle/waiting, with no skill or MCP installed in either session.
- A parent→child→parent exchange terminates (loop guard) and every hop shows queued/delivered/failed.
- Messaging is confined to sessions the app manages the PTY for; an unmanaged (raw iTerm) session is read-only until resumed under management, and that limitation is surfaced.

---

## Phase 10 — Hierarchy model v2 (tangent decoupling + context extraction)

**Goal.** The two edge types are not symmetric; make the model reflect that.

- **Blocking child** — a hard edge, part of the parent's tree. DONE (pre-Phase-10): category is derived from the parent (blocking chain → root); a blocking child can't be independently categorized; categorizing a parent carries its blocking subtree.
- **Tangential offshoot** — should NOT be a hard tree edge. It's an independent "spawned new idea": free to sit in any category, and it should not render *under* the parent as if it belongs to that tree. Replace the hard `edge` row for tangents with a **soft provenance link** ("spawned from X") that's informational only — surfaced if useful, but never gating or grouping. A blocking child rolls its parent back; a tangent never does and never inherits.
- **Context without the transcript (the hard part).** A tangent must be pre-seeded with the *necessary* context from its spawner **without shipping the entire transcript.** Options to evaluate: an LLM-generated summary of the relevant slice, the parent authoring a short brief at spawn, a selected set of transcript records, or a retrieval step. This is the same primitive the handoff-note field wants and it feeds the Phase 9 messaging bus — solve it once.

**Definition of done.**
- Tangential offshoots are independent nodes (own category, not rendered inside the parent's blocking tree) with an optional soft "spawned from" provenance.
- Spawning a tangent (or a child with a handoff note) carries a bounded, relevant context payload — never the full transcript — and the mechanism is shared with cross-session send.

---

## Future direction (discussion, not scheduled) — Control agent (fleet conductor)

**Idea (user, 2026-07-08).** Wire a **control agent** into the app itself — an agent that can help make decisions, read the output of sessions, act as an arbiter / control surface for the whole fleet. It's "the bus, with a brain": the apex of the awareness work, driving the same primitives (read any session's transcript, inject into any managed session, route by the edge graph, query state, spawn/resume) that Phases 5/9 expose.

**What it could do.** Triage the beacon bar ("who actually needs you, and why"), arbitrate/route messages between sessions, perform the Phase-10 context extraction (read a parent's transcript → produce the bounded brief for a tangent), summarize long-running sessions, and be a single natural-language control surface ("resume the schema-fix and tell it the migration path changed").

**Hard requirement — transparency (the user flagged this).** The control agent's activity MUST be viewable: it lives as its own **visible** session (terminal + transcript) plus an **activity log of every tool-call/action it takes**, never a hidden actor. This is both the trust story and the acceptable-use story — human-viewable, human-approvable (an approve-gate on consequential actions), no covert automation, no rate-limit end-run.

**It's a control surface, not a chat partner (user, 2026-07-08).** The user should be **discouraged, or outright prevented, from conversing with the control agent directly.** Interaction is by *directing and approving its actions on the fleet* — not a freeform chat box. This keeps it from degrading into an unmonitored "shadow assistant" the user offloads general work to (which would undercut the transparency/AUP story and blur it with just another session). The user talks to their *sessions*; the control agent is infrastructure that helps orchestrate them, surfaced and gated, not a Claude you chat with.

**How it wires in.** The app exposes its fleet primitives to the agent as tools (an MCP surface or the app's own tool API): `list_sessions` / `read_session` / `send_to_session` / `spawn` / `set_edge` / `get_status`. Same capabilities the UI uses, so the agent can only do what a user could do here — and every action is surfaced. Depends on Phases 5 + 9 being solid first (reliable send + read + routing).

**Not-a-harness structuring (user flagged 2026-07-09; must get right).** Anthropic is cracking down on automated harnesses that drive Claude Code CLI headlessly to bypass API metering. The control agent must be clearly on the right side of that line:
- It is a **real, interactive, supervised session the human is present for** — surfaced prominently, transcript + action log always viewable — NOT a headless background loop that runs the fleet while the human is away. Human-in-the-loop is exactly what separates a legitimate operator tool from a prohibited harness.
- It should **pause when unattended** and require the human present for consequential actions (the approve-gate). No covert, always-on autonomous operation.
- Model: **Haiku** for the conductor/triage role (cheap, fast classification), but the legitimacy comes from supervision + transparency, not the tier.
- **Triage-first (answers the Phase-7 beacon-bar noise).** Its first job is attention-routing: watch session states + the ✉ log and classify who *genuinely* needs the human — blocked on a **permission prompt** = yes; **replied and went idle** = no. Assists the human's oversight, doesn't replace it. Safe first slice, directly reduces flag noise.
- Uses the same read/drop/inject primitives as the human, transparently — a co-pilot for the middle seat (`docs/concepts.md`). The model breaks the moment the human leaves the middle.

## Fleet activity view — workflows / subagents / loops (user, 2026-07-09)

**Goal.** With several working sessions, background activity (subagents, workflows, loops, long tool runs) gets out of hand fast. A view — reachable from the rail/sidebar — showing, across ALL sessions, what's running and its status.

**Approach.** Same no-daemon file-scan the state engine uses, extended to `~/.claude/projects/*/` subagent/task artifacts + workflow journals (they carry per-agent progress). Aggregate into a live list grouped by session: spawned / running / done / stalled. This is `open-questions.md` Q2 promoted to a build item — it pairs with Phase 7 and the control agent (which would consume the same signal). Slot alongside Phase 7/8 for pre-share readiness.

---

## v0 task breakdown (Phase 0 + first usable milestone)

v0 = Phase 0 spike proven, then the smallest usable app: adopted sessions visible with correct coarse status, resumable on restart. This spans Phase 0 through Phase 4 with a minimal read-only UI.

### Phase 0 — terminal-host + Channels spike

- [ ] Scaffold a throwaway Electron 42.x app (main + renderer, TypeScript).
- [ ] Add `@xterm/xterm` 6.0.0, `@xterm/addon-webgl` 0.19.0, `@xterm/addon-fit` 0.11.0 in the renderer; activate the WebGL renderer.
- [ ] Add `node-pty` 1.1.0 in the main process; wire `@electron/rebuild` and rebuild against Electron 42.x.
- [ ] Stream PTY bytes main→renderer and keystrokes renderer→main over IPC.
- [ ] Spawn a real `claude` with `TERM=xterm-256color`.
- [ ] On every `FitAddon` fit, compute cols/rows and call `pty.resize()`; confirm `SIGWINCH` reaches the child.
- [ ] Verify the TUI renders with no scroll/garble: spinner, alt-screen, resize reflow.
- [ ] Build `cc-channel.mjs` with `@modelcontextprotocol/sdk` 1.29.0, `capabilities.experimental['claude/channel']` and a `cc_ack` tool.
- [ ] Spawn one `claude` with the channel server + `--dangerously-load-development-channels`; POST a notification and confirm it lands in-session and `cc_ack` round-trips.
- [ ] Record the Channels verdict (works / blocked by #71792 → v1 on send-keys).

### Phase 1 — state engine on live data

- [ ] Implement the transcript-tail watcher (chokidar v4, depth:2, 150 ms debounce, last 64 KB, per-line try/catch, backward-scan to last real record, skip `isSidechain`).
- [ ] Implement the derived-state parse (`stop_reason` → working/waiting/done; `AskUserQuestion` tool_use → waiting).
- [ ] Stand up the unix-socket hook endpoint at `~/.claude/ccc/engine.sock`.
- [ ] Write `ccc-emit.sh` (fail-open, 200 ms budget, `exit 0` fast, spool to `~/.claude/ccc/events/<sid>.ndjson`); drain + truncate spool on start.
- [ ] Implement the fusion core (WORKING rising edge from hooks, 8000 ms hold; transcript falling edge; precedence order).
- [ ] Implement the STUCK watchdog (1 s tick, `STUCK_MS=30000`, mtime-stale + no Stop).
- [ ] Implement the cache scanner (2 s poll) with the `ps -p <pid> -o comm=` PID-reuse guard and the args-regex matcher.
- [ ] Validate coarse states against the live ~19 (tool-launched + adopted spot-check).

### Phase 2 — registry

- [ ] Create the WAL DB in `userData` with PRAGMAs.
- [ ] Create `session`, `edge`, `category`, `handoff_note`, `scrollback_snapshot`, `status_event` + indexes.
- [ ] Implement the `PRAGMA user_version` migration runner.
- [ ] Enforce the single-writer rule and the partial unique index on `edge.child_id`.
- [ ] Add `better-sqlite3` to the `@electron/rebuild` step.
- [ ] Round-trip test: node, typed edge, category, scrollback blob.

### Phase 3 — adoption

- [ ] Implement `ps` discovery with the args regex, Electron-helper exclusion, and `procStart`/`lstart` guard.
- [ ] Reconcile against `sessions/<pid>.json` into the three buckets.
- [ ] Resolve identity from the self-identifying transcript when the cache is missing.
- [ ] Create adopted nodes parentless/category-less in the holding zone (`origin='adopted'`, `send_capability='external-degraded'`).
- [ ] Add the periodic rescan while open.
- [ ] Wire category assignment (required) and optional parent/edge assignment.
- [ ] Verify the ~19 appear on launch; verify an iTerm-started session appears on rescan; verify a stale-PID phantom is rejected.

### Phase 4 — resume + minimal UI

- [ ] Capture scrollback via `@xterm/addon-serialize` (1000-line cap) on idle-debounce and on quit into `scrollback_snapshot`.
- [ ] Implement reconcile-then-relaunch (attach if PID alive after app-only restart; else `claude --resume`).
- [ ] Rebuild layout/tree/category from the registry; instantiate xterm + PTY for visible panes only.
- [ ] Paint the static snapshot before the resumed claude repaints its alt-screen.
- [ ] Implement deleted/corrupt-transcript recovery (`stat` pre-check, keep node + snapshot, null `claude_session_id`, "start fresh here").
- [ ] Build the minimal read-only UI: category rail + indented tree + coarse status badges + one focused terminal pane.
- [ ] Verify quit/relaunch restores tree, categories, layout, snapshots, and resumes each node; verify the spool drains with no lost events.

**v0 definition of done.** The app launches, adopts the ~19 live sessions with correct coarse status (no daemon), shows them in a category rail + indented tree with a focused terminal pane, and on quit/relaunch restores the layout and resumes each node via `claude --resume` (or attaches a surviving PID), losing no hook events across the cycle. The Phase 0 Channels verdict is recorded and the send transport for v1 is chosen accordingly.
