import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { FleetPoller } from '../src/fleet-poller.ts'
import { SupervisorHost } from '../src/supervisor-host.ts'
import { REPORT_FRESH_MS } from '../src/usage-report.ts'

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
    type R = { value: { fiveHour: { usedPercent: number; resetsAt: number } | null; sevenDay: null }; source: 'statusline' | 'mod' | 'usage-report'; observedAt: number; stale: boolean }
    const at = (used: number, observedAt: number, source: R['source'] = 'statusline', resetsAt = 2_000_000_000): R => ({ value: { fiveHour: { usedPercent: used, resetsAt }, sevenDay: null }, source, observedAt, stale: false })
    const meterOf = (p: FleetPoller) => (p as unknown as { usage: (s: unknown[]) => R | null }).usage.bind(p)

    it("prefers the governor's file to a mod reading whose time is only its last contact", async () => {
      const { host } = hostWith([FIXTURE])
      const p = new FleetPoller({ host, readUsage: async () => at(91, 1000) })
      await p.pollOnce().catch(() => {})
      expect(meterOf(p)([{ rateLimits: at(5, 9999, 'mod') }])?.value.fiveHour?.usedPercent).toBe(91)
    })

    it("takes the newer of Claude Code's /usage and the files (MIP2-1522)", async () => {
      const { host } = hostWith([FIXTURE])
      let report: R | null = at(33, 9000, 'usage-report')
      const p = new FleetPoller({ host, readUsage: async () => at(20, 5000), readReport: () => report as never })
      await p.pollOnce()
      expect(meterOf(p)([])?.value.fiveHour?.usedPercent).toBe(33)
      // No report: the file's reading, but never back to an older one than shown.
      report = null
      const q = new FleetPoller({ host, readUsage: async () => at(20, 5000), readReport: () => report as never })
      await q.pollOnce()
      expect(meterOf(q)([])?.value.fiveHour?.usedPercent).toBe(20)
    })

    it("shows a reading with the 7-day window only, from /usage, a file or a mod (MIP2-1590)", async () => {
      const { host } = hostWith([FIXTURE])
      const weekly = (used: number, observedAt: number, source: R['source']) => ({ value: { fiveHour: null, sevenDay: { usedPercent: used, resetsAt: 2_000_000_000 } }, source, observedAt, stale: false })
      const fromReport = new FleetPoller({ host, readUsage: async () => null, readReport: () => weekly(3, 9000, 'usage-report') as never })
      expect((await fromReport.pollOnce()).usage?.value.sevenDay?.usedPercent).toBe(3)
      const fromFile = new FleetPoller({ host, readUsage: async () => weekly(4, 5000, 'statusline') as never })
      expect((await fromFile.pollOnce()).usage?.value).toEqual({ fiveHour: null, sevenDay: { usedPercent: 4, resetsAt: 2_000_000_000, observedAt: 5000, source: 'statusline' } })
      const fromMod = new FleetPoller({ host, readUsage: async () => null, now: () => 1_800_000_000_000 })
      expect((meterOf(fromMod) as (s: unknown[]) => { value: { sevenDay: { usedPercent: number } } } | null)([{ rateLimits: weekly(5, 100, 'mod') }])?.value.sevenDay.usedPercent).toBe(5)
    })

    it("keeps a window from an older complete reading when a newer one lacks it (gate pass 24, M-5)", async () => {
      const { host } = hostWith([FIXTURE])
      const full = { value: { fiveHour: { usedPercent: 40, resetsAt: 2_000_000_000 }, sevenDay: { usedPercent: 10, resetsAt: 2_000_000_000 } }, source: 'usage-report' as const, observedAt: 9000, stale: false }
      const weekly = { value: { fiveHour: null, sevenDay: { usedPercent: 11, resetsAt: 2_000_000_000 } }, source: 'statusline' as const, observedAt: 9500, stale: false }
      const p = new FleetPoller({ host, readUsage: async () => weekly as never, readReport: () => full as never, now: () => 1_800_000_000_000 })
      const u = (await p.pollOnce()).usage
      // Each window says where its own reading came from (gate pass 25, L-3).
      expect(u?.value.fiveHour).toEqual({ usedPercent: 40, resetsAt: 2_000_000_000, observedAt: 9000, source: 'usage-report' })
      expect(u?.value.sevenDay).toEqual({ usedPercent: 11, resetsAt: 2_000_000_000, observedAt: 9500, source: 'statusline' })
    })

    it("says which windows /usage itself listed, and goes stale with its reading, apart from the merged meter (MIP2-1613)", async () => {
      const { host } = hostWith([FIXTURE])
      let t = 1_800_000_000_000
      const report = { value: { fiveHour: null, sevenDay: { usedPercent: 12, resetsAt: t / 1000 + 86_400 } }, source: 'usage-report', observedAt: t, stale: false }
      // A statusline file still carries a 5h: the meter shows it, and the report's own word is kept apart.
      const file = { value: { fiveHour: { usedPercent: 30, resetsAt: t / 1000 + 3600 }, sevenDay: null }, source: 'statusline', observedAt: t, stale: false }
      const p = new FleetPoller({ host, readUsage: async () => file as never, readReport: () => report as never, now: () => t })
      const snap = await p.pollOnce()
      expect(snap.usage?.value.fiveHour?.usedPercent).toBe(30)
      expect(snap.usageReported).toEqual({ value: { fiveHour: false, sevenDay: true }, source: 'usage-report', observedAt: report.observedAt, stale: false })
      t += REPORT_FRESH_MS + 1
      expect((await p.pollOnce()).usageReported?.stale).toBe(true)
      const none = new FleetPoller({ host, readUsage: async () => null })
      expect(await none.pollOnce()).not.toHaveProperty('usageReported')
    })

    it('shows a window as not reported once its last reading has reset and no source carries it (MIP2-1590)', async () => {
      const { host } = hostWith([FIXTURE])
      let t = 1_800_000_000_000
      let report: unknown = { value: { fiveHour: { usedPercent: 40, resetsAt: t / 1000 + 60 }, sevenDay: { usedPercent: 10, resetsAt: t / 1000 + 86_400 } }, source: 'usage-report', observedAt: t, stale: false }
      const p = new FleetPoller({ host, readUsage: async () => null, readReport: () => report as never, now: () => t })
      expect((await p.pollOnce()).usage?.value.fiveHour?.usedPercent).toBe(40)
      // The server stops reporting the 5-hour window: it holds until its reset, then it's gone.
      t += 30_000
      report = { value: { fiveHour: null, sevenDay: { usedPercent: 11, resetsAt: t / 1000 + 86_400 } }, source: 'usage-report', observedAt: t, stale: false }
      expect((await p.pollOnce()).usage?.value.fiveHour?.usedPercent).toBe(40)
      t += 60_000
      report = { value: { fiveHour: null, sevenDay: { usedPercent: 12, resetsAt: t / 1000 + 86_400 } }, source: 'usage-report', observedAt: t, stale: false }
      expect((await p.pollOnce()).usage?.value.fiveHour).toBeNull()
    })

    it('lets a held window that has reset give way to an older reading that still carries it (gate pass 25, L-3)', async () => {
      const { host } = hostWith([FIXTURE])
      let t = 1_800_000_000_000
      let report: unknown = { value: { fiveHour: { usedPercent: 40, resetsAt: t / 1000 + 60 }, sevenDay: null }, source: 'usage-report', observedAt: t, stale: false }
      const file = { value: { fiveHour: { usedPercent: 5, resetsAt: t / 1000 + 18_000 }, sevenDay: null }, source: 'statusline', observedAt: t - 10_000, stale: false }
      const p = new FleetPoller({ host, readUsage: async () => file as never, readReport: () => report as never, now: () => t })
      expect((await p.pollOnce()).usage?.value.fiveHour?.usedPercent).toBe(40)
      // The report goes stale and its window resets; the older file's reading, still in its window, is shown.
      t += 120_000
      report = { ...(report as object), stale: true }
      expect((await p.pollOnce()).usage?.value.fiveHour?.usedPercent).toBe(5)
    })

    it('keeps a held window that has reset rather than step back to an older reading from an earlier window (gate pass 26, L-1)', async () => {
      const { host } = hostWith([FIXTURE])
      let t = 1_800_000_000_000
      let report: unknown = { value: { fiveHour: { usedPercent: 40, resetsAt: t / 1000 + 60 }, sevenDay: null }, source: 'usage-report', observedAt: t, stale: false }
      const older = { value: { fiveHour: { usedPercent: 90, resetsAt: t / 1000 - 3600 }, sevenDay: null }, source: 'statusline', observedAt: t - 7_200_000, stale: false }
      const p = new FleetPoller({ host, readUsage: async () => older as never, readReport: () => report as never, now: () => t })
      expect((await p.pollOnce()).usage?.value.fiveHour?.usedPercent).toBe(40)
      t += 120_000
      report = { ...(report as object), stale: true }
      expect((await p.pollOnce()).usage?.value.fiveHour?.usedPercent).toBe(40)
    })

    it("keeps a window still in its own window over a newer reading whose window has reset (gate pass 27, L-3)", async () => {
      const { host } = hostWith([FIXTURE])
      const t = 1_800_000_000_000
      const report = { value: { fiveHour: { usedPercent: 40, resetsAt: t / 1000 + 3600 }, sevenDay: null }, source: 'usage-report', observedAt: t - 100_000, stale: false }
      const expired = { value: { fiveHour: { usedPercent: 99, resetsAt: t / 1000 - 60 }, sevenDay: null }, source: 'statusline', observedAt: t - 1000, stale: false }
      let file: unknown = null
      const p = new FleetPoller({ host, readUsage: async () => file as never, readReport: () => report as never, now: () => t })
      expect((await p.pollOnce()).usage?.value.fiveHour?.usedPercent).toBe(40)
      file = expired
      expect((await p.pollOnce()).usage?.value.fiveHour?.usedPercent).toBe(40)
    })

    it('with no window held, takes a reading still in its window over a newer one past its reset (gate pass 28, L-3)', async () => {
      const { host } = hostWith([FIXTURE])
      const t = 1_800_000_000_000
      const report = { value: { fiveHour: { usedPercent: 40, resetsAt: t / 1000 + 3600 }, sevenDay: null }, source: 'usage-report', observedAt: t - 100_000, stale: false }
      const expired = { value: { fiveHour: { usedPercent: 99, resetsAt: t / 1000 - 60 }, sevenDay: null }, source: 'statusline', observedAt: t - 1000, stale: false }
      const p = new FleetPoller({ host, readUsage: async () => expired as never, readReport: () => report as never, now: () => t })
      expect((await p.pollOnce()).usage?.value.fiveHour?.usedPercent).toBe(40)
    })

    it('ranks a source whose reset time is unknown above a mod still in its window (gate pass 29, L-4)', async () => {
      const { host } = hostWith([FIXTURE])
      const t = 1_800_000_000_000
      const report = { value: { fiveHour: { usedPercent: 40, resetsAt: null }, sevenDay: null }, source: 'usage-report', observedAt: t - 100_000, stale: false }
      const mod = { value: { fiveHour: { usedPercent: 7, resetsAt: t / 1000 + 3600 }, sevenDay: null }, source: 'mod', observedAt: t, stale: false }
      const p = new FleetPoller({ host, readUsage: async () => null, readReport: () => report as never, now: () => t })
      await p.pollOnce()
      const meter = (p as unknown as { usage: (s: unknown[]) => { value: { fiveHour: { usedPercent: number } | null } } | null }).usage.bind(p)
      expect(meter([{ rateLimits: mod }])?.value.fiveHour?.usedPercent).toBe(40)
    })

    it('lets a newer source with an unknown reset time replace a held reading still in its window (gate pass 30, L-3)', async () => {
      const { host } = hostWith([FIXTURE])
      const t = 1_800_000_000_000
      let report: unknown = { value: { fiveHour: { usedPercent: 40, resetsAt: t / 1000 + 3600 }, sevenDay: null }, source: 'usage-report', observedAt: t - 10_000, stale: false }
      const p = new FleetPoller({ host, readUsage: async () => null, readReport: () => report as never, now: () => t })
      expect((await p.pollOnce()).usage?.value.fiveHour?.usedPercent).toBe(40)
      report = { value: { fiveHour: { usedPercent: 55, resetsAt: null }, sevenDay: null }, source: 'usage-report', observedAt: t, stale: false }
      expect((await p.pollOnce()).usage?.value.fiveHour?.usedPercent).toBe(55)
    })

    it('says when its session list was read, before the rest of the poll (gate pass 25, M-1)', async () => {
      const { host } = hostWith([FIXTURE])
      let t = 1000
      const p = new FleetPoller({ host, readUsage: async () => ((t = 5000), null), now: () => t })
      const snap = await p.pollOnce()
      expect(snap.listedAt).toBe(1000)
      expect(snap.at).toBe(5000)
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
