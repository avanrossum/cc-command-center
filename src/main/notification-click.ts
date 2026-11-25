// Clicking a notification opens its session (MIP2-2074). On macOS a notification's click reaches only a Notification
// object the app still holds (Electron's Notification docs: keep references so events continue to fire), so the app
// keeps each one until it's clicked or closed. Its id names what it opens, so a notification still in Notification
// Center after the app restarts, read back with Notification.getHistory() (code-signed builds only), opens it too.

/** What a notification opens: a session, or Needs you for the startup summary. */
export type NotificationTarget = { sessionId: string } | { needs: true }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** The id a notification is shown with: `ccc:session:<id>:<n>` or `ccc:needs:<n>`; `n` makes it unique, across app starts too. */
export function notificationId(target: NotificationTarget, n: string): string {
  return 'sessionId' in target ? `ccc:session:${target.sessionId}:${n}` : `ccc:needs:${n}`
}

/** What a notification's id says it opens; null for an id the app didn't make. */
export function targetOf(id: string): NotificationTarget | null {
  const parts = id.split(':')
  if (parts[0] !== 'ccc') return null
  if (parts[1] === 'needs' && parts.length === 3) return { needs: true }
  if (parts[1] === 'session' && parts.length === 4 && UUID.test(parts[2]!)) return { sessionId: parts[2]! }
  return null
}

/** The part of an Electron Notification the keeper uses. */
export interface Shown {
  id: string
  on(event: 'click' | 'close', listener: () => void): unknown
  close?(): void
}

/** The most notifications held at once; the oldest goes first. */
export const NOTIFICATIONS_KEPT = 100

/**
 * Holds each notification until it's clicked or closed, so its click
 * still arrives, and opens what its id names on a click.
 */
export class NotificationKeeper {
  private readonly held = new Map<string, Shown>()
  /** Read back from Notification Center at start, until the first good session list says which still apply. */
  private restored: Shown[] = []

  constructor(private readonly open: (target: NotificationTarget) => void) {}

  /** A notification from an earlier run, still in Notification Center: kept like a new one, and checked once the sessions are known. */
  restore(n: Shown): void {
    if (!targetOf(n.id)) return
    this.keep(n)
    this.restored.push(n)
  }

  /**
   * Once, on the first good session list: closes each restored notification
   * whose session isn't listed any more, so its click can't open a gone
   * session (gate pass 63, M-2). Returns how many it closed.
   */
  closeGone(listed: (sessionId: string) => boolean): number {
    let closed = 0
    for (const n of this.restored) {
      const t = targetOf(n.id)
      if (!t || !('sessionId' in t) || listed(t.sessionId)) continue
      n.close?.()
      this.held.delete(n.id)
      closed++
    }
    this.restored = []
    return closed
  }

  /** A notification just shown, or one read back from Notification Center. One the app didn't make is let go. */
  keep(n: Shown): void {
    const target = targetOf(n.id)
    if (!target || this.held.has(n.id)) return
    this.held.set(n.id, n)
    while (this.held.size > NOTIFICATIONS_KEPT) this.held.delete(this.held.keys().next().value!)
    n.on('click', () => {
      this.held.delete(n.id)
      this.open(target)
    })
    n.on('close', () => void this.held.delete(n.id))
  }

  count(): number {
    return this.held.size
  }
}
