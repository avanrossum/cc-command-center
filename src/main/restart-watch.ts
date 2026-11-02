// The supervisor's own restart of a session (MIP2-1512; gate pass 19, M-1).
// Claude Code's supervisor restarts a background session whose process exits
// before the session settles, on the launch options it saved, about 10 s
// after the exit, with a new pid under the same sessionId and a later
// `startedAt`. No field marks it, and daemon.log has no line per restart
// (Research MIP2-1527, Claude Code 2.1.312). After three crashes within 5 s
// of spawn it settles `failed` and stops restarting.
//
// So every new process the app sees is checked, whoever started it (D-043
// prototype): a changed pid, and a first sighting the app hasn't verified.
// Each runs the restart verdict, the check every restart the app starts
// already passed (restart.ts), so the app's own restarts pass it a second
// time, and nothing has to tell them apart from the supervisor's; a refusal
// stops the session and marks it untrusted. Not confirmed by Research: a
// kill mid-turn, and whether a crash later than 5 s after spawn resets the
// count. The watch covers both, since it looks only at the process changing.

/**
 * How long a session that left the list keeps its last pid. During a restart
 * Claude Code can list the job under another sessionId for a poll, then under
 * its own again with the new pid (QA, MIP2-1570); that change is still seen.
 */
export const ABSENT_KEEP_MS = 60_000

export interface ProcessSeen {
  sessionId: string
  /** null while no process runs it, or while the reading is stale. */
  pid: number | null
  startedAt: number
  /** The reading is stale: the pid is unknown, not absent, so it says nothing about a stop (gate pass 24, M-3). */
  stale?: boolean
}

export class RestartWatch {
  private readonly seen = new Map<string, { pid: number; startedAt: number; goneAt?: number; stopped?: boolean }>()
  /**
   * The first sightings of the last poll that no check covers (gate pass 20,
   * M-1): a process other than the last one the app verified (by its start,
   * compared for equality, so a clock set back doesn't hide one; pass 21,
   * L-1), or with none verified. The app may have been closed when the
   * supervisor restarted it, or the session out of the list longer than
   * ABSENT_KEEP_MS.
   */
  unverified: string[] = []
  /**
   * Refused processes, by pid, while the watch remembers the session: their
   * stop may have failed (gate pass 27, M-2). Dropped only when the session
   * is listed with another process, or the watch forgets it after
   * ABSENT_KEEP_MS; a missed listing or one with no pid doesn't clear it
   * (gate pass 28, M-1; pass 29, M-1).
   */
  private readonly refusedPid = new Map<string, number>()
  /** The refused processes the last poll still listed: never verified, and stopped again (gate pass 27, M-2). */
  stillRefused: string[] = []

  /**
   * `verifiedStart`: the `startedAt` of the session's last verified process,
   * kept across app starts; without it, first sightings aren't checked.
   * `isRefusedStart`: whether a process with this `startedAt` was refused, kept
   * across app starts until a resume from the app clears it: that process,
   * first seen after a restart of the app, is still refused, with no new
   * verdict to pass on options rewritten meanwhile (gate pass 28, M-1).
   * `refusesNextProcess`: the store flagged the session's next first
   * sighting as refused (refuseNextProcess): a mark from before refused starts were
   * kept, a refusal the watch couldn't place, or a dropped refused start
   * (gate pass 29, L-1; pass 30, M-2; pass 31).
   */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly verifiedStart?: (sessionId: string) => number | undefined,
    private readonly isRefusedStart?: (sessionId: string, startedAt: number) => boolean,
    private readonly refusesNextProcess?: (sessionId: string) => boolean,
  ) {}

  /**
   * The check refused the session's current process; it's kept refused while
   * that pid is listed (gate pass 27, M-2). Returns its `startedAt`, for the
   * store to keep; undefined when the watch has no live process for it, never
   * seen, stopped or gone, so the refusal falls on the next one instead
   * (gate pass 33, M-1).
   */
  refuse(sessionId: string): number | undefined {
    const last = this.seen.get(sessionId)
    if (!last || last.stopped || last.goneAt !== undefined) return undefined
    this.refusedPid.set(sessionId, last.pid)
    return last.startedAt
  }

  /** Forgets the session's process, so the one it runs now is a first sighting again (gate pass 28, L-1). */
  forget(sessionId: string): void {
    this.seen.delete(sessionId)
    this.refusedPid.delete(sessionId)
  }

  /**
   * The watch saw the session's process and then a poll with none, and
   * nothing since. A stale reading isn't a stop (gate pass 24, M-3).
   */
  knownStopped(sessionId: string): boolean {
    const last = this.seen.get(sessionId)
    return last !== undefined && last.goneAt === undefined && last.stopped === true
  }

  /**
   * One poll's sessions. Returns the sessions whose process changed: a new
   * pid after an earlier one, whoever started it. A session with no process
   * keeps its last pid, so the restart after the gap is still seen; a session
   * that left the list keeps it for ABSENT_KEEP_MS, then is forgotten. A first
   * sighting is never a change; it goes into `unverified` unless the store
   * verified that very process.
   */
  observe(sessions: readonly ProcessSeen[]): string[] {
    const now = this.now()
    const changed: string[] = []
    this.unverified = []
    this.stillRefused = []
    const listed = new Set<string>()
    for (const s of sessions) {
      listed.add(s.sessionId)
      const before = this.seen.get(s.sessionId)
      const refused = this.refusedPid.get(s.sessionId)
      if (s.stale) {
        if (before) delete before.goneAt
        if (refused !== undefined) this.stillRefused.push(s.sessionId)
        continue
      }
      if (s.pid === null) {
        // No process listed: the refusal stands, so the refused pid, listed again, is still refused (gate pass 29, M-1).
        if (before) (delete before.goneAt, (before.stopped = true))
        continue
      }
      this.seen.set(s.sessionId, { pid: s.pid, startedAt: s.startedAt })
      // Any sighting of a refused process is refused, ahead of every other branch: by its pid while the watch
      // remembers it, by its saved start across a missed listing, another pid between, or an app restart, with no new
      // verdict to pass on options rewritten meanwhile (gate pass 28, M-1; pass 29, M-1).
      if (s.pid === refused || this.isRefusedStart?.(s.sessionId, s.startedAt)) {
        this.refusedPid.set(s.sessionId, s.pid)
        this.stillRefused.push(s.sessionId)
        continue
      }
      // Another process: the refusal was for one that has ended.
      this.refusedPid.delete(s.sessionId)
      // The same process: the same pid and start. A reused pid with another start is a new process (gate pass 30, L-1).
      if (before?.pid === s.pid && before.startedAt === s.startedAt) continue
      // Flagged for it (the store's refuseNextProcess): its first process seen is refused until a resume from the app clears the
      // mark, with no exemption for a start verified before (gate pass 29, L-1; pass 31, M-1).
      if (!before && this.refusesNextProcess?.(s.sessionId)) {
        this.refusedPid.set(s.sessionId, s.pid)
        this.stillRefused.push(s.sessionId)
        continue
      }
      if (!before) {
        const last = this.verifiedStart?.(s.sessionId)
        if (this.verifiedStart && (last === undefined || s.startedAt !== last)) this.unverified.push(s.sessionId)
        continue
      }
      changed.push(s.sessionId)
    }
    for (const [id, last] of this.seen) {
      if (listed.has(id)) continue
      last.goneAt ??= now
      if (now - last.goneAt > ABSENT_KEEP_MS) (this.seen.delete(id), this.refusedPid.delete(id))
    }
    return changed
  }
}

/** A refusal's reason to follow "…, and ": its first word in lower case, unless it's a name. */
export const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) && !s.startsWith('Claude') ? s[0]!.toLowerCase() + s.slice(1) : s)
