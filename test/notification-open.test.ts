// What a notification's click does (gate pass 64, H-1).

import { describe, expect, it } from 'vitest'
import { notificationOpen } from '../src/renderer/model/notification-open.ts'

const entry = (pid: number | null, stale = false) => ({ name: 'site', session: { pid: { value: pid, stale } } })

describe('notificationOpen', () => {
  it('opens Focus only for a session listed with a live process', () => {
    expect(notificationOpen(entry(42))).toEqual({ kind: 'focus' })
  })

  it("offers Resume for one with no process, whatever its card says: ended, assumed dead, or waiting in the session", () => {
    expect(notificationOpen(entry(null))).toEqual({ kind: 'offer', text: "site isn't running." })
    expect(notificationOpen(entry(42, true))).toEqual({ kind: 'offer', text: "site isn't running." })
  })

  it('says a session no longer listed is gone', () => {
    expect(notificationOpen(undefined)).toEqual({ kind: 'gone' })
  })
})
