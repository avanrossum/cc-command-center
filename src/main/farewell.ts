// The farewell release, 0.25.0 (MIP2-61). This is the last version of this
// app: its updater is off (updater.ts), and on every launch, and on Check for
// Updates, it says the new CC Command Center is out and offers its disk
// image, which is attached to this release. The notice doesn't block the
// app, and Later leaves everything working as before.
import { BrowserWindow, dialog, shell } from 'electron'

/** The new app's disk image, attached to the v0.25.0 release in the public repository. */
export const NEW_APP_DMG =
  'https://github.com/avanrossum/cc-command-center/releases/download/v0.25.0/cc-command-center-app-1.0.0-arm64.dmg'

const MESSAGE = 'CC Command Center has a new version'
const DETAIL = [
  'The new CC Command Center (1.0.0) runs your sessions as Claude Code background sessions, so they keep running when the app quits.',
  "It imports this version's settings, categories and session names, and moves your sessions in. It only reads this version's data.",
  "This version keeps working, but it won't get updates. The new app needs an Apple Silicon Mac and Claude Code 2.1.311 or later.",
].join('\n\n')

let showing = false

/** Shows the notice, once at a time. Download opens the disk image in the browser. */
export async function showFarewell(win: BrowserWindow | null): Promise<void> {
  if (showing) return
  showing = true
  try {
    const opts = { type: 'info' as const, buttons: ['Download', 'Later'], defaultId: 0, cancelId: 1, message: MESSAGE, detail: DETAIL }
    const { response } = win && !win.isDestroyed() ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
    if (response === 0) await shell.openExternal(NEW_APP_DMG)
  } catch (e) {
    console.error('[farewell] notice failed', e)
  } finally {
    showing = false
  }
}
