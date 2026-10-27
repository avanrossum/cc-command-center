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
  /** When the rule first ran, and how many good agents polls it has seen: startup settles at the later of the second and 5 s. */
  firstAt: number | null
  goodPolls: number
  settled: boolean
}

/** Startup settles no sooner than this after the first poll (UX ruling on MIP2-1412, MIP2-1387 §4.3). */
export const SETTLE_MS = 5_000

export const NOTIFY_GAP_MS = 10_000
const BODY_CHARS = 180

export function newMemory(): NotifyMemory {
  return { last: new Map(), sentAt: new Map(), firstAt: null, goodPolls: 0, settled: false }
}

/** A key that changes when a session asks for something new. */
function needsKey(s: SessionSnapshot): string | null {
  const pending = s.pendingRequests?.value ?? []
  if (pending.length) return pending.map(p => p.requestId).join(',')
  const n = s.needsYou.value
  return n ? `${n.kind}:${n.detail ?? ''}` : null
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
    for (const s of sessions) mem.last.set(s.sessionId, { needs: needsKey(s), running: running(s) })
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
    if (focused || !s0.notifyEnabled) continue
    const meta = store.sessions[s.sessionId]
    // Archived sessions stay quiet; a contractor that needs Alex still asks (MIP2-1393 §4.4).
    if (quiet(store, s.sessionId)) continue
    let cls: NotifyClass | null = null
    // A session first seen after startup that's already waiting is announced once.
    if (needs && needs !== prev?.needs) cls = classOn(store, s.sessionId, 'needs') ? 'needs' : null
    else if (prev && !needs && prev.running && !run && !meta?.contractor) cls = classOn(store, s.sessionId, 'turn') ? 'turn' : null
    if (!cls) continue
    if (now - (mem.sentAt.get(s.sessionId) ?? 0) < NOTIFY_GAP_MS) continue
    mem.sentAt.set(s.sessionId, now)
    out.push(
      cls === 'needs'
        ? needsNotice(s, store)
        : { sessionId: s.sessionId, cls, title: nameOf(s, store), subtitle: `${labelOf(s, store)} · Your turn`, body: clip(s.turn?.value.lastAnswer ?? 'The turn finished.') },
    )
  }
  for (const id of mem.last.keys()) if (!sessions.some(s => s.sessionId === id)) mem.last.delete(id)
  return out
}
