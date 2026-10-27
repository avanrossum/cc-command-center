// SessionSnapshot v1: what the UI knows about one Claude Code session. The
// coupling package builds it; the UI reads it and nothing else (D-004).
//
// Shapes here are the app's own, not Claude Code's. When Claude Code changes
// a shape, the coupling package absorbs it and this contract stays put. A
// change to this file that breaks a reader is a new CONTRACT_VERSION.

import type { Field, FieldSource } from './field.ts'

export const CONTRACT_VERSION = 1

/** `interactive` (started with plain `claude`) or `background` (supervisor). */
export type SessionKind = 'interactive' | 'background'

/**
 * What the session is doing, normalized from `agents --json` `status` and
 * `state`:
 * - `working`: a turn is running, or the session drives work on its own.
 * - `waiting`: the session needs Alex; `needsYou` says for what.
 * - `idle`: the turn finished and the session waits for the next prompt.
 * - `failed`, `stopped`: a background session ended with an error or was stopped.
 * - `stale`: `agents --json` still lists it as blocked, but its process is
 *   gone, so the wait it reports can't be answered (DECISION item 2).
 * - `unknown`: the source gave a value this version doesn't recognize.
 */
export type Activity = 'working' | 'waiting' | 'idle' | 'failed' | 'stopped' | 'stale' | 'unknown'

/**
 * Why a session needs Alex. Mapped from `agents --json` `waitingFor`:
 * `permission prompt` → `permission`, `input needed` → `question`,
 * `sandbox request` → `sandbox`, `worker request` → `worker`,
 * `dialog open` → `dialog`. `blocked` is a blocked session whose source
 * named no open prompt (an expired login, or no first prompt yet).
 * `other` is a `waitingFor` value this version doesn't recognize.
 */
export type NeedsYouKind = 'permission' | 'question' | 'sandbox' | 'worker' | 'dialog' | 'blocked' | 'other'

export interface NeedsYou {
  kind: NeedsYouKind
  /** The source's own words, for display and debugging (`waitingFor`). */
  detail: string | null
}

export interface ContextUse {
  usedTokens: number | null
  windowTokens: number | null
  /** 0–100. */
  percent: number | null
}

export interface TokenTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

export interface RateLimitWindow {
  /** 0–100. */
  usedPercent: number
  /** When the window resets, Unix seconds (the usage governor's unit). */
  resetsAt: number | null
}

export interface RateLimits {
  fiveHour: RateLimitWindow | null
  sevenDay: RateLimitWindow | null
}

export interface SubagentInfo {
  agentId: string
  type: string | null
  description: string | null
  model: string | null
  status: string
  parentAgentId: string | null
}

export interface ToolCallInfo {
  toolUseId: string
  tool: string
  /** A short argument for the rail: the command, path, pattern or URL. Untrusted text. */
  detail: string | null
  /** The loop that made the call; null for the main loop. */
  agentId: string | null
  startedAt: number
}

/** The main loop's current or last turn. */
export interface TurnInfo {
  running: boolean
  startedAt: number | null
  endedAt: number | null
  /** The start of the last answer, for the card's now line. Untrusted text. */
  lastAnswer: string | null
}

export interface PeerMessage {
  direction: 'sent' | 'received'
  /** The other side's address or name, as Claude Code gave it. */
  peer: string
  at: number
  /** The first part of the text, for the card. */
  preview: string
}

export interface FileWrite {
  path: string
  tool: string
  at: number
  /** Set for an Artifact publish. */
  url: string | null
}

/**
 * A background session this session started with `claude --bg` from its
 * Bash tool: its contractor (Research MIP2-1392 item 3, UX MIP2-1393).
 */
export interface ContractorInfo {
  /** The child's short id, as `claude agents --json` lists it in `id`. */
  shortId: string
  name: string | null
  startedAt: number
}

/** A question a card may answer: single choice, one of `options` (D-010). */
export interface CardQuestion {
  question: string
  options: string[]
}

/**
 * The most lines a card may approve, counted by newline across every field;
 * wrapping isn't counted (gate run 2, M-2; ruling on MIP2-1442). Main
 * and the card both read this one value (pass 6, L-3).
 */
export const CARD_APPROVE_LINES = 8

/**
 * A permission or question prompt the session's mod offered to the app
 * (MIP2-1390). The session's dialog is open at the same time; whichever is
 * answered first applies.
 */
export interface PendingRequest {
  requestId: string
  tool: string
  /** One line for the card: the command, path or first question. Untrusted text. */
  summary: string
  /** Every field of the tool's input, in full up to the card's limit (gate H-1). Untrusted text. */
  fields: { name: string; value: string }[]
  /** Null when the card may approve it; otherwise why it can't, and the card offers Open only. */
  refusal: string | null
  /** Set for AskUserQuestion. */
  questions: CardQuestion[] | null
  /** Whether "remember for this session" would keep anything. */
  canRemember: boolean
  /** The loop that asked; null for the main loop. */
  agentId: string | null
  askedAt: number
}

export interface SessionSnapshot {
  contractVersion: typeof CONTRACT_VERSION
  /** The full session UUID: the registry key (DECISION item 2). */
  sessionId: string

  // From `agents --json`. Present for every listed session.
  kind: Field<SessionKind>
  cwd: Field<string>
  startedAt: Field<number>
  name: Field<string | null>
  /** Short ID for `claude attach`, `logs` and `stop`; background sessions only. */
  shortId: Field<string | null>
  /** Null when the process isn't alive. */
  pid: Field<number | null>
  activity: Field<Activity>
  /** Null when the session doesn't need Alex. */
  needsYou: Field<NeedsYou | null>

  // From the reporter mod (MIP2-1373). Absent until the mod reports, and
  // absent for sessions started outside the app (D-013).
  model?: Field<string>
  turn?: Field<TurnInfo>
  /**
   * The app started or resumed it without a prompt, and no turn has begun
   * since: its mod saw session.start and no main-loop turn.start. Claude
   * Code then lists it as `state: blocked` with no `waitingFor`, which here
   * means it awaits its first message (Research MIP2-1426, agent-view.md).
   */
  awaitingFirstPrompt?: Field<boolean>
  effort?: Field<string>
  context?: Field<ContextUse>
  tokens?: Field<TokenTotals>
  costUsd?: Field<number>
  rateLimits?: Field<RateLimits>
  subagents?: Field<SubagentInfo[]>
  toolCalls?: Field<ToolCallInfo[]>
  peerMessages?: Field<PeerMessage[]>
  filesWritten?: Field<FileWrite[]>
  /** Sessions this one started with `claude --bg`. Absent from mod 0.4.0 and earlier. */
  contractors?: Field<ContractorInfo[]>
  /** From the mod's channel: prompts a card may answer now. */
  pendingRequests?: Field<PendingRequest[]>
}

export interface SourceHealth {
  source: FieldSource
  ok: boolean
  /** The last successful read, Unix milliseconds; null before the first. */
  lastOkAt: number | null
  /** The last failure, in a line the UI can show. */
  error: string | null
}

/**
 * The detect-and-degrade self-check for the installed Claude Code version
 * (DECISION item 4). Each check passes once its source is seen working on
 * this version, and fails when a source that should have answered didn't.
 * Nothing switches off until a check fails.
 */
export interface SelfCheckItem {
  id: string
  label: string
  state: 'pass' | 'fail' | 'pending'
  /** Why it failed, in a line the band can show. */
  detail: string | null
}

export interface SelfCheckReport {
  claudeVersion: string | null
  /**
   * `new`: a version the app hasn't checked; `passed`; `degraded`: at least
   * one check failed; `too-old`: below the tested floor, so the app runs
   * read-only (MIP2-1406).
   */
  state: 'new' | 'passed' | 'degraded' | 'too-old'
  checks: SelfCheckItem[]
  /** Control paths the app has switched off for this version; their sessions keep the normal dialog. */
  controlOff: ('card-answers' | 'prompt-relay')[]
  /** When the checks last ran, Unix milliseconds; null before the first poll (settings, MIP2-1424). */
  checkedAt: number | null
}

/** What the coupling package publishes on each update. */
export interface FleetSnapshot {
  contractVersion: typeof CONTRACT_VERSION
  /** When this snapshot was assembled, Unix milliseconds. */
  at: number
  sessions: SessionSnapshot[]
  /** The freshest 5-hour and 7-day windows across sessions, for the usage meter; null with no reading. */
  usage: Field<RateLimits> | null
  /** The health of each source, so the UI can say why fields are stale. */
  sources: SourceHealth[]
  /** Null until the self-check has read the version. */
  selfCheck: SelfCheckReport | null
}
