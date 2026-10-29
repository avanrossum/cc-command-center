// The app's own Quit (MIP2-1528, spec MIP2-1462). Only the menu's Quit item
// and ⌘Q come here: Electron's `before-quit` also fires on macOS for log out
// and shutdown, so it can't tell them apart, and those quits close nothing
// and ask nothing (§2). Main decides which sessions stop, from the sessions
// closable now (shared/quit.ts); the window only shows the modal and answers.

import { QUIT_STOP_MS, rememberedStops, toStop, type QuitAnswer, type QuitProgress, type QuitReport, type QuitRow, type QuitSessions } from '../shared/quit.ts'

export interface QuitDeps {
  /** The sessions closable now. */
  rows(): QuitRow[]
  setting(): QuitSessions
  /** Show the modal with these rows, opening the window if none is open; the window also reads them with pending(). */
  ask(rows: QuitRow[]): void
  progress(p: QuitProgress): void
  stop(sessionId: string): Promise<void>
  nameOf(sessionId: string): string
  remember(choice: 'close' | 'keep'): void
  report(r: QuitReport): void
  quit(): void
  log?(line: string): void
  stopMs?: number
}

export class QuitControl {
  private state: 'idle' | 'asking' | 'stopping' | 'done' = 'idle'
  private asked: QuitRow[] | null = null

  constructor(private readonly d: QuitDeps) {}

  /** The menu's Quit, or ⌘Q. */
  request(): void {
    if (this.state === 'asking') return this.d.ask((this.asked = this.d.rows()))
    if (this.state !== 'idle') return
    const rows = this.d.rows()
    if (rows.length === 0) return this.finish()
    const setting = this.d.setting()
    if (setting === 'keep') return this.finish()
    if (setting === 'close') return void this.stopAll(rememberedStops(rows), true)
    this.state = 'asking'
    this.asked = rows
    this.d.ask(rows)
  }

  /** The rows the modal is asking about, for a window that opened after the ask was sent; null when not asking. */
  pending(): QuitRow[] | null {
    return this.state === 'asking' ? this.asked : null
  }

  /** The window's answer. Refused unless the modal is up. */
  answer(a: QuitAnswer): { ok: true } | { ok: false; error: string } {
    if (this.state !== 'asking') return { ok: false, error: 'the app is not asking about quitting' }
    if (a.action === 'cancel') {
      this.state = 'idle'
      this.asked = null
      return { ok: true }
    }
    if (a.action === 'keep') {
      if (a.remember) this.d.remember('keep')
      this.finish()
      return { ok: true }
    }
    if (a.remember) this.d.remember('close')
    // Recomputed now: only sessions closable at this moment are ever stopped, whatever the window sent.
    void this.stopAll(toStop(this.d.rows(), a.keep), false)
    return { ok: true }
  }

  /** One at a time, as the session menu stops them, until all are done or the time is up (§7). */
  private async stopAll(ids: string[], silent: boolean): Promise<void> {
    if (ids.length === 0) return this.finish()
    this.state = 'stopping'
    const done: string[] = []
    const failed: string[] = []
    const send = () => this.d.progress({ stopping: ids, done: [...done], failed: [...failed] })
    send()
    const deadline = Date.now() + (this.d.stopMs ?? QUIT_STOP_MS)
    for (const id of ids) {
      const left = deadline - Date.now()
      const ok =
        left > 0 &&
        (await Promise.race([
          this.d.stop(id).then(
            () => true,
            (err: unknown) => (this.d.log?.(`quit: stopping ${id.slice(0, 8)} failed: ${String(err)}`), false),
          ),
          new Promise<false>(r => setTimeout(() => r(false), left).unref?.()),
        ]))
      ;(ok ? done : failed).push(id)
      send()
    }
    if (done.length || failed.length) this.d.report({ closed: done.length, failed: failed.map(id => this.d.nameOf(id)), silent })
    this.finish()
  }

  private finish(): void {
    this.state = 'done'
    this.d.quit()
  }
}
