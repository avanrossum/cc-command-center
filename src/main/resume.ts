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
}

/** A resume refused because the session's mod copy can't be trusted (pass 6, H-1). The card offers Start a copy. */
export class ModStuck extends Error {
  constructor(why: string) {
    super(`It can't be resumed on its own reporter mod copy: ${why}. Start a copy of it instead: a copy uses the app's current mod.`)
    this.name = 'ModStuck'
  }
}

export async function resumeFromApp(
  sessionId: string,
  { host, hub, onRekeyed, modStuck = () => null, unrecorded = () => false, backfill = () => 'the app has no record of which reporter mod copy this session uses' }: ResumeDeps,
): Promise<void> {
  // First the copy is found and recorded, so the usual check below judges it like any other (MIP2-1504).
  if (unrecorded(sessionId)) {
    const why = backfill(sessionId)
    if (why) throw new ModStuck(why)
  }
  const stuck = modStuck(sessionId)
  if (stuck) throw new ModStuck(stuck)
  const channel = hub.channelOf(sessionId) !== null
  if (channel) {
    await host.stopIfRunning(sessionId)
    await hub.rekey(sessionId, { keepMark: true })
  } else if (hub.untrustedReason(sessionId)) {
    throw new Error(`its channel can't be trusted (${hub.untrustedReason(sessionId)}) and is gone, so it can't be given a new secret. Start a new session.`)
  }
  await host.resume(sessionId)
  // A channel changed during the resume stays marked, and so does the store's copy (pass 6, M-1).
  if (channel && (await hub.clearMark(sessionId))) onRekeyed(sessionId)
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

  run(sessionId: string, resume: () => Promise<void>): Promise<void> {
    const running = this.inFlight.get(sessionId)
    if (running) return running
    const done = this.doneAt.get(sessionId)
    if (done !== undefined && this.now() - done < RESUME_REPEAT_MS) return Promise.resolve()
    const p = resume().then(() => void this.doneAt.set(sessionId, this.now()))
    this.inFlight.set(sessionId, p)
    void p.catch(() => {}).finally(() => this.inFlight.delete(sessionId))
    return p
  }
}
