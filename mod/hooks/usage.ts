// The usage governor's file (D-011 item 9). `~/.claude/hooks/usage-governor.sh`
// reads `~/.claude/ccc/usage/<session>.json` in the statusLine's
// `rate_limits` shape: `five_hour` and `seven_day`, each with
// `used_percentage` and `resets_at` in Unix seconds. `session.measure` gives
// `rateLimits[]` with `percentUsed` and an ISO 8601 `resetsAt`, so this
// converts one to the other.

import type { Measure } from './wire.ts'

export interface GovernorWindow {
  used_percentage: number
  resets_at: number | null
}

export interface GovernorUsageFile {
  session_id: string
  cwd: string
  rate_limits: { five_hour?: GovernorWindow; seven_day?: GovernorWindow }
  written_by: string
}

function toWindow(limit: Measure['rateLimits'][number] | undefined): GovernorWindow | undefined {
  if (!limit) return undefined
  const ms = limit.resetsAt ? Date.parse(limit.resetsAt) : NaN
  return { used_percentage: limit.percentUsed, resets_at: Number.isFinite(ms) ? Math.floor(ms / 1000) : null }
}

/** Null when the measure has neither window, so no file is written. */
export function governorUsage(sessionId: string, cwd: string, measure: Measure, writtenBy: string): GovernorUsageFile | null {
  const fiveHour = toWindow(measure.rateLimits.find(r => r.kind === 'five_hour'))
  const sevenDay = toWindow(measure.rateLimits.find(r => r.kind === 'seven_day'))
  if (!fiveHour && !sevenDay) return null
  const rate_limits: GovernorUsageFile['rate_limits'] = {}
  if (fiveHour) rate_limits.five_hour = fiveHour
  if (sevenDay) rate_limits.seven_day = sevenDay
  return { session_id: sessionId, cwd, rate_limits, written_by: writtenBy }
}
