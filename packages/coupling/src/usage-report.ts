// The usage meter's main source (MIP2-1522): Claude Code's own `/usage`,
// read with `claude -p "/usage" --output-format stream-json --verbose
// --no-session-persistence`. The assistant line carries `usage_report`
// (Agent SDK `SDKUsageReport`, marked experimental). No model call is made
// and no token is read; Claude Code fetches the data itself. Research
// MIP2-1530, Claude Code 2.1.312:
//
// - Only `usage_report.rate_limits.limits` is trusted. With no network it's
//   `limits: null` while the text still shows old percentages, so the text
//   is never read. A missing report, or null limits, is no new reading; the
//   meter falls back to the governor's files (fleet-poller.ts).
// - `session` matches the statusLine's `five_hour` and `weekly_all` its
//   `seven_day` (observed, not documented). Other kinds are kept as extra
//   rows.
// - `extra_usage` amounts are in minor units of `currency` (cents for USD),
//   for the billing period, with no reset date. A null `monthly_limit` is no
//   cap of its own, not "unlimited".
// - `--no-session-persistence` keeps each run from writing a transcript. It
//   runs in an empty folder the app owns, since a `-p` run loads a folder's
//   project hooks and MCP servers (`headless.md`).
// - `--setting-sources project,local` leaves out the user's settings, so a
//   poll doesn't fire their SessionStart and SessionEnd hooks, start their
//   MCP servers and claude.ai connectors, or load their plugins, and the
//   report still comes; `--strict-mcp-config` guards MCP as well (Research,
//   MIP2-1530 follow-up).

import { readdirSync } from 'node:fs'
import { field, type Field, type RateLimits, type RateLimitWindow, type UsageLimit } from '@ccc/contract'

export const USAGE_REPORT_ARGS = ['-p', '/usage', '--output-format', 'stream-json', '--verbose', '--no-session-persistence', '--setting-sources', 'project,local', '--strict-mcp-config'] as const

/** A limit other than the two the meter shows (the contract's UsageLimit). */
export type UsageRow = UsageLimit

/** Usage-credit spend for the billing period. Amounts in minor units (cents for USD). */
export interface UsageCredits {
  enabled: boolean
  used: number
  /** Null: no cap of its own, which isn't "unlimited". */
  limit: number | null
  currency: string
}

export interface UsageReport {
  /** Null when `limits` is null: no fresh reading. */
  rateLimits: RateLimits | null
  extra: UsageRow[]
  credits: UsageCredits | null
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

function resetsAtOf(v: unknown): number | null {
  if (typeof v !== 'string') return null
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

/** The report in a run's stream-JSON output; null when no line carries one (`--bare`, or an older Claude Code). */
export function parseUsageReport(stdout: string): UsageReport | null {
  for (const line of stdout.split('\n')) {
    if (!line.startsWith('{')) continue
    let d: unknown
    try {
      d = JSON.parse(line)
    } catch {
      continue
    }
    if (!isObj(d) || d.type !== 'assistant' || !isObj(d.usage_report)) continue
    const rl = d.usage_report.rate_limits
    if (!isObj(rl)) return { rateLimits: null, extra: [], credits: null }
    return { ...limitsOf(rl.limits), credits: creditsOf(rl.extra_usage) }
  }
  return null
}

function limitsOf(v: unknown): { rateLimits: RateLimits | null; extra: UsageRow[] } {
  if (!Array.isArray(v)) return { rateLimits: null, extra: [] }
  let fiveHour: RateLimitWindow | null = null
  let sevenDay: RateLimitWindow | null = null
  const extra: UsageRow[] = []
  for (const l of v) {
    if (!isObj(l) || typeof l.kind !== 'string' || !finite(l.percent)) continue
    const resetsAt = resetsAtOf(l.resets_at)
    if (l.kind === 'session') fiveHour = { usedPercent: l.percent, resetsAt }
    else if (l.kind === 'weekly_all') sevenDay = { usedPercent: l.percent, resetsAt }
    else {
      const model = isObj(l.scope) && isObj(l.scope.model) && typeof l.scope.model.display_name === 'string' ? l.scope.model.display_name : null
      extra.push({ kind: l.kind.slice(0, 64), label: model?.slice(0, 64) ?? null, usedPercent: l.percent, resetsAt })
    }
  }
  return { rateLimits: fiveHour || sevenDay ? { fiveHour, sevenDay } : null, extra }
}

function creditsOf(v: unknown): UsageCredits | null {
  if (!isObj(v) || typeof v.is_enabled !== 'boolean' || !finite(v.used_credits) || typeof v.currency !== 'string') return null
  return { enabled: v.is_enabled, used: v.used_credits, limit: finite(v.monthly_limit) ? v.monthly_limit : null, currency: v.currency.slice(0, 8) }
}

/** Why the run folder can't be used: missing, or not empty. Null when it's an empty folder. */
export function folderRefusal(dir: string): string | null {
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return 'its folder is missing'
  }
  return names.length ? `its folder isn't empty (${names.slice(0, 3).join(', ')})` : null
}

/** How often it reads, and the longest it waits after readings that came back empty. */
export const REPORT_EVERY_MS = 3 * 60_000
export const REPORT_BACKOFF_MAX_MS = 30 * 60_000

export interface UsageReportReaderOptions {
  /** Runs `claude` with these arguments in `cwd`, resolving to stdout. */
  run: (args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<string>
  /** An empty folder the app owns. */
  cwd: string
  now?: () => number
  log?: (line: string) => void
  /** A read brought something new: the windows, or credits. */
  onRead?: () => void
}

/**
 * Reads the report every REPORT_EVERY_MS. A run that fails or comes back
 * empty doubles the wait, up to REPORT_BACKOFF_MAX_MS, starting at the first
 * one; a good reading resets it. The last good reading is kept with its time,
 * so the meter can weigh it against the governor's files.
 */
export class UsageReportReader {
  private last: { rateLimits: Field<RateLimits>; extra: Field<UsageRow[]> } | null = null
  private lastCredits: { credits: UsageCredits; at: number } | null = null
  private waitMs = REPORT_EVERY_MS
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = true
  private readonly now: () => number

  constructor(private readonly opts: UsageReportReaderOptions) {
    this.now = opts.now ?? Date.now
  }

  /** The last good reading of both windows, or null. */
  current(): Field<RateLimits> | null {
    return this.last?.rateLimits ?? null
  }

  /** The other limits from the last good reading, with its time. */
  extra(): Field<UsageRow[]> | null {
    return this.last?.extra ?? null
  }

  credits(): { credits: UsageCredits; at: number } | null {
    return this.lastCredits
  }

  /** The wait before the next read, for tests and the log. */
  nextWaitMs(): number {
    return this.waitMs
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    void this.tick()
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** One read. True when it gave a fresh reading of the windows. */
  async readOnce(): Promise<boolean> {
    let report: UsageReport | null = null
    // The folder must be empty before every run: a `.claude/` or `.mcp.json` there would load its hooks and MCP servers.
    const why = folderRefusal(this.opts.cwd)
    if (why) {
      this.opts.log?.(`usage report: not run: ${why}`)
      this.waitMs = Math.min(REPORT_BACKOFF_MAX_MS, this.waitMs * 2)
      return false
    }
    try {
      report = parseUsageReport(await this.opts.run([...USAGE_REPORT_ARGS], { cwd: this.opts.cwd, timeoutMs: 30_000 }))
    } catch (err) {
      this.opts.log?.(`usage report: ${err instanceof Error ? err.message.split('\n')[0] : String(err)}`)
    }
    const at = this.now()
    if (report?.credits) (this.lastCredits = { credits: report.credits, at }), this.opts.onRead?.()
    if (report?.rateLimits) {
      this.last = { rateLimits: field(report.rateLimits, 'usage-report', at), extra: field(report.extra, 'usage-report', at) }
      this.opts.onRead?.()
      this.waitMs = REPORT_EVERY_MS
      return true
    }
    this.waitMs = Math.min(REPORT_BACKOFF_MAX_MS, this.waitMs * 2)
    return false
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    await this.readOnce()
    if (this.stopped) return
    this.timer = setTimeout(() => void this.tick(), this.waitMs)
    this.timer.unref?.()
  }
}
