// A session's card state, from its snapshot (spec MIP2-1370 §4). Pure, and
// fed only by contract fields, so it can be tested without a window.

import type { Field, SessionSnapshot } from '@ccc/contract'

export type CardState =
  | 'approval'
  | 'question'
  | 'sandbox'
  | 'request'
  | 'working'
  | 'turn'
  | 'asked'
  | 'agents'
  | 'idle'
  | 'ended'
  | 'dead'

export type Glyph = 'needs' | 'question' | 'working' | 'turn' | 'blocked' | 'idle' | 'ended' | 'dead'

export const NEEDS_YOU: ReadonlySet<CardState> = new Set(['approval', 'question', 'sandbox', 'request'])
/** One-line rows in Fleet (spec §5.2). */
export const QUIET: ReadonlySet<CardState> = new Set(['idle', 'ended'])

export const IDLE_AFTER_MS = 30 * 60 * 1000
/** agents-json fields older than this read stale: the poll runs every 2 s. */
export const LIST_STALE_MS = 15_000
/** Mod fields older than this read stale (spec §4: 60 s without a report). */
export const MOD_STALE_MS = 60_000

export interface CardView {
  state: CardState
  glyph: Glyph
  label: string
  /** The peer the session asked, for `asked`. */
  askedPeer: string | null
  askedAt: number | null
  /** Running subagents, for `agents` and the links line. */
  runningAgents: number
  /** Started outside the app: no reporter mod, so only the agent-list fields (D-013). */
  outside: boolean
  /** Every agent-list field is stale: neither source reports the session. */
  unreported: boolean
  /** The time the state is known to have begun, when a source says. */
  knownSince: number | null
}

export function isStale(f: Field<unknown> | undefined, now: number): boolean {
  if (!f) return false
  if (f.stale) return true
  return now - f.observedAt > (f.source === 'agents-json' ? LIST_STALE_MS : MOD_STALE_MS)
}

const GLYPH: Record<CardState, Glyph> = {
  approval: 'needs',
  question: 'question',
  sandbox: 'needs',
  request: 'needs',
  working: 'working',
  turn: 'turn',
  asked: 'blocked',
  agents: 'blocked',
  idle: 'idle',
  ended: 'ended',
  dead: 'dead',
}

/** The peer this session last asked, when nothing has come back from it since and its turn has ended. */
function unanswered(s: SessionSnapshot): { peer: string; at: number } | null {
  const msgs = s.peerMessages?.value ?? []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!
    if (m.direction !== 'sent') continue
    const replied = msgs.slice(i + 1).some(r => r.direction === 'received' && r.peer === m.peer)
    return replied ? null : { peer: m.peer, at: m.at }
  }
  return null
}

export function cardView(s: SessionSnapshot, now: number): CardView {
  const outside = s.model === undefined && s.tokens === undefined
  const unreported = isStale(s.activity, now) && isStale(s.cwd, now)
  const runningAgents = (s.subagents?.value ?? []).filter(a => a.status === 'running').length
  const pending = s.pendingRequests?.value ?? []
  const turn = s.turn?.value
  const view = (state: CardState, label: string, knownSince: number | null, asked: { peer: string; at: number } | null = null): CardView => ({
    state,
    glyph: GLYPH[state],
    label,
    askedPeer: asked?.peer ?? null,
    askedAt: asked?.at ?? null,
    runningAgents,
    outside,
    unreported,
    knownSince,
  })

  // Needs you: the agent list's wait, or a prompt the mod offered.
  const needs = s.needsYou.value
  if (s.activity.value === 'waiting' || pending.length > 0) {
    const firstAsk = pending[0]
    if (needs?.kind === 'question' || (!needs && firstAsk?.tool === 'AskUserQuestion')) {
      return view('question', 'NEEDS YOU · QUESTION', firstAsk?.askedAt ?? null)
    }
    if (needs?.kind === 'sandbox') return view('sandbox', 'NEEDS YOU · SANDBOX', firstAsk?.askedAt ?? null)
    if (needs?.kind === 'permission' || (!needs && firstAsk)) return view('approval', 'NEEDS YOU · APPROVAL', firstAsk?.askedAt ?? null)
    const detail = needs?.detail ? `NEEDS YOU · ${needs.detail.toUpperCase()}` : 'NEEDS YOU'
    return view('request', detail, firstAsk?.askedAt ?? null)
  }

  // Ended: its process is gone.
  if (s.pid.value === null || s.activity.value === 'stopped' || s.activity.value === 'failed' || s.activity.value === 'stale') {
    return view('ended', 'ENDED', null)
  }

  if (s.activity.value === 'working' || turn?.running) return view('working', 'WORKING', turn?.running ? turn.startedAt : null)

  const asked = unanswered(s)
  if (asked) return view('asked', `ASKED ${asked.peer} · NO REPLY`, asked.at, asked)
  if (runningAgents > 0) return view('agents', `WAITING ON ${runningAgents} ${runningAgents === 1 ? 'AGENT' : 'AGENTS'}`, null)

  // Your turn and idle: only a mod knows when the turn ended. A session with
  // no turn time is "your turn" until the app has seen it idle for 30
  // minutes (useStateClock). Assumed dead is the lifecycle's call
  // (src/shared/lifecycle.ts, deadView), from activity rather than the turn.
  // Started without a prompt and none sent since (MIP2-1426): it waits for Alex's first message.
  if (s.awaitingFirstPrompt?.value && !s.awaitingFirstPrompt.stale) return view('turn', 'READY FOR YOUR FIRST MESSAGE', s.startedAt.value)
  const endedAt = turn?.endedAt ?? null
  if (endedAt !== null && now - endedAt >= IDLE_AFTER_MS) return view('idle', 'IDLE', endedAt + IDLE_AFTER_MS)
  return view('turn', 'YOUR TURN', endedAt)
}

/**
 * Where no source says when a session's turn ended (a session the agent list
 * alone reports), the app's own observation stands in. A turn the app saw
 * end is "your turn" for 30 minutes, then idle. A session already quiet when
 * the app first saw it reads idle with no age: its turn ended at an unknown
 * time, most often long ago.
 */
export function withObservedIdle(v: CardView, observedSince: number | null, now: number): CardView {
  if (v.state !== 'turn' || v.knownSince !== null) return v
  const idle = (since: number | null): CardView => ({ ...v, state: 'idle', glyph: 'idle', label: 'IDLE', knownSince: since })
  if (observedSince === null) return idle(null)
  return now - observedSince < IDLE_AFTER_MS ? { ...v, knownSince: observedSince } : idle(observedSince + IDLE_AFTER_MS)
}

/** Assumed dead, from the lifecycle (MIP2-1370 §4.1): the card goes to a row at the bottom. */
export function deadView(v: CardView, since: number): CardView {
  return { ...v, state: 'dead', glyph: 'dead', label: 'ASSUMED DEAD', knownSince: since }
}
