// A /clear in a background session (MIP2-1557, Research MIP2-1556): Claude
// Code keeps the job (short id) and its process (pid) and gives it a new
// sessionId. The old id leaves \`agents --json\`; the new one appears on the
// same row. Pure, so main decides from it and tests run it directly.

export interface JobSeen {
  sessionId: string
  shortId: string
  pid: number | null
}

/**
 * The sessions whose id changed under the same job and process since the
 * last poll: same short id, same pid, a new sessionId, and the old one no
 * longer listed. Main then checks the mod said so too before moving
 * anything.
 *
 * A /clear always gives a new sessionId. A return to an id the job had
 * before is Claude Code listing the job under another id for a poll during a
 * restart, then under its own again (QA, MIP2-1570), and isn't reported.
 */
export class ClearWatch {
  private readonly byJob = new Map<string, { sessionId: string; pid: number; ids: Set<string> }>()

  observe(sessions: readonly JobSeen[]): { from: string; to: string }[] {
    const listed = new Set(sessions.map(s => s.sessionId))
    const moved: { from: string; to: string }[] = []
    for (const s of sessions) {
      const before = this.byJob.get(s.shortId)
      if (s.pid === null) continue
      const back = before?.ids.has(s.sessionId) ?? false
      if (before && !back && before.pid === s.pid && before.sessionId !== s.sessionId && !listed.has(before.sessionId)) moved.push({ from: before.sessionId, to: s.sessionId })
      this.byJob.set(s.shortId, { sessionId: s.sessionId, pid: s.pid, ids: (before?.ids ?? new Set()).add(s.sessionId) })
    }
    const jobs = new Set(sessions.map(s => s.shortId))
    for (const id of this.byJob.keys()) if (!jobs.has(id)) this.byJob.delete(id)
    return moved
  }
}

/** How long a /clear waits for its session's mod to say so before the app gives it up (MIP2-2072). */
export const CLEAR_CONFIRM_MS = 2 * 60_000

/**
 * The /clears waiting for their mod's word (MIP2-2072). ClearWatch reports a
 * move once, on the poll that sees the new id; the mod's `session.end` can
 * reach its channel a poll or two later. Seen live on 2026-11-20: the move
 * was skipped as unconfirmed and the session lost. A move waits here and is
 * tried each poll while the new id is still listed and the old one isn't,
 * until its mod confirms it or CLEAR_CONFIRM_MS passes.
 */
export class ClearConfirm {
  private readonly waiting = new Map<string, { to: string; since: number; via: string[] }>()

  /**
   * This poll's moves and the ones still waiting: `move` the confirmed ones,
   * `gaveUp` the ones past CLEAR_CONFIRM_MS or no longer in place, and
   * `waiting` the rest, which are tried again next poll. `fresh` holds the
   * ones first seen this poll.
   */
  step(
    found: readonly { from: string; to: string }[],
    now: number,
    confirmed: (from: string) => boolean,
    inPlace: (from: string, to: string) => boolean,
  ): { move: { from: string; to: string; via: string[] }[]; gaveUp: { from: string; to: string }[]; fresh: { from: string; to: string }[] } {
    const fresh: { from: string; to: string }[] = []
    for (const m of found) {
      if (this.waiting.has(m.from)) continue
      // A second /clear while the first waits (A to B, then B to C): one move, A to C, judged by A's mod and timed from
      // A's wait, since B never held the record or the channel (gate pass 63, M-1).
      const earlier = [...this.waiting].find(([, w]) => w.to === m.from)
      // The id passed through goes with the move, for the record's former ids and to drop its stub (gate pass 64, M-1).
      if (earlier) (earlier[1].via.push(m.from), (earlier[1].to = m.to))
      else (this.waiting.set(m.from, { to: m.to, since: now, via: [] }), fresh.push(m))
    }
    const move: { from: string; to: string; via: string[] }[] = []
    const gaveUp: { from: string; to: string }[] = []
    for (const [from, w] of this.waiting) {
      const m = { from, to: w.to }
      if (!inPlace(from, w.to)) (gaveUp.push(m), this.waiting.delete(from))
      else if (confirmed(from)) (move.push({ ...m, via: w.via }), this.waiting.delete(from))
      else if (now - w.since > CLEAR_CONFIRM_MS) (gaveUp.push(m), this.waiting.delete(from))
    }
    return { move, gaveUp, fresh: fresh.filter(m => this.waiting.has(m.from)) }
  }

  /** Where a held old id, or an id it passed through, is moving to; undefined for any other (gate pass 64, L-2). */
  pendingTo(id: string): string | undefined {
    for (const [from, w] of this.waiting) if (from === id || w.via.includes(id)) return w.to
    return undefined
  }

  /** The old ids waiting for their mod's word: their records aren't removed meanwhile (gate pass 63, L-1). */
  holding(): ReadonlySet<string> {
    return new Set(this.waiting.keys())
  }
}

