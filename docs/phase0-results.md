# Phase 0 — Results

Phase 0 proved the two riskiest unknowns for the desktop-app substrate. Spike code lives in `spike/`. Verified 2026-07-07 on macOS, Claude Code v2.1.202, Electron 43, `@xterm/xterm` 6.0.0, `node-pty` 1.1.0.

## Terminal host — PASS

The Claude Code TUI renders cleanly through xterm.js 6.0 (WebGL) + node-pty inside Electron:

- Full alt-screen UI (welcome box, two-column layout, mascot, status bar) — no garble.
- Truecolor, bold/dim, unicode, rounded box-drawing, progress bars.
- The working spinner animates in place (single line, no scroll stacking). The failure mode below xterm 6.0 does not occur.
- Streaming markdown output renders correctly.
- Resize → SIGWINCH → reflow works; the alt-screen repaints at the new size.
- `node-pty` rebuilt for Electron 43 via `@electron/rebuild`; launches with no ABI error.

Verified by having the Electron main process capture its own web contents (`webContents.capturePage`) during a driven session.

Build gotchas: current versions are Electron 43 (not 42) and `electron-vite` 5 (peer-requires `vite <= 7`, so `vite` 8 fails ERESOLVE — pin `vite ^7`). The `electron` npm postinstall did not download the binary during `npm install`; run `node node_modules/electron/install.js` manually.

## Prompt injection (send-keys) — PARTIAL, as expected

Writing a raw carriage return (`\r`) to the pty does NOT submit — Ink treats it as a newline. Submitting requires bracketed-paste of the text (`ESC[200~ … ESC[201~`) followed by a SEPARATE `\r`. That sequence submits reliably. This matches research Fact 3 and is the mechanism for the Phase 5 send-keys fallback.

## Channels inject — BLOCKED in this environment

Built a spec-compliant custom channel MCP server (`spike/cc-channel.mjs`): declares `capabilities.experimental['claude/channel']`, exposes a `cc_ack` reply tool, listens on `127.0.0.1:8799`, and injects POST bodies via `notifications/claude/channel`. Registered via `spike/channel-test/.mcp.json` and launched with `claude --dangerously-load-development-channels server:ccc`.

Result: the server connects over stdio (MCP handshake succeeds, HTTP health OK) and each notification is written to the transport, but Claude never processes it — a POST does not create a session turn (no transcript activity in a ready, idle session). The message is silently dropped.

The symptom (server connects and its tools register, but channel messages don't arrive) has two possible causes, and this test cannot distinguish them from outside:

1. **Bug #71792** — dev-flag channel notifications silently dropped.
2. **Org policy** — `channelsEnabled` disabled. The account's banner shows a Team/Enterprise Organization. When the policy is off, the MCP server still connects and its tools work, but channel messages don't arrive. An Owner enables it at claude.ai → Admin settings → Claude Code → Channels.

**Verdict:** v1 cross-session send (inject / broadcast) ships on the **send-keys fallback** (bracketed-paste + separate Enter, verified above). Revisit Channels once the cause is resolved — the bug is fixed, or, if the account owns the org, channels are enabled for it.

A clean re-test requires launching `claude` with `--dangerously-load-development-channels`. The agent's auto-mode blocks that flag for review, so re-testing needs a manually approved run.

## Phase 0 status: COMPLETE

Terminal host proven; send-keys submit sequence known; Channels verdict recorded. The desktop-app bet is de-risked. Next: the real (non-spike) app — state engine, registry, and adoption (roadmap Phases 1–3).
