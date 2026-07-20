import fs from 'node:fs'

// Fleet activity: the subagents a session has spawned, from its transcript.
//
// A subagent is a `tool_use` block named "Agent" (the SDK Agent tool) or "Task"
// (the built-in). Its `input.description` is the human-readable "what it's
// working on". Completion is a later `tool_result` block carrying the same
// `tool_use_id`. All of this lives in the transcript the state engine already
// tails — this module reads the same file, cached on mtime so it re-parses only
// when the transcript changed.
//
// Data shape confirmed empirically against real transcripts (2026-07-20):
//   - tool name is "Agent" in this environment; "Task" matched too for portability
//   - message.content is a list ~96% of the time but a BARE STRING otherwise —
//     iterating it blindly throws, so string content is skipped
//   - a background task's tool_use can sit far back in the file, hence the
//     multi-MB bounded scan rather than the state engine's 64KB tail

export type SubtaskStatus = 'running' | 'done' | 'stalled'

export interface SubtaskInfo {
  id: string // the tool_use id — stable identity
  description: string
  subagentType?: string
  background: boolean
  status: SubtaskStatus
  startedAt?: number // ms epoch from the record timestamp
}

const AGENT_TOOL_NAMES = new Set(['Agent', 'Task'])
// A running subagent whose transcript hasn't advanced in this long reads as
// stalled rather than live — the session was likely interrupted mid-task.
const STALLED_MS = 5 * 60 * 1000
// Bound the scan. Covers the 99th-percentile transcript (~4.4MB measured across
// 1834 real transcripts; median 73KB) with headroom. A subagent whose ENTIRE
// lifecycle — spawn and result — predates the last MAX_SCAN_BYTES of a very
// large transcript is not shown. That is deliberate (this view is about recent
// activity) and safe: a tool_use and its tool_result both fall after the window
// start, so anything partially in-window is seen whole and nothing is ever
// mislabelled — the only effect is that ancient, already-finished work is
// omitted rather than shown wrong.
const MAX_SCAN_BYTES = 8 * 1024 * 1024

interface CacheEntry {
  mtimeMs: number
  size: number
  subtasks: SubtaskInfo[]
}
const cache = new Map<string, CacheEntry>()

function tsToMs(ts: unknown): number | undefined {
  if (typeof ts !== 'string') return undefined
  const n = Date.parse(ts)
  return Number.isFinite(n) ? n : undefined
}

// Parse a transcript for its subagents. Cheap on repeat calls: returns the
// cached result unless the file's mtime or size changed.
export function scanSubtasks(path: string, now = Date.now()): SubtaskInfo[] {
  let stat: fs.Stats
  try {
    stat = fs.statSync(path)
  } catch {
    cache.delete(path)
    return []
  }
  const cached = cache.get(path)
  // Recompute 'stalled' on every call (it depends on `now`, not the file), but
  // only re-READ the file when it actually changed.
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return applyStall(cached.subtasks, stat.mtimeMs, now)
  }

  const from = Math.max(0, stat.size - MAX_SCAN_BYTES)
  let buf: string
  try {
    const fd = fs.openSync(path, 'r')
    try {
      const len = stat.size - from
      const b = Buffer.alloc(len)
      fs.readSync(fd, b, 0, len, from)
      buf = b.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return cached ? applyStall(cached.subtasks, stat.mtimeMs, now) : []
  }

  const uses = new Map<string, SubtaskInfo>()
  const doneIds = new Set<string>()
  const lines = buf.split('\n')
  // If we started mid-file, the first line is probably a partial record — skip it.
  const start = from > 0 ? 1 : 0
  for (let i = start; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    let r: Record<string, unknown>
    try {
      r = JSON.parse(line)
    } catch {
      continue
    }
    const msg = r.message as { content?: unknown } | undefined
    const content = msg?.content
    if (!Array.isArray(content)) continue // bare-string content carries no tool blocks
    for (const block of content) {
      if (!block || typeof block !== 'object') continue
      const b = block as Record<string, unknown>
      if (b.type === 'tool_use' && AGENT_TOOL_NAMES.has(b.name as string)) {
        const id = b.id as string
        const input = (b.input ?? {}) as Record<string, unknown>
        if (!id) continue
        uses.set(id, {
          id,
          description: (input.description as string) || 'subagent',
          subagentType: input.subagent_type as string | undefined,
          background: input.run_in_background === true,
          status: 'running', // provisional; resolved against doneIds below
          startedAt: tsToMs(r.timestamp),
        })
      } else if (b.type === 'tool_result') {
        const tid = b.tool_use_id as string | undefined
        if (tid) doneIds.add(tid)
      }
    }
  }

  const subtasks: SubtaskInfo[] = []
  for (const [id, info] of uses) {
    subtasks.push({ ...info, status: doneIds.has(id) ? 'done' : 'running' })
  }
  // Most-recent first — the newest spawn is what the user is most likely tracking.
  subtasks.sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))

  cache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, subtasks })
  return applyStall(subtasks, stat.mtimeMs, now)
}

// A 'running' subtask in a transcript that hasn't advanced for STALLED_MS is
// re-labelled 'stalled'. Done rows are untouched. Returns a new array only when
// something changed, so callers can rely on reference stability otherwise.
function applyStall(subtasks: SubtaskInfo[], mtimeMs: number, now: number): SubtaskInfo[] {
  if (now - mtimeMs <= STALLED_MS) return subtasks
  if (!subtasks.some((s) => s.status === 'running')) return subtasks
  return subtasks.map((s) => (s.status === 'running' ? { ...s, status: 'stalled' } : s))
}

// Forget a session's cached subtasks (on removal, so a scrubbed session leaves
// nothing behind).
export function forgetSubtasks(path: string): void {
  cache.delete(path)
}
