// Per-card summaries of the last turn (MIP2-1422), shared by main and the window.

import type { SessionSnapshot } from '@ccc/contract'

export interface TurnSummary {
  /** One line of plain text from the model. Untrusted: shown as text, never followed. */
  text: string
  /** The `at` of the turn it summarizes (the mod's clock at turn end), to match it to the card's turn. */
  turnAt: number
  /** The turn's own last question or line, read locally for a category not opted in; shown as `Last line: "…"` (MIP2-1485). */
  lastLine?: true
}

/** Characters of a local excerpt kept for the card. */
export const LAST_LINE_CHARS = 160

/** Characters from the end of the turn that lastQuestion reads; a question to Alex is near the end (gate pass 15, M-1). */
export const LAST_LINE_SCAN = 2_000

/**
 * The turn's last question, else its last line, clipped (MIP2-1485). Read
 * locally for a category that doesn't share text with the Arbiter, and
 * never sent anywhere. Null for an empty turn. It reads only the turn's
 * last LAST_LINE_SCAN characters and scans them once: the last `?`, back to
 * the `.`, `!` or `?` before it. A turn can be 200,000 characters, and this
 * runs on the main thread (gate pass 15, M-1).
 */
export function lastQuestion(text: string): string | null {
  const lines = text.slice(-LAST_LINE_SCAN).split('\n').map(l => l.trim()).filter(Boolean)
  if (!lines.length) return null
  const flat = lines.join(' ')
  const q = flat.lastIndexOf('?')
  const start = q < 0 ? -1 : Math.max(flat.lastIndexOf('.', q - 1), flat.lastIndexOf('!', q - 1), flat.lastIndexOf('?', q - 1))
  const pick = (q < 0 ? lines.at(-1)! : flat.slice(start + 1, q + 1)).replace(/\s+/g, ' ').trim()
  // eslint-disable-next-line no-control-regex
  const clean = pick.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
  // A long sentence keeps its end, where the question is.
  return clean.length > LAST_LINE_CHARS ? `…${clean.slice(-(LAST_LINE_CHARS - 1))}` : clean
}

/**
 * Blocked on Alex with nothing saying why and nothing the card can answer:
 * most often a turn that ended with a question (MIP2-1426). Its card gets
 * the Arbiter's wait line where the category allows it (MIP2-1485).
 */
export function blockedOnAlex(s: Pick<SessionSnapshot, 'needsYou' | 'pendingRequests'>): boolean {
  const n = s.needsYou.value
  return n?.kind === 'blocked' && !n.detail && !s.pendingRequests?.value.length
}
