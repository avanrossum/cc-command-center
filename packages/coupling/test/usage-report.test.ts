// Claude Code's `/usage` as the meter's main source (MIP2-1522), on Research's recordings (MIP2-1530, 2.1.312).

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { folderRefusal, parseUsageReport, REPORT_BACKOFF_MAX_MS, REPORT_EVERY_MS, USAGE_REPORT_ARGS, UsageReportReader } from '../src/usage-report.ts'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/usage-report-2.1.312-${name}.jsonl`, import.meta.url), 'utf8')

describe('parseUsageReport', () => {
  it('maps session to the 5h window and weekly_all to the 7d one, keeps the scoped week as an extra row, and reads credits in cents', () => {
    const r = parseUsageReport(fixture('normal'))!
    expect(r.rateLimits).toEqual({
      fiveHour: { usedPercent: 10, resetsAt: Math.floor(Date.parse('2026-10-29T08:39:59.590460+00:00') / 1000) },
      sevenDay: { usedPercent: 70, resetsAt: Math.floor(Date.parse('2026-10-31T14:59:59.590480+00:00') / 1000) },
    })
    expect(r.extra).toEqual([{ kind: 'weekly_scoped', label: 'Fable', usedPercent: 0, resetsAt: Math.floor(Date.parse('2026-10-31T15:00:00+00:00') / 1000) }])
    expect(r.credits).toEqual({ enabled: true, used: 0, limit: 10000, currency: 'USD' })
  })

  it('with no network, limits are null: no reading of the windows, whatever the text says; credits still read', () => {
    const r = parseUsageReport(fixture('no-network'))!
    expect(r.rateLimits).toBeNull()
    expect(r.credits?.limit).toBe(10000)
  })

  it('with no usage_report (--bare), there is no report at all', () => {
    expect(parseUsageReport(fixture('bare'))).toBeNull()
  })

  it('keeps an unknown kind as an extra row, skips malformed limits, and reads a null cap as no cap', () => {
    const line = JSON.stringify({
      type: 'assistant',
      usage_report: {
        rate_limits: {
          limits: [{ kind: 'session', percent: 'ten' }, { kind: 'monthly_new', percent: 4, resets_at: 'not a date' }, { kind: 'weekly_all', percent: 12, resets_at: '2026-11-01T00:00:00Z' }],
          extra_usage: { is_enabled: false, monthly_limit: null, used_credits: 250, currency: 'USD' },
        },
      },
    })
    const r = parseUsageReport(`garbage\n${line}\n`)!
    expect(r.rateLimits).toEqual({ fiveHour: null, sevenDay: { usedPercent: 12, resetsAt: Date.parse('2026-11-01T00:00:00Z') / 1000 } })
    expect(r.extra).toEqual([{ kind: 'monthly_new', label: null, usedPercent: 4, resetsAt: null }])
    expect(r.credits).toEqual({ enabled: false, used: 250, limit: null, currency: 'USD' })
  })
})

describe('UsageReportReader', () => {
  const empty = mkdtempSync(join(tmpdir(), 'ccc-usage-run-'))

  it('runs /usage without a transcript, in its own folder', async () => {
    const calls: { args: string[]; cwd: string }[] = []
    const reader = new UsageReportReader({ run: async (args, o) => (calls.push({ args, cwd: o.cwd }), fixture('normal')), cwd: empty, now: () => 5 })
    expect(await reader.readOnce()).toBe(true)
    expect(calls).toEqual([{ args: [...USAGE_REPORT_ARGS], cwd: empty }])
    expect(USAGE_REPORT_ARGS).toContain('--no-session-persistence')
    // The user's hooks, MCP servers and plugins stay out of every poll (Research, MIP2-1530 follow-up).
    expect(USAGE_REPORT_ARGS.join(' ')).toContain('--setting-sources project,local')
    expect(USAGE_REPORT_ARGS).toContain('--strict-mcp-config')
    expect(USAGE_REPORT_ARGS).not.toContain('--bare')
    expect(reader.current()).toMatchObject({ source: 'usage-report', observedAt: 5, value: { fiveHour: { usedPercent: 10 } } })
  })

  it('backs off from the first empty reading, keeps the last good one, and resets on the next good one', async () => {
    let out = fixture('normal')
    let t = 1
    const reader = new UsageReportReader({ run: async () => out, cwd: empty, now: () => t })
    await reader.readOnce()
    out = fixture('no-network')
    t = 2
    expect(await reader.readOnce()).toBe(false)
    expect(reader.nextWaitMs()).toBe(REPORT_EVERY_MS * 2)
    expect(reader.current()?.observedAt).toBe(1)
    const failing = new UsageReportReader({ run: async () => Promise.reject(new Error('exit 1')), cwd: empty, log: () => {} })
    for (let i = 0; i < 8; i++) await failing.readOnce()
    expect(failing.nextWaitMs()).toBe(REPORT_BACKOFF_MAX_MS)
    out = fixture('normal')
    await reader.readOnce()
    expect(reader.nextWaitMs()).toBe(REPORT_EVERY_MS)
  })

  it("runs nothing when its folder isn't empty, as a .claude folder or .mcp.json there would load (MIP2-1522)", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccc-usage-run-'))
    try {
      expect(folderRefusal(dir)).toBeNull()
      writeFileSync(join(dir, '.mcp.json'), '{}')
      expect(folderRefusal(dir)).toMatch(/isn't empty \(\.mcp\.json\)/)
      rmSync(join(dir, '.mcp.json'))
      mkdirSync(join(dir, '.claude'))
      let ran = 0
      const lines: string[] = []
      const reader = new UsageReportReader({ run: async () => (ran++, fixture('normal')), cwd: dir, log: l => lines.push(l) })
      expect(await reader.readOnce()).toBe(false)
      expect(ran).toBe(0)
      expect(lines).toEqual([expect.stringMatching(/not run: its folder isn't empty \(\.claude\)/)])
      expect(folderRefusal(join(dir, 'missing'))).toBe('its folder is missing')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
