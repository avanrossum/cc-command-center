// A refusal reaches its booking and its stop whichever way it comes: the poll's verdict through a session's channel,
// a channel mark, or a session with no channel (gate pass 34, M-1, L-2).

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChannelHub, memoryReplyKeys } from '@ccc/coupling'
import { refusals, restartPoll, runQueuedStops, StopRetries, type Refusals } from '../src/main/restart-poll.ts'
import { RestartWatch } from '../src/main/restart-watch.ts'

const A = 'c0ffee01-0000-4000-8000-000000000001'
const B = 'c0ffee02-0000-4000-8000-000000000002'
const WHY = "its saved options hold flags the app never passed"

let base: string
beforeEach(() => void (base = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-refusals-')))))
afterEach(() => rmSync(base, { recursive: true, force: true }))

function wire(markChannel: (r: Refusals) => (id: string, why: string) => boolean) {
  const watch = new RestartWatch(() => 0, () => undefined)
  const retries = new StopRetries(2_000, 60_000, () => 0)
  const stops: [string, string][] = []
  const marked: [string, string][] = []
  const notices: string[] = []
  const notes: string[] = []
  const refusedStarts: [string, number][] = []
  let r: Refusals
  r = refusals({
    book: {
      refuse: id => watch.refuse(id),
      forget: id => watch.forget(id),
      recordRefusedStart: (id, at) => void refusedStarts.push([id, at]),
      seed: id => retries.seed(id),
      refuseNextSighting: () => {},
      dropLift: () => {},
      note: what => void notes.push(what),
    },
    stop: (id, told) => void stops.push([id, told]),
    stopRunning: id => retries.running(id),
    markStore: (id, why) => void marked.push([id, why]),
    notice: text => void notices.push(text),
    markChannel: (id, why) => markChannel(r)(id, why),
  })
  return { r, watch, retries, stops, marked, notices, notes, refusedStarts }
}

/** One poll: the watch's reading, the verdict, and each refusal marked as main marks it. */
function poll(w: ReturnType<typeof wire>, pid: number) {
  const processes = [{ sessionId: A, pid, startedAt: pid }]
  const changed = w.watch.observe(processes)
  const step = restartPoll({ processes, changed, unverified: w.watch.unverified, stillRefused: w.watch.stillRefused }, { verdict: () => WHY })
  for (const s of step.stop) w.r.markRestarted(s.sessionId, s.why)
  return step
}

describe('a poll refusal of a session with a channel (gate pass 34, M-1)', () => {
  it('goes through the real hub to its booking and its stop, and the process stays refused by pid', async () => {
    let hub: ChannelHub | undefined
    const w = wire(r => (id, why) => hub?.markSession(id, why) ?? false)
    hub = new ChannelHub({ modDir: '/mod', root: join(base, 'ch'), longPollMs: 300, log: () => {}, replyKeys: memoryReplyKeys(), onUntrusted: (id, why) => w.r.onUntrusted(id, why) })
    const l = await hub.prepareLaunch()
    hub.bind(l.channelId, A)
    const first = poll(w, 200)
    expect(first.stop.map(s => s.sessionId)).toEqual([A])
    expect(hub.untrustedReason(A)).toMatch(/started it while the app wasn't checking/)
    expect(w.marked).toEqual([[A, hub.untrustedReason(A)]])
    expect(w.refusedStarts).toEqual([[A, 200]])
    expect(w.stops).toEqual([[A, `${hub.untrustedReason(A)}. Resuming it from the app gives its channel a new secret first.`]])
    // Its own stop counts as running, so no retry starts before it finishes.
    expect(w.retries.start(A)).toBe(false)
    // Still listed: refused again and retried, never verified.
    const second = poll(w, 200)
    expect(second.retry).toEqual([A])
    expect(second.verified).toEqual([])
    await hub.closeAll()
  })

  it('a channel already marked still books the restarted process, and stops it once its first stop is done (gate pass 35, L-1)', async () => {
    let hub: ChannelHub | undefined
    const w = wire(r => (id, why) => hub?.markSession(id, why) ?? false)
    hub = new ChannelHub({ modDir: '/mod', root: join(base, 'ch2'), longPollMs: 300, log: () => {}, replyKeys: memoryReplyKeys(), onUntrusted: (id, why) => w.r.onUntrusted(id, why) })
    const l = await hub.prepareLaunch()
    hub.bind(l.channelId, A)
    poll(w, 200)
    poll(w, 300)
    expect(w.refusedStarts).toEqual([[A, 200], [A, 300]])
    // The first stop is still running: one stop at a time, logged, and the notice says so (gate pass 36, L-2).
    expect(w.stops).toHaveLength(1)
    expect(w.notes).toEqual(['refusal-coalesced'])
    expect(w.notices.at(-1)).toMatch(/^A session is already being stopped, and the app keeps trying: /)
    w.retries.finish(A, true)
    poll(w, 400)
    expect(w.refusedStarts).toEqual([[A, 200], [A, 300], [A, 400]])
    expect(w.stops).toHaveLength(2)
    await hub.closeAll()
  })
})

describe('a refusal with no channel to go through (gate pass 34, M-1)', () => {
  it('is marked, booked and stopped here when the hub has no channel for it', () => {
    const w = wire(() => () => false)
    poll(w, 200)
    expect(w.marked.map(m => m[0])).toEqual([A])
    expect(w.refusedStarts).toEqual([[A, 200]])
    expect(w.stops).toHaveLength(1)
    expect(w.notices[0]).toMatch(/^Stopping a session: Claude Code started it/)
  })

  it('books nothing for a channel with no session bound', () => {
    const w = wire(() => () => true)
    w.r.onUntrusted(null, 'the socket file was replaced')
    expect([w.marked, w.stops]).toEqual([[], []])
  })
})

describe('stops queued while channels recover (gate pass 33, L-1; pass 34, L-2; pass 37, L-1)', () => {
  const run = (queued: { id: string; told?: string }[], running: () => Promise<ReadonlySet<string>>, stopped = true) => {
    const calls: string[] = []
    const done = runQueuedStops(queued, {
      running,
      stop: async id => (calls.push(`stop ${id}`), stopped),
      finish: (id, s) => void calls.push(`finish ${id} ${s}`),
      notice: (told, s) => void calls.push(`notice ${told} ${s}`),
    })
    return { calls, done }
  }
  const settle = () => new Promise(r => setTimeout(r, 0))

  it('tells only a session that is running whether it stopped, and finishes every seed', async () => {
    const { calls, done } = run([{ id: A, told: 'A changed.' }, { id: B, told: 'B changed.' }], async () => new Set([A]))
    await done
    await settle()
    expect(calls).toEqual([`stop ${A}`, `stop ${B}`, `finish ${A} true`, `finish ${B} true`, 'notice A changed. true'])
  })

  it("starts and finishes every stop while the list hasn't come back", async () => {
    const { calls, done } = run([{ id: A, told: 'A changed.' }], () => new Promise(() => {}), false)
    await done
    await settle()
    expect(calls).toEqual([`stop ${A}`, `finish ${A} false`])
  })

  it('stops each session once, with the first notice queued for it (gate pass 35, L-2)', async () => {
    const { calls, done } = run([{ id: A, told: 'first.' }, { id: A, told: 'second.' }], async () => new Set([A]))
    await done
    await settle()
    expect(calls).toEqual([`stop ${A}`, `finish ${A} true`, 'notice first. true'])
  })

  it("sends no notice when the list can't be read", async () => {
    const { calls, done } = run([{ id: A, told: 'A changed.' }], async () => {
      throw new Error('supervisor down')
    }, false)
    await done
    await settle()
    expect(calls).toEqual([`stop ${A}`, `finish ${A} false`])
  })
})
