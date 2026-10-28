// The spend handlers behind window.ccc (spec MIP2-1498 §5): the state, the
// source, and the Console key (Admin, personal or service account; named
// adminKey in code). Like settings-control.ts, each checks its sender. The
// key is stored like the Arbiter's (arbiter-key.ts),
// never goes back to the window beyond its last four characters, and is
// never logged.

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC, type Result } from '../shared/ipc.ts'
import type { SpendState } from '../shared/spend.ts'
import { keyRefusal, type ArbiterKey } from './arbiter-key.ts'
import { isTrustedSender } from './security.ts'
import type { RealSpendPoller } from './spend.ts'

export interface SpendDeps {
  state: () => SpendState
  real: RealSpendPoller
  adminKey: ArbiterKey
  setSource: (source: 'real' | 'simulated') => void
  /** The spend state changed; tell the window. */
  changed: () => void
}

export function registerSpend({ state, real, adminKey, setSource, changed }: SpendDeps): void {
  const untrusted: Result = { ok: false, error: 'untrusted sender' }
  const invoke = <A extends unknown[], R>(channel: string, fn: (...args: A) => R, refused: Awaited<R>) =>
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!isTrustedSender(event)) return refused
      try {
        return await fn(...(args as A))
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    })

  invoke(IPC.spendGet, () => state(), null)
  invoke(IPC.spendSource, (source: unknown): Result => {
    if (source !== 'real' && source !== 'simulated') return { ok: false, error: 'bad request' }
    setSource(source)
    changed()
    return { ok: true }
  }, untrusted)
  invoke(IPC.adminKeyStatus, () => {
    const k = adminKey.has() ? adminKey.get() : null
    return adminKey.has() ? { end: k ? k.slice(-4) : null } : null
  }, null)
  // Test a pasted key before it's saved, or the saved one; the API's own message on failure.
  invoke(IPC.adminKeyTest, async (k: unknown): Promise<Result> => {
    const key = k === undefined || k === null ? adminKey.get() : typeof k === 'string' && k.length <= 400 ? k.trim() : null
    if (!key) return { ok: false, error: 'No key to test.' }
    const refused = keyRefusal('spend', key)
    if (refused) return { ok: false, error: refused }
    return real.test(key)
  }, untrusted)
  // Saved only after one cost-report call with it succeeds, so an unusable key is never stored (gate pass 15, M-3).
  invoke(IPC.adminKeySave, async (k: unknown): Promise<Result> => {
    if (typeof k !== 'string' || k.length > 400) return { ok: false, error: 'bad key' }
    const refused = keyRefusal('spend', k)
    if (refused) return { ok: false, error: refused }
    const tested = await real.test(k.trim())
    if (!tested.ok) return { ok: false, error: `Not saved: ${tested.error}` }
    adminKey.set(k)
    await real.poll()
    return { ok: true }
  }, untrusted)
  invoke(IPC.adminKeyRemove, async (): Promise<Result> => {
    adminKey.clear()
    await real.poll()
    return { ok: true }
  }, untrusted)
}
