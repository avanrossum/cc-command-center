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
