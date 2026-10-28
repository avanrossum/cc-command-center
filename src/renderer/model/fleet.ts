// Fleet's grouping, order, counts and top-bar line (spec MIP2-1370 §5.2,
// §12). Pure functions of the snapshot and the card views.

import type { SessionSnapshot } from '@ccc/contract'
import type { Classification, Life } from '../../shared/lifecycle.ts'
import type { AppStore } from '../../shared/store.ts'
import { NEEDS_YOU, QUIET, type CardView } from './card-state.ts'

/** A session's category as the UI draws it; `id` null is Uncategorized. */
export interface CatRef {
  id: string | null
  name: string
  color: string
  label: string
  emoji: string
  sort: number
  /** Placed by auto-assign and not yet seen by Alex: the chip reads `· auto` (spec MIP2-1370 §7). */
  auto: boolean
}

export interface Entry {
  session: SessionSnapshot
  view: CardView
  /** When the app saw the session enter this state; null when it hasn't seen it change yet. */
  since: number | null
  cat: CatRef
  /** Claude Code's name, 0.24's name, or the folder name, in that order. */
  name: string
  /** Null for Alex's own sessions; the parent is null when no parent was seen (MIP2-1393 §3). */
  contractor: Extract<Classification, { kind: 'contractor' }> | null
  life: Life
  /** D-020. */
  neverRollOff: boolean
  /** Its live contractors, for the `⚒ <n> contractors` tray. */
  children: Entry[]
  /** For a contractor whose parent is listed: the parent's name. */
  parentName: string | null
  /** "copy of <name>" or "from <name>", for a session started from another (MIP2-1387 §2.3). */
  origin?: string
  /** On the Arbiter's first-ranked session only: the names answering it unblocks, from the app's evidence. */
  arbiterStart?: string[]
  /** The model's one-line summary of the session's current last turn, for opted-in categories (MIP2-1422). Untrusted text. */
  summary?: string
  /** What a session blocked on Alex waits on, for opted-in categories, for its current turn only (MIP2-1485). Untrusted text. */
  waitingOn?: string
  /** `waitingOn` is the turn's own last question, read locally, not the Arbiter's line. */
  waitingLastLine?: boolean
  /** Hosted by CC Command Center 0.24 and not moved in yet (MIP2-1425). */
  inElectron?: boolean
  /** An interactive session started outside the app, not moved in yet: a 0.24 import or a terminal session (MIP2-1466). */
  movable?: boolean
}

/** `cat:<id>`, or `cat:none` for Uncategorized; `auto` shows what auto-assign placed (first run's Review). */
export type FilterId = 'all' | 'needs' | 'auto' | `cat:${string}`

export const UNCATEGORIZED = 'Uncategorized'
export const UNCAT_REF: CatRef = { id: null, name: UNCATEGORIZED, color: 'var(--cc-cat-none)', label: '', emoji: '', sort: Number.POSITIVE_INFINITY, auto: false }

export function catFilter(cat: CatRef): FilterId {
  return `cat:${cat.id ?? 'none'}`
}

export function categoryRef(store: AppStore | null, sessionId: string): CatRef {
  const meta = store?.sessions[sessionId]
  const c = meta?.categoryId ? store?.categories.find(x => x.id === meta.categoryId) : undefined
  if (!c) return UNCAT_REF
  return { id: c.id, name: c.name, color: c.color, label: c.label, emoji: c.emoji, sort: c.sort, auto: meta?.placedBy === 'auto' && !meta.autoSeen }
}

export function nameOf(store: AppStore | null, s: SessionSnapshot): string {
  const meta = store?.sessions[s.sessionId]
  // A name Alex gave (Rename…, or 0.24's names) wins over Claude Code's, as in 0.24.
  // 0.24's `alias` is a handle it minted for its mailbox, not a name Alex chose.
  return meta?.name || s.name.value || s.cwd.value.split('/').at(-1) || s.sessionId
}

/**
 * The color of the frame and strip rule on the view taking input (MIP2-1398
 * §4, amended): the category's color, or the focus blue for a session with
 * no category, whose gray would read like an unframed view.
 */
export function frameColor(cat: CatRef): string {
  return cat.id === null ? 'var(--cc-focus)' : cat.color
}

/** A category chip's short label: the category's own label, `UNCAT` for Uncategorized, else the first word, at most 8 characters. */
export function categoryLabel(cat: CatRef): string {
  if (cat.id === null) return 'UNCAT'
  return cat.label || (cat.name.split(/\s+/)[0] ?? cat.name).slice(0, 8).toUpperCase()
}

/** The attention line's count, emphasized on its own, and the rest. */
export function splitAttention(line: string): { count: string | null; rest: string } {
  const m = /^(\d+ needs? you)(.*)$/.exec(line)
  return m ? { count: m[1]!, rest: m[2]! } : { count: null, rest: line }
}

export interface FleetGroups {
  needs: Entry[]
  active: Entry[]
  quiet: Entry[]
  dead: Entry[]
}

const startOf = (e: Entry) => e.view.knownSince ?? e.since ?? Number.POSITIVE_INFINITY

export interface ContractorGroups {
  /** Contractors with no listed parent: the collapsed group at the bottom of Fleet (§4.2). */
  orphans: Entry[]
}

export function matchesFilter(e: Entry, filter: FilterId): boolean {
  if (filter === 'all') return true
  if (filter === 'needs') return NEEDS_YOU.has(e.view.state)
  if (filter === 'auto') return e.cat.auto
  return filter === catFilter(e.cat)
}

function rankOf(rank: readonly string[], e: Entry): number {
  const i = rank.indexOf(e.session.sessionId)
  return i < 0 ? rank.length : i
}

/** Contractors stay out of every group but Needs you, which holds them while they wait (MIP2-1393 §4.4). */
export function groupFleet(entries: Entry[], filter: FilterId, rank: readonly string[] = []): FleetGroups & ContractorGroups {
  const all = entries.filter(e => matchesFilter(e, filter))
  const shown = all.filter(e => !e.contractor)
  const listed = new Set(entries.map(e => e.session.sessionId))
  return {
    // Oldest wait first until the Arbiter ranks them (N3).
    // The Arbiter's order when it has one; otherwise oldest wait first.
    needs: all.filter(e => NEEDS_YOU.has(e.view.state)).sort((a, b) => rankOf(rank, a) - rankOf(rank, b) || startOf(a) - startOf(b)),
    orphans: entries
      .filter(e => e.contractor && !NEEDS_YOU.has(e.view.state) && !(e.contractor.parentId && listed.has(e.contractor.parentId)))
      .sort((a, b) => recency(b) - recency(a)),
    // Stable while states change: by category, then name.
    active: shown
      .filter(e => !NEEDS_YOU.has(e.view.state) && !QUIET.has(e.view.state) && e.view.state !== 'dead')
      .sort((a, b) => a.cat.sort - b.cat.sort || a.cat.name.localeCompare(b.cat.name) || a.name.localeCompare(b.name)),
    // Most recent first.
    quiet: shown.filter(e => QUIET.has(e.view.state)).sort((a, b) => recency(b) - recency(a)),
    dead: shown.filter(e => e.view.state === 'dead').sort((a, b) => recency(b) - recency(a)),
  }
}

function recency(e: Entry): number {
  return e.session.turn?.value.endedAt ?? e.session.startedAt.value
}

export interface Counts {
  all: number
  needs: number
  working: number
  turn: number
  asked: number
  idle: number
  /** By category id, `none` for Uncategorized, in sidebar order. */
  byCategory: Map<string, { cat: CatRef; n: number }>
}

export function countFleet(all: Entry[]): Counts {
  // A contractor counts only while it needs Alex (MIP2-1393 §4.2, §4.4).
  const entries = all.filter(e => !e.contractor)
  const byCategory = new Map<string, { cat: CatRef; n: number }>()
  for (const e of [...entries].sort((a, b) => a.cat.sort - b.cat.sort)) {
    const key = e.cat.id ?? 'none'
    byCategory.set(key, { cat: e.cat, n: (byCategory.get(key)?.n ?? 0) + 1 })
  }
  const n = (pred: (e: Entry) => boolean) => entries.filter(pred).length
  return {
    all: entries.length,
    needs: all.filter(e => NEEDS_YOU.has(e.view.state)).length,
    working: n(e => e.view.state === 'working'),
    turn: n(e => e.view.state === 'turn'),
    asked: n(e => e.view.state === 'asked' || e.view.state === 'agents'),
    idle: n(e => e.view.state === 'idle'),
    byCategory,
  }
}

/**
 * The top bar's line with no Arbiter yet (N3): spec §12's "Arbiter is off"
 * form, oldest wait first. Null when no wait time is known for any of them.
 */
/** The Arbiter's part of the line: its status, cap and "Start with", when it has evidence. */
export interface ArbiterLine {
  status: 'off' | 'waiting' | 'ranked' | 'capped' | 'error'
  start: { sessionId: string; name: string; unblocks: string[] } | null
  capUsd: number
}

const LINE_MAX = 120

/**
 * The top bar's line (spec §12):
 * - `<n> need you · Start with <session>: <what answering does>.` when the
 *   Arbiter found a session that unblocks others;
 * - otherwise oldest first, saying when the Arbiter is off or at its cap.
 */
export function attentionLine(groups: FleetGroups, counts: Counts, now: number, age: (ms: number) => string, arbiter: ArbiterLine | null = null): string {
  if (counts.needs === 0) return `Nothing needs you. · ${counts.working} working, ${counts.asked} asked and waiting.`
  const head = `${counts.needs} need${counts.needs === 1 ? 's' : ''} you`
  const clipLine = (t: string) => (t.length > LINE_MAX ? `${t.slice(0, LINE_MAX - 2)}….` : t)
  if (arbiter?.status === 'ranked' && arbiter.start && groups.needs[0]?.session.sessionId === arbiter.start.sessionId) {
    return clipLine(`${head} · Start with ${groups.needs[0].name}: unblocks ${arbiter.start.unblocks.join(', ')}.`)
  }
  const oldest = groups.needs[0]
  const start = oldest ? startOf(oldest) : Number.POSITIVE_INFINITY
  const who = oldest?.name ?? ''
  const waited = Number.isFinite(start) ? ` ${who} has waited ${age(now - start)}.` : ` ${who}.`
  const status =
    !arbiter || arbiter.status === 'off' || arbiter.status === 'error' ? ' Arbiter is off.' : arbiter.status === 'capped' ? ` Arbiter is at its $${arbiter.capUsd.toFixed(2)} cap.` : ''
  return `${head} · Oldest first:${waited}${status}`
}

/**
 * Settings → General → Sessions started outside the app (MIP2-1424; spec
 * MIP2-1387 §4, F9; imported from 0.24's `hideUnmanaged`). Hidden from
 * Fleet, the sidebar and the rail; contractors keep their own group. The
 * top line still counts them when they need Alex.
 */
export function shownEntries(entries: Entry[], showOutside: boolean | undefined): Entry[] {
  return showOutside === false ? entries.filter(e => !e.view.outside || e.contractor !== null) : entries
}

/** The summary for the card's current turn, or undefined when it's for an older turn (MIP2-1422). */
export function summaryFor(session: { turn?: { value: { endedAt: number | null } } }, summary: { text: string; turnAt: number } | undefined): string | undefined {
  if (!summary) return undefined
  return summary.turnAt >= (session.turn?.value.endedAt ?? 0) ? summary.text : undefined
}
