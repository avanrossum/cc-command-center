// The supervisor's own restart of a session (MIP2-1512; gate pass 19, M-1).
// Claude Code's supervisor restarts a background session whose process exits
// before the session settles, on the launch options it saved, about 10 s
// after the exit, with a new pid under the same sessionId and a later
// `startedAt`. No field marks it, and daemon.log has no line per restart
// (Research MIP2-1527, Claude Code 2.1.312). After three crashes within 5 s
// of spawn it settles `failed` and stops restarting.
//
// So the app records each restart it starts itself (resume, respawn, an
// attach to a stopped session, a move in) and watches each poll for a process change it didn't
// start. Each one runs the restart verdict, the same check every restart the
// app starts goes through (restart.ts); a refusal stops the session and marks
// it untrusted. Not confirmed by Research: a kill mid-turn, and whether a
// crash later than 5 s after spawn resets the count. The watch covers both,
// since it looks only at the process changing.

/** How long a restart the app started accounts for a process change. A resume returns once the process is up. */
export const OWN_RESTART_MS = 60_000
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
}

export class RestartWatch {
  private readonly seen = new Map<string, { pid: number; startedAt: number; goneAt?: number }>()
  private readonly own = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  /** The app is starting a process for this session; the next change within OWN_RESTART_MS is its own. */
  expect(sessionId: string): void {
    this.own.set(sessionId, this.now() + OWN_RESTART_MS)
  }

  /**
   * One poll's sessions. Returns the sessions whose process changed, a new pid
   * after an earlier one, that the app didn't start. A session with no
   * process keeps its last pid, so the restart after the gap is still seen; a
   * session that left the list keeps it for ABSENT_KEEP_MS, then is forgotten.
   */
  observe(sessions: readonly ProcessSeen[]): string[] {
    const now = this.now()
    const changed: string[] = []
    const listed = new Set<string>()
    for (const s of sessions) {
      listed.add(s.sessionId)
      const before = this.seen.get(s.sessionId)
      if (s.pid === null) {
        if (before) delete before.goneAt
        continue
      }
      this.seen.set(s.sessionId, { pid: s.pid, startedAt: s.startedAt })
      if (!before || before.pid === s.pid) continue
      const ownUntil = this.own.get(s.sessionId)
      this.own.delete(s.sessionId)
      if (ownUntil !== undefined && ownUntil >= now) continue
      changed.push(s.sessionId)
    }
    for (const [id, last] of this.seen) {
      if (listed.has(id)) continue
      last.goneAt ??= now
      if (now - last.goneAt > ABSENT_KEEP_MS) this.seen.delete(id)
    }
    for (const [id, until] of this.own) if (until < now) this.own.delete(id)
    return changed
  }
}

type Restarting = 'resume' | 'respawn' | 'attach' | 'moveIn'
const RESTARTING = new Set<string | symbol>(['resume', 'respawn', 'attach', 'moveIn'])

/**
 * The host, recording each restart the app starts with `watch` before it
 * runs. Main makes every other host from this one, so no restart the app
 * starts goes unrecorded.
 *
 * An attach starts a process only for a stopped session: Claude Code
 * restarts it when the attach command runs, after `attach` returns. So an
 * attach is recorded after it returns, and only when the session was
 * stopped. An attach to a running session, or one that fails, records
 * nothing, and the supervisor's restart of a running session in the next
 * minute is still checked (MIP2-1565).
 */
export function recordRestarts<H extends Partial<Record<Restarting, (sessionId: string, ...rest: never[]) => unknown>>>(
  host: H,
  watch: Pick<RestartWatch, 'expect'>,
  /** Whether no process runs the session, so an attach to it starts one. */
  stopped: (sessionId: string) => boolean,
  /** A session's current id for either of its ids after a /clear (MIP2-1557), so the expectation is where the poll sees it. */
  currentOf: (sessionId: string) => string = id => id,
): H {
  return new Proxy(host, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown
      if (typeof v !== 'function') return v
      if (!RESTARTING.has(prop)) return (v as (...a: unknown[]) => unknown).bind(target)
      if (prop === 'attach') {
        return async (sessionId: string, ...rest: unknown[]) => {
          const starts = stopped(sessionId)
          const command = await (v as (id: string, ...a: unknown[]) => unknown).call(target, sessionId, ...rest)
          if (starts) watch.expect(currentOf(sessionId))
          return command
        }
      }
      return (sessionId: string, ...rest: unknown[]) => {
        watch.expect(currentOf(sessionId))
        return (v as (id: string, ...a: unknown[]) => unknown).call(target, sessionId, ...rest)
      }
    },
  })
}

/**
 * What to do about a process change the app didn't start: nothing when the
 * verdict passes; otherwise the reason the session is stopped and marked
 * with, which the security band lists with the session.
 */
export function unexplainedRestart(sessionId: string, verdict: (sessionId: string) => string | null): string | null {
  const why = verdict(sessionId)
  return why === null ? null : `Claude Code restarted it by itself, and ${lowerFirst(why)}`
}

const lowerFirst = (s: string) => (/^[A-Z][a-z]/.test(s) && !s.startsWith('Claude') ? s[0]!.toLowerCase() + s.slice(1) : s)
