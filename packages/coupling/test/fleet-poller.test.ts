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

  it("uses only the usage folder's reading for QA's synthetic readings, never a fresher mod's (MIP2-1516)", async () => {
    const reading = (used: number, at: number) => ({ value: { fiveHour: { usedPercent: used, resetsAt: 2_000_000_000 }, sevenDay: null }, source: 'statusline' as const, observedAt: at, stale: false })
    const { host } = hostWith([FIXTURE])
    const poller = new FleetPoller({ host, readUsage: async () => reading(91, 1000), usageFileOnly: true })
    // A session's own reading would be fresher; with the switch on it's ignored.
    const snap = await poller.pollOnce()
    expect(snap.usage?.value.fiveHour?.usedPercent).toBe(91)
    const usage = (poller as unknown as { usage: (s: unknown[]) => { value: { fiveHour: { usedPercent: number } } } | null }).usage.bind(poller)
    expect(usage([{ rateLimits: reading(5, 9999) }])?.value.fiveHour.usedPercent).toBe(91)
  })

  describe('the usage meter (MIP2-1520)', () => {
    type R = { value: { fiveHour: { usedPercent: number; resetsAt: number } | null; sevenDay: null }; source: 'statusline' | 'mod'; observedAt: number; stale: boolean }
    const at = (used: number, observedAt: number, source: R['source'] = 'statusline', resetsAt = 2_000_000_000): R => ({ value: { fiveHour: { usedPercent: used, resetsAt }, sevenDay: null }, source, observedAt, stale: false })
    const meterOf = (p: FleetPoller) => (p as unknown as { usage: (s: unknown[]) => R | null }).usage.bind(p)

    it("prefers the governor's file to a mod reading whose time is only its last contact", async () => {
      const { host } = hostWith([FIXTURE])
      const p = new FleetPoller({ host, readUsage: async () => at(91, 1000) })
      await p.pollOnce().catch(() => {})
      expect(meterOf(p)([{ rateLimits: at(5, 9999, 'mod') }])?.value.fiveHour?.usedPercent).toBe(91)
    })

    it('passes the listed sessions to the file read', async () => {
      const { host } = hostWith([FIXTURE])
      let seen: ReadonlySet<string> | null = null
      const p = new FleetPoller({ host, readUsage: async listed => ((seen = listed), null) })
      const snap = await p.pollOnce()
      expect([...(seen ?? [])]).toEqual(snap.sessions.map(s => s.sessionId))
    })

    it("falls back to a mod's reading, skipping one whose window has reset", async () => {
      const { host } = hostWith([FIXTURE])
      const p = new FleetPoller({ host, readUsage: async () => null, now: () => 1_800_000_000_000 })
      const meter = meterOf(p)
      expect(meter([{ rateLimits: at(70, 9999, 'mod', 1_700_000_000) }, { rateLimits: at(30, 5000, 'mod') }])?.value.fiveHour?.usedPercent).toBe(30)
    })

    it('never steps back to an older reading, and holds the last one when nothing reads', async () => {
      const { host } = hostWith([FIXTURE])
      let file: R | null = at(40, 5000)
      const p = new FleetPoller({ host, readUsage: async () => file })
      await p.pollOnce()
      const meter = meterOf(p)
      expect(meter([])?.value.fiveHour?.usedPercent).toBe(40)
      file = at(12, 3000)
      await p.pollOnce()
      expect(meter([])?.value.fiveHour?.usedPercent).toBe(40)
      file = null
      await p.pollOnce()
      expect(meter([])).toMatchObject({ observedAt: 5000, value: { fiveHour: { usedPercent: 40 } } })
      file = at(44, 6000)
      await p.pollOnce()
      expect(meter([])?.value.fiveHour?.usedPercent).toBe(44)
    })
  })
})
