// A resume from the app (gate run 3, M-1; pass 4, H-1 and M-2; MIP2-1441
// live run). Every resume gives the session's channel a new secret and a
// settings file written from the app's own record. A running session is
// stopped first: `claude --resume <id> --bg` doesn't restart it, so its
// process would keep the old secret and its mod would be refused, and the
// command starts another session beside it. The mark is cleared only once
// the session is back (pass 5, L-2): a resume that fails leaves it marked.

import type { ChannelHub, SessionHost } from '@ccc/coupling'

export interface ResumeDeps {
  host: Pick<SessionHost, 'stopIfRunning' | 'resume'>
  hub: Pick<ChannelHub, 'channelOf' | 'rekey' | 'untrustedReason' | 'clearMark'>
  /** The re-key finished: the app's copy of the untrusted mark is cleared (pass 4, M-2). */
  onRekeyed: (sessionId: string) => void
  /**
   * The channel has its new secret and the old process is stopped, before
   * the restart (gate pass 32, M-1): the store's refusal of the session's
   * next process first seen is lifted in memory (LiftedRefusals), so the
   * process this resume starts
   * gets the restart verdict instead. Any process first seen before the
   * mark is cleared gets the verdict too, including one another path
   * started in this window. Returns how to put the refusal back, called if
   * the resume fails or the mark stays (gate pass 33, L-3; pass 34, L-1).
   */
  onRekeying?: (sessionId: string) => (() => void) | void
  /**
   * Why the session can't be resumed on its own mod copy, or null (pass 6,
   * H-1): its copy was changed and couldn't be moved aside, or launches are
   * paused. A resume keeps the session's saved `--plugin-dir`, so it would
   * run the changed copy; a copy goes through the current one instead.
   */
  modStuck?: (sessionId: string) => string | null
  /**
   * The app launched it but has no record of its mod copy, from an earlier
   * build (MIP2-1504). `backfill` finds and checks the copy its saved
   * options name, records it, and returns null; or returns why it can't.
   */
  unrecorded?: (sessionId: string) => boolean
  backfill?: (sessionId: string) => string | null
  /** The error a refusal becomes (D-040). */
  errorFor?: RefusalError
}

/**
 * A restart refused only because the session's saved settings go beyond its
 * launch: a higher permission mode or an added folder (gate pass 20, H-1;
 * D-040). `settings` is the wording shown; "Resume with these settings"
 * sends it back, and the app records them only if they still read the same.
 */
export class NeedsConfirm extends Error {
  constructor(
    readonly sessionId: string,
    readonly settings: string,
  ) {
    super(`its saved settings go beyond what the app launched it with. ${settings}`)
    this.name = 'NeedsConfirm'
  }
}

/** The error for a restart verdict's refusal: NeedsConfirm when it's only settings to confirm, else ModStuck. */
export type RefusalError = (sessionId: string, why: string) => Error

export const stuckError: RefusalError = (_id, why) => new ModStuck(why)

/** A resume refused because the session's mod copy can't be trusted (pass 6, H-1). The card offers Start a copy. */
export class ModStuck extends Error {
  constructor(why: string) {
    super(`It can't be resumed on its own reporter mod copy: ${why}. Start a copy of it instead: a copy uses the app's current mod.`)
    this.name = 'ModStuck'
  }
}

export async function resumeFromApp(
  sessionId: string,
  { host, hub, onRekeyed, onRekeying = () => {}, modStuck = () => null, unrecorded = () => false, backfill = () => 'the app has no record of which reporter mod copy this session uses', errorFor = stuckError }: ResumeDeps,
): Promise<void> {
  // First the copy is found and recorded, so the usual check below judges it like any other (MIP2-1504).
  if (unrecorded(sessionId)) {
    const why = backfill(sessionId)
    if (why) throw new ModStuck(why)
  }
  const stuck = modStuck(sessionId)
  if (stuck) throw errorFor(sessionId, stuck)
  const channel = hub.channelOf(sessionId) !== null
  let rearm: (() => void) | undefined
  if (channel) {
    await host.stopIfRunning(sessionId)
    await hub.rekey(sessionId, { keepMark: true })
    rearm = onRekeying(sessionId) ?? undefined
  } else if (hub.untrustedReason(sessionId)) {
    throw new Error(`its channel can't be trusted (${hub.untrustedReason(sessionId)}) and is gone, so it can't be given a new secret. Start a new session.`)
  }
  try {
    await host.resume(sessionId)
  } catch (err) {
    rearm?.()
    throw err
  }
  // A channel changed during the resume stays marked, and so does the store's copy (pass 6, M-1), with the refusal of
  // the next process first seen put back (gate pass 34, L-1).
  if (!channel) return
  // The lift never outlives the resume, even when clearing the mark throws (gate pass 36, L-1).
  let cleared = false
  try {
    cleared = await hub.clearMark(sessionId)
  } finally {
    if (cleared) onRekeyed(sessionId)
    else rearm?.()
  }
}

/** How long after a resume finishes another resume of the same session is taken as a repeat (MIP2-1467). */
export const RESUME_REPEAT_MS = 15_000

/**
 * Resumes one session at a time, once (MIP2-1467). A resume already under
 * way is joined, not run again; one that finished in the last 15 s counts
 * as done. Seen live: two opens of an ended session 1.6 s apart ran two
 * `--resume`s; the first woke it, and the second, finding it running,
 * started a copy. The fleet poll had not yet shown it running.
 */
export class ResumeGate {
  private readonly inFlight = new Map<string, Promise<void>>()
  private readonly doneAt = new Map<string, number>()

  constructor(private readonly now: () => number = Date.now) {}

  /** `fresh`: a confirmed resume, which restarts on the settings just recorded, so a recent resume doesn't count (gate pass 30, L-2). */
  run(sessionId: string, resume: () => Promise<void>, { fresh = false } = {}): Promise<void> {
    const running = this.inFlight.get(sessionId)
    if (running) return running
    const done = this.doneAt.get(sessionId)
    if (!fresh && done !== undefined && this.now() - done < RESUME_REPEAT_MS) return Promise.resolve()
    const p = resume().then(() => void this.doneAt.set(sessionId, this.now()))
    this.inFlight.set(sessionId, p)
    void p.catch(() => {}).finally(() => this.inFlight.delete(sessionId))
    return p
  }
}

/**
 * Why a session's untrusted mark can't be cleared by hand, or null
 * (MIP2-1518). Only a session that's gone may be cleared: not in Claude
 * Code's list, or archived or removed, and without a process. A session
 * that can still run keeps its mark until a resume from the app re-keys it.
 */
export function clearGoneRefusal(listed: { pid: { value: number | null } } | undefined, meta: { archivedAt?: number; rolledOffAt?: number; removedAt?: number } | undefined, archived: boolean): string | null {
  const gone = !listed || archived || meta?.removedAt !== undefined
  if (!gone || (listed && listed.pid.value !== null)) return 'the session still exists; resume it from the app to clear its alert'
  return null
}

/**
 * "Resume with these settings" (D-043 prototype): `begin` records the
 * settings shown, if they still read as `settings`, before the restart, so
 * every check of the restart, the app's and the poll's, passes on them;
 * `abort` puts the record back as it was when the restart fails; `commit`
 * keeps it. This reverses gate pass 21 L-2's record-after, which the
 * every-process check can't use: the poll checks the new process too.
 */
export interface Confirmation {
  begin: (sessionId: string, settings: string) => string | null
  commit: (sessionId: string) => void
  abort: (sessionId: string) => void
}

export async function resumeConfirmed(sessionId: string, settings: string, confirm: Confirmation, resume: (sessionId: string) => Promise<void>): Promise<void> {
  const why = confirm.begin(sessionId, settings)
  if (why) throw new Error(why)
  try {
    await resume(sessionId)
  } catch (err) {
    confirm.abort(sessionId)
    throw err
  }
  confirm.commit(sessionId)
}

/**
 * A confirmation whose restart failed (gate pass 28, L-1; pass 29, L-5): the
 * record goes back as it was, and the session's process is no longer taken
 * as verified, since the resume may have handed it to the supervisor before
 * it failed. Whatever runs now is seen afresh and checked against the record
 * put back.
 */
export function rollBackConfirmation(
  sessionId: string,
  d: { restore: (sessionId: string) => void; clearVerifiedStart: (sessionId: string) => void; forget: (sessionId: string) => void },
): void {
  // Its process is seen afresh even if putting the record back fails (gate pass 33, L-2).
  try {
    d.restore(sessionId)
  } finally {
    d.clearVerifiedStart(sessionId)
    d.forget(sessionId)
  }
}

/**
 * "Resume with these settings" for main (D-043; gate pass 31, L-1, L-4): the
 * settings shown are recorded before the restart, only if the escalation
 * offered and the current one both still read as shown, and only one
 * confirmation per session at a time, so a second click can't take the
 * first's widened record for the one to put back. A failed restart rolls
 * back (rollBackConfirmation).
 */
export function confirmationFor<E, C>(d: {
  /** The escalation each "Resume with these settings" was offered for. */
  offered: Map<string, E>
  escalationOf: (sessionId: string) => E | null
  text: (e: E) => string
  recordedOf: (sessionId: string) => C | undefined
  record: (sessionId: string, e: E) => void
  restore: (sessionId: string, recorded: C | undefined) => void
  clearVerifiedStart: (sessionId: string) => void
  forget: (sessionId: string) => void
}): Confirmation {
  const prior = new Map<string, C | undefined>()
  return {
    begin: (id, settings) => {
      if (prior.has(id)) return 'a confirmation for it is already under way'
      const shown = d.offered.get(id)
      const e = d.escalationOf(id)
      if (!shown || !e || d.text(shown) !== settings || d.text(e) !== settings) return 'its saved settings changed since they were shown. Open it again to see them'
      const before = d.recordedOf(id)
      // A record that fails to save is put back, and no confirmation is left under way (gate pass 32, L-2).
      try {
        d.record(id, e)
      } catch (err) {
        // The save's error is the one reported; a failure putting the record back is logged (gate pass 34, L-3).
        try {
          d.restore(id, before)
        } catch (restoreErr) {
          console.warn(`putting back the confirmed settings of ${id.slice(0, 8)}: ${String(restoreErr)}`)
        }
        throw err
      }
      prior.set(id, before)
      return null
    },
    commit: id => void (prior.delete(id), d.offered.delete(id)),
    abort: id =>
      rollBackConfirmation(id, {
        restore: sid => {
          try {
            d.restore(sid, prior.get(sid))
          } finally {
            prior.delete(sid)
          }
        },
        clearVerifiedStart: d.clearVerifiedStart,
        forget: d.forget,
      }),
  }
}

/**
 * Sessions whose refusal of the next process first seen a resume from the
 * app has lifted, in memory only (gate pass 32, M-1; pass 35, M-1): the
 * store keeps the flag until the resume clears the session's mark
 * (clearUntrusted), so an app exit mid-resume leaves it refusing.
 */
export class LiftedRefusals {
  private readonly ids = new Set<string>()

  /** Lifts it; returns how to put it back. */
  lift(sessionId: string): () => void {
    this.ids.add(sessionId)
    return () => this.drop(sessionId)
  }

  drop(sessionId: string): void {
    this.ids.delete(sessionId)
  }

  has(sessionId: string): boolean {
    return this.ids.has(sessionId)
  }
}

/**
 * A resume from the app re-keyed the session and cleared its channel's mark
 * (gate pass 43, INFO-3; pass 44, L-2, INFO-2). The lift goes first, so it
 * never outlives the resume. A store that fails to save is reported and
 * logged, not thrown: the resume succeeded, and the mark saved on disk only
 * comes back at the next start, which is the safe direction.
 */
export function rekeyedFor(d: { lifted: Pick<LiftedRefusals, 'drop'>; clearUntrusted: (sessionId: string) => void; notice: (text: string) => void }): (sessionId: string) => void {
  return id => {
    d.lifted.drop(id)
    try {
      d.clearUntrusted(id)
    } catch (err) {
      console.warn(`clearing the mark of ${id.slice(0, 8)} after its resume: ${String(err)}`)
      d.notice(`A session resumed, but the app couldn't save that its alert is cleared, so the alert may come back when the app next starts: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
}
