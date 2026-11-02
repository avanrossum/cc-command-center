// One poll's restart checks (gate pass 20, M-1; pass 21, L-4; pass 22, D-042): every refusal stops, settings to confirm included.

import { describe, expect, it } from 'vitest'
import { restartPoll, StopRetries } from '../src/main/restart-poll.ts'
import { ABSENT_KEEP_MS, RestartWatch, type ProcessSeen } from '../src/main/restart-watch.ts'
import { rollBackConfirmation } from '../src/main/resume.ts'

const A = 'c0ffee01-0000-4000-8000-000000000001'
const B = 'c0ffee02-0000-4000-8000-000000000002'
const FLAG = 'its saved options hold flags the app never passed'
const AUTO = 'Saved settings: auto. Launched as default.'
const verdict = (state: Record<string, string>) => ({ verdict: (id: string) => state[id] ?? null })
const running = (...ids: string[]) => ids.map((sessionId, i) => ({ sessionId, pid: 100 + i, startedAt: 900 }))

describe('restartPoll', () => {
  it('stops a first sighting whose only refusal is settings Alex could confirm, as any other', () => {
    const r = restartPoll({ processes: running(A, B), changed: [], unverified: [A, B] }, verdict({ [A]: AUTO, [B]: FLAG }))
    expect(r.stop).toEqual([
      { sessionId: A, why: "Claude Code started it while the app wasn't checking, and saved settings: auto. Launched as default.", note: 'unchecked-start' },
      { sessionId: B, why: `Claude Code started it while the app wasn't checking, and ${FLAG}`, note: 'unchecked-start' },
    ])
    expect(r.verified).toEqual([])
  })

  it('stops a session whose check throws, logged as its own note, with the error for the log only (gate pass 24, M-2; pass 25, L-2)', () => {
    const throwing = { verdict: (_id: string): string | null => { throw new TypeError('x.includes is not a function\nat /Users/x/app.js:1') } }
    const r = restartPoll({ processes: running(A, B), changed: [A], unverified: [B] }, throwing)
    expect(r.stop).toEqual([
      { sessionId: A, why: 'Claude Code restarted it by itself, and the restart check failed', note: 'restart-check-failed', error: 'TypeError: x.includes is not a function at /Users/x/app.js:1' },
      { sessionId: B, why: "Claude Code started it while the app wasn't checking, and the restart check failed", note: 'restart-check-failed', error: 'TypeError: x.includes is not a function at /Users/x/app.js:1' },
    ])
    expect(r.verified).toEqual([])
  })

  it("words a supervisor restart's refusal after its reason, keeping a name's capital", () => {
    const r = restartPoll({ processes: running(A, B), changed: [A, B], unverified: [] }, verdict({ [A]: FLAG, [B]: "Claude Code's saved options for it can't be read" }))
    expect(r.stop.map(s => s.why)).toEqual([`Claude Code restarted it by itself, and ${FLAG}`, "Claude Code restarted it by itself, and Claude Code's saved options for it can't be read"])
  })

  it('records as verified every running process that passed, and none that stopped or has no process', () => {
    const r = restartPoll({ processes: [...running(A, B), { sessionId: 'c0ffee03-0000-4000-8000-000000000003', pid: null, startedAt: 900 }], changed: [], unverified: [B] }, verdict({}))
    expect(r.verified).toEqual([[A, 900], [B, 900]])
  })
})

describe('every new process is checked once, whoever started it (D-043 prototype)', () => {
  /**
   * The watch and the poll step together, counting the poll's checks by session and pid. Verified starts are kept as
   * the store keeps them; A's running process (pid 100, which is also its start here) was verified before.
   */
  function harness(passes: (id: string) => boolean = () => true) {
    const checks: string[] = []
    const verified = new Map<string, number>([[A, 100]])
    const watch = new RestartWatch(() => 0, id => verified.get(id))
    let pids = new Map<string, number | null>()
    const poll = (list: [string, number | null][]) => {
      pids = new Map(list)
      const processes: ProcessSeen[] = list.map(([sessionId, pid]) => ({ sessionId, pid, startedAt: pid ?? 0 }))
      const changed = watch.observe(processes)
      const r = restartPoll(
        { processes, changed, unverified: watch.unverified, stillRefused: watch.stillRefused },
        { verdict: id => (checks.push(`${id} ${pids.get(id)}`), passes(id) ? null : AUTO) },
      )
      for (const [id, at] of r.verified) verified.set(id, at)
      return r
    }
    return { checks, poll }
  }

  it("checks the app's own resume once", () => {
    const h = harness()
    h.poll([[A, 100]])
    h.poll([[A, null]])
    h.poll([[A, 101]])
    h.poll([[A, 101]])
    expect(h.checks).toEqual([`${A} 101`])
  })

  it("checks the app's own attach to a stopped session once", () => {
    const h = harness()
    h.poll([[A, 100]])
    h.poll([[A, null]])
    const r = h.poll([[A, 102]])
    expect(h.checks).toEqual([`${A} 102`])
    expect(r.stop).toEqual([])
  })

  it('passes a confirmed resume, whose confirmation was recorded before the restart', () => {
    let recorded = false
    const h = harness(() => recorded)
    h.poll([[A, 100]])
    // Resume with these settings: recorded first, then the restart.
    recorded = true
    h.poll([[A, null]])
    const r = h.poll([[A, 103]])
    expect(h.checks).toEqual([`${A} 103`])
    expect(r.stop).toEqual([])
  })

  it('checks a supervisor restart before, during and after an app restart, each process once', () => {
    const h = harness()
    h.poll([[A, 100]])
    // Before: the supervisor restarts it, then the app does.
    h.poll([[A, 200]])
    h.poll([[A, 300]])
    // During: the supervisor's process and the app's both land between polls; only the one listed is checked.
    h.poll([[A, 500]])
    // After: the app restarts it, then the supervisor does.
    h.poll([[A, 600]])
    h.poll([[A, 700]])
    expect(h.checks).toEqual([`${A} 200`, `${A} 300`, `${A} 500`, `${A} 600`, `${A} 700`])
  })

  it("stops the supervisor's restart on settings that refuse, whether or not the app restarted it too", () => {
    const h = harness(() => false)
    h.poll([[A, 100]])
    expect(h.poll([[A, 200]]).stop).toMatchObject([{ sessionId: A, note: 'unexplained-restart' }])
  })
})

describe('a refusal lasts as long as the refused process (gate pass 28, M-1; pass 29, M-1)', () => {
  /** The watch and the poll as main runs them, with refused starts kept as the store keeps them. */
  function harness(verdict: () => string | null = () => AUTO, refusedAt = new Map<string, number[]>(), clock = { t: 0 }) {
    const verified = new Map<string, number>([[A, 100]])
    const watch = new RestartWatch(() => clock.t, id => verified.get(id), (id, at) => refusedAt.get(id)?.includes(at) === true)
    const poll = (list: [string, number | null][]) => {
      const processes: ProcessSeen[] = list.map(([sessionId, pid]) => ({ sessionId, pid, startedAt: pid ?? 0 }))
      const changed = watch.observe(processes)
      const r = restartPoll({ processes, changed, unverified: watch.unverified, stillRefused: watch.stillRefused }, { verdict })
      for (const s of r.stop) {
        const at = watch.refuse(s.sessionId)
        if (at !== undefined) refusedAt.set(s.sessionId, [...(refusedAt.get(s.sessionId) ?? []), at])
      }
      for (const [id, at] of r.verified) verified.set(id, at)
      return r
    }
    return { poll, refusedAt }
  }

  it('keeps it out of verified through a missed listing, and stops it again', () => {
    const h = harness()
    expect(h.poll([[A, 100]]).verified).toEqual([[A, 100]])
    expect(h.poll([[A, 200]]).stop).toHaveLength(1)
    expect(h.poll([[A, 200]])).toMatchObject({ retry: [A], verified: [] })
    expect(h.poll([])).toMatchObject({ retry: [], verified: [] })
    expect(h.poll([[A, 200]])).toMatchObject({ retry: [A], verified: [] })
  })

  it('keeps it refused through a listing with no pid (gate pass 29, M-1, the report\'s sequence)', () => {
    const h = harness()
    expect(h.poll([[A, 100]]).verified).toEqual([[A, 100]])
    expect(h.poll([[A, 200]]).stop).toHaveLength(1)
    expect(h.poll([[A, 200]])).toMatchObject({ retry: [A] })
    expect(h.poll([[A, null]])).toMatchObject({ retry: [], verified: [] })
    expect(h.poll([[A, 200]])).toMatchObject({ stop: [], retry: [A], verified: [] })
  })

  it('keeps it refused when another process is listed between, under a verdict that would pass now (gate pass 29, M-1)', () => {
    let passes = false
    const h = harness(() => (passes ? null : AUTO))
    h.poll([[A, 100]])
    h.poll([[A, 200]])
    h.poll([[A, 300]])
    passes = true
    expect(h.poll([[A, 200]])).toMatchObject({ stop: [], retry: [A], verified: [] })
  })

  it('keeps it refused after the watch forgets the session and it comes back in the same run (gate pass 29, L-5)', () => {
    const clock = { t: 1_000_000 }
    let passes = false
    const h = harness(() => (passes ? null : AUTO), new Map(), clock)
    h.poll([[A, 100]])
    h.poll([[A, 200]])
    h.poll([])
    clock.t += ABSENT_KEEP_MS + 1
    h.poll([])
    passes = true
    expect(h.poll([[A, 200]])).toMatchObject({ stop: [], retry: [A], verified: [] })
  })

  it('keeps it refused across an app restart, with no new verdict to pass on options rewritten meanwhile', () => {
    const before = harness()
    before.poll([[A, 100]])
    before.poll([[A, 200]])
    // The app restarts while 200 still runs; the store kept its start. The verdict would pass now, but isn't asked.
    const verified = new Map<string, number>()
    const watch = new RestartWatch(() => 0, id => verified.get(id), (id, at) => before.refusedAt.get(id)?.includes(at) === true)
    const processes: ProcessSeen[] = [{ sessionId: A, pid: 200, startedAt: 200 }]
    const changed = watch.observe(processes)
    const r = restartPoll({ processes, changed, unverified: watch.unverified, stillRefused: watch.stillRefused }, { verdict: () => null })
    expect(r).toMatchObject({ stop: [], retry: [A], verified: [] })
  })

  it('checks a reused pid with another start as a new process (gate pass 30, L-1)', () => {
    const watch = new RestartWatch(() => 0)
    watch.observe([{ sessionId: A, pid: 100, startedAt: 1 }])
    expect(watch.observe([{ sessionId: A, pid: 100, startedAt: 2 }])).toEqual([A])
  })

  it('refuses the first process seen of a session an earlier build marked without a refused start, unless the app verified it (gate pass 29, L-1)', () => {
    const watch = new RestartWatch(() => 0, () => 100, undefined, () => true)
    watch.observe([{ sessionId: A, pid: 200, startedAt: 200 }])
    expect(watch.stillRefused).toEqual([A])
    const verifiedOne = new RestartWatch(() => 0, () => 100, undefined, () => true)
    verifiedOne.observe([{ sessionId: A, pid: 100, startedAt: 100 }])
    expect(verifiedOne.stillRefused).toEqual([])
  })

  it('sees the process again as new once the watch forgets the session, as after a failed confirmed resume (gate pass 28, L-1)', () => {
    const watch = new RestartWatch(() => 0, () => undefined)
    watch.observe([{ sessionId: A, pid: 100, startedAt: 100 }])
    watch.forget(A)
    watch.observe([{ sessionId: A, pid: 100, startedAt: 100 }])
    expect(watch.unverified).toEqual([A])
  })

  it('rolls a failed confirmation back: the record, then the verified start, then the watch (gate pass 29, L-5)', () => {
    const calls: string[] = []
    rollBackConfirmation(A, { restore: id => void calls.push(`restore ${id}`), clearVerifiedStart: id => void calls.push(`clear ${id}`), forget: id => void calls.push(`forget ${id}`) })
    expect(calls).toEqual([`restore ${A}`, `clear ${A}`, `forget ${A}`])
  })
})

describe('StopRetries (gate pass 28, L-2; pass 29, L-2, L-3)', () => {
  it("waits for the refusal's own stop to finish, runs one stop at a time, and backs off from 2 s to 60 s after failures (gate pass 30, M-1)", () => {
    let t = 0
    const r = new StopRetries(2_000, 60_000, () => t)
    r.seed(A)
    // The poll that refused it keeps only sessions to retry; the seeded stop is still running, so it stays.
    r.keep([])
    t += 2_000
    expect(r.start(A)).toBe(false)
    // The refusal's own stop fails; the first retry waits 4 s from then.
    expect(r.finish(A, false)).toBe(4_000)
    t += 3_999
    expect(r.start(A)).toBe(false)
    t += 1
    expect(r.start(A)).toBe(true)
    expect(r.start(A)).toBe(false)
    expect(r.finish(A, false)).toBe(8_000)
    let last: number | undefined
    for (let i = 0; i < 10; i++) (t += 60_000, r.start(A), (last = r.finish(A, false)))
    expect(last).toBe(60_000)
  })

  it('lets a retry start once a stop has counted as running longer than the cap', () => {
    let t = 0
    const r = new StopRetries(2_000, 60_000, () => t)
    r.seed(A)
    t += 59_999
    expect(r.start(A)).toBe(false)
    t += 1
    expect(r.start(A)).toBe(true)
  })

  it('re-keys on a retry only until a re-key has finished since the refusal', () => {
    const r = new StopRetries(2_000, 60_000, () => 0)
    r.seed(A)
    expect(r.needsRekey(A)).toBe(true)
    r.rekeyed(A)
    expect(r.needsRekey(A)).toBe(false)
    // A new refusal starts over.
    r.seed(A)
    expect(r.needsRekey(A)).toBe(true)
  })

  it("keeps a session whose stop is still running, and forgets one that isn't once it's no longer refused", () => {
    let t = 0
    const r = new StopRetries(2_000, 60_000, () => t)
    expect(r.start(A)).toBe(true)
    r.keep([])
    expect(r.start(A)).toBe(false)
    r.finish(A, true)
    r.keep([])
    expect(r.start(A)).toBe(true)
  })
})
