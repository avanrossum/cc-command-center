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

  /** Whether a stop of the session is running and still blocks another (gate pass 35, L-1). */
  running(sessionId: string): boolean {
    const r = this.state.get(sessionId)
    return !!r && r.running && this.now() - r.since < this.max
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

/** Where a refusal is booked (gate pass 31, M-2). */
export interface RefusalBook {
  /** RestartWatch.refuse: the refused process's start, or undefined when the watch has no live process for it. */
  refuse: (sessionId: string) => number | undefined
  /** RestartWatch.forget: the session's next process is a first sighting, which the store's flag refuses. */
  forget: (sessionId: string) => void
  /** The store's list of refused starts; returns a start dropped to keep the list's size. */
  recordRefusedStart: (sessionId: string, startedAt: number) => number | undefined
  /** StopRetries.seed: the refusal's own stop is starting. */
  seed: (sessionId: string) => void
  /** No live process to refuse: the store refuses the session's next first sighting instead. */
  refuseNextSighting: (sessionId: string) => void
  /** LiftedRefusals.drop: a refusal booked during a resume withdraws the resume's lift (gate pass 36, M-1). */
  dropLift: (sessionId: string) => void
  note: (what: string, data: Record<string, unknown>) => void
}

/**
 * Books a refusal before its stop, the restart check's and a channel tamper
 * mark's alike (gate pass 31, M-2): the process is kept refused by pid and by
 * start, so a failed stop is retried and an app restart doesn't admit it,
 * and the retries wait for this stop.
 */
export function bookRefusal(sessionId: string, d: RefusalBook): void {
  d.dropLift(sessionId)
  const startedAt = d.refuse(sessionId)
  // A mark raised with no live process seen, as while the hub recovers channels or after the process stopped: the
  // session's next process is refused at its first sighting, whatever start the store verified before the mark. The
  // watch forgets the stopped one, so that next process is a first sighting (gate pass 33, M-1).
  if (startedAt === undefined) (d.forget(sessionId), d.refuseNextSighting(sessionId))
  const dropped = startedAt !== undefined ? d.recordRefusedStart(sessionId, startedAt) : undefined
  if (dropped !== undefined) d.note('refused-start-dropped', { sessionId, startedAt: dropped })
  d.seed(sessionId)
}

/** The refusal paths main wires (gate pass 34, M-1). */
export interface Refusals {
  /** Books the refusal, then stops the session with `told` as its notice, unless a stop of it is running. */
  refuseAndStop: (sessionId: string, told: string) => void
  /** A restart the verdict refused: marked through its channel when it has one, else marked and stopped here. */
  markRestarted: (sessionId: string, why: string) => void
  /** The hub's onUntrusted: a channel marked for tampering or a refused restart. */
  onUntrusted: (sessionId: string | null, why: string) => void
}

/**
 * Every refusal, the restart check's or a channel mark's, ends booked
 * (bookRefusal) and stopping, whichever way it comes: through the hub's
 * onUntrusted when the session has a channel, or here when
 * `markChannel` (ChannelHub.markSession) reports none (gate pass 31, M-2;
 * pass 34, M-1).
 */
export function refusals(d: {
  book: RefusalBook
  stop: (sessionId: string, told: string) => void
  /** StopRetries.running: a stop of the session is under way. */
  stopRunning: (sessionId: string) => boolean
  markStore: (sessionId: string, why: string) => void
  notice: (text: string) => void
  markChannel: (sessionId: string, why: string) => boolean
}): Refusals {
  // One stop at a time: a refusal booked while a stop is running is recorded and logged, and that stop, or the retries
  // after it, covers it (gate pass 35, L-1; pass 36, L-2). Returns whether it started a stop.
  const refuseAndStop = (id: string, told: string): boolean => {
    const running = d.stopRunning(id)
    bookRefusal(id, running ? { ...d.book, seed: () => {} } : d.book)
    if (running) d.book.note('refusal-coalesced', { sessionId: id })
    else d.stop(id, told)
    return !running
  }
  const markHere = (id: string, why: string, told: string) => {
    d.markStore(id, why)
    const started = refuseAndStop(id, told)
    d.notice(started ? `Stopping a session: ${why}.` : `A session is already being stopped, and the app keeps trying: ${why}.`)
  }
  return {
    refuseAndStop: (id, told) => void refuseAndStop(id, told),
    markRestarted: (id, why) => {
      if (!d.markChannel(id, why)) markHere(id, why, `${why}.`)
    },
    // A channel with no session bound has no session to stop or book.
    onUntrusted: (id, why) => {
      if (id) markHere(id, why, `${why}. Resuming it from the app gives its channel a new secret first.`)
    },
  }
}

/**
 * The stops queued while channels recovered, run once the host exists
 * (gate pass 33, L-1; pass 34, L-2; pass 35, L-2; pass 37, L-1). Each
 * session's stop starts at once, and its end finishes the retry entry its
 * refusal seeded. The list is read alongside, only for the notices: a
 * session listed with a process is told whether it stopped. A list that
 * can't be read sends none.
 */
export function runQueuedStops(
  queued: readonly { id: string; told?: string }[],
  d: {
    running: () => Promise<ReadonlySet<string>>
    stop: (sessionId: string) => Promise<boolean>
    finish: (sessionId: string, stopped: boolean) => void
    notice: (told: string, stopped: boolean) => void
  },
): Promise<void> {
  if (!queued.length) return Promise.resolve()
  // Once per session, with the first notice queued for it.
  const ids = new Set<string>()
  const once = queued.filter(q => !ids.has(q.id) && !!ids.add(q.id))
  const listed = d.running().catch(() => new Set<string>())
  return Promise.all(
    once.map(({ id, told }) =>
      d.stop(id).then(stopped => {
        d.finish(id, stopped)
        if (told) void listed.then(running => running.has(id) && d.notice(told, stopped))
      }),
    ),
  ).then(() => {})
}
