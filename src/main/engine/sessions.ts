import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { deriveStateFromTranscript } from './transcript'
import type { LiveSession, SessionRecord } from './types'

const HOME = os.homedir()
const SESSIONS_DIR = path.join(HOME, '.claude', 'sessions')
const PROJECTS_DIR = path.join(HOME, '.claude', 'projects')

// Claude Code encodes a project directory by replacing '/' and '.' with '-'.
export function slugForCwd(cwd: string): string {
  return cwd.replace(/[/.]/g, '-')
}

export function findTranscript(sessionId: string, cwd: string): string | undefined {
  const guess = path.join(PROJECTS_DIR, slugForCwd(cwd), `${sessionId}.jsonl`)
  if (fs.existsSync(guess)) return guess
  // Fallback: the slug guess can miss (odd cwd encodings), so scan project dirs
  // for the sessionId-named transcript.
  try {
    for (const d of fs.readdirSync(PROJECTS_DIR)) {
      const p = path.join(PROJECTS_DIR, d, `${sessionId}.jsonl`)
      if (fs.existsSync(p)) return p
    }
  } catch {
    /* ignore */
  }
  return undefined
}

export function readRegistry(): SessionRecord[] {
  let files: string[] = []
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'))
  } catch {
    return []
  }
  const out: SessionRecord[] = []
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'))
      if (!j.pid || !j.sessionId || !j.cwd) continue
      out.push({
        pid: j.pid,
        sessionId: j.sessionId,
        cwd: j.cwd,
        name: j.name,
        version: j.version,
        kind: j.kind,
        entrypoint: j.entrypoint,
        startedAt: j.startedAt,
        procStart: j.procStart,
        registryStatus: j.status,
        waitingFor: j.waitingFor,
      })
    } catch {
      /* skip malformed registry file */
    }
  }
  return out
}

// Allowed drift between the registry's startedAt (epoch ms) and the process's
// actual start parsed from `ps` (second-resolution, plus registry-write lag).
// Well below any realistic PID-reuse collision, which differs by hours or days.
const START_TOLERANCE_MS = 60_000

// PID-reuse-safe liveness: the pid must exist, its command must look like a
// claude process, and (when available) its start time must match the registry's
// startedAt. The registry is not garbage-collected, so a bare kill(0) is not
// enough — a reused pid could be any process. Note: the registry's procStart
// STRING is in a different timezone than `ps` lstart, so we compare the absolute
// epoch (startedAt vs parsed lstart), not the strings. Returns the process
// command when live, or null.
function psProcess(pid: number, startedAt?: number): { command: string } | null {
  let out: string
  try {
    out = execFileSync('ps', ['-p', String(pid), '-o', 'lstart=,command='], {
      encoding: 'utf8',
    }).trim()
  } catch {
    return null // ps exits non-zero when the pid does not exist
  }
  if (!out) return null
  const m = out.match(/^(\w{3}\s+\w{3}\s+\d+\s+\d+:\d+:\d+\s+\d{4})\s+(.*)$/)
  const lstart = m ? m[1] : ''
  const command = m ? m[2] : out
  if (!/claude/i.test(command)) return null
  if (startedAt && lstart) {
    const psEpoch = Date.parse(lstart) // lstart is local time; Date.parse reads it as local
    if (!Number.isNaN(psEpoch) && Math.abs(psEpoch - startedAt) > START_TOLERANCE_MS) return null
  }
  return { command }
}

export function hasTranscript(sessionId: string, cwd: string): boolean {
  const p = findTranscript(sessionId, cwd)
  if (!p) return false
  // A 0-byte transcript resumes into "No conversation found" too — treat it as
  // gone so the recovery path handles it instead of a doomed `claude --resume`.
  try {
    return fs.statSync(p).size > 0
  } catch {
    return false
  }
}

// Delete the stale ~/.claude/sessions/*.json files for a session id whose
// process is dead (PID-reuse-safe). Returns how many were removed. Files for a
// still-alive pid are left alone. Used to permanently drop a terminated ghost
// from the list (the scan re-adds anything whose file still exists).
export function purgeDeadSessionFiles(sessionId: string): number {
  let files: string[] = []
  try {
    files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith('.json'))
  } catch {
    return 0
  }
  let removed = 0
  for (const f of files) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, f), 'utf8'))
      if (j.sessionId !== sessionId) continue
      if (psProcess(j.pid, j.startedAt) === null) {
        fs.unlinkSync(path.join(SESSIONS_DIR, f))
        removed++
      }
    } catch {
      /* skip malformed / already-gone file */
    }
  }
  return removed
}

// Enumerate every registered session, filter to the live ones (PID-reuse safe),
// and derive each live session's coarse state from its transcript tail. This is
// the no-daemon adoption path: everything here reads files that exist on disk
// independent of any running process.
export function scanLiveSessions(now = Date.now()): LiveSession[] {
  const out: LiveSession[] = []
  for (const s of readRegistry()) {
    const proc = psProcess(s.pid, s.startedAt)
    const alive = proc !== null
    const command = proc?.command
    const isSpare = alive && /--bg-spare/.test(command ?? '')
    let state: LiveSession['state'] = 'unknown'
    let stateReason = !alive
      ? 'process not alive'
      : isSpare
        ? 'background spare process'
        : 'no transcript found'
    let transcriptPath: string | undefined
    let transcriptMtimeMs: number | undefined
    let lastRecordType: string | undefined
    let stopReason: string | undefined

    if (alive && !isSpare) {
      transcriptPath = findTranscript(s.sessionId, s.cwd)
      if (transcriptPath) {
        const d = deriveStateFromTranscript(transcriptPath, now)
        state = d.state
        stateReason = d.reason
        transcriptMtimeMs = d.mtimeMs
        lastRecordType = d.lastRecordType
        stopReason = d.stopReason
      } else {
        // No transcript (pruned/rotated on old long-idle sessions). The stale
        // registry status is the only remaining signal — low confidence, but
        // better than 'unknown' for a dormant session.
        const rs = s.registryStatus
        if (rs === 'busy') {
          state = 'working'
          stateReason = 'no transcript; registry busy (stale)'
        } else if (rs === 'waiting') {
          state = 'waiting'
          stateReason = 'no transcript; registry waiting (stale)'
        } else if (rs === 'idle') {
          state = 'idle'
          stateReason = 'no transcript; registry idle (stale)'
        }
      }
    }

    out.push({
      ...s,
      alive,
      command,
      isSpare,
      transcriptPath,
      state,
      stateReason,
      transcriptMtimeMs,
      lastRecordType,
      stopReason,
    })
  }
  return out
}
