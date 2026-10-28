// The farewell release, 0.25.0 (MIP2-61). This is the last version of this
// app: its updater is off (updater.ts), and on every launch, and on Check for
// Updates, it says CC Command Center 1.0 is out and offers its disk image,
// which is attached to this release. The notice is its own window, so it
// can't be missed, and it doesn't block the app: Or wait closes it and
// everything works as before.
//
// The window shows one fixed page: sandboxed, JavaScript off, and a content
// policy that loads nothing. Its two buttons are links that main intercepts.
// Get 1.0 early opens the disk image in the browser; Or wait closes the
// window. No other navigation happens, and no other window opens.
import { BrowserWindow, shell } from 'electron'

/** The new app's disk image, attached to the v0.25.0 release in the public repository. */
export const NEW_APP_DMG =
  'https://github.com/avanrossum/cc-command-center/releases/download/v0.25.0/cc-command-center-app-1.0.0-arm64.dmg'
/** The "Or wait" button's link; never loaded, only recognized. */
const LATER = 'https://later.invalid/'

const PAGE = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 28px 32px; font: 14px/1.5 -apple-system, BlinkMacSystemFont, sans-serif; background: Canvas; color: CanvasText; }
  h1 { margin: 0 0 16px; font-size: 22px; line-height: 1.25; color: #d9822b; }
  p { margin: 0 0 12px; }
  .req { color: GrayText; font-size: 13px; }
  .acts { display: flex; gap: 10px; justify-content: flex-end; margin-top: 20px; }
  a.btn { display: inline-block; padding: 7px 16px; border-radius: 7px; text-decoration: none; font-weight: 600; }
  a.primary { background: #d9822b; color: #fff; }
  a.plain { border: 1px solid GrayText; color: CanvasText; }
</style></head><body>
<h1>NOTE: v1.0.0 release, please read</h1>
<p>CC Command Center 1.0 is a rebuild of this app. It runs your sessions as Claude Code background sessions, so they keep running when the app quits.</p>
<p>This is the last update for this version. It keeps working, but it won't get more updates.</p>
<p><b>Get 1.0 early:</b> download it now. An early download is the same 1.0.0 that's published on October 28, and it gets every update after it.</p>
<p><b>Or wait:</b> on the afternoon of October 28, 1.0 is on the Releases page (github.com/avanrossum/cc-command-center/releases). This notice comes back each time you open the app.</p>
<p class="req">1.0 needs a Mac with Apple Silicon and Claude Code 2.1.311 or later. It imports this version's settings, categories and session names, and moves your sessions in. It only reads this version's data.</p>
<div class="acts"><a class="btn plain" href="${LATER}">Or wait</a><a class="btn primary" href="${NEW_APP_DMG}">Get 1.0 early</a></div>
</body></html>`

let notice: BrowserWindow | null = null

/** Shows the notice, one window at a time, in front of the app's window. */
export function showFarewell(parent: BrowserWindow | null): void {
  if (notice && !notice.isDestroyed()) {
    notice.focus()
    return
  }
  const w = new BrowserWindow({
    width: 560,
    height: 480,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: 'CC Command Center has a new version',
    ...(parent && !parent.isDestroyed() ? { parent } : {}),
    show: false,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: false, webSecurity: true },
  })
  notice = w
  // Both buttons are links: main acts on them, and the page never navigates.
  w.webContents.on('will-navigate', (e, url) => {
    e.preventDefault()
    if (url === NEW_APP_DMG) void shell.openExternal(NEW_APP_DMG).catch((err) => console.error('[farewell] open failed', err))
    if (url === NEW_APP_DMG || url === LATER) w.close()
  })
  w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  w.once('ready-to-show', () => w.show())
  w.on('closed', () => (notice = null))
  void w.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(PAGE)}`)
}
