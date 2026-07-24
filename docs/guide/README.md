# CC Command Center — user guide

CC Command Center is a single macOS window that hosts and orchestrates many concurrent Claude Code CLI sessions, each in a real terminal. It keeps a live picture of what every session is doing, tracks which ones are waiting on you, and holds that state across restarts, so running 5 to 25 sessions at once stays manageable from one place.

This guide is for someone already running the Claude Code CLI who wants to supervise several sessions at once. It covers installing the app, the mental model it uses, the day-to-day session lifecycle, the surfaces that tell you what needs you, and the reference material for settings, shortcuts, keys, and troubleshooting.

**Start here:** [Getting started](getting-started.md) — install the app, launch it, and get your running sessions on screen in about a minute.

## Contents

### Getting started

- [Getting started](getting-started.md) — prerequisites, downloading and installing the signed DMG, first launch, automatic adoption of your running sessions, the one-time hook and mailbox setup, and a first-minute walkthrough.

### Core concepts

- [Concepts — the mental model](concepts.md) — how to think about the app: one window supervising many human-in-the-middle sessions, the state taxonomy and colors, the needs-you set and gate ledger, categories, the parent/child hierarchy, and managed vs. adopted/dormant sessions.

### Working with sessions

- [Managing sessions](sessions.md) — the full lifecycle: opening and attaching, the New Session composer and every field, spawning blocking and tangential children, resuming a dormant session, the launch flags that survive a resume, and removing a session or its subtree.
- [Artifacts](artifacts.md) — the drawer above a session's terminal that collects the files it wrote, which kinds preview inline versus open externally, the size caps, and the sortable list with reveal-in-Finder.

### Reading the fleet

- [Awareness](awareness.md) — how to read status at a glance: the beacon bar, the needs-you companion board and its urgency order, the per-session "why" line, the soft your-turn vs. direct-question split, "done — your move", and how the app keeps readings steady.
- [Fleet views](fleet-views.md) — the three multi-session views: the full-screen Overview grid (`⌘⇧E`), the Activity panel for subagents/workflows/background tasks, and the Timeline swimlanes, plus which view answers which question.
- [Notifications](notifications.md) — native macOS notifications: turning them on, the three event classes and their defaults, global switches and per-category overrides, the never-while-focused rule, click-to-open, and the required Alert style.

### Organizing & coordinating

- [Categories](categories.md) — grouping sessions into hard-separated collections: color/emoji/short-label identity, drag-to-reorder, assigning sessions, per-category notification overrides, hiding unmanaged sessions, and deleting a category.
- [Agent-to-agent messaging](messaging.md) — the mailbox bus that lets a managed parent and child message each other with nothing installed in either session: the outbox, edge-graph routing, idle-only delivery, the approve-before-send gate and global pause, the message log, and why both ends run in auto mode.

### Reference & help

- [Settings and keyboard shortcuts](settings-and-shortcuts.md) — every Settings tab control-by-control (General, Terminal, Notifications, Arbiter, API keys) and the full keyboard-shortcut and right-click/drag reference.
- [API keys, metered spend, and usage](api-keys-and-usage.md) — adding an encrypted API key, billing a session to it via `apiKeyHelper`, reading the per-session context and account 5h/7d usage meters, and running the optional Arbiter control agent.
- [Troubleshooting](troubleshooting.md) — six common situations with symptom, cause, and fix: external sessions in the needs-you bar, stale needs-approval after resume, notification behavior, breakage after a Claude Code upgrade, native-module rebuilds, and the overview at high session counts.

## Status

CC Command Center is a solo project in active beta, macOS on Apple Silicon (arm64) only, with no support SLA. It is not an official Anthropic product and is not affiliated with or endorsed by Anthropic. It does not bundle Claude Code; it drives the `claude` command already on your machine and reads parts of Claude Code that are not a public API — the transcript format, the session registry files under `~/.claude/`, hook payloads, and terminal rendering. A Claude Code update can change any of those, so breakage after an upstream release is expected, and some features may lag until the app is updated to match.
