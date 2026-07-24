# CC Command Center — Feature Inventory

This is the single source of truth for marketing pages. Each feature lists what it does and the concrete benefit. Keep entries plain and specific.

## What it is

CC Command Center is a single macOS desktop window that hosts and orchestrates many concurrent Claude Code CLI sessions, each in a real terminal. It keeps a live picture of what every session is doing, how sessions relate to each other, and which ones are waiting on you. It replaces a screen full of scattered terminal windows with one operations surface where the whole fleet is visible and the state you would otherwise forget is held for you across restarts.

**Who it is for:** a single technical operator — developer, founder, or architect — running roughly 5 to 25 Claude Code sessions at once across personal projects, their own business, and multiple clients. Comfortable with terminals and keyboard-driven tools.

**The problem it solves:** running many agent sessions makes you lose track of what you were doing — which session is waiting on you, what it was waiting for, whether you already handled it, and what you set running last night and forgot. The app externalizes that state and survives restarts, so "out of sight" stops meaning "gone." The core job is answering "which sessions are waiting on me right now, and where?" in under a second.

**Current status:** version 0.20.0, a solo project in active beta, macOS on Apple Silicon only. Requires the Claude Code CLI already installed and a Claude subscription and/or Anthropic API key. Not an official Anthropic product; independent and not affiliated with or endorsed by Anthropic. It integrates with parts of Claude Code that are not a public API (transcript format, session registry files, hook payloads, terminal rendering), so breakage after an upstream Claude Code release is expected, with no support SLA.

---

## Session management

**Adopt already-running sessions** — Scans `~/.claude/sessions` every ~1.5s, confirms each PID is a genuinely live `claude` process (matching command and start-time so a recycled PID can't impersonate a dead session), and derives a coarse state from the transcript. Sessions you started in any terminal appear here and become manageable without relaunching them.

**Managed launch (app-owned PTY)** — Spawns a real `claude` process under a node-pty the app owns, then reconciles it to a stable session id on the next scan. A session the app launched can receive injected prompts, cross-session messages, and remembered launch flags that an externally-started session cannot.

**New Session composer** — A two-column modal that launches and adopts a managed session in one step: name, category, folder (with recent-folders list), launch parameters, extra CLI flags, an optional API key, and initial instructions. One dialog configures everything instead of hand-typing a `claude` command and categorizing it afterward.

**Model + effort pickers (including ultracode)** — A model dropdown (with a Custom id field) and an effort level from low through max plus "ultracode," which maps to xhigh and injects a standing workflow-orchestration instruction. Levels that would silently no-op on the chosen model (for example ultracode on Haiku) are hidden, so the UI never offers a setting that does nothing.

**Permission Mode picker** — A launch-time `--permission-mode` selector: Default, Plan, Accept edits, Auto, Don't ask, Manual, and Bypass all. You start a session directly in the posture you want. Bypass is never remembered as a sticky flag, so it can't silently disable permission checks on later launches.

**1M context toggle** — A Context picker whose "1M" choice appends the `[1m]` suffix to the model string, enabled only for models that have a 1M variant. You opt a session into the 1M-token window at launch without knowing the suffix trick or misapplying it.

**Per-session API key (metered billing)** — Runs a chosen session on a named Anthropic API key via `apiKeyHelper` instead of the subscription, with the key fetched at runtime from an owner-only local key daemon and re-applied on resume. You bill specific sessions (client or automated work) to a metered key while everything else stays on your subscription.

**Initial instructions** — An optional first message delivered once the session is adopted and its input is actually up. The session starts working on your task immediately instead of sitting at an empty prompt.

**Extra CLI flags** — A free-text field appended after the structured launch args, so anything you type wins. You pass arbitrary args like `--add-dir` without a dedicated field for every option. This freeform string is never remembered as a sticky flag, so it can't re-inject `-p` or `--continue` on resume.

**Spawn children (blocking vs tangential)** — From an active session, spawn a child in a chosen folder with a typed edge: "blocking" (the parent rolls back and shows blocked until the child finishes) or "tangential" (spun off with context, doesn't block). You break a task into a real parent/child tree the app tracks, and messages can flow between the two. Also available as a Cmd+K instant spawn from the current selection.

**Launch flags that survive a resume** — `claude --resume` does not carry model, effort, context, or permission-mode forward, so those four fields are stored per session and rebuilt into argv after `--resume`. A session reopens with the same settings it was running instead of reverting to CLI defaults. "Always use these flags" resumes silently; otherwise a params gate appears first, and per-session Launch settings edit or clear the remembered flags later.

**Restore-on-launch (last session + task tree)** — Persists the last-active session and category; on start, once that session is live it reopens, and opening any tree member brings the rest of the family back up (bounded to six). You reopen the app back where you left off, with the whole task tree live so parents can message children again.

**Remove / terminate a session or subtree** — Kills the managed PTY, purges dead session files, deletes the registry node (edges, gates, and event log cascade), and deny-lists the id so a ghost row can't re-adopt. It removes the whole subtree behind a confirm that names the children, so you retire a finished session and everything it spawned in one action with no orphan PTYs.

**Scrollback snapshot (resume repaint)** — Persists a debounced snapshot of the last ~1000 lines per session and paints it into the pane on the next open. A resumed session shows its prior conversation instantly instead of an empty terminal while `claude --resume` spins up.

**Recovery when a transcript is gone** — Treats a missing or empty transcript as unresumable and shows a recovery card offering "Start fresh here" (a new session in the same folder) or "Remove from list." A pruned conversation gives you a clear choice instead of a confusing resume failure.

---

## Awareness & status

**Coarse state engine** — Fuses each session's display state per scan from four signals: the transcript-derived state, the Claude Code status hook, a live PTY-buffer dialog scan, and the edge-graph "blocked" derivation, resolving most-urgent-wins into working / your-turn / needs-approval / blocked / done / idle. You get one honest at-a-glance status per session with no daemon and nothing installed inside the session.

**"Why" lines behind a needs-you moment** — Every needs-you row carries the substance of the ask: the verbatim gated command for a permission, the actual sentence the assistant ended on for a question, or the name of the unfinished child for a blocked parent. You triage without opening the session by reading what it actually wants.

**Gate ledger (the "did I handle that?" memory)** — A SQLite-backed ledger reconciled every scan against the currently open gates, keyed by a stable fingerprint so a repainting dialog stays one gate. Gates auto-mark as seen when you're focused on the session and auto-resolve after handling, and survive a restart. Nothing you haven't looked at silently disappears, and a needs-you moment is still there, dimmed and resumable, after you quit and relaunch.

**Beacon status bar + tallies** — An always-visible top header counting the fleet by state and listing the top few things waiting on you, each of which jumps to its session. At any moment you see how many sessions are in each state and what needs you, regardless of which category you're viewing.

**Needs-you companion board (why-board)** — A docked pane rendering the full needs-you set as cards, scoped to the current category or the whole fleet, with each cross-category card tagged by its category color. A working surface for triage when several things need you at once, without hopping between category rails.

**Permission-gate detection (live PTY-buffer scan)** — A permission dialog reads as "working" in the transcript, so the app instead scans the terminal's raw buffer tail for a version-gated table of prompt signatures, anchored on the dialog footer lines that survive a scrolled header. A session frozen on an approval it can't clear itself reliably surfaces amber instead of masquerading as busy-green, and clears the instant you answer.

**Release-hysteresis (anti-flicker)** — Holds a higher-urgency state for a few seconds of consecutive lower readings before releasing, while a genuine transition (for example a newer hook event after you approve) still releases immediately. The status display stays steady instead of strobing, and a real change still snaps through instantly.

**"Done — your move" completion signal** — Flags a session as done only when its turn ends on a statement, it finished after your last-viewed watermark, and you aren't currently looking at it. You get told when an unattended session actually finished, without a session you're watching nagging you about its own completions.

**Your-turn vs "asked you a direct question" distinction** — Separates a soft turn-end ("tell me what next") from a genuine question that blocks the assistant, giving the question a badge, a higher sort position, and an "Asked you" label. At a glance you can tell which sessions actually asked you something from the ones that are merely idle and your-move. *(Sidebar and overview shipped; a deeper unified re-tiering across the tally and notifications is on the roadmap.)*

---

## The fleet views

**50k-foot overview grid (Show all / Cmd+Shift+E)** — A full-screen grid of every active session as a live-ish terminal thumbnail outlined in its state color. One glance answers "what are all my Claudes doing right now" without clicking through sessions.

**Live state-color tile outlines** — Each tile's outline color and its position ride the 1.5s snapshot and are genuinely real-time; only the thumbnail image is a periodic snapshot. You can trust the "who needs me" color at a glance even though the picture is cheap.

**Critical-order sort** — Tiles sort by urgency (permission, working, question, soft your-turn, blocked, done) and animate to their new position as sessions change state. The sessions that most need you land top-left automatically.

**Show-idle toggle** — A persisted checkbox that adds live-idle sessions to the grid, off by default. The default view stays focused on what's in motion; flip it on for the whole live fleet.

**Click-to-dive-in** — Clicking a tile closes the grid and opens that live session, switching to its category and highlighting its row. The overview is a launchpad, not a dead-end dashboard.

**Grid overflow cap** — Caps at 24 tiles and shows the remainder as a "+N more" count. The grid stays legible and performant no matter how busy the fleet is.

**Hard-separated categories** — Sessions live in categories (personal, business, clients), each with its own color, optional emoji, and short rail label, rendered as a category rail. Client work never bleeds into personal, and each collection reads at a glance by its emoji and color.

**Drag-to-reorder categories** — Drag a category cell to a new slot with an optimistic reorder that lands without flicker. You arrange categories in the order that matches how you work.

**Per-category notification overrides** — Each category can override any notification class (needs-permission, question, done), inheriting the global setting otherwise. Noisy classes stay quiet where you don't want them (personal) and loud where you do (clients).

**Last-used category restore** — Restores the last-selected category on launch and jumps back to the last session you had open in that category. The app reopens where you left off instead of on an arbitrary category.

**Parent/child hierarchy with typed edges** — Sessions form an indented tree via typed edges: a solid "blocking" edge (the parent rolls back to it) and a dotted "tangential" offshoot. You see which session spawned which and can tell a hard dependency from an independent spin-off.

**Derived "blocked" parent state** — A parent whose blocking child is still unfinished computes as "blocked" (pink) and names the child it's waiting on. A stalled parent reads as blocked, not misleadingly idle, and tells you exactly what's holding it up.

**Strip / timeline swimlanes** — Per-session swimlanes recording each live session's coarse-state change-points over an adjustable window (5, 10, or 25 minutes). You see at a glance how each session's state has moved recently — how long it's been working, when it flipped to your-turn.

**Companion cross-fleet why-board** — A docked pane showing the same needs-you set as cards scoped to a category or the whole fleet, each cross-category card tagged and carrying a context-usage bar. A waiting session in a category you're not looking at stays visible without switching.

**Fleet activity view (subagents / workflows / background tasks)** — Aggregates across all sessions the background work each has spawned — subagents, workflow runs with progress like 8/19, and background shell tasks — grouped by owner with status. With several working sessions, background activity gets out of hand fast; this shows what's running fleet-wide so a session running a build or workflow doesn't read as idle.

**Activity open-session priority + rollup chips** — The session you're viewing gets its full activity ledger at the top; every other session collapses to a one-line rollup chip you click to switch to it. Detail follows your attention while the rest stays a compact glance.

**Pop-out floating panels (Timeline / Activity)** — The Timeline and Activity panels can each pop out into a draggable floating card that persists when the companion sidebar is hidden, with the layout remembered. Keep the timeline or activity visible while collapsing the rest of the sidebar.

---

## Communication & automation

**Agent-to-agent messaging bus** — Every app-spawned session gets a filesystem outbox and a one-time preamble teaching it to write there; the app drains each outbox every scan and routes messages up to the parent or down to a named child via the edge graph, injecting them as fresh turns. Parent and child sessions coordinate autonomously using only their native tools, with the command center as the bus — no skill, MCP, or Channels dependency installed in either session.

**State-aware delivery** — A routed message is injected only when the target is affirmatively free (idle or waiting), never mid-work, and is buffered in memory until the target becomes routable. Cross-session messages land as clean new turns instead of corrupting a session's in-flight input.

**Approve-before-send: trust gate + global pause** — Messaging is gated on link trust: an untrusted parent/child edge holds messages until you trust the link, and trust is re-checked at delivery time so an untrust drops in-flight messages. A global pause switch freezes all routing without losing anything. No session can message another until you bless the link, and one click can stop all autonomous messaging fleet-wide.

**Auto mode for unattended messaging** — A composer checkbox launches a child with `--permission-mode auto` (sticky across resume) so routine gates like the mailbox write self-approve. Parent/child messaging flows without you clearing a permission dialog on every outbox write.

**Directed @-addressing, self-exit, and loop guards** — A message starting with `@"Child Name"` routes to that child; plain text routes up to the parent. A session can end its own PTY by writing an exact exit sentinel, and a per-link rate cap plus a hop cap bound runaway loops. Sessions address specific children by name and terminate themselves when done, while guards stop a ping-pong from storming.

**Cross-session message log** — A header badge opens a log of every message the bus routed — from, to, text, and status (delivered, held, dropped, expired, self-exit). Every autonomous hop is visible and auditable.

**Manual cross-session send / broadcast** — A send surface types text into one or more target sessions using the same transport the bus uses. You push a prompt into any managed session, or many at once, without switching to each terminal.

**macOS system notifications** — Optional native notifications for three classes (needs permission, your turn/question, finished a task) with a global switch and per-category overrides, off by default. They never fire while the app is focused, notify once per event, and have a per-session cooldown, so you get told when a session on another monitor needs you without banner-spam.

**Click-to-open notification routing** — Clicking a notification activates the app and opens that exact session, switching to its category and highlighting its row. One click on the banner takes you straight to the session that needs you.

**The Arbiter (optional metered control agent)** — An optional read-only agent that writes a one-line plain-English gloss ("wants to delete the migrations folder") for each session waiting on you, rendered inline on the session row. It's a direct metered Anthropic API call (Haiku by default), off unless enabled with a stored key, and takes no action. At a glance you see why each blocked session needs you, in your own words. *(Note: shipped but not yet run against a real API key.)*

**Arbiter cost tracking + spend cap** — Every billable call records usage to cost via standard pricing, spend shows on the Arbiter bar at all times, and a daily cap is checked before each request and stops the agent when hit. The metered agent can never produce a surprise bill — spend is always on screen and the cap is a hard stop.

**Arbiter privacy redaction (per-category opt-in)** — Session substance and name are sent to the API only for categories you explicitly cleared; every other session sends state and shape alone, with the name replaced by a stable handle. Client or personal content never leaves the machine unless you clear that category.

---

## Artifacts

**Artifact preview drawer with in-app rendering** — A fold-down drawer over the open session's terminal renders what that session produced: images and SVG, an inline audio player, syntax-highlighted code, rendered Markdown, and RTF, with a per-artifact error boundary. You see a session's charts, docs, and generated files without leaving the app or hunting through Finder. HTML, PDF, and Office files deliberately open in the default app.

**Artifact list (sortable, timestamped, reveal-in-Finder)** — The drawer's right pane lists the session's previewables with a kind badge, a relative modified time, and per-item Open and Reveal in Finder, sortable by recency or name with the choice persisted. On a long-running session you find the file you want and jump to it in Finder.

**Artifact detection (session-scoped, passive)** — Detects artifacts two ways without a daemon: file paths from the session's own transcript, plus a shallow scan of its working directory for recent binary files a Bash step made. The drawer shows only what this session actually produced, staying accurate even in a shared project directory.

---

## Platform & infrastructure

**Secure named API keys** — API keys are encrypted at rest with the OS keychain, and a metered session receives only a per-session capability token that an owner-only local key daemon exchanges for the key in memory. The key never enters the child's environment, a plaintext file, or a process listing, so you can run untrusted or auto-mode work on a spend-limited key with subscription sessions kept separate.

**Per-session context-window readout** — Each session row and terminal show the percentage of the model's context window used, parsed from the session's own status-line payload, with a warning near auto-compact. You can tell at a glance which sessions are about to compact and need attention. Requires the app-owned status line, so adopted sessions show unknown.

**Account-wide 5h / 7d usage meter** — A dual-bar readout showing the account's rate-limit usage with a live reset countdown, captured by the app's own installed status line. You see how close the whole account is to its limits and when they reset, so you can pace fan-out work before you get throttled.

**Auto-update** — electron-updater reads from a separate public releases repo (so no token is baked into the app), checks after launch and daily but never downloads until you choose, and shows rich per-version release notes. Testers get new builds and readable notes automatically while the source repo stays private.

**Versioning & build identity** — Every build carries a MAJOR.MINOR.PATCH-shorthash identity with clean/dirty state, shown in the top bar and the About window. Any build handed to a tester maps to the exact commit, so bug reports map to real source.

**Per-terminal color themes** — Nine built-in iTerm-style color schemes, each with an accent used as the session's identity swatch, set per session and persisted across resume. You color-code sessions so a glance tells you which one you're in.

**Configurable terminal font & size** — A settings tab to pick the terminal font family and size, with discovery filtered to genuinely monospaced families so a proportional font can't wreck Claude's TUI alignment. You get a readable, correctly-aligned terminal in your preferred coding font.

**Drag-a-file-to-insert** — Dragging files or folders from Finder onto a terminal inserts their full paths at the cursor. You reference files in a prompt by dragging them in instead of typing long paths.

**Cmd-click a path to open** — A link provider recognizes file paths in the terminal output (including real macOS paths with spaces) and opens them via the OS on Cmd+Click, resolving mid-sentence paths to the longest existing prefix. You jump straight from a path Claude prints to the file, the way iTerm's Semantic History works.

**Prompt composer** — An optional multi-line composer under the terminal where Enter inserts a newline and Cmd+Return sends, with the draft cleared when you switch sessions. You compose multi-line prompts without Enter submitting early, and a draft for one session can't be sent to another.

**Tabbed Settings** — The Settings modal is organized into General, Terminal, Notifications, Arbiter, and Keys tabs. Settings stay navigable as the feature set grows.

**Hide unmanaged sessions** — A toggle that hides live Claude Code sessions running in other terminals the app doesn't manage, keeping the app's own and dormant sessions visible. External sessions stop adding noise, so the fleet view reflects only what you manage here.

**Window-bounds persistence** — The window's last position and size are restored on launch, but only if the saved bounds land on a currently-connected display, and maximized state is tracked separately. The app reopens where you left it without the hazard of opening onto a monitor that's no longer attached.

---

## On the roadmap

**Rich / interactive notifications** — Lift the verbatim permission query or question into the notification body with its options as action buttons and an inline reply field, routing the answer back into the session over the existing send-keys path. You would answer a session's prompt straight from the notification without opening the app. *(The substance and the return path already exist; this is the interactive layer on top of today's text-only banners.)*

**Deeper question re-tiering** — Promote a direct question to its own rung just below permission across the beacon tally, sidebar ordering, overview sort, and notification class, unifying the distinction that today lives only in the sidebar and grid.
