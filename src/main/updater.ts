// Auto-update manager.
//
// electron-updater owns the mechanics: it reads latest-mac.yml from the public
// releases repo (via the app-update.yml electron-builder embeds), verifies the
// signature — it REQUIRES the app to be signed + notarized — downloads, and can
// install on quit. It is the authority on WHETHER an update exists.
//
// The rich UI (per-version feature list, full changelog, the "critical" flag
// that hides "Skip this update") is not something electron-updater provides, so
// we fetch a changelog.json from the releases repo and merge it in. If that
// fetch fails, the flow still works — it just degrades to no feature list.
//
// Nothing here runs in dev (no app-update.yml), and downloads are user-driven:
// autoDownload is off, so a check never pulls bytes until the user asks.
import { app, BrowserWindow } from 'electron'
import electronUpdater from 'electron-updater'
import { APP_VERSION } from '../shared/version'
import { getAppState, setAppState } from './registry'

const { autoUpdater } = electronUpdater

const CHANGELOG_URL =
  'https://raw.githubusercontent.com/avanrossum/claude-command-center-releases/main/changelog.json'
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000 // once a day

export interface ChangelogEntry {
  version: string
  date?: string
  critical?: boolean
  features: string[]
}
export interface UpdatePayload {
  version: string
  currentVersion: string
  critical: boolean
  features: string[]
  changelog: ChangelogEntry[]
}

let getMainWin: (() => BrowserWindow | null) | null = null
let changelogCache: ChangelogEntry[] | null = null
let pendingInstall: 'now' | 'quit' | null = null
let checking = false
let lastCheck = 0

function send(channel: string, payload?: unknown): void {
  // Resolve the window lazily each send: if it was closed and recreated (e.g.
  // via the dock), a captured reference would go stale and events would vanish.
  const win = getMainWin?.() ?? null
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

// Semantic-ish version compare for MAJOR.MINOR.PATCH. Returns >0 if a>b.
function cmpVersion(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0)
  }
  return 0
}

async function fetchChangelog(): Promise<ChangelogEntry[]> {
  try {
    const res = await fetch(CHANGELOG_URL, { cache: 'no-store' } as RequestInit)
    if (!res.ok) return changelogCache ?? []
    const j = (await res.json()) as { versions?: ChangelogEntry[] }
    const list = Array.isArray(j?.versions) ? j.versions : []
    // Newest first, so the UI can slice the top entry as "this release".
    list.sort((a, b) => cmpVersion(b.version, a.version))
    changelogCache = list
    return list
  } catch {
    return changelogCache ?? []
  }
}

// Build the renderer payload for a given target version: its own features +
// critical flag from the changelog, plus the whole changelog for the full tab.
async function buildPayload(version: string): Promise<UpdatePayload> {
  const changelog = await fetchChangelog()
  const entry = changelog.find((e) => e.version === version)
  return {
    version,
    currentVersion: APP_VERSION,
    critical: entry?.critical === true,
    features: entry?.features ?? [],
    changelog,
  }
}

export function initUpdater(getMain: () => BrowserWindow | null): void {
  getMainWin = getMain
  if (!app.isPackaged) return // no app-update.yml in dev; auto-update is a packaged-only path

  autoUpdater.autoDownload = false // never pull bytes until the user chooses
  autoUpdater.autoInstallOnAppQuit = false // opt in per "install on quit"
  autoUpdater.logger = null

  autoUpdater.on('update-available', async (info) => {
    const payload = await buildPayload(info.version)
    // On an automatic (non-manual) check, honor a skipped version — unless it's
    // marked critical, which overrides the skip.
    const skipped = getAppState('updateSkippedVersion')
    if (!checking && skipped === info.version && !payload.critical) return
    send('update:available', payload)
  })
  autoUpdater.on('update-not-available', () => {
    if (checking) send('update:none') // only announce "you're current" for a manual check
  })
  autoUpdater.on('download-progress', (p) => {
    send('update:progress', { percent: Math.round(p.percent) })
  })
  autoUpdater.on('update-downloaded', () => {
    if (pendingInstall === 'now') {
      // Give the renderer a beat to show "installing…" before the app quits.
      setTimeout(() => autoUpdater.quitAndInstall(), 400)
    } else {
      // 'quit' path: it's staged; autoInstallOnAppQuit will apply it on exit.
      send('update:staged')
    }
  })
  autoUpdater.on('error', (err) => {
    send('update:error', { message: (err as Error)?.message ?? 'update failed' })
  })

  // First check shortly after launch, then daily.
  setTimeout(() => void checkForUpdates(false), 8000)
  setInterval(() => void checkForUpdates(false), CHECK_INTERVAL_MS)
}

export async function checkForUpdates(manual: boolean): Promise<void> {
  if (!app.isPackaged) {
    if (manual) send('update:none') // dev build: nothing to update to
    return
  }
  const now = Date.now()
  if (!manual && now - lastCheck < 60_000) return // debounce auto-checks
  lastCheck = now
  checking = manual // 'checking' gates the manual-only "you're current" / skip-override
  try {
    await autoUpdater.checkForUpdates()
  } catch (e) {
    if (manual) send('update:error', { message: (e as Error)?.message ?? 'check failed' })
  } finally {
    checking = false
  }
}

export function downloadAndInstall(mode: 'now' | 'quit'): void {
  if (!app.isPackaged) return
  pendingInstall = mode
  autoUpdater.autoInstallOnAppQuit = mode === 'quit'
  send('update:downloading')
  void autoUpdater.downloadUpdate().catch((e) => {
    send('update:error', { message: (e as Error)?.message ?? 'download failed' })
  })
}

export function skipVersion(version: string): void {
  setAppState('updateSkippedVersion', version)
}

// Post-update greeting: on launch, if the running version is newer than the one
// we last recorded, we just updated — hand the renderer the payload so it can
// show the "you've been updated" modal, then record the current version.
export async function justUpdatedPayload(): Promise<UpdatePayload | null> {
  const last = getAppState('lastRunVersion')
  setAppState('lastRunVersion', APP_VERSION)
  if (!last || cmpVersion(APP_VERSION, last) <= 0) return null
  const changelog = await fetchChangelog()
  const entry = changelog.find((e) => e.version === APP_VERSION)
  return {
    version: APP_VERSION,
    currentVersion: APP_VERSION,
    critical: false,
    features: entry?.features ?? [],
    changelog,
  }
}
