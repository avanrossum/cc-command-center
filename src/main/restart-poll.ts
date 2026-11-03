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

  /** Whether a retry is queued for the session: its refusal seeded one, and it hasn't been let go (gate pass 51, L-1). */
  tracking(sessionId: string): boolean {
    return this.state.has(sessionId)
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
 * Books a refusal around its stop, the restart check's and a channel tamper
 * mark's alike (gate pass 31, M-2): the process is kept refused by pid and by
 * start, so a failed stop is retried and an app restart doesn't admit it,
 * and the retries wait for this stop. The bookings in memory come first,
 * then `stop`, then the store's: a store that can't save never keeps the
 * stop from being issued (gate pass 54, H-1). Returns the store saves that
 * failed, each noted as `refusal-not-saved`.
 */
export function bookRefusal(sessionId: string, d: RefusalBook, stop: () => void = () => {}): string[] {
  d.dropLift(sessionId)
  const startedAt = d.refuse(sessionId)
  // A mark raised with no live process seen, as while the hub recovers channels or after the process stopped: the
  // session's next process is refused at its first sighting, whatever start the store verified before the mark. The
  // watch forgets the stopped one, so that next process is a first sighting (gate pass 33, M-1).
  if (startedAt === undefined) d.forget(sessionId)
  d.seed(sessionId)
  stop()
  const failed: string[] = []
  const save = (what: string, write: () => void) => {
    try {
      write()
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      failed.push(message)
      try {
        d.note('refusal-not-saved', { sessionId, what, error: message.slice(0, 300) })
      } catch {
        // The failure is still returned and shown.
      }
    }
  }
  if (startedAt === undefined) save('next-sighting', () => d.refuseNextSighting(sessionId))
  else
    save('refused-start', () => {
      const dropped = d.recordRefusedStart(sessionId, startedAt)
      if (dropped !== undefined) d.note('refused-start-dropped', { sessionId, startedAt: dropped })
    })
  return failed
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
  /**
   * A session with no channel, marked here: the hub keeps the mark too, so a
   * resume from the app is refused in this run as after a restart (gate pass
   * 43, L-2; ChannelHub.restoreMarks).
   */
  markChannelless?: (sessionId: string, why: string) => void
}): Refusals {
  // One stop at a time: a refusal booked while a stop is running is recorded and logged, and that stop, or the retries
  // after it, covers it (gate pass 35, L-1; pass 36, L-2). Returns whether it started a stop.
  const refuseAndStop = (id: string, told: string): boolean => {
    const running = d.stopRunning(id)
    // The stop is issued before any store write (gate pass 54, H-1).
    const failed = bookRefusal(id, running ? { ...d.book, seed: () => {} } : d.book, running ? undefined : () => d.stop(id, told))
    if (running) d.book.note('refusal-coalesced', { sessionId: id })
    if (failed.length) d.notice(`The app couldn't save a session's refusal, so it may not outlast a restart of the app: ${failed[0]!.slice(0, 200)}`)
    return !running
  }
  const markHere = (id: string, why: string, told: string) => {
    // The stop first; a mark that fails to save afterwards is logged and shown (gate pass 53, M-1; pass 54, H-1).
    const started = refuseAndStop(id, told)
    try {
      d.markStore(id, why)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      d.book.note('mark-not-saved', { sessionId: id, error: message.slice(0, 300) })
      d.notice(`The app couldn't save that a session is untrusted, so the mark may not outlast a restart of the app: ${message.slice(0, 200)}`)
    }
    d.notice(started ? `Stopping a session: ${why}.` : `A session is already being stopped, and the app keeps trying: ${why}.`)
  }
  return {
    refuseAndStop: (id, told) => void refuseAndStop(id, told),
    markRestarted: (id, why) => {
      if (d.markChannel(id, why)) return
      d.markChannelless?.(id, why)
      markHere(id, why, `${why}.`)
    },
    // A channel with no session bound has no session to stop or book.
    onUntrusted: (id, why) => {
      if (id) markHere(id, why, `${why}. Resuming it from the app gives its channel a new secret first.`)
    },
  }
}

/**
 * The stops queued while channels recovered, run once the host exists
 * (gate pass 33, L-1; pass 34, L-2; pass 35, L-2; pass 37, L-1; pass 38;
 * pass 48, L-2; pass 50, L-1). Every stop starts at once. Each one's end
 * finishes the retry entry its refusal seeded, and a stop queued with a
 * notice reports its own outcome, stopped or still being tried. Nothing
 * waits on the session list, so a fast stop can't drop its notice.
 */
export async function runQueuedStops(
  queued: readonly { id: string; told?: string }[],
  d: {
    stop: (sessionId: string) => Promise<boolean>
    finish: (sessionId: string, stopped: boolean) => void
    notice: (sessionId: string, told: string, stopped: boolean) => void
  },
): Promise<void> {
  // Once per session, with the first notice queued for it.
  const ids = new Set<string>()
  const once = queued.filter(q => !ids.has(q.id) && !!ids.add(q.id))
  await Promise.all(
    once.map(async ({ id, told }) => {
      const stopped = await d.stop(id)
      d.finish(id, stopped)
      if (told) d.notice(id, told, stopped)
    }),
  )
}

/**
 * What a refusal's stop says once its command is done (gate pass 38; pass
 * 51, L-1): only what its exit status shows. An exit of 0 means the stop was
 * sent, whether or not a process was running. A failure says the app keeps
 * trying only when a retry is queued for the session.
 */
export function stopNotice(sessionId: string, told: string, sent: boolean, retrying: boolean): string {
  const name = `session ${sessionId.slice(0, 8)}`
  if (sent) return `Stop sent to ${name}: ${told}`
  return retrying ? `Couldn't stop ${name} yet, and the app keeps trying: ${told}` : `Couldn't stop ${name}: ${told}`
}
