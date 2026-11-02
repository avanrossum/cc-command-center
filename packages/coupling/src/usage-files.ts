// Reads the usage governor's files, `~/.claude/ccc/usage/<session>.json`,
// for the usage meter. Electron CCCC writes them from each session's
// statusLine, and the reporter mod writes them for app-launched sessions
// (D-011 item 9). Both carry the statusLine's `rate_limits` shape.
//
// The rule matches `usage-governor.sh`: the newest file whose window hasn't
// reset yet, chosen for each window on its own (gate pass 24, M-5). Either
// window may be absent from a file (Claude Code's status-line docs, not
// re-verified; MIP2-1590), and a window with no reset time is left out, so
// nothing else's reset guards it (L-7). An idle session re-renders an old payload whose reset
// time has passed, so that guard keeps a stale window off the meter. When
// every file is past its reset, the newest of them comes back, so the meter
// can say the window reset and it waits for a new reading (MIP2-1498 §4.4).
//
// `keep` limits the files to sessions the app lists (MIP2-1520): the folder
// also holds files from sessions run under other config folders, such as
// QA's isolated ones, which aren't this account's sessions.

import { lstat, readdir, readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { field, type Field, type RateLimits, type RateLimitWindow } from '@ccc/contract'

export const DEFAULT_USAGE_DIR = join(homedir(), '.claude', 'ccc', 'usage')
const NEWEST_READ = 20
const MAX_BYTES = 1024 * 1024

function windowOf(v: unknown): RateLimitWindow | null {
  if (typeof v !== 'object' || v === null) return null
  const w = v as { used_percentage?: unknown; resets_at?: unknown }
  if (typeof w.used_percentage !== 'number' || !Number.isFinite(w.used_percentage)) return null
  const resetsAt = typeof w.resets_at === 'number' && Number.isFinite(w.resets_at) ? w.resets_at : null
  return { usedPercent: w.used_percentage, resetsAt }
}

export async function readUsageDir(dir = DEFAULT_USAGE_DIR, now = Date.now(), keep?: (sessionId: string) => boolean): Promise<Field<RateLimits> | null> {
  let names: string[]
  try {
    // Each file is named for its session, and says which one inside; both must be kept.
    names = (await readdir(dir)).filter(n => n.endsWith('.json') && (!keep || keep(n.slice(0, -'.json'.length))))
  } catch {
    return null
  }
  const stats = await Promise.all(
    names.map(async name => {
      try {
        const st = await lstat(join(dir, name))
        return st.isFile() && st.size <= MAX_BYTES ? { name, mtimeMs: st.mtimeMs } : null
      } catch {
        return null
      }
    }),
  )
  const newest = stats.filter((s): s is { name: string; mtimeMs: number } => s !== null).sort((a, b) => b.mtimeMs - a.mtimeMs)
  type Pick = { w: RateLimitWindow; at: number }
  const unreset: Record<'fiveHour' | 'sevenDay', Pick | null> = { fiveHour: null, sevenDay: null }
  const pastReset: Record<'fiveHour' | 'sevenDay', Pick | null> = { fiveHour: null, sevenDay: null }
  for (const { name, mtimeMs } of newest.slice(0, NEWEST_READ)) {
    if (unreset.fiveHour && unreset.sevenDay) break
    try {
      const data = JSON.parse(await readFile(join(dir, name), 'utf8')) as { session_id?: unknown; rate_limits?: { five_hour?: unknown; seven_day?: unknown } }
      const sessionId = typeof data.session_id === 'string' ? data.session_id : name.slice(0, -'.json'.length)
      if (keep && !keep(sessionId)) continue
      for (const [key, raw] of [['fiveHour', data.rate_limits?.five_hour], ['sevenDay', data.rate_limits?.seven_day]] as const) {
        const w = windowOf(raw)
        if (!w || w.resetsAt === null) continue
        if (w.resetsAt * 1000 > now) unreset[key] ??= { w, at: mtimeMs }
        else pastReset[key] ??= { w, at: mtimeMs }
      }
    } catch {
      // A file mid-write reads short; the next poll reads it whole.
    }
  }
  const fiveHour = unreset.fiveHour ?? pastReset.fiveHour
  const sevenDay = unreset.sevenDay ?? pastReset.sevenDay
  if (!fiveHour && !sevenDay) return null
  const at = Math.max(fiveHour?.at ?? 0, sevenDay?.at ?? 0)
  const out = (p: Pick | null) => (p ? { ...p.w, observedAt: p.at } : null)
  return field({ fiveHour: out(fiveHour), sevenDay: out(sevenDay) }, 'statusline', at)
}
