# Command Center — Substrate Decision

Decision doc for the "one window for all my Claude Code sessions" tool. Produced 2026-07-07 from a 10-agent research pass (tool survey, Desktop and tmux/zellij deep-dives, Claude Code control primitives, local-machine inspection) followed by adversarial verification of the four make-or-break feasibility facts. CLI version on this machine at time of research: `v2.1.202` (spread of `2.1.162`–`2.1.202` across ~19 live sessions).

## What we're building

A single contained surface that replaces the iTerm "window soup" for managing many concurrent interactive Claude Code sessions. Requirements:

1. **Containment** — all sessions in one window that stays put.
2. **Status space** — every session's live state (waiting-on-me / working / idle) and which tree/category it belongs to, always visible.
3. **Hierarchy** — parent→child task trees plus hard-separated categories.
4. **Navigation** — keyboard-driven, extendable to mouse.
5. **Resume on restart** — conversations (`claude --resume`), the tree/layout, and a scrollback snapshot.
6. **Cross-session send** — inject a prompt, copy text, share files/handoff notes, broadcast to many.

Design decisions already made (from interview):

- **Typed edges.** A relationship is either a **blocking child** (parent can't continue until it's fixed — the "roll back" case) or a **tangential offshoot** (spun off with the parent's context, but doesn't gate the parent). A blocking parent renders as "blocked, waiting on → child"; a tangential offshoot never marks its source blocked.
- **Both inference and manual** parentage. Inferred (a session launched from within session X becomes a child of X) and hand-declared (attach / re-parent nodes).
- **Optional handoff note** on spawn — a toggle, useful for both edge types.
- **Categories, not personal-vs-work.** Hard-separated top-level collections (truly personal, the business, each client) that never bleed together, with a global status board spanning all categories so a waiting session in one is never lost while working in another.

## The four verified feasibility facts

These are the constraints everything else sits on. Each was checked against primary sources; state detection and injection were also checked against the local install.

### Fact 1 — State detection is only partially solvable, and the hard state is the one that matters most

Verdict: **partial** (high confidence).

- The **working** edge is reliable via hooks (`UserPromptSubmit` starts a turn; `PreToolUse`/`PostToolUse` are a per-tool heartbeat).
- **Waiting vs idle/done is NOT reliable from hooks.** Documented breakages: `idle_prompt` doesn't fire (#8320), `permission_prompt` regressed during active thinking (#58909), `AskUserQuestion` pauses emit no hook (#13024), `Stop` misses silent tool-stalls (#29881) and Esc-interrupts (#9516). The by-design 60s idle delay is far too slow for a live panel.
- `~/.claude/sessions/<pid>.json` exposes `status: busy|waiting|idle` and `waitingFor`, but that field is a **stale cache** (measured 16 min–279 h behind reality) and isn't garbage-collected on process death. Use it for enumeration/liveness only, guarded by `ps -p <pid> -o comm= == claude` against PID reuse.
- **Robust design:** a fused signal at ~1–3s latency — hooks for the working edge and register/deregister; a **transcript-tail watcher** (`~/.claude/projects/<slug>/<sessionId>.jsonl` + file mtime) as the primary waiting/idle detector; a PTY/screen read as the tie-breaker for the permission-vs-idle pause.

**Implication:** the one state weighted highest — "waiting on me" — is exactly what Claude Code can't reliably emit. A substrate that can read the actual TUI (owning the PTY, or `capture-pane` on a multiplexer) gets ground truth. This is the strongest single argument for a PTY-aware substrate.

### Fact 2 — No substrate keeps a live process across a reboot; resume is always a re-launch

Verdict: **partial** (high confidence).

Three things must be separated, and nothing preserves all three:

1. **Layout/tree** — restored nearly free on both multiplexers (tmux-resurrect + continuum; zellij `session_serialization` on by default). A desktop app implements this itself.
2. **Scrollback** — restored only if explicitly enabled, and only as static text: tmux `@resurrect-capture-pane-contents 'on'` (off by default); zellij `pane_viewport_serialization=true` + `scrollback_lines_to_serialize=0` (off by default); desktop via `@xterm/addon-serialize`. A visual snapshot, not a live view.
3. **Live process** — never survives a reboot on any substrate. A reboot kills every child process. tmux re-spawns programs by name from a whitelist (`claude` isn't on it); zellij re-runs a discovered command (discovery is unreliable for a REPL typed into a shell); an Electron/Tauri node-pty host equally loses its children.

Nuance: if only iTerm quits but the tmux/zellij **server stays alive** (no reboot), the live `claude` process survives and you truly re-attach. Only a full reboot (the security-update case) kills it.

**Implication:** conversational continuity comes solely from `claude --resume <session-id>`, which reloads the transcript from `~/.claude`. The real work is a **session registry** you build regardless of substrate: persist each pane's claude session-id, its parent + edge-type, category, and cwd, so on restart you regenerate the layout and launch `claude --resume <id>` per pane. This neutralizes any resume advantage a desktop app seems to have and slightly favors the multiplexer (layout + scrollback from config, not code).

### Fact 3 — The clean injection path is Channels (MCP), identical on both substrates; the keystroke path is brittle on both

Verdict: **partial** (high confidence).

- **Channels** (official, `v2.1.80+`, research preview) are an MCP server that pushes an event directly into a running session, processed in order, with an optional reply tool. No keystrokes, no carriage-return race, no vim-mode trap. This is the path for **inject (6a)** and **broadcast (6d)**, and it works identically under a desktop app and under tmux/zellij because it rides MCP over stdio. Constraints: research-preview gating (a custom channel needs the `dangerously-load-development-channels` flag today), fire-and-forget delivery (build a reply tool for confirmation), it queues rather than interrupts an in-flight turn, and every target session must have been **started** with the channel registered.
- The **PTY keystroke fallback** (`tmux send-keys` / `node-pty write`) is race-prone and mode-fragile: submit races, multiline needing `load-buffer`/`paste-buffer -p`, vim NORMAL mode silently eating submits, Esc-Esc corrupting `send-keys` until `/clear`, version-dependent carriage-return behavior. Must be inject-then-verify, never fire-and-forget. Owning the PTY does not escape this — same Ink input-layer semantics.

**Implication:** make Channels primary for inject/broadcast; keep PTY injection as a degraded fallback for sessions not started with the channel flag. Neither substrate has an injection advantage. Copy (6b) and share (6c) still read OUT via `capture-pane` or the xterm buffer — Channels only pushes IN.

### Fact 4 — Electron/Tauri can host the Claude Code TUI cleanly, with two hard constraints

Verdict: **confirmed** (high confidence).

- xterm.js supports the VT sequences a rich TUI drives (alt-screen, SGR mouse, 256/truecolor, cursor save/restore); it's the VS Code terminal engine.
- **Version floor:** synchronized output (DEC mode 2026) landed only in `@xterm/xterm >= 6.0.0`. Below that, Claude Code's spinner frames scroll instead of animating in place (documented breakage in waveterm#2787). Pin `>= 6.0.0`, use WebGL (canvas was removed in 6.0).
- **PTY contract:** on every FitAddon resize, compute cols/rows and call the backend `resize()` (raises SIGWINCH so the TUI repaints); set `TERM=xterm-256color`. Miss it and the alt-screen corrupts.
- Electron: `node-pty` in-process, but native rebuilds break across Electron/Node bumps (`NODE_MODULE_VERSION`) — budget `@electron/rebuild`. Tauri v2: `portable-pty` in Rust, stream PTY bytes over the Channel API (never `emit()`).
- Scrollback via `@xterm/addon-serialize` is a static snapshot; fine because the plan relaunches `claude --resume` to repaint the live alt-screen.
- WebGL context cap (~16 per engine): render only visible terminals, keep backgrounded PTYs buffered/detached (the VS Code model).

**Implication:** hosting the TUI in a desktop app is dependable if you pin xterm.js 6.0.0+ and honor the resize→SIGWINCH contract. The terminal-hosting core is de-risked; the differentiated work is the tree/status/resume/broadcast layer, which no tool ships end-to-end.

## Existing tools survey

| Tool | Category | Fit to the task-tree model | Verdict |
|---|---|---|---|
| **tmux-agent-status** | tmux plugin | Persistent per-session sidebar with real working/done/wait/parked states from hooks; collapsible session>window>pane tree; fzf switcher. Best status space. But it's tmux's *structural* tree, not the semantic task tree; no category axis; no native cross-session send. | closest-match |
| **zellaude** | zellij plugin | Claude-aware tab bar: distinguishes waiting-for-prompt vs waiting-for-permission vs working vs done per pane, hook→`zellij pipe`→WASM. Maintained (v0.5.1). Delivers req 2 nearly off the shelf. No tree column; fork to add grouping. | strong |
| **cmux** | GUI (native macOS) | One native window, vertical tabs, 40+ rebindable shortcuts, full mouse, notification panel as coarse status; renders subagents as native splits. Restores layout/scrollback/cwd but NOT live processes (#1663). Flat tab list, not a tree; binary notify status; broadcast not first-class. GPL-3.0, macOS-only. | closest-match |
| **Zellij (+ WASM plugins)** | zellij | Only substrate with native reboot-survivable layout+scrollback serialization; WASM plugin API (Rust) to build a tree/status view. No semantic tree, category, or broadcast out of the box. | closest-match |
| **ccmanager** | TUI (Node) | Clearest explicit Waiting/Busy/Idle per session + status-change hooks; organizes by git worktree. No task tree, no categories, no inject/broadcast, no mouse. | partial |
| **claude-squad** | TUI (Go) | Mature multi-agent manager (tmux + worktree per instance), ~8k stars. Flat list, explicitly no hierarchy; no status board; no cross-session send. | partial |
| **tmai** | tmux + web | Only tool whose metaphor is parent-dispatches-child (Producer→Workers) with real handoff/decision stores and hook status. But single-level (not a recursive tree) and very immature. Best conceptual reference. | partial |
| **DIY tmux family** (Tmux-Orchestrator, muxtree, workmux…) | tmux scripts | Raw send-keys toolkit: the only family with native broadcast-to-many; Tmux-Orchestrator has a real 3-tier tree. Containment/status/resume all bring-your-own. Highest ceiling, most assembly. | partial |
| **opcode / Claudia** | Tauri GUI | Popular (~21k stars) Claude Code GUI; session/checkpoint browser. Off-model as shipped, but the best **fork base** for a Tauri desktop build. | partial |
| Conductor, Nimbalyst/Crystal, Superset, Sculptor, Warp, Vibe Kanban | GUI/web | Worktree/branch or Kanban or flat-agent-list models. Warp has a genuinely strong cross-session status panel. None model the task tree or categories. Vibe Kanban is web (ruled out). | partial / not-relevant |

**Gap none of them fill:** no tool models a semantic parent→gap→child→rollback task tree; none has a category partition; none delivers all four cross-session modes together; none bundles [layout + scrollback + `claude --resume` per pane + the tree] into one restore. This is a build/fork.

## Substrate comparison

| # | Requirement | Desktop app (Electron/Tauri + xterm.js) | tmux / zellij control layer |
|---|---|---|---|
| 1 | Containment | Strong. One window you control. Risk: an app crash takes the PTYs down (no detached server). | Strong. Multiplexer server is separate and long-lived; quitting iTerm re-attaches. Avoid `tmux -CC` (re-creates window soup). |
| 2 | Status space | Strongest. Can read the TUI as ground truth for "waiting on me" (Fact 1) plus render any board. You build the fusion + UI. | Feasible. zellij is ahead via `zellaude`; `capture-pane` as the tie-breaker. Less clean than owning the PTY. |
| 3 | Hierarchy (tree + categories) | Strong. Genuine indented tree with connectors, badges, collapse, drag-to-reparent, and a first-class category band. | **Weak.** A pane grid can't draw a tree; degrades to an indented list (dotted-path names). Categories via session/tab groups + color. |
| 4 | Navigation (keyboard + mouse) | Strong. Full mouse/click/drag out of the box; drag-to-reparent is ordinary web work. | Good keyboard; mouse is a bolt-on, not rich click/drag. |
| 5 | Resume on restart | Build layout + scrollback yourself. Same `--resume` + registry as everyone. No inherent edge. | Layout + scrollback from config (cheap). Registry + per-pane `--resume` still bespoke. Slight edge. |
| 6 | Cross-session send | Inject/broadcast via Channels (identical); copy/share by reading the xterm buffer. | Inject/broadcast via Channels (identical); native `send-keys` fallback; copy/share via `capture-pane`. |

**Desktop — benefits:** only substrate that draws a real tree + categories + full mouse; can read the TUI for reliable "waiting on me"; terminal-hosting core is de-risked (Fact 4); fork bases exist (cmux native, opcode/Claudia Tauri). **Risks:** highest effort (you build a terminal host + the app layer); app crash kills PTYs; you build layout/scrollback persistence; native-rebuild maintenance (Electron) or Channel-API routing (Tauri); version floor + resize contract are easy to miss. **Effort:** large — multi-month to all six at production quality; smaller if forking cmux (macOS-only, GPL).

**tmux/zellij — benefits:** containment, layout + scrollback restore, and per-pane injection come from mature tooling with little code; `zellaude` gives a status board nearly off the shelf; detached-server survives iTerm quit; lowest code volume for four of six requirements. **Risks:** can't draw a real tree (the direct miss against requirement 3); "waiting on me" from hooks is unreliable and needs `capture-pane`; zellij resurrection is functional-but-fragile (#4129/#4413/#4754/#2925/#4023); mouse is constrained; registry + `--resume` still bespoke. **Effort:** small-to-medium — ~1–2 weeks to a working command center; the registry is the concentrated bespoke work (a few days) and is required on any substrate.

## Recommendation

The hard, valuable, differentiated work is **substrate-independent**: the session registry (pane → claude session-id, parent, edge-type, category, cwd), the fused state detector (hooks + transcript-tail watcher + optional PTY read), and the Channels-based inject/broadcast layer. The substrate only decides how the tree/status is *rendered* and how much of resume/layout comes for free.

So build the **engine first**, on the cheap substrate, and defer the shell:

1. Build the session registry + state detector + Channels layer, fronted by **zellij + `zellaude`**. This reaches a usable command center in ~1–2 weeks and de-risks the true long pole without first writing a terminal emulator.
2. Live with it. The two requirements zellij serves worst are the real tree and "waiting on me" precision. If the indented-list tree or the status precision grate against the daily rolling workflow — likely, given how much the tree visualization and hard-separated categories matter here — graduate to a **desktop app** that reuses the same engine unchanged, and evaluate forking **opcode/Claudia** (Tauri, portable) or **cmux** (native, macOS-only, GPL) before building from scratch.

A full hybrid (desktop shell over a live multiplexer backend) is the highest-effort path and isn't recommended as a starting point; the staged sequence gets its main benefit (cheap resume now, richer UI later) without paying for both at once.

## Open questions

Resolved in interview: task tree is **declared and inferred** with **typed edges**; grouping is **hard-separated categories**; handoff note is **optional**.

Still open:

1. **Reach** — macOS-only (opens a cmux fork, native perf) or portable (Tauri / multiplexer, for Linux/SSH)?
2. **Cross-session send** — Channels-first (accept the `dangerously-load-development-channels` flag and tool-launched sessions), send-keys-only (brittle but ungated, adopts any session), or both?
3. **"Waiting on me" precision** — is coarse working/waiting/idle enough to start (precise permission-vs-idle split as a later `capture-pane` add-on), or is the precise split day-one (pushes toward owning the PTY)?
4. **Session adoption** — must every session be launched *by* the command center (required for Channels + clean registry), or must it also adopt already-running sessions (the ~19 currently live, which predate any hooks)?
5. **Scrollback snapshot** — a fixed cap (e.g. last 5–10k lines/pane) is fine, and static-text-until-`--resume`-repaints is the expected behavior (it can't be interactive on any substrate)?
