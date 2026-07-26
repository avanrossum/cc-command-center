# CC Command Center

**Run and orchestrate many Claude Code sessions from one window — and never lose track of which one needs you.**

A macOS app that hosts every Claude Code CLI session in one place, each in a real terminal, and keeps a live picture of what they are all doing, how they relate, and which are waiting on you. Built for the person running five, ten, twenty sessions at once who keeps losing the thread of which one they were in the middle of.

![The full app: beacon bar across the top, category rail and session list on the left, an active terminal, and the needs-you board on the right](screenshots/hero-full-app.png)

> **Not an official Anthropic product.** This is an independent, third-party tool. It is not affiliated with, endorsed by, or supported by Anthropic. "Claude" and "Claude Code" are Anthropic's. This app orchestrates the Claude Code CLI you already run; the optional Arbiter feature makes metered calls to the Anthropic API under your own key, billed to you at API rates.

---

## Why it exists

Running many agent sessions creates one specific problem: **you lose track of what you were doing.** Which session is waiting on you? What was it waiting *for*? Did you already handle that one? What did you set running last night and forget about?

Most of this app is one answer to that question — externalize the state your working memory keeps dropping, so "out of sight" stops meaning "gone." It survives restarts on purpose, because a thing you can't see is a thing you'll forget.

---

## See the whole fleet at a glance

The **beacon bar** across the top is a live status board: which sessions need you, and why. A session surfaces when it is parked on a permission dialog, when it asked you a question, or when it is blocked on an unfinished child. Sessions that are just working stay quiet.

![The needs-you board listing four sessions, each with the reason it is waiting](screenshots/needs-you-four-states.png)

A single row carries the substance of the ask — here, the exact command a session is waiting to run:

![A needs-you row for a session parked on a permission prompt, showing its command](screenshots/needs-you-permission-gate.png)

**Zoom out to the whole fleet.** `⌘⇧E` opens the overview: every active session as a tile outlined in its state color, sorted so the ones that need you land first. Click a tile to drop into that session.

![The overview grid: four sessions as tiles, each outlined in its state color](screenshots/overview-grid.png)

**It survives a restart.** Close the app mid-flow, reopen it, and the sessions that were waiting on you are *still there* in the needs-you list — dimmed, tagged "resume," ready to pick back up. You don't have to remember what you were in the middle of; the app remembers for you.


---

## Keep separate work separate

Sessions live in **hard-separated categories** — personal, business, per-client, however you define them — with a rail to switch between them and set each one's color, emoji, and short label. A blocking child inherits its parent's category, so a subtree of work can't accidentally drift across the boundary between, say, two different clients.

![The category editor: color, emoji, short label, and per-category notification overrides](screenshots/category-editor.png)

---

## Structure work as a tree

Spawn a **child session** to go work on one thing without staining the context you're in — seeded with a handoff note carrying just enough to pick up the idea. Links are typed: a **blocking** child means the parent isn't done until the child is; a **tangential** child is a decoupled side-exploration that never blocks the parent.

Resume one member of a task tree after a restart and the **whole family comes back up** — parent, children, and siblings — so the sessions that talk to each other are all live again, not stranded half-dormant.

![Spawning a blocking child session, with a handoff note to start from](screenshots/spawn-blocking-child.png)

---

## Sessions that talk to each other

Sessions can message each other through the app over a filesystem mailbox — a parent hands its child a task, the child reports back when done. Delivery is **trust-gated per link**: you bless a link once, and after that messages flow without approving each one, but every hop is written to a message log with its outcome, and a global kill switch stops all of it instantly.

This is the "Human In The Middle" idea (see below) made concrete: you sit at a node in the mesh, able to read, hold, or inject every message.

A handoff, start to finish. The parent sends the work down:

![A parent session sending a request to its child](screenshots/parent-requests-child.png)

The child receives it on its own next turn and starts:

![The child session receiving the request and beginning work](screenshots/child-received-request.png)

And the exchange in full:

![The full transcript of the exchange between parent and child](screenshots/parent-child-transcript.png)

---

## Know what's actually happening

**Hook-driven status.** Sessions report their own state through Claude Code hooks, which the app fuses with a transcript reader and a terminal-buffer scan into one honest signal: working / your turn / needs approval / idle. Stale signals age out, so nothing gets pinned in the wrong state.

**Fleet activity.** Every subagent your sessions spawn, what it's working on, and whether it's running, done, or stalled — grouped by the session that owns it. A quiet collapsed line ("3 running") that expands into the full picture.

![The activity panel listing a session's subagents](screenshots/activity-subagents.png)

**The activity strip.** A per-session timeline of the last few minutes, at adjustable granularity (5m / 10m / 25m) — a glanceable heartbeat of the whole fleet.

![Timeline swimlanes, popped out into a floating card](screenshots/timeline-popout.png)

---

## See what a session produced

A drawer above the terminal collects the files the open session created. Images, SVG, audio, syntax-highlighted code, Markdown, and RTF render in place; PDFs, Office documents, and HTML open in your default app. The list is sortable by name or recency and every entry can be revealed in Finder.

![The artifact drawer rendering Markdown a session produced](screenshots/artifacts-markdown.png)

Code and data files render with syntax highlighting, and anything the app can't display in place offers to open externally instead.

![The artifact drawer showing a file it will open in an external application](screenshots/artifacts-open-externally.png)

---

## Bill it your way

Launch a session against a specific named **Anthropic API key** so its usage bills to that key instead of your subscription, and pick its **model and context window** (including 1M-context variants) right from the spawn dialog. Keys are stored encrypted in the macOS Keychain and never shown again after entry.

![The New Session composer: name, category and folder on the left; model, effort, context and permission mode on the right](screenshots/new-session-modal.png)

![Settings, showing named API key entry](screenshots/settings-api-keys.png)

---

## The Arbiter (optional)

An optional control agent that writes a plain-English line explaining *why* each session is waiting on you — turning "needs approval" into "wants to delete the migrations folder." It runs on **metered API billing**, not your subscription, and it is built to never surprise you:

- **Off by default.** Nothing runs until you enable it and point it at a key.
- **Opt-in privacy, per category.** It reads only categories you explicitly tick. Everything else sends state alone — no session content leaves your machine.
- **A hard spend cap.** You set a daily ceiling; it *stops* at the cap, it doesn't just warn. Spend is tracked and always visible as it accrues.
- **Pausable.** Stop it from its own window without tearing down the setup.
- **Read-only.** It explains; it takes no action on any session.

![The Arbiter panel: running spend against its daily cap, and a log of each run](screenshots/arbiter-log.png)

---

## HITM — Human In The Middle

The organizing idea. Human-In-the-**Loop** puts the human at the *edge* of an automated pipeline, as a gate that approves or rejects. Human-In-the-**Middle** puts the human at a *node in the mesh*: inside a session, able to message any other session, be messaged, spawn new ones, and watch the whole bus.

The name is the security sense of "man in the middle" on purpose. An attacker in the middle of a channel can do three things — read traffic, drop or alter it, inject its own. The app gives those three powers to the human, deliberately:

- **read** — a message log of every routing decision, both directions, delivered / held / dropped.
- **drop or alter** — a global kill switch, per-link untrust, the trust gate, a rate guard.
- **inject** — cross-session send, broadcast, spawn-child-with-context, selection-to-tangent.

See [`docs/concepts.md`](docs/concepts.md) for the full rationale.

---

## Security & privacy

This is a single-user desktop app; the security boundary is your user account. It handles credentials and edits your global Claude config, so the handling is deliberate and documented in full in [`SECURITY.md`](SECURITY.md). The essentials:

- **API keys are encrypted at rest** with Electron `safeStorage` (macOS Keychain). If secure storage is unavailable, the app refuses to store the key rather than falling back to plaintext. A key is never shown again after entry and never sent to the renderer process.
- **Per-session key access goes through a local, owner-only (`0600`) socket** using a per-session capability token that's revoked when the session exits — the session gets a token, not the key.
- **Edits to `~/.claude/settings.json` are conservative**: backed up first (a hard precondition), atomic, malformed input refused rather than repaired, unrelated keys preserved, and the auto-granted permission rule scoped to the mailbox trees only.
- **No telemetry.** The app phones home to nothing. The awareness bus is local files; the message log is local. The only outbound network call is the optional Arbiter, to the Anthropic API, under your own key.
- **Known residual risk, stated plainly:** a session running on a metered API key can read that key — and so can any code that session runs, including a shell command from prompt injection. This is inherent to giving a session a credential, not a bug a patch removes. Use narrowly-scoped keys with a Console spend limit for anything untrusted, and rotate promptly. Full discussion in [`SECURITY.md`](SECURITY.md).

**Reporting a vulnerability:** open a private GitHub Security Advisory (Security → Advisories → Report a vulnerability). Don't open a public issue for a vulnerability.

---

## Requirements

- macOS on **Apple Silicon**.
- The **Claude Code CLI**, installed and working.
- A Claude subscription and/or an Anthropic API key.

## Install

Download the signed and notarized `.dmg` from the [Releases](../../releases) page — the recommended path. Or build from source below.

## Build from source

Requires Node (with npm).

```sh
npm install
npm run dev      # run in development
npm run build    # build to out/
npm run dist     # build and package a signed .dmg / .zip into release/
```

`npm run dist` signs and notarizes, which needs the maintainer's Apple Developer credentials, so third-party builds are unsigned. An unsigned build still runs after you clear Gatekeeper on it.

## Expectations

This is a solo project. It integrates with parts of Claude Code that are not a public API — the transcript format, the session registry files, hook payload shapes, terminal rendering. Those change between Claude Code releases without notice, and breakage after an upstream release is expected and normal, not a sign the project is abandoned.

Pull requests are welcome, especially compatibility fixes for new Claude Code versions. There is no support SLA; issues may sit.

## License

[Apache-2.0](LICENSE). © 2026 MipYip, LLC.
