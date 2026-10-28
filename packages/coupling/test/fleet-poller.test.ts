import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FleetPoller } from '../src/fleet-poller.ts'
import { SupervisorHost } from '../src/supervisor-host.ts'

const FIXTURE = readFileSync(new URL('./fixtures/agents-json-2.1.311.json', import.meta.url), 'utf8')

function hostWith(outputs: (string | Error)[]) {
  const calls: string[][] = []
  const host = new SupervisorHost({
    now: () => 1000,
    run: async args => {
      calls.push(args)
      const next = outputs.shift()
      if (next instanceof Error) throw next
      return next ?? '[]'
    },
  })
  return { host, calls }
}

describe('SupervisorHost.list', () => {
  it('polls agents --json --all', async () => {
    const { host, calls } = hostWith([FIXTURE])
    const { sessions } = await host.list()
    expect(calls).toEqual([['agents', '--json', '--all']])
    expect(sessions).toHaveLength(6)
  })

})

describe('FleetPoller', () => {
  it('publishes a snapshot with healthy source after a good poll', async () => {
    const { host } = hostWith([FIXTURE])
    const poller = new FleetPoller({ host, now: () => 2000 })
    const snap = await poller.pollOnce()
    expect(snap.contractVersion).toBe(1)
    expect(snap.sessions).toHaveLength(6)
    expect(snap.sources).toEqual([{ source: 'agents-json', ok: true, lastOkAt: 2000, error: null }])
  })

  it('keeps the last sessions, marked stale, when a poll fails', async () => {
    const { host } = hostWith([FIXTURE, new Error('claude agents --json --all: timed out')])
    const poller = new FleetPoller({ host, now: () => 2000 })
    await poller.pollOnce()
    const snap = await poller.pollOnce()
    expect(snap.sessions).toHaveLength(6)
    expect(snap.sessions.every(s => s.activity.stale && s.cwd.stale)).toBe(true)
    expect(snap.sources[0]).toMatchObject({ ok: false, lastOkAt: 2000, error: 'claude agents --json --all: timed out' })
  })

  it('clears staleness when the source recovers', async () => {
    const { host } = hostWith([new Error('down'), FIXTURE])
    const poller = new FleetPoller({ host })
    await poller.pollOnce()
    const snap = await poller.pollOnce()
    expect(snap.sessions.some(s => s.activity.stale)).toBe(false)
    expect(snap.sources[0]?.ok).toBe(true)
  })

  it('reports unreadable entries on the source line', async () => {
    const { host } = hostWith([JSON.stringify([{ cwd: '/a', kind: 'interactive', startedAt: 1 }])])
    const snap = await new FleetPoller({ host }).pollOnce()
    expect(snap.sources[0]?.error).toBe('1 entries unreadable: no sessionId')
  })

  it('gives a new subscriber the latest snapshot at once', async () => {
    const { host } = hostWith([FIXTURE])
    const poller = new FleetPoller({ host })
    await poller.pollOnce()
    const seen: number[] = []
    poller.subscribe(s => seen.push(s.sessions.length))
    expect(seen).toEqual([6])
  })

  it('keeps publishing to the other listeners when one throws (gate pass 15, M-2)', async () => {
    const { host } = hostWith([FIXTURE, FIXTURE])
    const poller = new FleetPoller({ host })
    const seen: number[] = []
    poller.subscribe(() => {
      throw new TypeError('a broken listener')
    })
    poller.subscribe(s => seen.push(s.sessions.length))
    await poller.pollOnce()
    await poller.pollOnce()
    expect(seen).toEqual([6, 6])
  })

  it('schedules the next poll after one that throws (gate pass 15, M-2)', async () => {
    const { host } = hostWith([])
    const poller = new FleetPoller({ host, intervalMs: 5 })
    let polls = 0
    poller.pollOnce = async () => {
      polls++
      throw new Error('a poll that throws')
    }
    poller.start()
    await new Promise(r => setTimeout(r, 60))
    poller.stop()
    expect(polls).toBeGreaterThan(1)
  })
})
