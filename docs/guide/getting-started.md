# Getting started

Install CC Command Center, launch it, and get your running Claude Code sessions on screen in about a minute.

CC Command Center is a single macOS window that hosts and orchestrates many concurrent Claude Code CLI sessions, each in a real terminal. It keeps a live picture of what every session is doing and which ones are waiting on you. This guide covers installing the app, the first launch, how it picks up sessions you already have running, and the one-time setup worth doing.

Current version: 0.20.0. This is a solo project in active beta. It is not an official Anthropic product and is not affiliated with or endorsed by Anthropic.

---

## Prerequisites

You need all of these before installing:

- **A Mac with Apple Silicon (arm64).** The build is arm64-only. There is no Intel, Windows, or Linux build, and none is planned.
- **The Claude Code CLI already installed and working.** The app does not install or bundle Claude Code. It drives the `claude` command that is already on your machine, reads the session files Claude Code writes under `~/.claude/`, and hosts `claude` processes in its terminals. If `claude` does not run in your own terminal, fix that first.
- **A Claude subscription and/or an Anthropic API key.** Sessions authenticate the same way they do when you run `claude` yourself. A subscription covers normal use; an API key is only needed if you want to bill specific sessions to a metered key (an optional per-session feature).

### One caveat to know up front

The app integrates with parts of Claude Code that are not a public API: the transcript format, the session registry files under `~/.claude/sessions`, hook payloads, and terminal rendering. A Claude Code update can change any of those, so breakage after an upstream release is expected. This is beta software with no support SLA.

---

## Download and install

1. Go to the public releases repo: **https://github.com/avanrossum/claude-command-center-releases**
2. Open the latest release and download the DMG. It is named `claude-command-center-<version>-arm64.dmg` (for example, `claude-command-center-0.20.0-arm64.dmg`). The DMG is code-signed and notarized by Apple.
3. Open the downloaded DMG.
4. Drag **CC Command Center** to your Applications folder.
5. Eject the DMG.

Later versions arrive through the app's own auto-update: it checks the same releases repo after launch and once a day, shows the release notes, and downloads only when you choose to. You do not need to re-download the DMG for updates.

---

## First launch and Gatekeeper

Open CC Command Center from Applications (or Spotlight) the first time.

Because the app is signed and notarized, macOS does not block it as an unidentified developer. On the first open you will see the standard confirmation that the app was downloaded from the internet. Click **Open**.

If macOS is being cautious and does not offer an Open button, right-click (or Control-click) the app in Applications, choose **Open** from the menu, then click **Open** in the dialog. You only do this once.

---

## The app adopts your running sessions automatically

There is nothing to import. When the app starts, it finds the Claude Code sessions you already have running and puts them on screen.

How it works:

- The app scans `~/.claude/sessions` about every 1.5 seconds. Claude Code writes a small file there for each session it starts.
- For each entry, the app confirms the process ID belongs to a genuinely live `claude` process. It matches both the command and the process start time, so a recycled PID from an unrelated program cannot impersonate a session that has died.
- It reads the session's transcript to derive a coarse state (working, your turn, needs approval, and so on).

Any session you started in any terminal shows up here within a couple of seconds and becomes manageable without relaunching it. Close and reopen the app and your live sessions reappear the same way, because the picture is rebuilt from what is actually running.

### Adopted vs. managed sessions

Two kinds of sessions live side by side, and the difference matters for what you can do to each:

- **Adopted sessions** are ones you started elsewhere. The app shows their state and lets you watch and interact with the terminal, but it does not own the process. It cannot inject prompts or cross-session messages into them, and it cannot remember launch flags for them. Their context-window percentage reads as unknown, because that number comes from the app's own status line, which an externally-started session does not have.
- **Managed sessions** are ones you start from inside the app (the **+ New session…** button). The app owns the process, so these can receive injected prompts, participate in agent-to-agent messaging, spawn child sessions, and reopen with the same model, effort, context, and permission-mode settings they were running.

If sessions running in other terminals add noise you do not want, open **Settings > General** and turn on **Only show sessions managed here**. That hides live sessions the app does not manage while keeping your own and any dormant, resumable ones.

---

## One-time setup worth doing

The app works the moment it opens. Two optional settings make it work better, and you only do each once. Both are in **Settings > General**, and both edit your global `~/.claude/settings.json` (the app backs the file up first and refuses to touch it if it is malformed).

### Install the status hooks (accurate state)

Without hooks, the app infers each session's state from its transcript and a scan of the terminal buffer. That is a good guess, but it is a guess.

With hooks installed, each session reports its own state directly, including the exact instant a permission dialog opens, which the transcript alone cannot see. State becomes definitive and immediate instead of inferred.

To install: **Settings > General > Accurate status via hooks > Install…**. This writes a small script to `~/.claude/ccc/status-hook.sh` and wires it into your global Claude Code settings, so it covers every session, adopted ones included. It applies to sessions started after you install it, so restart a session (or start a new one) to see the difference. The same row's button flips to **Remove** if you want to undo it.

### Pre-authorize the mailbox (only if you use agent-to-agent messaging)

Managed sessions can message each other by writing tiny files under `~/.claude/ccc/`. By default, Claude Code prompts for permission on every one of those writes, which stalls autonomous parent/child messaging.

Granting the mailbox permission adds one narrowly-scoped rule to your global settings that allows edits only to the app's mailbox directory (not the whole `~/.claude/ccc/` tree). Those writes then happen without a prompt.

To grant: **Settings > General > Awareness mailbox write permission > Grant…**. The app also offers this on first launch, in a dialog titled "Let sessions message each other without prompts?" — you can accept it there or decline and grant it later in Settings. You can remove the rule at any time by editing `~/.claude/settings.json` yourself, or by choosing not to grant it. Skip this entirely if you are not going to spawn child sessions or use cross-session messaging.

---

## Your first minute

A quick tour once the app is open and your sessions have appeared:

1. **Read the beacon bar.** The header across the top counts your whole fleet by state and lists the top few things waiting on you. Each item there jumps to its session when clicked. This answers "what needs me right now?" at a glance.
2. **Open the overview grid.** Press **Cmd+Shift+E** (or click **Show all**) for a full-screen grid of every active session as a live terminal thumbnail, outlined in its state color. The most urgent sessions sort to the top-left automatically. This is "what are all my Claudes doing right now?" in one look.
3. **Dive into a session.** Click any tile. The grid closes and that session's live terminal opens, switching to its category and highlighting its row. Type into it exactly as you would in a standalone terminal.
4. **Start a managed session.** Click **+ New session…**. The dialog sets the name, category, working folder, model and effort, permission mode, and an optional first instruction in one place, then launches and adopts the session for you. A session started this way is a managed session, so it gets the full set of app features described above.
5. **Come back later.** State you would otherwise forget — which session was waiting, what it was waiting for, whether you already handled it — is held for you and survives quitting and reopening the app.

That is enough to run the fleet. The rest of the features (categories, the timeline, agent-to-agent messaging, the artifact preview drawer, per-session API keys) are there when you want them.
