// The supervisor's own restart of a session (MIP2-1512, Research MIP2-1527).

import { describe, expect, it } from 'vitest'
import { OWN_RESTART_MS, recordRestarts, RestartWatch, unexplainedRestart } from '../src/main/restart-watch.ts'

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

  it('a first sighting and a session that left the list are not changes', () => {
    const watch = new RestartWatch(() => 0)
    expect(watch.observe([{ sessionId: A, pid: 100, startedAt: 1 }])).toEqual([])
    expect(watch.observe([])).toEqual([])
    // Back with a new process after leaving the list: seen fresh, not as a restart.
    expect(watch.observe([{ sessionId: A, pid: 300, startedAt: 2 }])).toEqual([])
  })
})

describe('recordRestarts', () => {
  it('records resume, respawn, attach and a move in before they run, and leaves other methods alone', async () => {
    const order: string[] = []
    const watch = { expect: (id: string) => void order.push(`expect ${id}`) }
    const host = {
      resume: async (id: string) => void order.push(`resume ${id}`),
      respawn: async (id: string) => void order.push(`respawn ${id}`),
      attach: async (id: string) => (order.push(`attach ${id}`), { file: 'claude' }),
      moveIn: async (id: string) => (order.push(`moveIn ${id}`), { sessionId: id, sameId: true }),
      stop: async (id: string) => void order.push(`stop ${id}`),
    }
    const recorded = recordRestarts(host, watch)
    await recorded.resume(A)
    await recorded.respawn(A)
    await recorded.attach(A)
    await recorded.moveIn(A)
    await recorded.stop(A)
    expect(order).toEqual([`expect ${A}`, `resume ${A}`, `expect ${A}`, `respawn ${A}`, `expect ${A}`, `attach ${A}`, `expect ${A}`, `moveIn ${A}`, `stop ${A}`])
  })
})

describe('recordRestarts after a /clear (MIP2-1557)', () => {
  it("records the session's current id when called with its launch id, where the poll sees it", async () => {
    const seen: string[] = []
    const host = { resume: async (_id: string) => {} }
    await recordRestarts(host, { expect: id => void seen.push(id) }, id => (id === A ? B : id)).resume(A)
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
