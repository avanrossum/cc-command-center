# Prompt captures

Raw PTY output from Claude Code permission dialogs, kept as regression fixtures
for the terminal-buffer scan (`renderTail` + `PROMPT_SIGNATURES` in
`src/main/index.ts`).

These exist because detection has now broken twice on upstream changes, and both
times the failure was invisible without real bytes to test against. Claude Code
repaints dialogs as DIFFERENTIAL cell updates — inter-word spaces are emitted as
absolute column jumps (`CSI…G`) and line breaks as cursor motion (`CSI…B`) — so a
stripper that deletes CSI sequences fuses words and destroys lines. Any change to
the scan should be checked against these files, not against hand-written samples.

Captured from CLI 2.1.220. Filename records the prompt kind and CLI version.

## `startup-modes-*.bin`

Raw PTY bytes from a Claude Code session's first seconds, captured with the same
`TERM_PROGRAM` identity `buildEnv` fakes (kitty support is gated on an allowlist, so
capturing without it records nothing).

These exist because **the mode is emitted once and never repeated.** Claude Code
pushes the kitty keyboard protocol as `ESC [ > 1 u` at byte 47 and never sends it
again. The renderer rebuilds its xterm on every session switch and re-attach replays
only a capped buffer, so on a session that had produced more than that cap the push
had scrolled out — the new terminal never learned the mode, and Shift+Enter submitted
instead of inserting a newline. It looked random because the trigger was cumulative
output volume.

Re-capture when the CLI bumps, and check the offset is still near the start: if
upstream ever moves the push later, or repeats it, the tracking assumptions change.
Test against these bytes, never against a hand-written sample — the same discipline as
the `prompt-*` captures, and for the same reason.
