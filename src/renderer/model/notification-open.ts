// What a notification's click does (MIP2-2074; gate pass 63, M-2; pass 64, H-1). Focus attaches, and an attach to a
// session with no process restarts it, so Focus opens only for a session listed with a live process. Any other is
// offered: its name, with Resume for Alex to press. Decided from the process, not the card's label, since an assumed-
// dead or waiting-in-session card can have no process too. Pure, so it's tested without React.

/** The part of a sidebar entry the decision reads. */
export interface NotificationEntry {
  name: string
  session: { pid: { value: number | null; stale: boolean } }
}

export type NotificationOpen = { kind: 'gone' } | { kind: 'focus' } | { kind: 'offer'; text: string }

export function notificationOpen(e: NotificationEntry | undefined): NotificationOpen {
  if (!e) return { kind: 'gone' }
  if (e.session.pid.value !== null && !e.session.pid.stale) return { kind: 'focus' }
  return { kind: 'offer', text: `${e.name} isn't running.` }
}
