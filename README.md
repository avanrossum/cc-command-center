# CC Command Center

A macOS desktop app for running and orchestrating many concurrent Claude Code CLI sessions from one
window. Each session gets a real terminal inside the app. The app tracks what every session is
doing, how sessions relate to each other, and which ones are waiting on you.

## HITM — Human In The Middle

The organizing idea is Human In The Middle multi-agent orchestration. Human-In-The-Loop puts the
human at the edge of an automated pipeline, as a gate that approves or rejects. HITM puts the human
at a node in the mesh: sitting inside a session, able to message any other session, be messaged,
spawn new ones, and watch the whole bus.

The name is taken from the security sense of "man in the middle" on purpose. An attacker in the
middle of a channel can read traffic, drop or alter it, and inject its own. The app gives those
three powers to the human deliberately:

- **read** — a message log of every routing decision, both directions, delivered / held / dropped.
- **drop or alter** — a global kill switch, per-link untrust, the trust gate, a rate guard.
- **inject** — cross-session send, broadcast, spawn-child-with-context, selection-to-tangent.

See [`docs/concepts.md`](docs/concepts.md) for the full rationale, including an adversarial test of
whether sessions hold to their own brief when another session argues against it.

## Features

- **Status board ("beacon")** — a bar showing which sessions need you and why. A session surfaces
  when it is parked on a permission or approval dialog, or when it is blocked on an unfinished
  blocking child. Ended turns show as "Your turn" separately.
- **Hard-separated categories** — sessions are bucketed into categories (personal, business,
  clients, whatever you define) with a rail for switching between them. A blocking child inherits
  its parent's category, so a blocking subtree cannot drift across the separation.
- **Session tree with typed edges** — parent to child links are either *blocking* (the parent's work
  is not done until the child's is) or *tangential* (a decoupled side exploration that never blocks
  the parent).
- **Live terminal hosting** — each managed session runs in a PTY (`node-pty`) rendered with
  xterm.js. Sessions already running outside the app can be adopted, with reduced fidelity.
- **Awareness bus** — sessions can message each other through the app using a filesystem mailbox.
  Delivery is trust-gated per link: an untrusted link holds the message rather than delivering or
  discarding it, and every hop is written to the message log with its outcome.
- **Hook-driven status** — sessions report their state through Claude Code hooks
  (`UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `Notification`), which the app maps to
  working / your turn / needs approval / idle. Hook signals are fused with a transcript reader and a
  terminal buffer scan, and are aged out so a stale signal cannot pin a session in the wrong state.
- **Per-session API-key billing** — a session can be launched against a specific named Anthropic API
  key, so its usage bills to that key instead of your subscription.
- **Spawn child sessions with a handoff note** — start a child in its own context, seeded with just
  enough detail to pick up the idea, without staining the context you are working in.

## Requirements

- macOS on Apple Silicon.
- The Claude Code CLI, installed and working.
- Either a Claude subscription or an Anthropic API key.

## Install

Download the signed and notarized `.dmg` from the Releases page. This is the recommended path; the
maintainer publishes notarized builds.

Otherwise, build from source.

## Build from source

Requires Node (with npm).

```
npm install
npm run dev      # run in development
npm run build    # build to out/
npm run dist     # build and package a .dmg / .zip into release/
```

`npm run dist` runs electron-builder with signing and notarization enabled. That requires the
maintainer's Apple Developer credentials (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
`APPLE_TEAM_ID`), so third-party builds will be unsigned. An unsigned build still runs locally after
you clear Gatekeeper on it.

## Expectations

This is a solo project.

It integrates with parts of Claude Code that are not public API: the transcript file format, the
session registry files, hook payload shapes, and terminal rendering behavior. Those change between
Claude Code releases without notice. Breakage after an upstream release is expected and normal, not
a sign the project is abandoned.

Pull requests are welcome, especially compatibility fixes for new Claude Code versions. There is no
support SLA. Issues may sit.

## Security

The app stores Anthropic API keys and modifies your global `~/.claude/settings.json`. See
[`SECURITY.md`](SECURITY.md) for what it does, how to report a vulnerability, and the known residual
risk of running a session on a metered key.

## License

Apache-2.0. See [`LICENSE`](LICENSE).
