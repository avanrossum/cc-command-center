// The supervisor's own restart of a session (MIP2-1512, Research MIP2-1527). Every new process is checked, whoever
// started it (D-043 prototype).

import { describe, expect, it } from 'vitest'
import { ABSENT_KEEP_MS, RestartWatch } from '../src/main/restart-watch.ts'

const A = 'c0ffee01-0000-4000-8000-000000000001'
const B = 'c0ffee02-0000-4000-8000-000000000002'

describe('RestartWatch', () => {
  it("reports every process change, the app's own restarts included", () => {
    let t = 1_000_000
    const watch = new RestartWatch(() => t)
    expect(watch.observe([{ sessionId: A, pid: 100, startedAt: 1 }, { sessionId: B, pid: 200, startedAt: 1 }])).toEqual([])
    // The app resumes A; the supervisor restarts B on its own about 10 s after its process exits.
    expect(watch.observe([{ sessionId: A, pid: null, startedAt: 1 }, { sessionId: B, pid: null, startedAt: 1 }])).toEqual([])
    t += 10_400
    expect(watch.observe([{ sessionId: A, pid: 101, startedAt: t }, { sessionId: B, pid: 201, startedAt: t }])).toEqual([A, B])
    // Steady again: nothing to report.
    expect(watch.observe([{ sessionId: A, pid: 101, startedAt: t }, { sessionId: B, pid: 201, startedAt: t }])).toEqual([])
  })

  it('sees a restart listed under another id for one poll, then under its own again (MIP2-1570)', () => {
    let t = 1_000_000
    const watch = new RestartWatch(() => t)
    const B2 = 'a1344fa3-0000-4000-8000-000000000003'
    watch.observe([{ sessionId: A, pid: 100, startedAt: 1 }])
    t += 2_000
    expect(watch.observe([{ sessionId: B2, pid: 101, startedAt: t }])).toEqual([])
    t += 2_000
    expect(watch.observe([{ sessionId: A, pid: 101, startedAt: t }])).toEqual([A])
  })

  it('forgets a session ABSENT_KEEP_MS after it left the list', () => {
    let t = 1_000_000
    const watch = new RestartWatch(() => t)
    watch.observe([{ sessionId: A, pid: 100, startedAt: 1 }])
    watch.observe([])
    t += ABSENT_KEEP_MS + 1
    watch.observe([])
    expect(watch.observe([{ sessionId: A, pid: 101, startedAt: t }])).toEqual([])
  })

  it('a first sighting and leaving the list are not changes; back with a new process soon after is one', () => {
    const watch = new RestartWatch(() => 0)
    expect(watch.observe([{ sessionId: A, pid: 100, startedAt: 1 }])).toEqual([])
    expect(watch.observe([])).toEqual([])
    expect(watch.observe([{ sessionId: A, pid: 300, startedAt: 2 }])).toEqual([A])
  })

  it("doesn't take a stale reading as a stop (gate pass 24, M-3)", () => {
    const watch = new RestartWatch(() => 0)
    watch.observe([{ sessionId: A, pid: 100, startedAt: 1 }])
    watch.observe([{ sessionId: A, pid: null, startedAt: 1, stale: true }])
    expect(watch.knownStopped(A)).toBe(false)
    expect(watch.observe([{ sessionId: A, pid: 100, startedAt: 1 }])).toEqual([])
    watch.observe([{ sessionId: A, pid: null, startedAt: 1 }])
    expect(watch.knownStopped(A)).toBe(true)
  })

  it('keeps a refused process refused while its pid is listed, and checks a new one as any other (gate pass 27, M-2)', () => {
    let t = 1_000_000
    const watch = new RestartWatch(() => t)
    watch.observe([{ sessionId: A, pid: 100, startedAt: 1 }])
    t += 10_000
    expect(watch.observe([{ sessionId: A, pid: 200, startedAt: t }])).toEqual([A])
    watch.refuse(A)
    // The stop failed: the same pid, still refused, on each poll, a stale one included.
    t += 2_000
    watch.observe([{ sessionId: A, pid: 200, startedAt: t }])
    expect(watch.stillRefused).toEqual([A])
    watch.observe([{ sessionId: A, pid: null, startedAt: t, stale: true }])
    expect(watch.stillRefused).toEqual([A])
    // It ends; the supervisor's next restart is a change like any other, and nothing is still refused.
    t += 2_000
    watch.observe([{ sessionId: A, pid: null, startedAt: t }])
    expect(watch.stillRefused).toEqual([])
    t += 10_000
    expect(watch.observe([{ sessionId: A, pid: 300, startedAt: t }])).toEqual([A])
    expect(watch.stillRefused).toEqual([])
  })
})

describe('first sightings against the verified start (gate pass 20, M-1)', () => {
  it('reports a first sighting with no verified start, or one started later, and not one started by then', () => {
    const verified = new Map([[A, 500]])
    const watch = new RestartWatch(() => 1_000_000, id => verified.get(id))
    watch.observe([{ sessionId: A, pid: 100, startedAt: 500 }, { sessionId: B, pid: 200, startedAt: 400 }])
    // A started when it was last verified; B has no verified start.
    expect(watch.unverified).toEqual([B])
    // Steady: nothing more to check.
    watch.observe([{ sessionId: A, pid: 100, startedAt: 500 }, { sessionId: B, pid: 200, startedAt: 400 }])
    expect(watch.unverified).toEqual([])
    // Restarted while the app was closed: a new watch, a later start.
    const next = new RestartWatch(() => 2_000_000, id => verified.get(id))
    next.observe([{ sessionId: A, pid: 101, startedAt: 900 }])
    expect(next.unverified).toEqual([A])
  })

  it('reports a session back after ABSENT_KEEP_MS with a later start', () => {
    let t = 1_000_000
    const watch = new RestartWatch(() => t, () => 500)
    watch.observe([{ sessionId: A, pid: 100, startedAt: 500 }])
    watch.observe([])
    t += ABSENT_KEEP_MS + 1
    watch.observe([])
    watch.observe([{ sessionId: A, pid: 101, startedAt: 800 }])
    expect(watch.unverified).toEqual([A])
  })

  it('checks nothing at a first sighting without a verified-start source', () => {
    const plain = new RestartWatch(() => 1_000_000)
    plain.observe([{ sessionId: A, pid: 100, startedAt: 900 }])
    expect(plain.unverified).toEqual([])
  })

  it('compares the verified start for equality, so a process started earlier is checked too (gate pass 21, L-1)', () => {
    const watch = new RestartWatch(() => 1_000_000, () => 500)
    watch.observe([{ sessionId: A, pid: 100, startedAt: 400 }])
    expect(watch.unverified).toEqual([A])
  })
})
