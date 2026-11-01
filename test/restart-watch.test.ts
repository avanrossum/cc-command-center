// The supervisor's own restart of a session (MIP2-1512, Research MIP2-1527).

import { describe, expect, it } from 'vitest'
import { ABSENT_KEEP_MS, OWN_RESTART_MS, recordRestarts, RestartWatch, unexplainedRestart } from '../src/main/restart-watch.ts'

const A = 'c0ffee01-0000-4000-8000-000000000001'
const B = 'c0ffee02-0000-4000-8000-000000000002'

describe('RestartWatch', () => {
  it('ignores a process change the app started, and reports one it did not', () => {
    let t = 1_000_000
    const watch = new RestartWatch(() => t)
    expect(watch.observe([{ sessionId: A, pid: 100, startedAt: 1 }, { sessionId: B, pid: 200, startedAt: 1 }])).toEqual([])
    // The app resumes A; the supervisor restarts B on its own about 10 s after its process exits.
    watch.expect(A)
    expect(watch.observe([{ sessionId: A, pid: null, startedAt: 1 }, { sessionId: B, pid: null, startedAt: 1 }])).toEqual([])
    t += 10_400
    expect(watch.observe([{ sessionId: A, pid: 101, startedAt: t }, { sessionId: B, pid: 201, startedAt: t }])).toEqual([B])
    // Steady again: nothing to report.
    expect(watch.observe([{ sessionId: A, pid: 101, startedAt: t }, { sessionId: B, pid: 201, startedAt: t }])).toEqual([])
    // The app's restart accounts for one change only; a second one is the supervisor's.
    expect(watch.observe([{ sessionId: A, pid: 102, startedAt: t + 1 }])).toEqual([A])
  })

  it("an app restart older than the window doesn't account for a change", () => {
    let t = 1_000_000
    const watch = new RestartWatch(() => t)
    watch.observe([{ sessionId: A, pid: 100, startedAt: 1 }])
    watch.expect(A)
    t += OWN_RESTART_MS + 1
    expect(watch.observe([{ sessionId: A, pid: 101, startedAt: t }])).toEqual([A])
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
})

describe('recordRestarts', () => {
  it('records resume, respawn and a move in before they run, an attach to a stopped session after it returns, and leaves other methods alone', async () => {
    const order: string[] = []
    const watch = { expect: (id: string) => void order.push(`expect ${id}`) }
    const host = {
      resume: async (id: string) => void order.push(`resume ${id}`),
      respawn: async (id: string) => void order.push(`respawn ${id}`),
      attach: async (id: string) => (order.push(`attach ${id}`), { file: 'claude' }),
      moveIn: async (id: string) => (order.push(`moveIn ${id}`), { sessionId: id, sameId: true }),
      stop: async (id: string) => void order.push(`stop ${id}`),
    }
    const recorded = recordRestarts(host, watch, () => true)
    await recorded.resume(A)
    await recorded.respawn(A)
    await recorded.attach(A)
    await recorded.moveIn(A)
    await recorded.stop(A)
    expect(order).toEqual([`expect ${A}`, `resume ${A}`, `expect ${A}`, `respawn ${A}`, `attach ${A}`, `expect ${A}`, `expect ${A}`, `moveIn ${A}`, `stop ${A}`])
  })

  it("doesn't record an attach to a running session, or an attach that fails (MIP2-1565)", async () => {
    const seen: string[] = []
    const host = {
      attach: async (id: string) => {
        if (id === B) throw new Error('no such session')
        return { file: 'claude' }
      },
    }
    const recorded = recordRestarts(host, { expect: id => void seen.push(id) }, id => id === B)
    await recorded.attach(A)
    await expect(recorded.attach(B)).rejects.toThrow('no such session')
    expect(seen).toEqual([])
  })

  it("checks the supervisor's restart of a running session in the minute after Focus attached to it (MIP2-1565)", async () => {
    let t = 1_000_000
    const watch = new RestartWatch(() => t)
    const pids = new Map([[A, 100 as number | null]])
    const host = { attach: async (_id: string) => ({ file: 'claude' }) }
    const recorded = recordRestarts(host, watch, id => pids.get(id) === null)
    watch.observe([{ sessionId: A, pid: 100, startedAt: 1 }])
    // Focus opens on the running session; its process is killed and the supervisor restarts it 10 s later.
    await recorded.attach(A)
    t += 10_400
    expect(watch.observe([{ sessionId: A, pid: 101, startedAt: t }])).toEqual([A])
    // An attach to the stopped session is the app's own restart.
    pids.set(A, null)
    await recorded.attach(A)
    t += 2_000
    expect(watch.observe([{ sessionId: A, pid: 102, startedAt: t }])).toEqual([])
  })
})

describe('recordRestarts after a /clear (MIP2-1557)', () => {
  it("records the session's current id when called with its launch id, where the poll sees it", async () => {
    const seen: string[] = []
    const host = { resume: async (_id: string) => {} }
    await recordRestarts(host, { expect: id => void seen.push(id) }, () => true, id => (id === A ? B : id)).resume(A)
    expect(seen).toEqual([B])
  })
})

describe('unexplainedRestart', () => {
  it('passes when the verdict does, and names the refusal when it does not', () => {
    expect(unexplainedRestart(A, () => null)).toBeNull()
    expect(unexplainedRestart(A, () => 'its saved options hold flags the app never passed')).toBe('Claude Code restarted it by itself, and its saved options hold flags the app never passed')
    expect(unexplainedRestart(A, () => "Claude Code's saved options for it can't be read")).toBe("Claude Code restarted it by itself, and Claude Code's saved options for it can't be read")
  })
})
