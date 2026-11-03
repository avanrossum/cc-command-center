// Which notifications to show (MIP2-1412; spec MIP2-1387 §4.3, D-016,
// D-021). Pure, so tested without Electron. index.ts shows them.
//
// Two classes: Needs you (approvals, questions, requests; on by default)
// and Your turn (a turn finished; off by default). Never while the app is
// in front, and at most one every 10 s per session (Electron's rule,
// engine/notify.ts). The title names the session, the subtitle its
// category and class, and the body says what it wants, up to 180 characters.

import type { SessionSnapshot } from '@ccc/contract'
import type { AppStore } from '../shared/store.ts'

export type NotifyClass = 'needs' | 'turn'

export interface Notice {
  /** Null for the startup summary, which opens Fleet on Needs you. */
  sessionId: string | null
  cls: NotifyClass
  title: string
  subtitle: string
  body: string
}

/** What the rule remembers between polls. */
export interface NotifyMemory {
  /** Each session's needs-you key and whether a turn was running, at the last poll. */
  last: Map<string, { needs: string | null; running: boolean }>
  /** When each session last notified. */
  sentAt: Map<string, number>
  /**
   * Each session's current stretch of needing Alex: the requests it has
   * announced, and since when it has needed nothing or been out of the
   * list. A stretch ends only after EPISODE_GAP_MS of that (MIP2-1574).
   */
  episodes: Map<string, { requests: Set<string>; keys: Set<string>; clearSince: number | null }>
  /** When the rule first ran, and how many good agents polls it has seen: startup settles at the later of the second and 5 s. */
  firstAt: number | null
  goodPolls: number
  settled: boolean
}

/** Startup settles no sooner than this after the first poll (UX ruling on MIP2-1412, MIP2-1387 §4.3). */
export const SETTLE_MS = 5_000

export const NOTIFY_GAP_MS = 10_000
/**
 * How long a session must need nothing, or be out of the list, before a new
 * need is a new notice. A need that drops out for a poll, or a session listed
 * under another id for a poll, stays one notice (MIP2-1574).
 */
export const EPISODE_GAP_MS = 15_000
const BODY_CHARS = 180

export function newMemory(): NotifyMemory {
  return { last: new Map(), sentAt: new Map(), episodes: new Map(), firstAt: null, goodPolls: 0, settled: false }
}

/** A key that changes when a session asks for something new. */
function needsKey(s: SessionSnapshot): string | null {
  const pending = s.pendingRequests?.value ?? []
  if (pending.length) return pending.map(p => p.requestId).join(',')
  const n = s.needsYou.value
  return n ? `${n.kind}:${n.detail ?? ''}` : null
}

const requestIds = (s: SessionSnapshot) => (s.pendingRequests?.value ?? []).map(p => p.requestId)

/**
 * Whether this poll's need is news in the session's stretch: the stretch's
 * first need, a request it hasn't announced, or a need it hasn't seen,
 * such as another question with no request id (gate pass 20, L-6). `mark`
 * records it as announced; the caller calls it once a notice went out, or
 * when it's held back on purpose (the app in front, notifications off),
 * but not when the 10 s gap held it back, so it's announced on the next
 * poll instead (L-6).
 */
function needsNews(mem: NotifyMemory, s: SessionSnapshot, now: number): { news: boolean; mark: () => void } {
  const ep = mem.episodes.get(s.sessionId)
  const key = needsKey(s)
  if (!key) {
    if (ep) ep.clearSince ??= now
    return { news: false, mark: () => {} }
  }
  const ids = requestIds(s)
  if (ep) ep.clearSince = null
  const fresh = ids.filter(id => !ep?.requests.has(id))
  const freshKey = !ids.length && !ep?.keys.has(key)
  const mark = () => {
    const e = mem.episodes.get(s.sessionId) ?? { requests: new Set<string>(), keys: new Set<string>(), clearSince: null }
    mem.episodes.set(s.sessionId, e)
    for (const id of ids) e.requests.add(id)
    if (!ids.length) e.keys.add(key)
  }
  return { news: !ep || fresh.length > 0 || freshKey, mark }
}

/** Ends the stretches of sessions that have needed nothing, or been out of the list, for EPISODE_GAP_MS. */
function endEpisodes(mem: NotifyMemory, sessions: readonly SessionSnapshot[], now: number): void {
  const listed = new Set(sessions.map(s => s.sessionId))
  for (const [id, ep] of mem.episodes) {
    if (!listed.has(id)) ep.clearSince ??= now
    if (ep.clearSince !== null && now - ep.clearSince >= EPISODE_GAP_MS) mem.episodes.delete(id)
  }
}

function running(s: SessionSnapshot): boolean {
  return s.activity.value === 'working' || s.turn?.value.running === true
}

function nameOf(s: SessionSnapshot, store: AppStore): string {
  return store.sessions[s.sessionId]?.name || s.name.value || s.cwd.value.split('/').at(-1) || s.sessionId.slice(0, 8)
}

function labelOf(s: SessionSnapshot, store: AppStore): string {
  const id = store.sessions[s.sessionId]?.categoryId
  const c = id ? store.categories.find(x => x.id === id) : undefined
  if (!c) return 'UNCAT'
  return c.label || (c.name.split(/\s+/)[0] ?? c.name).slice(0, 8).toUpperCase()
}

const clip = (t: string) => (t.length > BODY_CHARS ? `${t.slice(0, BODY_CHARS - 1)}…` : t)

function needsBody(s: SessionSnapshot): string {
  const p = s.pendingRequests?.value[0]
  if (p?.questions?.[0]) return clip(p.questions[0].question)
  if (p) return clip(`${p.tool}: ${p.summary}`)
  const n = s.needsYou.value
  return clip(n?.detail ?? (n?.kind === 'question' ? 'A question is waiting.' : n?.kind === 'blocked' ? 'Open the session to see what it needs.' : 'Waiting on you.'))
}

/**
 * Whether a class notifies for this session. A category's `on` or `off`
 * overrides the global class switch for its sessions; `auto` follows it
 * (MIP2-1387 §3, UX note on MIP2-1407). The master switch is checked first.
 */
export function classOn(store: AppStore, sessionId: string, cls: NotifyClass): boolean {
  const id = store.sessions[sessionId]?.categoryId
  const cat = id ? store.categories.find(c => c.id === id) : undefined
  const o = cls === 'needs' ? cat?.notifyNeeds : cat?.notifyTurn
  if (o === 'on') return true
  if (o === 'off') return false
  return cls === 'needs' ? store.settings.notifyNeedsYou !== false : store.settings.notifyTurn === true
}

function quiet(store: AppStore, id: string): boolean {
  const m = store.sessions[id]
  return Boolean(m?.rolledOffAt || m?.archivedAt)
}

function needsNotice(s: SessionSnapshot, store: AppStore): Notice {
  return { sessionId: s.sessionId, cls: 'needs', title: nameOf(s, store), subtitle: `${labelOf(s, store)} · Needs you`, body: needsBody(s) }
}

export interface NotifyInput {
  sessions: readonly SessionSnapshot[]
  store: AppStore
  /** The app's window is in front: show nothing. */
  focused: boolean
  now: number
  /** This poll's agents list answered; only good polls count toward settling. Defaults to true. */
  listOk?: boolean
}

/**
 * Compares this poll with the last and returns what to show. The memory
 * updates either way, so nothing queued while the app was in front
 * appears later. The first poll only records.
 */
export function decide(mem: NotifyMemory, { sessions, store, focused, now, listOk = true }: NotifyInput): Notice[] {
  const s0 = store.settings
  const out: Notice[] = []
  mem.firstAt ??= now
  if (listOk) mem.goodPolls += 1
  // Until startup settles, only record. At that moment, sessions already
  // waiting get one notice between them (UX ruling, MIP2-1387 §4.3).
  if (!mem.settled) {
    for (const s of sessions) {
      mem.last.set(s.sessionId, { needs: needsKey(s), running: running(s) })
      needsNews(mem, s, now).mark()
    }
    endEpisodes(mem, sessions, now)
    if (mem.goodPolls < 2 || now - mem.firstAt < SETTLE_MS) return out
    mem.settled = true
    if (focused || !s0.notifyEnabled) return out
    const waiting = sessions.filter(s => needsKey(s) && !quiet(store, s.sessionId) && classOn(store, s.sessionId, 'needs'))
    for (const s of waiting) mem.sentAt.set(s.sessionId, now)
    if (waiting.length === 1) out.push(needsNotice(waiting[0]!, store))
    else if (waiting.length > 1) out.push({ sessionId: null, cls: 'needs', title: `${waiting.length} sessions need you`, subtitle: 'Needs you', body: waiting.map(s => nameOf(s, store)).join(', ').slice(0, BODY_CHARS) })
    return out
  }
  for (const s of sessions) {
    const prev = mem.last.get(s.sessionId)
    const needs = needsKey(s)
    const run = running(s)
    mem.last.set(s.sessionId, { needs, running: run })
    const { news, mark } = needsNews(mem, s, now)
    // Held back on purpose, it counts as announced, so it doesn't appear later.
    if (focused || !s0.notifyEnabled) {
      mark()
      continue
    }
    const meta = store.sessions[s.sessionId]
    // Archived sessions stay quiet; a contractor that needs Alex still asks (MIP2-1393 §4.4).
    if (quiet(store, s.sessionId)) {
      mark()
      continue
    }
    let cls: NotifyClass | null = null
    // Once per stretch of needing Alex, and again for each new request or need in it. A session first seen after startup
    // that's already waiting is announced once.
    if (news) cls = classOn(store, s.sessionId, 'needs') ? 'needs' : null
    else if (prev && !needs && prev.running && !run && !meta?.contractor) cls = classOn(store, s.sessionId, 'turn') ? 'turn' : null
    if (!cls) {
      mark()
      continue
    }
    // Held back by the gap: not announced yet, so the next poll tries again (gate pass 20, L-6).
    if (now - (mem.sentAt.get(s.sessionId) ?? 0) < NOTIFY_GAP_MS) continue
    mark()
    mem.sentAt.set(s.sessionId, now)
    out.push(
      cls === 'needs'
        ? needsNotice(s, store)
        : { sessionId: s.sessionId, cls, title: nameOf(s, store), subtitle: `${labelOf(s, store)} · Your turn`, body: clip(s.turn?.value.lastAnswer ?? 'The turn finished.') },
    )
  }
  for (const id of mem.last.keys()) if (!sessions.some(s => s.sessionId === id)) mem.last.delete(id)
  endEpisodes(mem, sessions, now)
  return out
}
