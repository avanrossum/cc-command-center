// The mod's usage file against the usage governor's own jq expression
// (D-011 item 9). The expression is read from ~/.claude/hooks/usage-governor.sh
// when it exists, so a change there shows up here; otherwise the copy below,
// taken from that file on 2026-10-26, is used.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { governorUsage } from '../mod/hooks/usage.ts'

const GOVERNOR = join(homedir(), '.claude', 'hooks', 'usage-governor.sh')

const COPIED_EXPRESSION = `
      .rate_limits as $r
      | select(($r.five_hour.resets_at // 0) > $now)
      | [$r.five_hour.used_percentage, $r.seven_day.used_percentage,
         $r.five_hour.resets_at, $r.seven_day.resets_at]
      | map(if . == null then "null" else tostring end) | join(" ")`

function governorExpression(): string {
  if (!existsSync(GOVERNOR)) return COPIED_EXPRESSION
  const match = /row=\$\(jq -r --argjson now "\$now" '([\s\S]*?)' "\$f"/.exec(readFileSync(GOVERNOR, 'utf8'))
  if (!match?.[1]) throw new Error('the governor no longer has the expected jq call; update this test')
  return match[1]
}

function runGovernor(file: object, now: number): string {
  return execFileSync('jq', ['-r', '--argjson', 'now', String(now), governorExpression()], {
    input: JSON.stringify(file),
    encoding: 'utf8',
  }).trim()
}

// From the scratch run's session.measure, 2026-10-26.
const MEASURE = {
  context: { tokens: 69534, window: 1000000, percent: 7 },
  rateLimits: [
    { kind: 'five_hour', percentUsed: 12.5, resetsAt: '2026-10-27T08:30:00.000Z' },
    { kind: 'seven_day', percentUsed: 29, resetsAt: '2026-10-31T15:00:00.000Z' },
  ],
  cost: { usd: 0.28 },
}

describe('governorUsage', () => {
  it('converts ISO resetsAt to Unix seconds', () => {
    const usage = governorUsage('s', '/x', MEASURE, 'test')
    expect(usage?.rate_limits).toEqual({
      five_hour: { used_percentage: 12.5, resets_at: 1793089800 },
      seven_day: { used_percentage: 29, resets_at: 1793458800 },
    })
  })

  it('passes the governor while the 5-hour window is open', () => {
    const usage = governorUsage('s', '/x', MEASURE, 'test')!
    expect(runGovernor(usage, 1793072000)).toBe('12.5 29 1793089800 1793458800')
  })

  it('is skipped by the governor once the 5-hour window has reset', () => {
    const usage = governorUsage('s', '/x', MEASURE, 'test')!
    expect(runGovernor(usage, 1793089801)).toBe('')
  })

  it('writes nothing before the first rate-limit reading', () => {
    expect(governorUsage('s', '/x', { ...MEASURE, rateLimits: [] }, 'test')).toBeNull()
  })
})
