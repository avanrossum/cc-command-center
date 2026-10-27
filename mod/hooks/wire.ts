// The reporter file: what the mod writes and the coupling package reads.
// Types only, so the coupling package imports them without running mod code.
//
// v0 transport (D-003 in this repo): the mod rewrites one file per session,
// `<home>/.claude/ccc/reporter/<sessionId>.json`, after each event. The
// socket channel in D-011 item 7 replaces it once Research has probed it
// (MIP2-1376); the file's shape is what moves to the socket.

export const REPORTER_WIRE = 0
export const REPORTER_NAME = 'ccc-reporter'
/** Events kept in the file; older ones roll off. */
export const REPORTER_EVENT_LIMIT = 200
/**
 * Characters of a peer message's raw text kept. A received message starts
 * with Claude Code's `<cross-session-message …>` envelope, which names the
 * sender; the coupling package reads it and trims the body for the card.
 */
export const PREVIEW_CHARS = 400
/** Characters kept of a tool call's argument and of an answer. */
export const DETAIL_CHARS = 300

export type ReporterEvent = { seq: number; at: number; agentId: string | null } & (
  | { type: 'session.start'; model: string; cwd: string; version: string }
  | { type: 'session.end'; reason: string | null }
  | { type: 'turn.start' }
  | { type: 'turn.step'; model: string; effort: string | null }
  | {
      type: 'turn.complete'
      reason: string | null
      durationMs: number | null
      usage: TurnTokens | null
      /** The start of the main loop's answer (DETAIL_CHARS); null for a subagent's turn. Absent from mod 0.2.0 and earlier. */
      answer?: string | null
    }
  | { type: 'session.measure'; measure: Measure }
  | { type: 'agent.spawn'; spawnedId: string | null; subagentType: string; description: string; model: string | null; background: boolean }
  | {
      type: 'tool.start'
      toolUseId: string
      tool: string
      path: string | null
      /** The call's main argument, cut to DETAIL_CHARS: a command, path, pattern or URL. Absent from mod 0.2.0 and earlier. */
      detail?: string | null
    }
  | { type: 'tool.end'; toolUseId: string; tool: string; isError: boolean }
  /**
   * A Bash call started a background session: Claude Code printed
   * `backgrounded · <shortId> · <name>` (Research MIP2-1392 item 3). The
   * child is this session's contractor. Absent from mod 0.4.0 and earlier.
   */
  | { type: 'child.started'; shortId: string; name: string | null }
  | { type: 'peer.sent'; to: string; preview: string }
  | { type: 'peer.received'; from: string; preview: string }
)

export interface TurnTokens {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  model: string | null
}

/** `session.measure`, as Claude Code gave it (see the pinned SessionMeasureInput). */
export interface Measure {
  context: { tokens?: number; window: number; percent?: number }
  rateLimits: { kind: string; percentUsed: number; resetsAt?: string }[]
  cost?: { usd: number }
}

export interface AgentListEntry {
  id: string
  type: string | null
  description: string | null
  status: string
  parentId: string | null
}

export interface ReporterFile {
  wire: typeof REPORTER_WIRE
  plugin: { name: string; version: string }
  sessionId: string
  /** When the mod started in this process, Unix milliseconds. */
  loadedAt: number
  writtenAt: number
  /** The last event's seq; increases by one per event within a process. */
  seq: number
  /** Values kept past the event window, so a reader that starts late has them. */
  latest: {
    /** The Claude Code version the session runs, from session.start. Absent from mod 0.3.0 and earlier. */
    version?: string
    /** CLAUDE_CODE_PLUGIN_DIR_WATCH as the session sees it, null when unset (gate run 2, L-3). Absent from mod 0.6.0 and earlier. */
    pluginDirWatch?: string | null
    model: string | null
    effort: string | null
    measure: Measure | null
    agents: AgentListEntry[]
    /** Main-loop token totals since the mod loaded in this process. */
    tokens: Omit<TurnTokens, 'model'>
  }
  events: ReporterEvent[]
}
