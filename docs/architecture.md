# Claude Command Center — Architecture

A macOS desktop app for managing many concurrent interactive Claude Code CLI sessions in one contained window: live status for every session, a parent→child task tree with hard-separated categories, keyboard-first navigation, resume on restart, and cross-session send.

This document describes the chosen architecture, the components and how they communicate, the data model, the state-detection engine, the resume and adoption flows, cross-session send, pinned libraries, and the top risks. The two detailed component designs it folds in live at:

- `scratchpad/state-detection-engine.md`
- `scratchpad/registry-resume-adoption.md`

All on-disk format claims were verified against the live machine on 2026-07-07 (Claude Code 2.1.162–2.1.201 across ~19 running sessions).

---

## 1. Chosen architecture

**A monolithic, hardened Electron desktop app.** One Electron main process (TypeScript) owns everything:

- the SQLite registry (`better-sqlite3`, WAL mode);
- the `node-pty` child processes running `claude`;
- the `@xterm/xterm` renderers (in the React renderer process, fed by the main process);
- the transcript-tail watchers (`chokidar` v4);
- the `~/.claude/sessions/<pid>.json` cache scanner;
- the fusion state engine and the STUCK watchdog;
- a unix-domain-socket endpoint that receives hook events;
- the per-session MCP Channels servers used for cross-session send.

The renderer is React 19 + Zustand. The app launches at login via macOS `SMAppService` (the app itself, registered as a Login Item — not a separate daemon).

### Why this process model

The decision hinges on whether adoption of the ~19 already-live sessions requires an always-on daemon. It does not.

- Adopted sessions never had our hooks installed. Hooks bind at session start, so no `SessionStart` or working-edge hook ever fires into any listener for them, daemon or not. Their entire live-status story is the transcript-tail watcher plus the `sessions/<pid>.json` cache plus a `ps` liveness guard. All three read files that exist on disk independent of any running process. A launch-time cold scan reconstructs their full state; a periodic rescan while the app is open catches sessions the user starts in iTerm meanwhile.
- Sessions the tool launches are owned by the app's process tree, so their PTYs die when the window closes or the machine reboots (F2: no live process survives app-close or reboot on any substrate). There is nothing live for a daemon to monitor while the app is closed.

A daemon would therefore add live monitoring only for sessions that are dead whenever the app is closed, and would gain nothing for adopted sessions. Its costs are real: a second OS process, a wire protocol between UI and daemon, PTY-byte streaming over that socket, daemon supervision, an `SMAppService` daemon-approval flow macOS surfaces to the user, and a two-writer SQLite story. The daemon is rejected. Reconsider only if a future requirement demands headless monitoring with no UI ever open (server-side team status). That is not this project.

Two changes close the adoption gap without a daemon:

1. **Fail-open hook shim.** The installed shim (`ccc-emit.sh`) POSTs to the socket with a ~200 ms budget and spools the event to `~/.claude/ccc/events/<sid>.ndjson` on any failure, draining on next app start. A closed app loses no working-edges and never errors a Claude turn.
2. **Cold-scan adoption.** Adoption is a filesystem reconstruction (`ps` + `sessions/<pid>.json` + transcript-tail) run at launch and re-run on a periodic rescan while open. It needs no live listener because transcripts and the pid-cache exist on disk independent of any process.

### Why Electron over Tauri or a native fork

Both on-disk component designs assume `node-pty` and the watchers run in-process in JavaScript. Electron keeps that: one process, one language, no IPC wire protocol, no launchd plist, no second DB writer. This is the VS Code / Hyper stack, the densest-training-data path for a Claude-maintained codebase, which is the stated build priority.

Tauri would rewrite PTY handling in Rust (`portable-pty` over the v2 Channel API) and split the state engine across a JS/Rust boundary. The WebGL/xterm contract is identical either way, so Tauri buys nothing on the terminal side while adding novel surface. A native Swift/libghostty fork (cmux) or a Tauri/Rust fork (opcode/Claudia) abandons the entire `node-pty`/xterm/chokidar/`better-sqlite3` toolchain the four designs are written against, and carries GPL/AGPL copyleft onto a personal tool. Rejected on buildability and license.

---

## 2. Component overview

```
┌──────────────────────────── Electron main process (TypeScript, single OS process) ──────────────────────────┐
│                                                                                                              │
│   ┌──────────────────┐   IPC    ┌──────────────────────────────────────────────────────────────────────┐   │
│   │  Renderer         │◀────────▶│  Main-process services                                                │   │
│   │  (React 19 +      │  pty     │                                                                        │   │
│   │   Zustand)        │  bytes,  │   ┌───────────────┐   ┌───────────────────┐   ┌────────────────────┐   │   │
│   │                   │  status, │   │ PTY manager   │   │ Session registry  │   │ State engine       │   │   │
│   │  • beacon bar     │  events  │   │ (node-pty)    │   │ (better-sqlite3,  │   │ • HookIngest sock  │   │   │
│   │  • category rail  │          │   │ spawn/resize/ │   │  WAL)             │   │ • TranscriptWatcher│   │   │
│   │  • task tree      │          │   │ write/kill    │   │ • session/edge/   │   │   (chokidar v4)    │   │   │
│   │  • xterm panes    │          │   │               │   │   category/       │   │ • CacheScanner     │   │   │
│   │    (WebGL)        │          │   │ owns claude   │   │   handoff/        │   │ • PtyScraper (opt) │   │   │
│   │  • status footer  │          │   │ children      │   │   scrollback/     │   │ • FusionCore       │   │   │
│   └──────────────────┘          │   └───────┬───────┘   │   status_event    │   │ • StuckWatchdog    │   │   │
│                                 │           │           └─────────┬─────────┘   └─────────┬──────────┘   │   │
│                                 │           │                     │                       │              │   │
│                                 │   ┌───────▼─────────────────────▼───────────────────────▼──────────┐   │   │
│                                 │   │ Cross-session send layer                                        │   │   │
│                                 │   │ • ChannelBus (per-session MCP server + unix socket)             │   │   │
│                                 │   │ • send-keys fallback (write into owned PTY, inject-then-verify) │   │   │
│                                 │   │ • copy / share / broadcast                                      │   │   │
│                                 │   └────────────────────────────────────────────────────────────────┘   │   │
│                                 └──────────────────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────┘
        ▲ hooks POST                       ▲ fs read/watch                     ▲ ps / cache read
        │ (unix socket + disk spool)       │ ~/.claude/projects/<slug>/*.jsonl │ ~/.claude/sessions/<pid>.json
   ┌────┴─────────┐                    ┌────┴──────────┐                   ┌────┴──────────┐
   │ claude procs │                    │ transcripts   │                   │ pid cache +   │
   │ (tool-owned  │                    │ (all sessions,│                   │ ps process    │
   │  + adopted)  │                    │  hook-indep.) │                   │  table        │
   └──────────────┘                    └───────────────┘                   └───────────────┘
```

### Components and how they communicate

- **Renderer (React 19 + Zustand).** Draws the four regions: the global beacon bar (cross-category status, always visible), the category rail (hard-separated collections), the task tree (typed edges, blocked-parent banner), and the terminal panes. It holds no source-of-truth state; it mirrors the registry and the fusion engine over IPC into a single Zustand store. User actions (spawn, reparent, inject, resize) go to the main process over IPC.

- **Terminal host.** `@xterm/xterm` 6.0.0 with the WebGL renderer in the renderer process; `node-pty` 1.1.0 children in the main process. PTY output bytes stream main→renderer over IPC; keystrokes stream renderer→main. Every `FitAddon` resize computes cols/rows and calls `pty.resize()`, which raises `SIGWINCH` (non-negotiable contract, §7). WebGL has a ~16-context cap, so only visible panes are instantiated; backgrounded PTYs stay buffered/detached (the VS Code model).

- **Session registry (SQLite / `better-sqlite3`, WAL).** Single source of truth for nodes, typed edges, categories, handoff notes, scrollback snapshots, and status history. The main process is the only writer. Every other component reads and writes through in-process calls, no wire protocol.

- **State-detection engine.** Fuses hook events (received on the unix socket), the transcript-tail watcher, the cache scanner, and an optional on-demand PTY scrape into one coarse state per session. Writes `last_status` to the registry and pushes deltas to the renderer.

- **Cross-session send layer.** Dispatches on a per-node `sendCapability` field: Channels for tool-launched sessions, send-keys inject-then-verify for PTY-owned sessions without a channel, and a degraded path for external adopted sessions.

Everything above runs in one OS process. Communication between components is in-process function calls plus SQLite. The only wire boundaries are (a) main↔renderer IPC, (b) the hook shim's unix-socket POST, and (c) the per-session Channels unix sockets.

---

## 3. Data model

SQLite via `better-sqlite3` 12.x, one WAL database at `app.getPath('userData')/registry.db`. SQLite over a JSON file because status-board queries want indexed `WHERE`, the resume store must survive a crash mid-write, and the undocumented upstream formats guarantee schema migrations. PRAGMAs: `journal_mode=WAL; synchronous=NORMAL; foreign_keys=ON; busy_timeout=5000`. Schema version tracked in `PRAGMA user_version`.

### Tables

**`category`** — hard-separated top-level collections (Personal, the business, each client). Categories never bleed together in the UI; the global board spans all of them.

| Field | Type | Notes |
|---|---|---|
| `id` | TEXT PK | uuid v4 |
| `name` | TEXT | "Personal", "Client", "Client: Acme" |
| `color` | TEXT | UI accent |
| `sort_order` | INTEGER | |
| `created_at` / `updated_at` | INTEGER | epoch ms |

**`session`** — one row per pane / tree node. A node is stable across resumes; it points at a Claude session id that can change if a transcript is deleted and re-seeded.

| Field | Type | Notes |
|---|---|---|
| `id` | TEXT PK | our node id, uuid v4, stable across resumes |
| `claude_session_id` | TEXT | transcript stem; NULL until first known |
| `pid` | INTEGER | last-known live claude PID; NULL when not running |
| `proc_start` | TEXT | `procStart` from `<pid>.json`, for the PID-reuse guard |
| `cwd` | TEXT | absolute; determines the transcript slug |
| `transcript_path` | TEXT | resolved absolute path to `<sessionId>.jsonl` |
| `category_id` | TEXT FK→category | ON DELETE SET NULL |
| `title` | TEXT | user label; seed from cache `name` or transcript slug |
| `slug` | TEXT | CC's own memorable slug, from transcript |
| `origin` | TEXT | `spawned` \| `adopted` |
| `adopted` | INTEGER | 1 = started outside the tool → degraded status/send |
| `channel_ready` | INTEGER | 1 = launched with our MCP channel → inject works; else send-keys |
| `send_capability` | TEXT | `channel` \| `pty-sendkeys` \| `external-degraded` |
| `cc_version` | TEXT | gates version-dependent parsing |
| `layout_zone`, `layout_x/y/w/h`, `layout_order` | | pane placement for restore |
| `is_open` | INTEGER | pane currently instantiated (WebGL budget) |
| `last_status` | TEXT | `working`\|`waiting`\|`idle`\|`stuck`\|`dead`\|`unknown` |
| `last_status_at` | INTEGER | |
| `last_transcript_mtime` | INTEGER | for the STUCK watchdog |
| `created_at`, `updated_at`, `closed_at` | INTEGER | `closed_at` is a soft-delete for history |

Indexes: `(category_id)`, `(claude_session_id)`, `(pid)`, and `(category_id, last_status)` for the board query.

**`edge`** — typed, directed parent→child relationships. A node has at most one structural parent (a tree). Modeled as a table so re-parenting is one UPDATE and so edges carry type and provenance.

| Field | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `parent_id` | TEXT FK→session | |
| `child_id` | TEXT FK→session | |
| `type` | TEXT | `blocking` \| `tangential` |
| `source` | TEXT | `inferred` \| `manual` |
| `handoff_note_id` | TEXT FK→handoff_note | NULL if no pre-seed |
| `created_at`, `updated_at` | INTEGER | |

A partial unique index on `child_id` enforces the single-parent tree invariant at the DB level. `type=blocking` means the parent cannot continue until the child is resolved (the roll-back case; the parent renders "blocked, waiting on → child"). `type=tangential` means the child was spun off with the parent's context and does not gate the parent. `source=inferred` is set when a child is launched from within a parent (in-tool spawn captures the source node id exactly, not heuristically); `source=manual` is set by attach / re-parent.

**`handoff_note`** — optional pre-seed text carried on an edge, delivered at child launch.

| Field | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `body` | TEXT | the note |
| `created_at` | INTEGER | |
| `delivered` | INTEGER | 1 only after delivery is confirmed |
| `delivered_at` | INTEGER | |

**`scrollback_snapshot`** — static visual snapshots for resume, kept in their own table so hot rows stay small.

| Field | Type | Notes |
|---|---|---|
| `id` | TEXT PK | |
| `session_id` | TEXT FK→session | |
| `serialized` | BLOB/TEXT | `@xterm/addon-serialize` output, 1000-line cap |
| `captured_at` | INTEGER | |

**`status_event`** — append-only status history for the board timeline and for a possible future separate writer.

| Field | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `session_id` | TEXT FK→session | |
| `status` | TEXT | coarse state |
| `source` | TEXT | which signal drove it (hook / transcript / cache / pty / watchdog) |
| `at` | INTEGER | epoch ms |

---

## 4. State-detection engine

Requirement 2, constrained by F1. Full design in `scratchpad/state-detection-engine.md`. Coarse states: **WORKING | WAITING_INPUT | WAITING_PERMISSION | IDLE | STUCK** (plus `DEAD` / `UNKNOWN`). M1 ships coarse working/waiting/idle/stuck; M2 splits `WAITING_PERMISSION` out of `WAITING` additively.

### Four signal sources

1. **Hooks (rising edge + register).** One shim `~/.claude/hooks/ccc-emit.sh <EVENT>` POSTs the hook's stdin envelope to `~/.claude/ccc/engine.sock`. Events and meaning:

| Hook event | Matcher | State signal |
|---|---|---|
| `SessionStart` | all (`startup`/`resume`/`clear`/`compact`) | register node; capture cwd, source, version |
| `SessionEnd` | all | deregister → DEAD (keep row, greyed) |
| `UserPromptSubmit` | none | WORKING rising edge (authoritative) |
| `PreToolUse` | `.*` | WORKING (refresh) |
| `PostToolUse` | `.*` | refresh activity; not "done" by itself |
| `Notification` | `permission_prompt` | WAITING_PERMISSION (fast edge) |
| `Notification` | `idle_prompt` | IDLE hint (corroborate) |
| `Notification` | `agent_needs_input` | WAITING_INPUT (fast edge) |
| `Notification` | `agent_completed` | IDLE/DONE hint |
| `Stop` | all | WAITING/DONE edge (corroborate; misses silent stalls) |
| `PermissionRequest` | `.*` | WAITING_PERMISSION (belt-and-suspenders across versions) |

The shim always `exit 0` fast and fail-open: it tries the socket with `nc -U -w1` (~200 ms budget) and, on any failure, appends the line to `~/.claude/ccc/events/<sid>.ndjson`, which the engine drains and truncates at startup. A closed app never errors a Claude turn and loses no working-edges.

Older events (`SessionStart`, `SessionEnd`, `UserPromptSubmit`, `PreToolUse`) are stable across the 2.1.x spread and carry the reliable working-edge + register. The newer `Notification`/`Stop`/`PermissionRequest` events are treated as fast hints, never sole truth, because they are version-dependent and absent on adopted sessions.

**Hook install merges, never clobbers.** The user's `~/.claude/settings.json` already has global hooks (`dirty-tree-guard.sh`, `usage-governor.sh` under `PreToolUse`), a statusline, and `mcpServers` — all load-bearing. `settings.json` hooks are additive arrays of matcher-groups, so the installer appends our matcher-group to each event's array (creating the array if absent) and never rewrites an existing group. Our groups are tagged by the `ccc-emit.sh` substring so re-install replaces only ours. Backup before first write; write tmp + fsync + atomic rename.

2. **Transcript-tail watcher (falling edge, primary waiting/idle authority).** `chokidar` v4 (bundles fsevents; v5 is ESM-only/Node-20+ and fights Electron CJS main) rooted at `~/.claude/projects`, `depth:2`, 150 ms per-file debounce. On change: read the last 64 KB, per-line try/catch, **scan backward to the last real conversation record** (the last physical lines are frequently synthetic `last-prompt` / `ai-title` control records, so `tail -1` is wrong), skip `isSidechain:true` sub-agent records. Decision: last record is `assistant` with `message.stop_reason` in `{end_turn, stop_sequence}` and no fresh tool activity → waiting/done; `stop_reason=tool_use` or fresh tool records → working; `AskUserQuestion` as a `tool_use` block → waiting on user, independent of hooks. File mtime is the staleness clock.

3. **Cache scanner (enumeration + liveness only).** Polls `~/.claude/sessions/<pid>.json` every 2 s for the `pid ↔ sessionId ↔ cwd` mapping. The cache is stale (entries seen weeks old) and un-GC'd, so it is never a live status source. Guard PID reuse: a `<pid>.json` is trustworthy only if `ps -p <pid> -o comm=` resolves to a claude binary, cross-checked against `proc_start`.

4. **PTY scraper (on-demand tie-breaker).** For tool-owned PTYs, an on-demand read of the pane to disambiguate permission-vs-idle. Used for the M2 precision split, not for M1 coarse states.

### Fusion

- Hooks own the **WORKING rising edge**, with an 8000 ms anti-flicker hold.
- The transcript-tail owns the **falling edge** (WORKING → IDLE / WAITING).
- `Notification` / `Stop` are corroborating overlays.
- The cache is enumeration/liveness only.
- The PTY scrape is an on-demand permission-vs-idle tie-breaker.
- Precedence: WAITING_PERMISSION > WAITING_INPUT > WORKING > IDLE.

### STUCK watchdog

A 1 s tick. A node is STUCK when it is WORKING but the transcript mtime has been stale for more than `STUCK_MS` (30000) with no `Stop`. This is format-independent, so it backstops any transcript-parser drift. Reported states never go dark: on parser failure a node falls back to mtime-only and reads UNKNOWN rather than lying.

### Latency

Managed WORKING edge < 100 ms; transcript falling edge ~0.2–0.5 s; slowest coarse transition 1–2 s; STUCK within `STUCK_MS` + 1 s.

### Adoption path (no daemon)

Adopted sessions use the same transcript-tail watcher and state machine (the transcript is hook-independent), the cache for enumeration with the `ps` PID-reuse guard, and the optional PTY scrape. They are degraded (no working-edge hooks, send-keys only) until restarted under management. A "Restart under management" flow relaunches `claude --resume <sessionId>` in a tool-owned `node-pty`, so the new `SessionStart` attaches our hooks and upgrades the row in place. Detection that a live session is unmanaged is structural: alive + has-transcript + never-sent-a-hook ⇒ `managed=false`.

---

## 5. Resume and adoption flows

Requirements 5 and 3, constrained by F2. Full design in `scratchpad/registry-resume-adoption.md`.

### Resume on restart

No live process survives a reboot on any substrate; resume is a registry-driven relaunch, not process survival. On launch:

1. Open the WAL DB.
2. Reconcile: for each node whose `pid` is still alive after a mere app-restart (not a reboot), attach to the existing process instead of relaunching. Otherwise plan a relaunch.
3. Rebuild the tree, categories, and layout from the registry.
4. Instantiate xterm + PTY only for visible panes (WebGL ~16-context cap).
5. Paint the static `addon-serialize` scrollback snapshot (1000-line cap, captured on idle-debounce and on quit) into each visible pane.
6. Relaunch `claude --resume <claude_session_id>` per node; the resumed claude repaints its own alt-screen above the static snapshot.

Deleted or corrupt transcript is pre-checked with `stat`. Recovery keeps the node and its snapshot, nulls `claude_session_id`, and offers one-click "start fresh here" that binds a new claude session to the same node id (layout and edges preserved).

### Adoption of the ~19 already-live sessions

Two independent discovery sources, reconciled:

1. **`ps`** — authoritative liveness. The claude binary path is not a fixed string (observed: bare `claude`, `…/versions/2.1.186`, `…/claude-code/2.1.197/…/MacOS/claude`, `…/.local/bin/claude`), so matching uses an args regex plus an Electron-helper exclusion, with a `procStart`/`lstart` PID-reuse guard.
2. **`~/.claude/sessions/<pid>.json`** — the `pid ↔ sessionId ↔ cwd` map, cross-checked against `ps`.

Reconcile into cache∩process / process-only / stale-cache buckets. When the cache is missing, identity resolves from the self-identifying transcript (each conversation record carries `sessionId`, `cwd`, `version` inline). Adopted nodes are created parentless and category-less in a holding zone, degraded (transcript-tail + cache status, send-keys only) until restarted under the tool. The user assigns a category (required) and optionally a parent + edge type (drag-to-reparent) after the fact.

Adoption is a cold filesystem reconstruction run at launch and re-run on a periodic rescan while open, so sessions the user starts in iTerm mid-session also appear. This is the no-daemon adoption path and the core bet of the architecture.

---

## 6. Cross-session send

Requirement 6, constrained by F3. Full design folded from the cross-session-send component. Every target falls into exactly one tier, decided once at spawn/adopt time and stored on `session.send_capability`:

| Tier | Condition | INJECT / BROADCAST | COPY-in | SHARE-in |
|---|---|---|---|---|
| **A. Channel-native** (`channel`) | Spawned by the tool with our channel MCP server wired into the `claude` invocation | Channels (primary) | Channels | Channels (reference to handoff file) |
| **B. PTY-owned, no channel** (`pty-sendkeys`) | Spawned by the tool before channel support, or channel failed to register | send-keys via our node-pty write | send-keys | send-keys (reference to handoff file) |
| **C. Adopted / external** (`external-degraded`) | Started outside the tool; we do not own its PTY | send-keys only if the controlling terminal is reachable; otherwise unsupported → prompt to relaunch under the tool | best-effort capture-pane read | write a handoff file + a copyable reference to paste manually |

A channel can only be registered at `claude` launch; it cannot be attached to a running session. Tier C → A and Tier B → A both require a relaunch (`claude --resume`). The UI states this one-way gate plainly.

### Channels (primary) — inject and broadcast

A channel is a plain MCP server spawned by Claude Code as a stdio subprocess of the target `claude` process. It declares `capabilities.experimental['claude/channel'] = {}` (which makes Claude Code register the inbound listener) and pushes events with `mcp.notification({ method: 'notifications/claude/channel', params: { content, meta } })`. `content` becomes the body of a `<channel>` tag injected into Claude's context; `meta` keys (identifier characters only) become attributes.

Delivery is fire-and-forget: the `await` resolves when the message is written to the transport, not when Claude has processed it, and if the session did not load the channel the event drops silently with no error. Delivery queues and does not interrupt — events arriving mid-turn are delivered together on the next turn. Broadcasting mid-turn will not corrupt an in-flight turn the way send-keys can. The UI reflects "queued" vs "delivered."

Because notifications must originate from inside the target's subprocess, each `claude` gets its own channel server. The channel server is a thin local receiver bound to a per-session unix socket (`CC_CHANNEL_SOCKET`), and the app is the only client. It gates on a per-session shared secret (`CC_CHANNEL_TOKEN`) checked on each POST, with `0600` socket perms, so a rogue local process that guesses the path cannot inject. The channel server also exposes a `cc_ack(delivery_id)` MCP tool so Claude can confirm receipt, turning fire-and-forget into an observed round-trip. A custom channel needs the `--dangerously-load-development-channels` flag today.

### Send-keys (fallback) — inject-then-verify

For Tier B and reachable Tier C, the app writes into the PTY it owns. send-keys is brittle: bracketed-paste markers, multiline needs `load-buffer` / `paste-buffer`, vim NORMAL mode eats submits, Esc-Esc can corrupt input, and the carriage return is version-dependent. Every send is therefore inject-then-verify: read the pane back and confirm the text landed. A send never silently no-ops; `external-degraded` targets surface plainly with one-click "restart under management."

### Copy and share

COPY and SHARE read out via the xterm buffer (or `capture-pane` for adopted). SHARE writes a handoff file and delivers a reference over the channel (Tier A) or send-keys (Tier B), or surfaces a copyable reference for manual paste (Tier C).

---

## 7. Pinned libraries and the non-negotiable xterm.js constraints

Versions verified available on npm 2026-07-07.

| Library | Version constraint | Notes |
|---|---|---|
| `electron` | 42.x (e.g. 42.5.2) | current stable line |
| `typescript` | >= 5.5 | |
| `react` | 19.x | |
| `zustand` | >= 5.0.0 | single global store |
| `@xterm/xterm` | **pin 6.0.0 exactly** | see constraints below |
| `@xterm/addon-webgl` | 0.19.0 | stable; 0.20 is beta |
| `@xterm/addon-fit` | 0.11.0 | |
| `@xterm/addon-serialize` | 0.14.0 | scrollback snapshot for resume |
| `node-pty` | 1.1.0 | Electron main process; native, rebuild required |
| `better-sqlite3` | 12.x (12.11.1 current) | WAL; native, shares the rebuild step |
| `chokidar` | 4.x | v4 bundles fsevents, drops the glob dep; v5 is ESM-only/Node-20+ and fights Electron CJS main |
| `@modelcontextprotocol/sdk` | 1.29.0 | per-session Channels server; MCP v2 SDK stable lands 2026-07-28 — plan a migration point, do not target v2 pre-release now |
| `@electron/rebuild` | build-time | rebuild `node-pty` + `better-sqlite3` + `fsevents` on every Electron/Node ABI bump |

### The two non-negotiable xterm.js constraints (F4)

1. **`@xterm/xterm` >= 6.0.0, pinned to 6.0.0.** Below 6.0, Claude Code's spinner scrolls and garbles because it relies on DEC private mode 2026 (synchronized output). The canvas renderer was removed in 6.0, so the WebGL renderer is the only accelerated renderer and the ~16-context cap is a hard architectural constraint (render visible terminals only; keep backgrounded PTYs buffered/detached).

2. **Every `FitAddon` resize must compute cols/rows and call the backend `pty.resize()`, which raises `SIGWINCH`.** Set `TERM=xterm-256color`. Without the resize→`SIGWINCH` contract, the Claude Code TUI renders against the wrong geometry.

---

## 8. Top risks and mitigations

| Risk | Mitigation |
|---|---|
| Channels is research-preview and open bug #71792 (dev-flag channel notifications silently dropped) may make the primary inject path non-functional on current builds; it also requires claude.ai login, no API-key auth. | Prove it in Spike 0 before building on it. Keep send-keys inject-then-verify as the always-present fallback via `send_capability`. Version-gate per `cc_version`. Ship v1 on send-keys if the bug blocks it and flip to Channels at GA. |
| `node-pty` and `better-sqlite3` are native modules with no prebuilt for Electron 42.x; every ABI bump breaks launch until rebuilt. | Pin Electron/Node exactly. `@electron/rebuild` as postinstall + a CI gate rebuilding `node-pty`, `better-sqlite3`, `fsevents` together. Startup ABI self-check with a clear remediation message. |
| Transcript JSONL and `sessions/<pid>.json` are internal/undocumented and version-spread (2.1.162–2.1.201); a format drift can silently break waiting/idle detection, on which the whole board depends. | Versioned defensive parser (try/catch per line, backward-scan to the last real record, skip `isSidechain`). mtime-only fallback so the board degrades rather than going dark. Per-node `cc_version` gating. The STUCK watchdog as a format-independent backstop. |
| WebGL ~16-context cap with canvas removed in xterm 6.0 means WebGL-or-nothing; ~19 sessions exhaust contexts if all rendered. | VS Code visible-only model from day one (`is_open` flag, buffered/detached backgrounded PTYs, serialize-snapshot for non-live nodes, a hard cap on simultaneous live terminals). Test at 19+ nodes. |
| send-keys is brittle (bracketed-paste, multiline, vim NORMAL, Esc-Esc corruption, version-dependent CR) and often unreachable for truly external adopted sessions, so some cross-sends are unsupported until relaunch. | Inject-then-verify every send by reading the pane back. Classify `send_capability` (channel / pty-sendkeys / external-degraded) and surface external-degraded plainly with one-click restart-under-management. Never silently no-op. |
| Installing hooks by editing shared `~/.claude/settings.json` can clobber existing global hooks (dirty-tree-guard, usage-governor), the statusline, and `mcpServers` already load-bearing on this machine. | Additive-merge installer: append matcher-groups (never rewrite), identify our groups by the `ccc-emit.sh` substring so re-install replaces only ours, backup before first write, tmp + fsync + atomic rename. Prefer session/project-scope registration over global edits where possible. |
