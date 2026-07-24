# CC Command Center

One window for every Claude Code session you have running.

[IMAGE: hero — the overview grid with several sessions]

CC Command Center is a macOS desktop app that hosts and orchestrates many Claude Code CLI sessions at once, each in a real terminal. It shows what every session is doing, how sessions relate to each other, and which ones are waiting on you. Instead of a screen full of scattered terminal windows, you get one surface where the whole fleet is visible and the state you would otherwise forget is kept for you across restarts.

The core question it answers, in about a second: which sessions are waiting on me right now, and where?

## Adopt and launch sessions

**Adopt sessions you already have running.** The app scans your Claude Code sessions every couple of seconds and confirms each one is a genuinely live process. Sessions you started in any terminal show up here and become manageable without relaunching them.

**Launch a new session from one dialog.** The New Session composer sets name, category, folder, model, effort level, permission mode, an optional API key, and an initial instruction in a single step. The session starts working on your task right away instead of sitting at an empty prompt.

**Pick the model and effort you want.** Model and effort pickers cover everything from low effort through max, plus an ultracode mode for heavy orchestration work. Settings that would do nothing on the chosen model are hidden, so the UI never offers a knob that has no effect.

**Reopen where you left off.** Launch flags like model, effort, and permission mode are stored per session and reapplied on resume, which the Claude Code CLI does not carry forward on its own. A resumed session shows its prior conversation immediately and comes back with the same settings it was running.

## See who needs you

[VIDEO: 30s — spawning a child and watching the needs-you bar]

**One honest status per session.** The app derives a coarse state for each session — working, your turn, needs approval, blocked, done, or idle — by combining several signals, with the most urgent one winning. Nothing is installed inside the session to make this work.

**Read the reason without opening the session.** Every "needs you" row carries the substance of the ask: the exact command awaiting a permission, the actual question the assistant ended on, or the name of the child a parent is blocked on. You can triage from the row itself.

**Remember what you have already handled.** A ledger tracks every gate a session raises and survives a restart. A moment that needed you is still there, dimmed and resumable, after you quit and relaunch, so nothing you have not looked at quietly disappears.

**Get told when unattended work finishes.** A session is flagged as done only when it actually completed while you were not watching it. A session you are looking at will not nag you about its own completions.

## The fleet at a glance

**A grid of everything at once.** The overview grid shows every active session as a live terminal thumbnail outlined in its state color. One keystroke opens it, and one glance tells you what all your sessions are doing. The most urgent sessions sort to the top-left automatically.

**Click a tile to dive in.** Clicking a session in the grid opens that live terminal, switches to its category, and highlights its row. The overview is a launchpad into the session that needs you.

**An always-visible status bar.** A top header counts the fleet by state and lists the top few things waiting on you. Each item jumps to its session. You see the whole picture regardless of which category you are viewing.

**Hard-separated categories.** Sessions live in categories such as personal, business, and clients, each with its own color, emoji, and label. Client work never bleeds into personal, and each collection reads at a glance.

## Coordinate and automate

**Spawn child sessions with a typed relationship.** From an active session you can spawn a child in a chosen folder as either blocking (the parent waits and shows blocked until the child finishes) or tangential (spun off with context, running independently). The app tracks the parent/child tree and shows which session spawned which.

**Let sessions message each other.** App-spawned sessions can pass messages up to a parent or down to a named child. The app routes them and injects each as a fresh turn only when the target is free, never mid-work. Parent and child coordinate using their own native tools, with the app acting as the message bus.

**Approve links before anything sends.** Messaging is held until you trust a given parent/child link, and a global pause switch stops all routing at once without losing messages. No session can message another until you allow it.

**Audit every hop.** A message log shows every message the bus routed — from, to, text, and status. Every autonomous exchange is visible.

## Notifications and control

**Native macOS notifications, off by default.** Optional notifications cover three cases: a session needs permission, a session wants your input, or a session finished a task. They never fire while the app is focused, notify once per event, and can be overridden per category so client work is loud and personal work stays quiet.

**Click a notification to land on the session.** Clicking a banner activates the app and opens that exact session, switches to its category, and highlights its row.

**An optional agent that explains what each blocked session wants.** The Arbiter is a read-only helper that writes a one-line plain-English note for each session waiting on you. It runs on a metered Anthropic API key, is off unless you enable it, takes no action, shows its spend on screen at all times, and stops at a daily cap you set. Session substance is sent to the API only for categories you explicitly clear.

## Terminal and artifacts

**Preview what a session produced, in the app.** A drawer over the open session's terminal renders images, SVG, audio, syntax-highlighted code, and Markdown that the session generated, so you see its output without hunting through Finder. It lists the session's files with timestamps and a reveal-in-Finder button.

**A terminal built for real work.** Nine color themes, a configurable monospaced font, drag-a-file-from-Finder to insert its path, and Cmd-click a printed path to open it. A multi-line composer lets Enter add a newline and Cmd+Return send, so long prompts do not submit early.

**Keys and usage in view.** API keys are encrypted at rest with the OS keychain and never enter a session's environment or a plaintext file. A dual-bar meter shows how close your account is to its rate limits and when they reset, so you can pace heavy work before you get throttled.

## Who it's for

A single technical operator — a developer, founder, or architect — running roughly 5 to 25 Claude Code sessions at once across personal projects, their own business, and multiple clients. If you are comfortable with terminals and keyboard-driven tools and you lose track of which agent session is waiting on you, this is built for that.

## How it works

1. **Adopt your running sessions.** Open the app and every live Claude Code session appears, with its current state, no relaunch required.
2. **See who needs you.** The status bar and overview grid show which sessions are waiting, what each one wants, and how they relate. The most urgent ones rise to the top.
3. **Dive in.** Click the session that needs you and land directly in its live terminal, ready to answer.

## Status

Version 0.20.0, in active beta. macOS on Apple Silicon only. Requires the Claude Code CLI already installed and a Claude subscription and/or an Anthropic API key. This is an independent project, not an official Anthropic product, and not affiliated with or endorsed by Anthropic. It works against internal parts of Claude Code that are not a public API, so an upstream Claude Code release can break it, and there is no support SLA.

## Get it

Download the latest beta build, or request beta access to be added to the tester list.

[Download for macOS] · [Request beta access]
