// Spend (spec MIP2-1498 §5; Research MIP2-1499 §3). Simulated spend is
// Claude Code's own per-session `cost.usd`, a list-price estimate, summed by
// calendar month: each reading's increase is added to the month and day it
// was seen in, so a session that spans a month boundary counts only its
// in-month part. Real spend is the Console's, from the Admin Usage & Cost
// API's cost report (daily buckets, USD in cents), with Alex's Console key.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SessionSnapshot } from '@ccc/contract'
import type { RealSpend, SimulatedSpend } from '../shared/spend.ts'

const monthKey = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
}
const dayKey = (ms: number) => `${monthKey(ms)}-${String(new Date(ms).getDate()).padStart(2, '0')}`

interface Month {
  total: number
  bySession: Record<string, number>
  byModel: Record<string, number>
  byDay: Record<string, number>
}

interface LedgerFile {
  /** 2 from MIP2-1521: a version 1 file booked first-seen sessions to the day they were seen, so it's rebuilt. */
  version: 2
  /** When this ledger began, Unix ms: the panel says the figures go back only to then. */
  since: number
  /** Each session's cost at its last reading. */
  last: Record<string, number>
  months: Record<string, Month>
}

/** A tally with no prototype, so a key such as `constructor` or `__proto__` is just a key (gate pass 15, L-3). */
const tally = (from: Record<string, number> = {}): Record<string, number> => Object.assign(Object.create(null) as Record<string, number>, from)
const emptyMonth = (): Month => ({ total: 0, bySession: tally(), byModel: tally(), byDay: tally() })

const isPlain = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** A plain object of finite numbers, as a prototype-free tally; null if anything is off. */
function checkTally(v: unknown): Record<string, number> | null {
  if (!isPlain(v)) return null
  const out = tally()
  for (const [k, n] of Object.entries(v)) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return null
    out[k] = n
  }
  return out
}

/**
 * The file, checked (gate pass 15, M-2): `last` a tally, and each month a
 * finite total with tallies by session, model and day. A bad month is
 * dropped; a bad `last` starts it over. Anything else starts the file over.
 */
export function checkLedger(v: unknown, now: number = Date.now()): LedgerFile {
  const empty: LedgerFile = { version: 2, since: now, last: tally(), months: {} }
  if (!isPlain(v) || v.version !== 2 || !isPlain(v.months) || typeof v.since !== 'number' || !Number.isFinite(v.since)) return empty
  const months: Record<string, Month> = {}
  for (const [key, m] of Object.entries(v.months)) {
    if (!/^\d{4}-\d{2}$/.test(key) || !isPlain(m) || typeof m.total !== 'number' || !Number.isFinite(m.total)) continue
    const bySession = checkTally(m.bySession)
    const byModel = checkTally(m.byModel)
    const byDay = checkTally(m.byDay)
    if (bySession && byModel && byDay) months[key] = { total: m.total, bySession, byModel, byDay }
  }
  return { version: 2, since: v.since as number, last: checkTally(v.last) ?? tally(), months }
}

export class SpendLedger {
  private data: LedgerFile
  private dirty = false
  private savedAt = 0
  /** Sessions this month that reported no cost, by the last reading. */
  private noCost: string[] = []

  constructor(
    private readonly path: string,
    private readonly saveEveryMs = 30_000,
  ) {
    this.data = this.load()
  }

  private load(): LedgerFile {
    try {
      return checkLedger(JSON.parse(readFileSync(this.path, 'utf8')))
    } catch {
      // Missing or unreadable: start over.
      return checkLedger(null)
    }
  }

  /**
   * One poll's sessions. A session's first reading counts in full if it
   * started this month, else not at all, since its cost before now can't be
   * split by month. A cost that went down (a /clear) counts from zero.
   */
  observe(sessions: readonly SessionSnapshot[], now: number): boolean {
    const month = monthKey(now)
    const day = dayKey(now)
    const m = (this.data.months[month] ??= emptyMonth())
    const monthStart = new Date(new Date(now).getFullYear(), new Date(now).getMonth(), 1).getTime()
    let changed = false
    const noCost: string[] = []
    for (const s of sessions) {
      const cost = s.costUsd?.value
      if (cost === undefined || !Number.isFinite(cost) || cost < 0) {
        if (s.startedAt.value >= monthStart || s.pid.value !== null) noCost.push(s.sessionId)
        continue
      }
      const last = this.data.last[s.sessionId]
      this.data.last[s.sessionId] = cost
      if (last !== cost) this.dirty = true
      // A first sight is a baseline (MIP2-1521): Claude Code's cost is the session's lifetime total. Only a session
      // started this month counts its cost so far, on the day it started, not the day the app first saw it.
      const first = last === undefined
      const delta = first ? (s.startedAt.value >= monthStart ? cost : 0) : cost >= last ? cost - last : cost
      if (delta <= 0) continue
      const onDay = first ? dayKey(Math.min(now, s.startedAt.value)) : day
      const model = s.model?.value ?? 'unknown'
      m.total += delta
      m.bySession[s.sessionId] = (m.bySession[s.sessionId] ?? 0) + delta
      m.byModel[model] = (m.byModel[model] ?? 0) + delta
      m.byDay[onDay] = (m.byDay[onDay] ?? 0) + delta
      changed = true
    }
    if (noCost.join() !== this.noCost.join()) (this.noCost = noCost), (changed = true)
    // Only this month and the one before are kept. A last cost is kept while its session is listed or has
    // spend in a kept month, so a session that drops out of one poll isn't counted again (gate pass 15, L-3).
    for (const k of Object.keys(this.data.months)) if (k < monthKey(monthStart - 1)) delete this.data.months[k]
    const keep = new Set(sessions.map(s => s.sessionId))
    for (const kept of Object.values(this.data.months)) for (const id of Object.keys(kept.bySession)) keep.add(id)
    for (const id of Object.keys(this.data.last)) if (!keep.has(id)) (delete this.data.last[id], (this.dirty = true))
    if (this.dirty && now - this.savedAt >= this.saveEveryMs) this.save(now)
    return changed
  }

  save(now = Date.now()): void {
    if (!this.dirty) return
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data), { mode: 0o600 })
      renameSync(`${this.path}.tmp`, this.path)
      this.dirty = false
      this.savedAt = now
    } catch (err) {
      console.warn(`spend ledger: ${String(err)}`)
    }
  }

  current(now: number): SimulatedSpend {
    const m = this.data.months[monthKey(now)] ?? emptyMonth()
    return {
      totalUsd: m.total,
      todayUsd: m.byDay[dayKey(now)] ?? 0,
      topSessions: Object.entries(m.bySession)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([sessionId, usd]) => ({ sessionId, usd })),
      byModel: Object.entries(m.byModel)
        .sort((a, b) => b[1] - a[1])
        .map(([model, usd]) => ({ model, usd })),
      noCost: this.noCost.length,
      noCostIds: [...this.noCost],
      since: this.data.since,
    }
  }
}

/** The month's first instant, UTC, as RFC 3339, for the cost report. The local month starts in it or after. */
export function monthStartUtc(now: number): string {
  const d = new Date(now)
  return new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1)).toISOString().replace('.000Z', 'Z')
}

interface CostPage {
  data: { starting_at: string; ending_at: string; results: { amount: string; currency: string; model: string | null }[] }[]
  has_more: boolean
  next_page: string | null
}

export type Fetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal; redirect?: 'error' }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown>; text(): Promise<string> }>

const COST_URL = 'https://api.anthropic.com/v1/organizations/cost_report'

/** The API's own error message, else the HTTP status (§5.3: a failed test shows the API's message). */
async function apiError(r: Awaited<ReturnType<Fetch>>): Promise<string> {
  try {
    const body = (await r.json()) as { error?: { message?: unknown } }
    if (typeof body?.error?.message === 'string') return body.error.message.slice(0, 300)
  } catch {
    // Not JSON.
  }
  return `HTTP ${r.status}`
}

/**
 * This month's Console cost: every daily bucket since the month began,
 * grouped by description so each result names its model. Amounts are
 * decimal strings in cents. Today is the bucket that holds `now`.
 */
export async function fetchMonthCost(key: string, now: number, fetchFn: Fetch): Promise<Omit<RealSpend, 'configured' | 'at' | 'error' | 'errorAt'>> {
  const byModel = new Map<string, number>()
  let total = 0
  let today = 0
  let page: string | null = null
  for (let i = 0; i < 10; i++) {
    const q = new URLSearchParams({ starting_at: monthStartUtc(now), bucket_width: '1d', limit: '31' })
    q.append('group_by[]', 'description')
    if (page) q.set('page', page)
    const r = await fetchFn(`${COST_URL}?${q}`, {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'user-agent': 'CCCommandCenter' },
      signal: AbortSignal.timeout(20_000),
      // A redirect would carry x-api-key to its target: fetch strips only Authorization (gate pass 15, L-1).
      redirect: 'error',
    })
    if (!r.ok) throw new Error(await apiError(r))
    const body = (await r.json()) as CostPage
    if (!Array.isArray(body?.data)) throw new Error('The cost report had an unexpected shape.')
    for (const bucket of body.data) {
      const start = Date.parse(bucket.starting_at)
      const end = Date.parse(bucket.ending_at)
      for (const res of bucket.results ?? []) {
        if (res.currency !== 'USD') continue
        const usd = Number(res.amount) / 100
        if (!Number.isFinite(usd)) continue
        total += usd
        if (now >= start && now < end) today += usd
        const model = res.model ?? 'other'
        byModel.set(model, (byModel.get(model) ?? 0) + usd)
      }
    }
    if (!body.has_more || !body.next_page) break
    page = body.next_page
  }
  return {
    totalUsd: total,
    todayUsd: today,
    byModel: [...byModel].sort((a, b) => b[1] - a[1]).map(([model, usd]) => ({ model, usd })),
  }
}

export const REAL_POLL_MS = 15 * 60_000

/** Real spend, polled every 15 minutes while a Console key is saved. Keeps the last amount when a poll fails. */
export class RealSpendPoller {
  private state: RealSpend = { configured: false, totalUsd: null, todayUsd: null, byModel: [], at: null, error: null, errorAt: null }

  constructor(
    private readonly key: () => string | null,
    private readonly fetchFn: Fetch,
    private readonly onChange: () => void,
    private readonly now: () => number = Date.now,
  ) {}

  current(): RealSpend {
    return { ...this.state, configured: this.key() !== null }
  }

  /** One poll; with no key it clears what it had. */
  async poll(): Promise<void> {
    const key = this.key()
    if (!key) {
      this.state = { configured: false, totalUsd: null, todayUsd: null, byModel: [], at: null, error: null, errorAt: null }
      return this.onChange()
    }
    try {
      const r = await fetchMonthCost(key, this.now(), this.fetchFn)
      this.state = { ...this.state, ...r, configured: true, at: this.now(), error: null, errorAt: null }
    } catch (err) {
      this.state = { ...this.state, configured: true, error: err instanceof Error ? err.message : String(err), errorAt: this.now() }
    }
    this.onChange()
  }

  /** Test a key without saving it: the API's own message on failure. */
  async test(key: string): Promise<{ ok: true } | { ok: false; error: string }> {
    try {
      await fetchMonthCost(key, this.now(), this.fetchFn)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  }
}
