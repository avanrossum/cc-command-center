// The first run's handlers behind window.ccc (MIP2-1412; spec MIP2-1370
// §14, MIP2-1379 §4). Each checks its sender and arguments, like control.ts.

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC, type FirstRunInfo, type Result } from '../shared/ipc.ts'
import type { AppStoreService } from './app-store.ts'
import type { ArbiterKey } from './arbiter-key.ts'
import { findMailboxRules, removeMailboxRules } from './mailbox.ts'
import { isTrustedSender } from './security.ts'

export interface FirstRunDeps {
  store: AppStoreService
  key: ArbiterKey
  /** Claude Code's user settings, or a copy for development (mailbox.ts claudeSettingsPath). */
  settingsFile: string
  importAvailable: () => boolean
}

export function registerFirstRun({ store, key, settingsFile, importAvailable }: FirstRunDeps): void {
  const untrusted: Result = { ok: false, error: 'untrusted sender' }
  const invoke = <A extends unknown[], R>(channel: string, fn: (...args: A) => R, refused: R) =>
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!isTrustedSender(event)) return refused
      try {
        return fn(...(args as A))
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    })

  invoke(
    IPC.firstRunInfo,
    (): FirstRunInfo => ({
      done: store.get().settings.firstRunDoneAt != null,
      mailboxRules: findMailboxRules(settingsFile),
      settingsFile,
      importAvailable: importAvailable(),
      arbiterKeySet: key.has(),
    }),
    null,
  )

  // Step 1: the one change to Claude Code's settings, on Alex's press, after a backup.
  invoke(IPC.firstRunRemoveMailbox, (): Result<{ removed: string[]; backup: string | null }> => ({ ok: true, ...removeMailboxRules(settingsFile) }), untrusted)

  // Step 4: the key goes in; it never comes back out.
  invoke(IPC.arbiterSetKey, (k: unknown): Result => {
    if (typeof k !== 'string' || k.length > 400) return { ok: false, error: 'bad key' }
    key.set(k)
    return { ok: true }
  }, untrusted)

  invoke(IPC.firstRunFinish, (opts: unknown): Result => {
    const o = (typeof opts === 'object' && opts !== null ? opts : {}) as Record<string, unknown>
    const cap = typeof o.capUsd === 'number' && Number.isFinite(o.capUsd) && o.capUsd >= 0 && o.capUsd <= 100 ? o.capUsd : 1
    store.finishFirstRun({ arbiterCapUsd: cap, arbiterEnabled: o.arbiterEnabled !== false })
    return { ok: true }
  }, untrusted)
}
