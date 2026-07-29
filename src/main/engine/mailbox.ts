// Pure helpers for the awareness bus — no Electron, no fs — so the two decisions
// that fail SILENTLY when they are wrong can be exercised without booting the app.
// (A broken spool-name round-trip means a restart quietly stops re-claiming mail; a
// target lookup that picks the dead row means a message stalls forever with no log.)
import type { LiveSession } from './types'

// Just enough of a registry edge to route on, so this module stays free of the DB.
export interface RoutableEdge {
  parent_id: string
  child_id: string
  trusted?: number | boolean | null
}

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

// A quoted address is an explicit claim about WHO the message is for. When it names
// nothing, the honest outcome is a failure the sender is told about — not a guess.
// (A BARE "@word" is different: it may just be the message starting with an @, so a
// miss there still falls through to the parent, which is the documented behaviour
// that lets "@scoped/pkg …" reach the parent instead of vanishing.)
export type DirectedResult =
  | { kind: 'match'; child: LiveSession; body: string; trusted: boolean }
  | { kind: 'unknown'; wanted: string; candidates: string[] }
  | undefined

export function matchDirectedChild(
  sessions: LiveSession[],
  edges: RoutableEdge[],
  senderId: string,
  rest: string,
  // Every address a session answers to, most stable FIRST: its immutable alias, then
  // its display name. Injected rather than imported so this can be exercised without
  // the registry — resolution is where addressing goes wrong silently.
  handlesOf: (s: LiveSession) => string[],
): DirectedResult {
  const kids: { child: LiveSession; trusted: boolean }[] = []
  for (const e of edges) {
    if (e.parent_id !== senderId) continue
    const child = sessions.find((s) => s.sessionId === e.child_id)
    if (child) kids.push({ child, trusted: !!e.trusted })
  }
  // Quoted form: @"Multi Word Name" body. Quotes delimit the name unambiguously,
  // so a name with spaces routes even though a bare @name assumes a single token.
  // This is the form we instruct parents to use (see parentBlessNote / preamble).
  const q = rest.match(/^"([^"]+)"[\s:,-]*/)
  if (q) {
    const wanted = q[1].trim().toLowerCase()
    for (const { child, trusted } of kids) {
      if (handlesOf(child).some((h) => h.toLowerCase() === wanted)) {
        return { kind: 'match', child, body: rest.slice(q[0].length).trim(), trusted }
      }
    }
    // A named session that has since ended takes its edge with it (edges cascade on
    // node delete), so "the child I was talking to yesterday" lands here.
    return {
      kind: 'unknown',
      wanted: q[1].trim(),
      candidates: kids.map((k) => handlesOf(k.child)[0]).filter(Boolean),
    }
  }
  // Bare form: longest display-name prefix, requiring a word boundary after (so
  // "@apidoc" can't match a child named "a"). Works when the name is reproduced
  // verbatim (incl. spaces); single-word names are the common case.
  let best: { kind: 'match'; child: LiveSession; body: string; trusted: boolean } | undefined
  let bestLen = 0
  const lower = rest.toLowerCase()
  for (const { child, trusted } of kids) {
    for (const nm of handlesOf(child)) {
      if (!nm || !lower.startsWith(nm.toLowerCase())) continue
      const after = rest.charAt(nm.length) // '' at end-of-string is fine (exact match)
      if (after && !/[\s:,]/.test(after)) continue // reject mid-word prefix hits
      if (nm.length <= bestLen) continue
      bestLen = nm.length
      best = {
        kind: 'match',
        child,
        body: rest.slice(nm.length).replace(/^[\s:,-]+/, '').trim(),
        trusted,
      }
    }
  }
  return best
}


// Reserved addresses, recognised before any peer lookup so no session can ever claim
// one by naming itself after it.
//
// @user reaches the HUMAN's inbox and is injected into no session at all. It gives a
// session a way to raise something without spending a peer's turn, and because it can
// never reach a peer it adds no fan-out — which is why it is safe to hand out before
// per-session budgets exist.
// Two exact forms only: the quoted "user", or bare `user` followed by end-of-string
// or a separator that cannot be part of a name. A hyphen is NOT such a separator —
// allowing it made a peer legitimately named "user-docs" resolve as the human, which
// would silently swallow its mail.
const USER_ADDR = /^(?:"user"|user(?=$|[\s:,]))/i
export function isUserAddress(rest: string): boolean {
  return USER_ADDR.test(rest.trim())
}

export function stripUserAddress(rest: string): string {
  return rest.trim().replace(/^(?:"user"|user)[\s:,-]*/i, '').trim()
}

// The directory lane, on the same outbox file as everything else. Anchored to the
// whole content so a message that merely discusses "?WHO" is not a query.
export function parseQuery(content: string): { verb: string; arg: string } | undefined {
  const m = /^\?(WHO|INBOX|WHOIS)\b\s*(.*)$/i.exec(content.trim())
  return m ? { verb: m[1].toUpperCase(), arg: (m[2] ?? '').trim() } : undefined
}
