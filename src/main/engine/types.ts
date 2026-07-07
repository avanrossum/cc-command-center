// Coarse session state. The precise permission-vs-idle split and STUCK detection
// are later refinements (roadmap Phase 7); v0 produces these four.
export type CoarseState = 'working' | 'waiting' | 'idle' | 'unknown'

// A row from ~/.claude/sessions/<pid>.json. The `registryStatus` field is a
// stale cache (measured minutes-to-days behind reality) — a hint, never truth.
export interface SessionRecord {
  pid: number
  sessionId: string
  cwd: string
  name?: string
  version?: string
  kind?: string
  entrypoint?: string
  startedAt?: number
  procStart?: string
  registryStatus?: string
  waitingFor?: string
}

// A registry row enriched with liveness and transcript-derived coarse state.
export interface LiveSession extends SessionRecord {
  alive: boolean
  command?: string
  // A `--bg-spare` background process Claude Code keeps ready — has a registry
  // entry but is not a real interactive session.
  isSpare: boolean
  transcriptPath?: string
  state: CoarseState
  stateReason: string
  transcriptMtimeMs?: number
  lastRecordType?: string
  stopReason?: string
}
