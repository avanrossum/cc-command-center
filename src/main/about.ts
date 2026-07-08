import { app, BrowserWindow, Menu, shell, type MenuItemConstructorOptions } from 'electron'
import { APP_VERSION, BUILD_HASH, BUILD_BRANCH, BUILD_TIME, FULL_VERSION } from '../shared/version'

const APP_TITLE = 'CC Command Center'
const COMPANY = 'MipYip, LLC'
const COMPANY_URL = 'https://mipyip.com'
// Private repository. Update this if the repo moves or is renamed. The link
// opens in the user's default browser (GitHub handles auth); it 404s for
// anyone without access, which is expected while the repo is private.
const REPO_URL = 'https://github.com/mipyip/claude-command-center'

let aboutWin: BrowserWindow | null = null

function buildLabel(): string {
  const when = BUILD_TIME.replace('T', ' ').slice(0, 16) + ' UTC'
  const dirty = FULL_VERSION.endsWith('-dirty')
  return [
    `build ${BUILD_HASH}${dirty ? ' (dirty)' : ''} · ${BUILD_BRANCH}`,
    `built ${when}`,
  ].join('\n')
}

function aboutHtml(): string {
  const meta = buildLabel()
    .split('\n')
    .map((l) => `<div>${l}</div>`)
    .join('')
  return `<!doctype html><html><head><meta charset="utf-8" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { height: 100%; margin: 0; }
  body {
    background: radial-gradient(120% 80% at 50% 0%, #14120f 0%, #0e0d0b 60%);
    color: #e7e3db;
    font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    -webkit-font-smoothing: antialiased;
    display: flex; flex-direction: column; align-items: center;
    text-align: center; padding: 34px 28px 24px; -webkit-user-select: none;
  }
  .mark { display: flex; align-items: center; gap: 10px; margin-bottom: 4px; }
  .pulse {
    width: 11px; height: 11px; border-radius: 50%; background: #34d399;
    box-shadow: 0 0 0 4px rgba(52, 211, 153, 0.14);
  }
  .app { font-size: 18px; font-weight: 650; letter-spacing: 0.2px; }
  .ver {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 15px; color: #7ee7b8; margin: 12px 0 4px; -webkit-user-select: text;
  }
  .meta {
    font-family: ui-monospace, 'SF Mono', Menlo, monospace;
    font-size: 11px; color: #6a6355; line-height: 1.7; -webkit-user-select: text;
  }
  .rule { width: 64px; height: 1px; background: #2a2824; margin: 20px 0 18px; }
  .by { font-size: 13px; color: #9a9384; }
  .by a, .links a { color: #9db4ff; text-decoration: none; }
  .by a:hover, .links a:hover { text-decoration: underline; }
  .links { margin-top: 8px; font-size: 12px; }
  .note {
    margin-top: 18px; font-size: 11px; color: #6a6355; max-width: 280px;
  }
  .copy { margin-top: auto; padding-top: 18px; font-size: 11px; color: #4a5160; }
</style></head>
<body>
  <div class="mark"><span class="pulse"></span><span class="app">${APP_TITLE}</span></div>
  <div class="ver">${FULL_VERSION}</div>
  <div class="meta">${meta}</div>
  <div class="rule"></div>
  <div class="by">by <a href="${COMPANY_URL}" target="_blank" rel="noreferrer">${COMPANY}</a></div>
  <div class="links"><a href="${REPO_URL}" target="_blank" rel="noreferrer">Source repository ↗</a></div>
  <div class="note">One window for every Claude Code session. Automatic updates are coming in a future release.</div>
  <div class="copy">© 2026 ${COMPANY}. All rights reserved.</div>
</body></html>`
}

export function openAbout(parent?: BrowserWindow | null): void {
  if (aboutWin && !aboutWin.isDestroyed()) {
    aboutWin.focus()
    return
  }
  aboutWin = new BrowserWindow({
    width: 400,
    height: 500,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: `About ${APP_TITLE}`,
    backgroundColor: '#0e0d0b',
    parent: parent ?? undefined,
    show: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })
  aboutWin.setMenuBarVisibility(false)
  // Route every outbound link to the user's real browser; never navigate the
  // about window itself.
  aboutWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
  aboutWin.webContents.on('will-navigate', (e, url) => {
    e.preventDefault()
    shell.openExternal(url)
  })
  aboutWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(aboutHtml()))
  aboutWin.once('ready-to-show', () => aboutWin?.show())
  aboutWin.on('closed', () => {
    aboutWin = null
  })
}

// Register a branded native About panel too, so any OS path that reaches it
// (e.g. the Dock or a native menu role) shows our info, not Electron's.
export function setAboutPanel(): void {
  app.setAboutPanelOptions({
    applicationName: APP_TITLE,
    applicationVersion: FULL_VERSION,
    version: `${BUILD_HASH} · v${APP_VERSION}`,
    copyright: `© 2026 ${COMPANY}`,
  })
}

// Application menu. The macOS app menu's "About" item opens our custom window
// instead of the default Electron panel. Standard Edit/View/Window roles are
// kept so copy/paste/select-all work inside the terminal panes.
export function installAppMenu(getMain: () => BrowserWindow | null): void {
  const isMac = process.platform === 'darwin'
  const aboutItem: MenuItemConstructorOptions = {
    label: `About ${APP_TITLE}`,
    click: () => openAbout(getMain()),
  }
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? [
          {
            label: APP_TITLE,
            submenu: [
              aboutItem,
              { type: 'separator' },
              { label: 'Check for Updates…', enabled: false },
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [
        { label: `${COMPANY} website`, click: () => shell.openExternal(COMPANY_URL) },
        { label: 'Source repository', click: () => shell.openExternal(REPO_URL) },
        ...(!isMac ? [{ type: 'separator' } as MenuItemConstructorOptions, aboutItem] : []),
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
