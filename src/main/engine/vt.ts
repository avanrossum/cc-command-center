// Terminal modes a session turns on ONCE and never repeats — no Electron, no fs, so
// the tracking can be exercised against real captured bytes.
//
// The problem this solves: the renderer rebuilds its xterm from scratch on every
// session switch (the component is keyed on the session), and re-attach replays only
// the capped output buffer. A mode the session set before that window has scrolled out
// is therefore LOST, and the fresh terminal silently behaves as though the session
// never asked for it. Nothing errors; the keyboard just quietly does something else.
//
// Verified against Claude Code 2.1.220: it pushes the kitty keyboard protocol as
// `ESC [ > 1 u` at byte 47 of its startup output and never emits it again. That mode
// is what makes Shift+Enter insert a newline instead of submitting — so on any session
// that had produced more than the buffer cap, switching to it broke Shift+Enter. The
// failure tracked cumulative output volume, which is why it looked random.

export interface VtModes {
  // Kitty keyboard protocol — governs what the terminal SENDS for Shift+Enter.
  kitty: string
  // Bracketed paste — governs whether a paste is wrapped in markers. Lost the same
  // way, with a failure of the same shape: a pasted newline submits instead of
  // being taken as text.
  bracketedPaste: string
}

export const NO_MODES: VtModes = { kitty: '', bracketedPaste: '' }

// Fold a chunk of PTY output into the running mode state. Tracks the CURRENT setting,
// not a history: a session that pushes and later pops ends with the mode off, and that
// is what gets re-asserted.
export function nextModes(cur: VtModes, chunk: string): VtModes {
  let { kitty, bracketedPaste } = cur
  // CSI > flags u  pushes the kitty protocol; CSI < n u  pops it back off.
  const k = [...chunk.matchAll(/\x1b\[[<>][0-9;]*u/g)].pop()
  if (k) kitty = k[0][2] === '>' ? k[0] : ''
  // CSI ? 2004 h  enables bracketed paste;  l  disables it.
  const b = [...chunk.matchAll(/\x1b\[\?2004[hl]/g)].pop()
  if (b) bracketedPaste = b[0].endsWith('h') ? b[0] : ''
  return kitty === cur.kitty && bracketedPaste === cur.bracketedPaste
    ? cur
    : { kitty, bracketedPaste }
}

// What to write into a freshly-built terminal before replaying its scrollback, so it
// starts in the state the session actually established. Only ever replays modes the
// session itself set — it cannot invent one, so a session that never asked for kitty
// keyboard does not suddenly get it.
export function modePrelude(m: VtModes): string {
  return `${m.kitty}${m.bracketedPaste}`
}
