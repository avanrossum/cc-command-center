// Pure helpers for the awareness bus — no Electron, no fs — so the two decisions
// that fail SILENTLY when they are wrong can be exercised without booting the app.
// (A broken spool-name round-trip means a restart quietly stops re-claiming mail; a
// target lookup that picks the dead row means a message stalls forever with no log.)
import type { LiveSession } from './types'

// A spooled payload is named "<outboxToken>__<claimedAt>-<n>.msg". The token is the
// stable identity a session carries across resume, so the suffix has to be strippable
// again — the whole point of the spool is that a restart can re-claim what is in it.
// The "__" separator is deliberate: a token is itself "cc-<ts>-<n>", so a plain "-"
// would make a spool name indistinguishable from an outbox name (both parse, both
// wrong), and the failure would be a silent mis-keyed re-claim.
export function spoolName(token: string, claimedAt: number, n: number): string {
  return `${token}__${claimedAt}-${n}.msg`
}

// Inverse of spoolName. Returns undefined when the file is not one of ours, so a
// stray file in the spool directory is left alone rather than held under a bogus token.
export function tokenFromSpoolName(file: string): string | undefined {
  const m = /^(.+)__\d+-\d+\.msg$/.exec(file)
  return m ? m[1] : undefined
}

// Roughly how many characters sit unsent in a session's input box, updated from the
// raw bytes the human typed. The bus only asks "is the box empty?", and every
// ambiguity here resolves toward "not empty" — that defers a message rather than
// corrupting a draft, because delivery is a bracketed paste followed by a CR and
// would otherwise send the half-written prompt along with it.
//
// Deliberately NOT derived from the terminal buffer: Claude Code repaints its UI
// differentially and buffer scanning has broken twice on upstream releases, whereas
// the bytes a key produces are exact and upstream cannot change them.
export function nextDraft(draft: number, data: string): number {
  if (!data) return draft
  // A bare Enter submits the box. Only an EXACT bare CR/LF counts: Shift+Enter
  // (newline, no submit) arrives as a kitty CSI-u sequence, or as ESC+CR without it —
  // neither is exactly "\r", so neither wrongly clears a multi-line draft.
  if (data === '\r' || data === '\n' || data === '\r\n') return 0
  if (data === '\x03' || data === '\x15' || data === '\x1b') return 0 // Ctrl-C, Ctrl-U, Esc
  // A pasted block — including the app's own path insertion and drag-and-drop, which
  // go through the same handler and do put text in the box.
  let pasted = 0
  for (const m of data.matchAll(/\x1b\[200~([\s\S]*?)\x1b\[201~/g)) pasted += m[1].length
  if (pasted) return draft + pasted
  if (data.startsWith('\x1b')) return draft // arrows, function keys, key encodings
  let n = draft
  for (const ch of data) {
    if (ch === '\x7f' || ch === '\b') n = Math.max(0, n - 1)
    else if (ch.codePointAt(0)! >= 0x20) n++
  }
  return n
}

// Resolve a delivery target, preferring the ALIVE row. A resumed session yields a dead
// and a live record under one session id; a dead row's state is always 'unknown', which
// never passes the free-target gate, so picking it stalls the message permanently. The
// enrich dedup and the pending-new guards already prefer alive — the delivery bus was
// the one lookup in the app that didn't.
export function resolveTargetSession(
  sessions: LiveSession[],
  id: string,
): LiveSession | undefined {
  let dead: LiveSession | undefined
  for (const s of sessions) {
    if (s.sessionId !== id) continue
    if (s.alive) return s
    dead ??= s
  }
  return dead
}
