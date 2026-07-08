import fs from 'node:fs'
import type { CoarseState } from './types'

// A completed turn older than this reads as dormant (idle) rather than
// freshly waiting-on-me. Also the cutoff past which a trailing user record is a
// turn that never produced a response (idle) rather than one in progress.
const IDLE_MS = 5 * 60 * 1000
// Read only the tail of the transcript; enough to hold several records.
const TAIL_BYTES = 64 * 1024
// If the tail holds only metadata, scan up to this much of the file for the last
// real conversation record before giving up.
const MAX_SCAN_BYTES = 4 * 1024 * 1024

export interface DerivedState {
  state: CoarseState
  reason: string
  lastRecordType?: string
  stopReason?: string
  mtimeMs?: number
}

function readTail(path: string, size: number, bytes: number): string | null {
  const from = Math.max(0, size - bytes)
  try {
    const fd = fs.openSync(path, 'r')
    try {
      const len = size - from
      const buf = Buffer.alloc(len)
      fs.readSync(fd, buf, 0, len, from)
      return buf.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

// Backward-scan a window of transcript lines for the last real conversation
// record (user/assistant, non-sidechain). Returns the derived state, or null if
// the window held only metadata.
function scanForConversationRecord(buf: string, ageMs: number, mtimeMs: number): DerivedState | null {
  const lines = buf.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i].trim()
    if (!line) continue
    let r: Record<string, unknown>
    try {
      r = JSON.parse(line)
    } catch {
      continue // partial first line of the window, or a malformed record
    }
    if (!r || typeof r !== 'object') continue
    if (r.isSidechain) continue // subagent sidechain, not the main session
    const t = r.type as string | undefined
    // Only user/assistant records are conversation turns; skip every metadata
    // record type (ai-title, last-prompt, queue-operation, permission-mode, …).
    if (t !== 'assistant' && t !== 'user') continue

    if (t === 'assistant') {
      const stopReason = (r.message as { stop_reason?: string } | undefined)?.stop_reason
      if (stopReason === 'tool_use') {
        return { state: 'working', reason: 'assistant tool_use (mid-turn)', lastRecordType: t, stopReason, mtimeMs }
      }
      // A completed assistant turn means Claude is waiting for the user.
      const state: CoarseState = ageMs > IDLE_MS ? 'idle' : 'waiting'
      return {
        state,
        reason: `assistant turn complete (${stopReason ?? 'no stop_reason'}), ${Math.round(ageMs / 1000)}s ago`,
        lastRecordType: t,
        stopReason,
        mtimeMs,
      }
    }

    // A trailing user record means it is Claude's turn. Fresh: working. Stale:
    // a turn that never produced a response (interrupted/abandoned) — idle.
    const state: CoarseState = ageMs < IDLE_MS ? 'working' : 'idle'
    return {
      state,
      reason:
        ageMs < IDLE_MS
          ? 'user message (assistant responding)'
          : `user message, quiet ${Math.round(ageMs / 1000)}s`,
      lastRecordType: t,
      mtimeMs,
    }
  }
  return null
}

// Derive coarse state from a session transcript. Defensive by design: the
// transcript format is internal and undocumented, so every line is parsed in a
// try/catch and unknown shapes degrade to 'unknown' rather than throwing. Reads
// a small tail first, then a larger window if the tail held only metadata.
export function deriveStateFromTranscript(path: string, now = Date.now()): DerivedState {
  let stat: fs.Stats
  try {
    stat = fs.statSync(path)
  } catch {
    return { state: 'unknown', reason: 'no transcript' }
  }
  const mtimeMs = stat.mtimeMs
  const ageMs = now - mtimeMs

  for (const bytes of [TAIL_BYTES, Math.min(stat.size, MAX_SCAN_BYTES)]) {
    const buf = readTail(path, stat.size, bytes)
    if (buf == null) return { state: 'unknown', reason: 'read error', mtimeMs }
    const res = scanForConversationRecord(buf, ageMs, mtimeMs)
    if (res) return res
    if (bytes >= stat.size) break // already scanned the whole file
  }
  return { state: 'unknown', reason: 'no conversation record found', mtimeMs }
}

function extractText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
      .map((b) => (b as { text?: string }).text ?? '')
      .join('')
      .trim()
  }
  return ''
}

// The text of the session's most recent completed assistant message (skips
// trailing tool_use-only records). Used by cross-session copy-out.
export function readLastAssistantText(path: string): string | null {
  let stat: fs.Stats
  try {
    stat = fs.statSync(path)
  } catch {
    return null
  }
  for (const bytes of [TAIL_BYTES, Math.min(stat.size, MAX_SCAN_BYTES)]) {
    const buf = readTail(path, stat.size, bytes)
    if (buf == null) return null
    const lines = buf.split('\n')
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim()
      if (!line) continue
      let r: Record<string, unknown>
      try {
        r = JSON.parse(line)
      } catch {
        continue
      }
      if (!r || r.isSidechain || r.type !== 'assistant') continue
      const text = extractText((r.message as { content?: unknown } | undefined)?.content)
      if (text) return text
    }
    if (bytes >= stat.size) break
  }
  return null
}
