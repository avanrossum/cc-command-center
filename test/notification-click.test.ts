// Clicking a notification opens its session (MIP2-2074).

import { describe, expect, it } from 'vitest'
import { NOTIFICATIONS_KEPT, NotificationKeeper, notificationId, targetOf, type Shown } from '../src/main/notification-click.ts'

const A = 'c0ffee01-0000-4000-8000-000000000001'

function shown(id: string) {
  const handlers = new Map<string, () => void>()
  let closed = 0
  const n: Shown = { id, on: (event, listener) => void handlers.set(event, listener), close: () => void closed++ }
  return { n, click: () => handlers.get('click')?.(), close: () => handlers.get('close')?.(), closed: () => closed }
}

describe('notification ids', () => {
  it('name what they open, and read back', () => {
    expect(targetOf(notificationId({ sessionId: A }, '1-1'))).toEqual({ sessionId: A })
    expect(targetOf(notificationId({ needs: true }, '1-2'))).toEqual({ needs: true })
    for (const id of ['', 'other', 'ccc:session:not-an-id:1', 'ccc:session:' + A, 'ccc:needs']) expect(targetOf(id), id).toBeNull()
  })
})

describe('NotificationKeeper', () => {
  it('holds a notification until it is clicked, and opens its session then', () => {
    const opened: unknown[] = []
    const k = new NotificationKeeper(t => void opened.push(t))
    const a = shown(notificationId({ sessionId: A }, '1-1'))
    const b = shown(notificationId({ needs: true }, '1-2'))
    k.keep(a.n)
    k.keep(b.n)
    expect(k.count()).toBe(2)
    a.click()
    b.click()
    expect(opened).toEqual([{ sessionId: A }, { needs: true }])
    expect(k.count()).toBe(0)
  })

  it('lets go of one closed, one the app did not make, and the oldest past the cap', () => {
    const k = new NotificationKeeper(() => {})
    const a = shown(notificationId({ sessionId: A }, '1-1'))
    k.keep(a.n)
    a.close()
    k.keep(shown('someone-else').n)
    expect(k.count()).toBe(0)
    for (let i = 0; i < NOTIFICATIONS_KEPT + 5; i++) k.keep(shown(notificationId({ sessionId: A }, `2-${i}`)).n)
    expect(k.count()).toBe(NOTIFICATIONS_KEPT)
  })
})

describe('notifications from an earlier run (gate pass 63, M-2)', () => {
  it('are kept, and those for a session no longer listed closed once the sessions are known', () => {
    const B = 'c0ffee02-0000-4000-8000-000000000002'
    const opened: unknown[] = []
    const k = new NotificationKeeper(t => void opened.push(t))
    const live = shown(notificationId({ sessionId: A }, '1-1'))
    const gone = shown(notificationId({ sessionId: B }, '1-2'))
    const needs = shown(notificationId({ needs: true }, '1-3'))
    for (const x of [live, gone, needs]) k.restore(x.n)
    expect(k.count()).toBe(3)
    expect(k.closeGone(id => id === A)).toBe(1)
    expect([live.closed(), gone.closed(), needs.closed()]).toEqual([0, 1, 0])
    expect(k.count()).toBe(2)
    // Once only.
    expect(k.closeGone(() => false)).toBe(0)
    live.click()
    expect(opened).toEqual([{ sessionId: A }])
  })
})

