// A refusal reaches its booking and its stop whichever way it comes: the poll's verdict through a session's channel,
// a channel mark, or a session with no channel (gate pass 34, M-1, L-2).

import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChannelHub, memoryReplyKeys } from '@ccc/coupling'
import { refusals, restartPoll, runQueuedStops, stopNotice, StopRetries, type Refusals } from '../src/main/restart-poll.ts'
import { resumeFromApp } from '../src/main/resume.ts'
import { RestartWatch } from '../src/main/restart-watch.ts'

const A = 'c0ffee01-0000-4000-8000-000000000001'
const B = 'c0ffee02-0000-4000-8000-000000000002'
const WHY = "its saved options hold flags the app never passed"

let base: string
beforeEach(() => void (base = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-refusals-')))))
afterEach(() => rmSync(base, { recursive: true, force: true }))

function wire(markChannel: (r: Refusals) => (id: string, why: string) => boolean, markChannelless?: (id: string, why: string) => void) {
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
    ...(markChannelless ? { markChannelless } : {}),
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

  it('keeps the mark in the hub too, so a resume from the app is refused in the same run (gate pass 43, L-2)', async () => {
    const hub = new ChannelHub({ modDir: '/mod', root: join(base, 'ch3'), longPollMs: 300, log: () => {}, replyKeys: memoryReplyKeys() })
    const w = wire(() => (id, why) => hub.markSession(id, why), (id, why) => hub.restoreMarks([[id, why]]))
    poll(w, 200)
    expect(hub.untrustedReason(A)).toMatch(/started it while the app wasn't checking/)
    const resumed: string[] = []
    await expect(
      resumeFromApp(A, { host: { stopIfRunning: async () => false, resume: async id => void resumed.push(id) }, hub, onRekeyed: () => {} }),
    ).rejects.toThrow(/can't be trusted/)
    expect(resumed).toEqual([])
    await hub.closeAll()
  })

  it('stops the session though its mark fails to save, and says so (gate pass 53, M-1)', () => {
    const stops: string[] = []
    const notes: string[] = []
    const notices: string[] = []
    const r = refusals({
      book: { refuse: () => 200, forget: () => {}, recordRefusedStart: () => undefined, seed: () => {}, refuseNextSighting: () => {}, dropLift: () => {}, note: what => void notes.push(what) },
      stop: id => void stops.push(id),
      stopRunning: () => false,
      markStore: () => {
        throw new Error('disk full')
      },
      notice: t => void notices.push(t),
      markChannel: () => false,
    })
    r.markRestarted(A, 'its saved options hold flags the app never passed')
    expect(stops).toEqual([A])
    expect(notes).toContain('mark-not-saved')
    expect(notices.some(t => /couldn't save that a session is untrusted.*disk full/.test(t))).toBe(true)
  })

  it.each([
    ['a live process', 200],
    ['no live process', undefined],
  ])('stops the session, with %s, though every store write throws, before any of them (gate pass 54, H-1)', (_, startedAt) => {
    const order: string[] = []
    const notes: string[] = []
    const notices: string[] = []
    const fail = (what: string) => () => {
      order.push(what)
      throw new Error('disk full')
    }
    const r = refusals({
      book: {
        refuse: () => startedAt,
        forget: () => {},
        recordRefusedStart: fail('record'),
        seed: () => {},
        refuseNextSighting: fail('next'),
        dropLift: () => {},
        note: what => void notes.push(what),
      },
      stop: id => void order.push(`stop ${id}`),
      stopRunning: () => false,
      markStore: fail('mark'),
      notice: t => void notices.push(t),
      markChannel: () => false,
    })
    expect(() => r.markRestarted(A, WHY)).not.toThrow()
    expect(order).toEqual([`stop ${A}`, startedAt === undefined ? 'next' : 'record', 'mark'])
    expect(notes).toEqual(expect.arrayContaining(['refusal-not-saved', 'mark-not-saved']))
    expect(notices.some(t => /couldn't save a session's refusal.*disk full/.test(t))).toBe(true)
    expect(notices.at(-1)).toBe(`Stopping a session: ${WHY}.`)
  })

  it('stops a channel-marked session though every store write throws (gate pass 54, H-1)', () => {
    const stops: string[] = []
    const r = refusals({
      book: { refuse: () => 200, forget: () => {}, recordRefusedStart: () => { throw new Error('x') }, seed: () => {}, refuseNextSighting: () => {}, dropLift: () => {}, note: () => {} },
      stop: id => void stops.push(id),
      stopRunning: () => false,
      markStore: () => { throw new Error('x') },
      notice: () => {},
      markChannel: () => false,
    })
    r.onUntrusted(A, 'the socket file was replaced')
    expect(stops).toEqual([A])
  })

  it('books nothing for a channel with no session bound', () => {
    const w = wire(() => () => true)
    w.r.onUntrusted(null, 'the socket file was replaced')
    expect([w.marked, w.stops]).toEqual([[], []])
  })
})

describe('stops queued while channels recover (gate pass 33, L-1; pass 34, L-2; pass 37, L-1; pass 48, L-2; pass 50, L-1)', () => {
  const run = (queued: { id: string; told?: string }[], stopped: (id: string) => boolean) => {
    const calls: string[] = []
    const done = runQueuedStops(queued, {
      stop: async id => (calls.push(`stop ${id}`), stopped(id)),
      finish: (id, s) => void calls.push(`finish ${id} ${s}`),
      notice: (_id, told, s) => void calls.push(`notice ${told} ${s}`),
    })
    return { calls, done }
  }

  it('starts every stop at once, and each queued with a notice reports its own outcome, a fast one too', async () => {
    const { calls, done } = run([{ id: A, told: 'A changed.' }, { id: B, told: 'B changed.' }, { id: 'c0ffee03-0000-4000-8000-000000000003' }], id => id !== B)
    await done
    expect(calls).toEqual([
      `stop ${A}`,
      `stop ${B}`,
      'stop c0ffee03-0000-4000-8000-000000000003',
      `finish ${A} true`,
      'notice A changed. true',
      `finish ${B} false`,
      'notice B changed. false',
      'finish c0ffee03-0000-4000-8000-000000000003 true',
    ])
  })

  it('stops each session once, with the first notice queued for it (gate pass 35, L-2)', async () => {
    const { calls, done } = run([{ id: A, told: 'first.' }, { id: A, told: 'second.' }], () => true)
    await done
    expect(calls).toEqual([`stop ${A}`, `finish ${A} true`, 'notice first. true'])
  })
})

describe('stopNotice says only what the stop command showed (gate pass 51, L-1)', () => {
  it('reads a stop that exited 0 as sent, for a session the host does not list too, and says "keeps trying" only with a retry queued', () => {
    const UNLISTED = 'c0ffee09-0000-4000-8000-000000000009'
    expect(stopNotice(UNLISTED, 'its channel changed.', true, false)).toBe('Stop sent to session c0ffee09: its channel changed.')
    expect(stopNotice(A, 'x.', false, true)).toBe(`Couldn't stop session ${A.slice(0, 8)} yet, and the app keeps trying: x.`)
    expect(stopNotice(A, 'x.', false, false)).toBe(`Couldn't stop session ${A.slice(0, 8)}: x.`)
    const retries = new StopRetries()
    expect(retries.tracking(A)).toBe(false)
    retries.seed(A)
    expect(retries.tracking(A)).toBe(true)
  })
})
