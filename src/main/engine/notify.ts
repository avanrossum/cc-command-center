// macOS system notifications for fleet attention events.
//
// The design constraint is noise, not delivery: a fleet this active would fire
// constantly if every state change notified, so everything here is a filter.
//   1. MASTER OFF by default — enabling it is also when macOS asks for permission.
//   2. NEVER while the app is focused. If you're in CCCC, the needs-you bar already
//      IS the notification and a banner is redundant. Gated on focused, not visible:
//      an open window on a second monitor while you work elsewhere is exactly when
//      a notification earns its place.
//   3. Per event class, with per-category overrides (null = inherit global).
//   4. Edge-triggered + cooled down, so one event notifies once.
//
// Defaults are conservative on purpose: permission and question notify (something
// is STOPPED and only you can unstick it), 'done' does not (the work is banked and
// it's the highest-volume class — the one that would train you to ignore banners).
import { Notification } from 'electron'
import type { Category, OpenedGate } from '../registry'

export type NotifyClass = 'permission' | 'question' | 'done'

export interface NotifyPrefs {
  enabled: boolean // master switch
  permission: boolean
  question: boolean
  done: boolean
}

export interface NotifyCtx {
  prefs: NotifyPrefs
  focused: boolean // app window has focus right now
  categoryById: Map<number, Category>
  nameOf: (sessionId: string) => string
  onActivate: (sessionId: string) => void // clicking the notification opens that session
}

const COOLDOWN_MS = 10_000 // per session, so a flapping state can't storm
const MAX_BODY = 180

const LABEL: Record<NotifyClass, string> = {
  permission: 'Needs permission',
  question: 'Your turn',
  done: 'Done',
}

// Sessions currently notified as 'done'. 'done' isn't a gate (it has no ledger
// fingerprint), so it needs its own edge-trigger: notify on the transition into
// done, clear when the session leaves it. Without this it would re-fire every tick.
const doneNotified = new Set<string>()
const lastNotifiedAt = new Map<string, number>()
// Shown-but-not-yet-dismissed notifications, held so they (and their click
// listeners) survive until the user acts. Removed on click/close.
const live = new Set<Notification>()

// Per-category override wins over the global switch; null/undefined inherits.
function classEnabled(cls: NotifyClass, categoryId: number | null, ctx: NotifyCtx): boolean {
  const global = ctx.prefs[cls]
  if (categoryId == null) return global
  const cat = ctx.categoryById.get(categoryId)
  if (!cat) return global
  const override =
    cls === 'permission' ? cat.notify_permission : cls === 'question' ? cat.notify_question : cat.notify_done
  return override == null ? global : override === 1
}

function trim(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > MAX_BODY ? one.slice(0, MAX_BODY - 1) + '…' : one
}

function categoryTag(categoryId: number | null, ctx: NotifyCtx): string {
  if (categoryId == null) return 'Uncategorized'
  const c = ctx.categoryById.get(categoryId)
  if (!c) return 'Uncategorized'
  const word = c.label?.trim() || c.name
  return c.emoji ? `${c.emoji} ${word}` : word
}

function fire(
  cls: NotifyClass,
  sessionId: string,
  categoryId: number | null,
  body: string,
  now: number,
  ctx: NotifyCtx,
): boolean {
  if (!ctx.prefs.enabled || ctx.focused) return false
  if (!Notification.isSupported()) return false
  if (!classEnabled(cls, categoryId, ctx)) return false
  const last = lastNotifiedAt.get(sessionId) ?? 0
  if (now - last < COOLDOWN_MS) return false
  lastNotifiedAt.set(sessionId, now)
  const n = new Notification({
    title: ctx.nameOf(sessionId),
    subtitle: `${categoryTag(categoryId, ctx)} · ${LABEL[cls]}`,
    body: trim(body) || LABEL[cls],
    silent: false,
  })
  // Hold a reference until the notification is done. Without this the Notification
  // object is eligible for GC as soon as fire() returns — macOS still shows the
  // banner, but the JS object (and its 'click' listener) can be collected before
  // the user clicks, so the click does nothing. This is the fix for "notifications
  // fire but clicking them doesn't open the session".
  live.add(n)
  const done = (): void => {
    live.delete(n)
  }
  n.on('click', () => {
    done()
    ctx.onActivate(sessionId)
  })
  n.on('close', done)
  n.show()
  return true
}

// Gates that opened on this tick. The ledger's fp identity means one live dialog
// notifies exactly once, however many scans it spans and however much its display
// text repaints. 'blocked' is deliberately not notified: it's derived from a child
// that has its own gate, so notifying both would double-report one situation.
// autoSeen is NOT a filter — when the app is unfocused you aren't looking at the
// attached session either, and focus is the honest "am I here" signal.
export function notifyOpenedGates(opened: OpenedGate[], now: number, ctx: NotifyCtx): void {
  if (!ctx.prefs.enabled || ctx.focused || opened.length === 0) return
  for (const g of opened) {
    if (g.kind !== 'permission' && g.kind !== 'question') continue
    fire(g.kind, g.sessionId, g.categoryId, g.payload, now, ctx)
  }
}

// 'done' sessions this tick, edge-triggered against the previous tick. Pass every
// session so sessions that LEFT done get cleared and can notify again next time.
export function notifyDone(
  sessions: { sessionId: string; categoryId: number | null; isDone: boolean; why?: string }[],
  now: number,
  ctx: NotifyCtx,
): void {
  for (const s of sessions) {
    if (!s.isDone) {
      doneNotified.delete(s.sessionId)
      continue
    }
    if (doneNotified.has(s.sessionId)) continue
    // Mark before the filters so a suppressed 'done' (focused, class off) doesn't
    // fire later in the same episode the moment a filter flips.
    doneNotified.add(s.sessionId)
    fire('done', s.sessionId, s.categoryId, s.why ?? 'Finished — your move.', now, ctx)
  }
}

// Drop state for sessions that no longer exist, so the maps can't grow forever.
export function forgetNotifyState(liveIds: Set<string>): void {
  for (const id of doneNotified) if (!liveIds.has(id)) doneNotified.delete(id)
  for (const id of lastNotifiedAt.keys()) if (!liveIds.has(id)) lastNotifiedAt.delete(id)
}
