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
