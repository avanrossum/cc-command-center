// One poll's restart checks on the sessions the app launched (gate pass 20,
// M-1; pass 21, L-4; pass 22). Pure, so main runs it and tests drive it.
//
// A process change the app didn't start (`changed`) and a process no check
// covered (`unverified`: started while the app was closed, before its first
// poll, or after a long absence) each run the restart verdict; any refusal
// stops the session and marks it, settings Alex could confirm included. He
// confirms those with "Resume with these settings" when he resumes it
// (D-042). Every other running process is recorded as verified.

import { lowerFirst, type ProcessSeen } from './restart-watch.ts'

export interface PollInput {
  processes: readonly ProcessSeen[]
  /** Process changes the app didn't start (RestartWatch.observe). */
  changed: readonly string[]
  /** First sightings no check covered (RestartWatch.unverified). */
  unverified: readonly string[]
  /** Processes an earlier poll refused, still listed: their stop failed (RestartWatch.stillRefused; gate pass 27, M-2). */
  stillRefused?: readonly string[]
}

export interface PollDeps {
  /** The restart verdict: null, or why it refuses. */
  verdict: (sessionId: string) => string | null
}

/** Why the session was stopped, for the command log: a refusal of each kind, or a check that threw (gate pass 25, L-2). */
export type StopNote = 'unexplained-restart' | 'unchecked-start' | 'restart-check-failed'

export interface PollResult {
  /** `error`: for a check that threw, the error on one line, for the command log only. */
  stop: { sessionId: string; why: string; note: StopNote; error?: string }[]
  /** The starts to record as verified: every running process not stopped or still refused. */
  verified: [sessionId: string, startedAt: number][]
  /** Refused processes still running, to stop again (gate pass 27, M-2). */
  retry: string[]
}

/**
 * The verdict, failing closed: a check that throws refuses (gate pass 24,
 * M-2), since the watch has already taken this process change and a throw
 * that escaped would leave it unchecked for good. The reason the session
 * shows says only that the check failed; the error, which may hold paths,
 * goes to the command log on one line, which caps it (gate pass 25, L-2;
 * pass 26, L-3).
 */
function verdictOf(id: string, deps: PollDeps): { why: string | null; error?: string } {
  try {
    return { why: deps.verdict(id) }
  } catch (err) {
    const error = (err instanceof Error ? `${err.name}: ${err.message}` : String(err)).replace(/\s+/g, ' ')
    return { why: 'the restart check failed', error }
  }
}

export function restartPoll(input: PollInput, deps: PollDeps): PollResult {
  const stop: PollResult['stop'] = []
  const stopped = new Set<string>()
  const halt = (sessionId: string, why: string, note: StopNote, error?: string) => {
    stop.push({ sessionId, why, note: error ? 'restart-check-failed' : note, ...(error ? { error } : {}) })
    stopped.add(sessionId)
  }
  for (const id of input.changed) {
    const v = verdictOf(id, deps)
    if (v.why) halt(id, `Claude Code restarted it by itself, and ${lowerFirst(v.why)}`, 'unexplained-restart', v.error)
  }
  for (const id of input.unverified) {
    if (stopped.has(id)) continue
    const v = verdictOf(id, deps)
    if (v.why) halt(id, `Claude Code started it while the app wasn't checking, and ${lowerFirst(v.why)}`, 'unchecked-start', v.error)
  }
  const retry = (input.stillRefused ?? []).filter(id => !stopped.has(id))
  const held = new Set([...stopped, ...retry])
  const verified = input.processes.flatMap(p => (p.pid !== null && !held.has(p.sessionId) ? [[p.sessionId, p.startedAt] as [string, number]] : []))
  return { stop, verified, retry }
}

/**
 * When to stop a refused process again (gate pass 28, L-2; pass 29, L-2,
 * L-3; pass 30, M-1): one stop at a time per session, the refusal's own
 * stop included, the first retry `first` ms after that stop finishes, then
 * twice as long after each failure, up to `max`. A
 * retry re-keys the channel only while no re-key has finished since the
 * refusal. A session no longer refused is forgotten, unless a stop for it
 * is still running.
 */
export class StopRetries {
  private readonly state = new Map<string, { next: number; delay: number; running: boolean; since: number; rekeyed: boolean }>()

  constructor(
    private readonly first = 2_000,
    private readonly max = 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** The refusal's own stop is starting: it counts as running, so no retry starts before it finishes (gate pass 30, M-1). */
  seed(sessionId: string): void {
    this.state.set(sessionId, { next: this.now() + this.first, delay: this.first, running: true, since: this.now(), rekeyed: false })
  }

  /** Whether a stop may start now; if so, it's counted as running. A stop running longer than `max` no longer blocks one. */
  start(sessionId: string): boolean {
    const now = this.now()
    const r = this.state.get(sessionId) ?? { next: now, delay: this.first, running: false, since: now, rekeyed: false }
    this.state.set(sessionId, r)
    if ((r.running && now - r.since < this.max) || now < r.next) return false
    r.running = true
    r.since = now
    return true
  }

  /** The stop finished; after a failure the wait doubles. Returns the wait before the next attempt. */
  finish(sessionId: string, stopped: boolean): number | undefined {
    const r = this.state.get(sessionId)
    if (!r) return undefined
    r.running = false
    if (!stopped) r.delay = Math.min(r.delay * 2, this.max)
    r.next = this.now() + r.delay
    return r.delay
  }

  /** A re-key of the session's channel finished. */
  rekeyed(sessionId: string): void {
    const r = this.state.get(sessionId)
    if (r) r.rekeyed = true
  }

  /** Whether a retry should re-key: no re-key has finished since the refusal. */
  needsRekey(sessionId: string): boolean {
    return !this.state.get(sessionId)?.rekeyed
  }

  /** Keeps only the sessions still refused, and any whose stop is still running. */
  keep(sessionIds: readonly string[]): void {
    for (const [id, r] of this.state) if (!r.running && !sessionIds.includes(id)) this.state.delete(id)
  }
}
