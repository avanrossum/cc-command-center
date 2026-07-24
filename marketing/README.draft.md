# CC Command Center

One macOS window that hosts and orchestrates many concurrent Claude Code sessions, so you always know which ones are waiting on you.

<!-- BADGE ROW — add once repos/CI are wired up:
[![Build](https://img.shields.io/…)](…)
[![Version](https://img.shields.io/…)](…)
[![License](https://img.shields.io/…)](…)
-->

![overview](docs/media/PLACEHOLDER-overview.png)

<!-- HERO SHOT: the main window with the category rail on the left, a live terminal
     session in the center, the beacon status bar across the top showing state tallies
     ("3 working · 2 your turn · 1 needs approval"), and the needs-you companion board
     docked on the right. Should read as "one operations surface for the whole fleet." -->

## What is it

CC Command Center is a single desktop window that runs and manages many Claude Code CLI sessions at once, each in a real terminal. It watches every session, works out what each one is doing, how sessions relate to each other, and which ones are waiting on you.

It is built for one technical operator — a developer, founder, or architect — running roughly 5 to 25 Claude Code sessions across personal projects, their own business, and multiple clients. When you have that many agents going, it is easy to lose track: which session is waiting on you, what it was waiting for, whether you already handled it, and what you left running last night. The app keeps that state outside your head and holds it across restarts. The main question it answers, in under a second, is "which sessions are waiting on me right now, and where?"

It is a solo project in active beta. It is not an official Anthropic product and is not affiliated with or endorsed by Anthropic.

## Features

### Session management

- **Adopt already-running sessions.** Scans `~/.claude/sessions` every ~1.5s and confirms each process is a genuinely live `claude` process, matching command and start time so a recycled PID can't impersonate a dead session. Sessions you started in any terminal show up here and become manageable without relaunching them.
- **Managed launch.** Spawns a real `claude` process under a PTY the app owns. Sessions the app launched can receive injected prompts, cross-session messages, and remembered launch flags that externally-started sessions cannot.
- **New Session composer.** One dialog to name a session, pick its category and folder, set launch parameters and extra CLI flags, choose an API key, and give it initial instructions — instead of hand-typing a `claude` command and categorizing it afterward.
- **Model and effort pickers.** A model dropdown and an effort level from low through max, plus "ultracode" (maps to xhigh and adds a workflow-orchestration instruction). Levels that would do nothing on the chosen model are hidden.
- **Permission mode picker.** Choose the `--permission-mode` at launch: Default, Plan, Accept edits, Auto, Don't ask, Manual, or Bypass all. Bypass is never remembered as a sticky flag, so it can't silently disable permission checks on a later launch.
- **1M context toggle.** Opt a session into the 1M-token window at launch, enabled only for models that have a 1M variant.
- **Per-session API key.** Run a chosen session on a named Anthropic API key with metered billing while everything else stays on your subscription. The key is fetched at runtime from an owner-only local key daemon and re-applied on resume.
- **Initial instructions.** An optional first message delivered once the session is up, so it starts on your task immediately instead of sitting at an empty prompt.
- **Spawn children.** From an active session, spawn a child with a typed edge: "blocking" (the parent shows blocked until the child finishes) or "tangential" (spun off with context, doesn't block). Also available as a `⌘K` instant spawn from the current selection.
- **Launch flags that survive resume.** `claude --resume` drops model, effort, context, and permission-mode, so the app stores those four per session and rebuilds them into the command after `--resume`. A session reopens with the settings it was running.
- **Restore on launch.** Reopens the last-active session and category on start, and opening any member of a task tree brings the rest of the family back up.
- **Remove a session or subtree.** Kills the PTY, purges dead session files, and deny-lists the id so a ghost row can't re-adopt. Removing a session removes the whole subtree behind a confirm that names the children.
- **Scrollback snapshot.** Persists the last ~1000 lines per session and paints them back on the next open, so a resumed session shows its prior conversation instantly.
- **Recovery for a missing transcript.** A pruned or empty conversation gives you a clear choice — "Start fresh here" or "Remove from list" — instead of a confusing resume failure.

### Awareness and status

- **Coarse state engine.** Fuses four signals per scan (transcript state, the Claude Code status hook, a live terminal-buffer scan, and the edge-graph "blocked" derivation) into one status per session: working, your-turn, needs-approval, blocked, done, or idle. No daemon, nothing installed inside the session.
- **"Why" lines.** Every needs-you row carries the substance of the ask — the verbatim gated command for a permission, the sentence the assistant ended on for a question, the name of the unfinished child for a blocked parent — so you can triage without opening the session.
- **Gate ledger.** A SQLite-backed record of every needs-you moment, keyed by a stable fingerprint so a repainting dialog stays one gate. Gates mark as seen when you focus the session, resolve after you handle them, and survive a restart, so nothing you haven't looked at disappears silently.
- **Beacon status bar.** An always-visible header counting the fleet by state and listing the top things waiting on you, each of which jumps to its session.
- **Needs-you companion board.** A docked pane rendering the full needs-you set as cards, scoped to the current category or the whole fleet, with cross-category cards tagged by category color.
- **Permission-gate detection.** A permission dialog reads as "working" in the transcript, so the app scans the terminal's raw buffer for the prompt's signature instead. A session stuck on an approval it can't clear itself shows amber, and clears the instant you answer.
- **Anti-flicker.** Holds a higher-urgency state for a few seconds before releasing it, while a genuine transition still releases immediately, so the display stays steady without hiding real changes.
- **Completion signal.** Flags a session as done only when it finished after your last-viewed watermark and you aren't currently looking at it, so an unattended session tells you it finished without a session you're watching nagging you.
- **Question vs soft your-turn.** Separates a soft turn-end ("tell me what's next") from a genuine question that blocks the assistant, giving the question a badge, a higher sort position, and an "Asked you" label.

### Fleet views

- **50,000-foot overview grid (`⌘⇧E`).** A full-screen grid of every active session as a live-ish terminal thumbnail outlined in its state color. One glance answers "what are all my Claudes doing right now."
- **Real-time tile outlines.** Each tile's outline color and position ride the 1.5s snapshot and are genuinely real-time; only the thumbnail image is periodic, so the "who needs me" color is trustworthy at a glance.
- **Critical-order sort.** Tiles sort by urgency and animate to their new positions as sessions change state, so the sessions that most need you land top-left.
- **Show-idle toggle.** Idle sessions are off by default and one click away, keeping the default view focused on what's in motion.
- **Click to dive in.** Clicking a tile opens that live session, switches to its category, and highlights its row.
- **Hard-separated categories.** Sessions live in categories (personal, business, clients), each with its own color, optional emoji, and rail label. Client work never bleeds into personal.
- **Drag to reorder categories** and **per-category notification overrides**, so noisy notification classes stay quiet where you want them and loud where you don't.
- **Parent/child hierarchy.** Sessions form an indented tree via typed edges — a solid "blocking" edge and a dotted "tangential" offshoot — so you can tell a hard dependency from an independent spin-off. A parent waiting on an unfinished blocking child computes as "blocked" and names the child it's waiting on.
- **Timeline swimlanes.** Per-session lanes recording each session's coarse-state change-points over an adjustable window (5, 10, or 25 minutes), so you see how long a session has been working and when it flipped to your-turn.
- **Fleet activity view.** Aggregates the background work every session has spawned — subagents, workflow runs with progress like 8/19, and background shell tasks — grouped by owner, so a session running a build doesn't read as idle.
- **Pop-out panels.** The Timeline and Activity panels each pop out into a draggable floating card that persists when the sidebar is hidden, with the layout remembered.

### Communication and automation

- **Agent-to-agent messaging bus.** Every app-spawned session gets a filesystem outbox and a one-time preamble teaching it to write there. The app drains each outbox every scan and routes messages up to the parent or down to a named child, injecting them as fresh turns. No skill, MCP, or extra dependency installed in either session.
- **State-aware delivery.** A routed message is injected only when the target is affirmatively free, never mid-work, and is buffered until the target becomes routable, so messages land as clean new turns.
- **Trust gate and global pause.** No session can message another until you trust the link, trust is re-checked at delivery, and one switch pauses all routing without losing anything.
- **Auto mode for unattended messaging.** Launch a child with `--permission-mode auto` (sticky across resume) so routine gates like the mailbox write self-approve.
- **Directed addressing and loop guards.** A message starting with `@"Child Name"` routes to that child; plain text routes up to the parent. A session can end its own PTY with an exit sentinel, and per-link rate caps plus a hop cap bound runaway loops.
- **Cross-session message log.** A header badge opens a log of every routed message — from, to, text, and status (delivered, held, dropped, expired, self-exit).
- **Manual send and broadcast.** Push a prompt into one managed session or many at once without switching to each terminal.
- **macOS system notifications.** Optional native notifications for three classes (needs permission, your turn/question, finished a task), off by default, with a global switch and per-category overrides. They never fire while the app is focused, notify once per event, and have a per-session cooldown. Clicking one opens that exact session.
- **The Arbiter (optional).** An optional read-only agent that writes a one-line plain-English gloss ("wants to delete the migrations folder") for each session waiting on you, rendered on the session row. It's a metered Anthropic API call (Haiku by default), off unless enabled, takes no action, tracks its own spend against a daily cap, and only sends session substance for categories you explicitly cleared. *(Shipped but not yet run against a real API key.)*

### Artifacts

- **Artifact preview drawer.** A fold-down drawer over the open session's terminal renders what that session produced — images and SVG, an inline audio player, syntax-highlighted code, rendered Markdown, and RTF — so you see a session's charts, docs, and generated files without leaving the app. HTML, PDF, and Office files open in the default app.
- **Artifact list.** A sortable, timestamped list of the session's previewables with a kind badge and per-item Open and Reveal in Finder.
- **Passive detection.** Finds artifacts from the session's own transcript plus a shallow scan of its working directory, so the drawer shows only what this session actually produced even in a shared project folder.

### Platform and infrastructure

- **Secure named API keys.** Keys are encrypted at rest with the OS keychain. A metered session receives only a per-session capability token that an owner-only local key daemon exchanges for the key in memory, so the key never enters the child's environment, a plaintext file, or a process listing.
- **Per-session context-window readout.** Each session shows the percentage of the model's context window used, with a warning near auto-compact. (Requires the app-owned status line, so adopted sessions show unknown.)
- **Account-wide 5h / 7d usage meter.** A dual-bar readout of the account's rate-limit usage with a live reset countdown, so you can pace fan-out work before you get throttled.
- **Auto-update.** Reads from a separate public releases repo, checks after launch and daily, and never downloads until you choose, with per-version release notes. The source repo stays private.
- **Versioning.** Every build carries a `MAJOR.MINOR.PATCH-shorthash` identity shown in the top bar and About window, so a build handed to a tester maps to the exact commit.
- **Per-terminal color themes** and **configurable terminal font and size**, with font discovery filtered to genuinely monospaced families so a proportional font can't break Claude's TUI alignment.
- **Drag a file to insert** its full path at the cursor, and **`⌘`-click a path** in terminal output to open it in the OS.
- **Prompt composer.** An optional multi-line composer where Enter inserts a newline and `⌘Return` sends, with the draft cleared when you switch sessions.
- **Hide unmanaged sessions**, **tabbed settings**, and **window-bounds persistence** that restores position only when the saved bounds land on a connected display.

## Install

macOS on Apple Silicon (arm64) only. You also need the Claude Code CLI already installed and a Claude subscription and/or an Anthropic API key.

1. Download the signed, notarized `.dmg` from the [Releases page](https://github.com/avanrossum/claude-command-center-releases/releases). <!-- confirm/replace URL -->
2. Open the DMG and drag CC Command Center to Applications.
3. Launch it. It finds and adopts any Claude Code sessions already running.

The releases repo is public and the app auto-updates: it checks after launch and daily, shows the release notes for each new version, and downloads only when you choose.

## How it works

**Adopt what's already running.** On launch the app scans for live `claude` processes and lists them, so sessions you started in any terminal appear without relaunching. It reads a coarse state from each transcript.

**Sort work into categories.** Put each session in a category — personal, business, a specific client — each with its own color and emoji. Categories are hard-separated so client work stays out of your personal view.

**Watch the needs-you bar.** The beacon status bar across the top counts the fleet by state and lists what's waiting on you. Click any item to jump straight to that session. Each needs-you row carries a "why" line, so you can read what a session wants before opening it.

**Zoom out with `⌘⇧E`.** The overview grid shows every active session as a live-outlined thumbnail, sorted so the most urgent land top-left. Click a tile to dive into that session.

**Spawn children when a task branches.** From a running session, spawn a child in another folder with a "blocking" or "tangential" edge (or `⌘K` for an instant spawn). The app tracks the parent/child tree, shows a parent as blocked while a blocking child runs, and can route messages between them.

## Screenshots

![needs-you bar](docs/media/PLACEHOLDER-beacon.png)
<!-- The beacon status bar across the top: state tallies for the whole fleet and the
     top few things waiting on you, each clickable. Should show a "why" line on a row. -->

![overview grid](docs/media/PLACEHOLDER-overview-grid.png)
<!-- The ⌘⇧E full-screen overview grid: many session thumbnails outlined in state
     colors (green working, amber needs-approval, pink blocked), sorted by urgency,
     with a "+N more" overflow chip. -->

![category rail](docs/media/PLACEHOLDER-categories.png)
<!-- The left category rail with emoji + color per category (personal / business /
     a client), and the parent/child hierarchy shown as an indented tree with solid
     blocking edges and dotted tangential edges. -->

![new session composer](docs/media/PLACEHOLDER-new-session.png)
<!-- The two-column New Session modal: name, category, folder with recents, model +
     effort pickers, permission-mode, context toggle, API key, and initial instructions. -->

![artifact drawer](docs/media/PLACEHOLDER-artifacts.png)
<!-- The fold-down artifact drawer over a terminal: a rendered chart or Markdown on the
     left, the sortable artifact list with kind badges and timestamps on the right. -->

![timeline swimlanes](docs/media/PLACEHOLDER-timeline.png)
<!-- Per-session timeline swimlanes over a 10-minute window, showing coarse-state
     change-points so you can see how long each session has been working. -->

## Status

Beta. This is a solo project in active development, version 0.20.0. It runs on macOS with Apple Silicon only, and requires the Claude Code CLI plus a Claude subscription and/or Anthropic API key.

It integrates with parts of Claude Code that are not a public API — the transcript format, session registry files, hook payloads, and terminal rendering. An upstream Claude Code release can break it, and there is no support SLA. It is not an official Anthropic product and is not affiliated with or endorsed by Anthropic.

## License

<!-- LICENSE — add the chosen license here (e.g. "MIT — see [LICENSE](LICENSE)."). -->
