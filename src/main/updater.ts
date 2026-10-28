// App updates (MIP2-1469; release plan §3). As in 0.24, nothing downloads
// until Alex chooses to: a check at start and every few hours, a notice
// "Version X is available" with Download and Later, then Restart to update.
// The release is found by src/main/update-provider.ts. No telemetry: the
// only requests are the feed, the update file and the update itself.

import { ipcMain, type IpcMainInvokeEvent } from 'electron'
import { IPC, type Result } from '../shared/ipc.ts'
import { INITIAL_UPDATE_STATE, type UpdateState } from '../shared/update-state.ts'
import { isTrustedSender } from './security.ts'

/** How often the app checks while it runs. */
export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000

/** The part of electron-updater's AppUpdater this uses. */
export interface UpdaterLike {
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(): void
  on(event: string, listener: (...args: never[]) => void): unknown
}

/** An error as one short line: electron-updater's messages can carry a stack and a whole feed. */
export function shortError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err)
  const line = text.split('\n')[0] ?? ''
  return line.length > 300 ? `${line.slice(0, 300)}…` : line
}

export class Updates {
  private state: UpdateState

  constructor(
    private readonly updater: UpdaterLike,
    private readonly opts: { active: boolean; testOrigin: string | null; onChange: (s: UpdateState) => void; now?: () => number },
  ) {
    this.state = { ...INITIAL_UPDATE_STATE, phase: opts.active ? 'idle' : 'off', testOrigin: opts.testOrigin }
    const on = <A extends unknown[]>(event: string, fn: (...args: A) => void) => updater.on(event, fn as unknown as (...args: never[]) => void)
    on('checking-for-update', () => this.set({ phase: 'checking', error: null }))
    on('update-available', (info: { version: string }) =>
      this.set({ phase: 'available', version: info.version, error: null, checkedAt: this.now(), dismissed: this.state.dismissed && this.state.version === info.version }),
    )
    on('update-not-available', () => this.set({ phase: 'none', version: null, error: null, checkedAt: this.now(), dismissed: false }))
    on('download-progress', (p: { percent: number }) => this.set({ phase: 'downloading', percent: Math.round(p.percent) }))
    on('update-downloaded', (info: { version: string }) => this.set({ phase: 'downloaded', version: info.version, percent: 100, error: null }))
    on('error', (err: unknown) => this.set({ phase: 'error', error: shortError(err), checkedAt: this.state.phase === 'checking' ? this.now() : this.state.checkedAt }))
  }

  current(): UpdateState {
    return this.state
  }

  /** A check, at start, on the timer or by hand. One by hand also brings back a notice Later hid. */
  async check(byHand = false): Promise<void> {
    if (!this.opts.active) return
    if (['checking', 'downloading', 'downloaded'].includes(this.state.phase)) return
    if (byHand) this.set({ dismissed: false })
    this.set({ phase: 'checking', error: null })
    await this.updater.checkForUpdates().catch(err => this.set({ phase: 'error', error: shortError(err), checkedAt: this.now() }))
  }

  /** Download, pressed on the notice. */
  download(): Result {
    if (this.state.phase !== 'available') return { ok: false, error: 'no update is available to download' }
    this.set({ phase: 'downloading', percent: 0 })
    void this.updater.downloadUpdate().catch(err => this.set({ phase: 'error', error: shortError(err) }))
    return { ok: true }
  }

  /** Later: hides the notice for this version. */
  later(): Result {
    this.set({ dismissed: true })
    return { ok: true }
  }

  /** Restart to update. Sessions keep running: they belong to Claude Code's supervisor. */
  restart(): Result {
    if (this.state.phase !== 'downloaded') return { ok: false, error: 'no update has been downloaded' }
    this.updater.quitAndInstall()
    return { ok: true }
  }

  /** The check at start, then every CHECK_EVERY_MS. Returns the timer's stop. */
  start(): () => void {
    void this.check()
    const timer = setInterval(() => void this.check(), CHECK_EVERY_MS)
    return () => clearInterval(timer)
  }

  private now(): number {
    return (this.opts.now ?? Date.now)()
  }

  private set(patch: Partial<UpdateState>): void {
    this.state = { ...this.state, ...patch }
    this.opts.onChange(this.state)
  }
}

export function registerUpdates(updates: Updates): void {
  const untrusted: Result = { ok: false, error: 'untrusted sender' }
  const invoke = <R>(channel: string, fn: () => R | Promise<R>, refused: R) =>
    ipcMain.handle(channel, (event: IpcMainInvokeEvent) => (isTrustedSender(event) ? fn() : refused))
  invoke(IPC.updateGet, () => updates.current(), null)
  invoke(IPC.updateCheck, async (): Promise<Result> => (await updates.check(true), { ok: true }), untrusted)
  invoke(IPC.updateDownload, () => updates.download(), untrusted)
  invoke(IPC.updateLater, () => updates.later(), untrusted)
  invoke(IPC.updateRestart, () => updates.restart(), untrusted)
}
