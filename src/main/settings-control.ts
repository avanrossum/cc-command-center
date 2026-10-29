// The settings window's handlers that aren't settings values (MIP2-1424;
// spec MIP2-1387 §4.4–4.6): the app's build and versions, Claude Code's
// status, Check again, and removing the Arbiter key. Each checks its sender.

import { app, ipcMain, type IpcMainInvokeEvent } from 'electron'
import { CLAUDE_CODE_FLOOR } from '@ccc/contract'
import type { SelfCheck, SupervisorWatchdog } from '@ccc/coupling'
import { IPC, type AppStatus, type Result } from '../shared/ipc.ts'
import type { ArbiterKey } from './arbiter-key.ts'
import { isTrustedSender } from './security.ts'

/** Set by scripts/build.mjs from git; absent when the bundle wasn't built by it. */
declare const __CCC_BUILD__: { commit: string; builtAt: string } | undefined

export const BUILD = typeof __CCC_BUILD__ === 'object' ? __CCC_BUILD__ : { commit: 'unknown', builtAt: '' }

export interface SettingsDeps {
  key: ArbiterKey
  selfCheck: SelfCheck
  watchdog: () => SupervisorWatchdog | null
  now?: () => number
}

/** Local midnight before `now`. */
export function startOfDay(now: number): number {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

export function registerSettings({ key, selfCheck, watchdog, now = Date.now }: SettingsDeps): void {
  const untrusted: Result = { ok: false, error: 'untrusted sender' }
  const invoke = <R>(channel: string, fn: () => R, refused: R) =>
    ipcMain.handle(channel, (event: IpcMainInvokeEvent) => {
      if (!isTrustedSender(event)) return refused
      try {
        return fn()
      } catch (e) {
        return { ok: false, error: e instanceof Error ? e.message : String(e) }
      }
    })

  invoke(
    IPC.appStatus,
    (): AppStatus => {
      const w = watchdog()
      // Only the key's last four characters reach the window (spec §4.4: `Stored · …<last 4>`).
      const st = key.status()
      return {
        version: app.getVersion(),
        commit: BUILD.commit,
        builtAt: BUILD.builtAt,
        electron: process.versions.electron ?? '',
        chrome: process.versions.chrome ?? '',
        node: process.versions.node,
        floor: CLAUDE_CODE_FLOOR,
        supervisor: w?.state.kind ?? 'unknown',
        restartsToday: w?.restartsSince(startOfDay(now())) ?? 0,
        // One decryption for all three (gate pass 17, L-2); a key that can't be read stays visible, with Remove.
        arbiterKey: st.kind === 'ok' ? { end: st.end } : st.kind === 'unreadable' ? { end: null } : null,
        arbiterKeyIsAdmin: st.kind === 'admin',
      }
    },
    null,
  )
  invoke(
    IPC.selfCheckAgain,
    (): Result => {
      selfCheck.recheck(now())
      return { ok: true }
    },
    untrusted,
  )
  invoke(
    IPC.channelCheckAgain,
    (): Result => {
      selfCheck.recheckChannel(now())
      return { ok: true }
    },
    untrusted,
  )
  invoke(
    IPC.arbiterKeyRemove,
    (): Result => {
      key.clear()
      return { ok: true }
    },
    untrusted,
  )
}
