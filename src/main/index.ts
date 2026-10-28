// The main process: applies the security baseline, starts the coupling
// package's fleet poller, self-check and supervisor watchdog, and shows the
// window. It reads Claude Code only through @ccc/coupling.

import { chmodSync, lstatSync, mkdirSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import {
  AttachPool,
  ChannelHub,
  CommandLog,
  DEFAULT_CHANNEL_ROOT,
  createClaudeExitCode,
  createClaudeRunner,
  createClaudeSpawner,
  FleetPoller,
  parseVersion,
  readUsageDir,
  removeLegacyReporterDir,
  resolveClaudeBinary,
  SelfCheck,
  SessionControl,
  SupervisorHost,
  SupervisorWatchdog,
  spawnAttach,
  TrustRuns,
  resolveLoginPath,
  setLoginPath,
  checkSupervisorPath,
  processStartedAt,
  sharedSupervisorStart,
  awaitLoginPath,
  terminalHostOf,
} from '@ccc/coupling'
import { app, BrowserWindow, dialog, ipcMain, Menu, Notification, safeStorage } from 'electron'
import { IPC } from '../shared/ipc.ts'
import { APP_ORIGIN } from './policy.ts'
import { AppStoreService, registryPresent } from './app-store.ts'
import { Arbiter, ArbiterLog, waitingItems } from './arbiter.ts'
import { Summaries } from './summaries.ts'
import { blockedOnAlex, lastQuestion, type TurnSummary } from '../shared/summaries.ts'
import { createAsk, createSummarize, createTips } from './arbiter-client.ts'
import { checkTipFacts, UsageTips } from './usage-tips.ts'
import { REAL_POLL_MS, RealSpendPoller, SpendLedger, type Fetch } from './spend.ts'
import { registerSpend } from './spend-control.ts'
import type { SpendState } from '../shared/spend.ts'
import type { SessionSnapshot } from '@ccc/contract'
import { ArbiterKey } from './arbiter-key.ts'
import { registerArtifacts } from './artifacts.ts'
import { registerFirstRun } from './first-run-control.ts'
import { claudeSettingsPath } from './mailbox.ts'
import { decide, newMemory } from './notify-rules.ts'
import { registerControl } from './control.ts'
import { registerStore } from './store-control.ts'
import { applyBeforeReady, applyWhenReady, isTrustedSender } from './security.ts'
import { checkClaudeBinOverride, debugPortAllowed, qaPickPaths, resolveChannelRoot, resolveImportFolder, resolveUserData } from './paths.ts'
import { fileStore } from './self-check-store.ts'
import { appMenuTemplate } from './app-menu.ts'
import { modVerdict } from './mod-verdict.ts'
import { checkModFolders, MOD_FOLDERS_MAX, modDir, type ModHealed } from './reporter-mod.ts'
import { moveRequest } from './move.ts'
import { registerSettings } from './settings-control.ts'
import { setUpUpdates } from './update-setup.ts'
import { isolatedEnv, runFolderRefusal, TEST_RUN_FOLDER, testIsolation, UPDATE_TEST_FEED } from './test-isolation.ts'
import { registerUpdates } from './updater.ts'
import { betaUpdatesOn } from '../shared/update-state.ts'

// The build writes main.cjs, preload.cjs and renderer/ side by side in dist/.
const DIST = __dirname

/** A setup the app refuses (a bad override, a channel folder open to others): say why and exit. */
function fatal(err: unknown): never {
  const why = err instanceof Error ? err.message : String(err)
  console.error(`CC Command Center can't start: ${why}`)
  // Said where Alex sees it, not only in a log (pass 5, M-5). Safe before ready.
  dialog.showErrorBox("CC Command Center App can't start", why)
  app.exit(1)
  process.exit(1)
}

// A dry-run test build isolates itself, environment or not (MIP2-1469): a ShipIt relaunch has none.
const isolation = testIsolation(UPDATE_TEST_FEED, homedir())
if (isolation) {
  try {
    try {
      mkdirSync(TEST_RUN_FOLDER, { mode: 0o700 })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
    }
    // lstat, so a planted symlink is refused rather than followed (pass 9, L-3).
    const st = lstatSync(TEST_RUN_FOLDER)
    const refused = runFolderRefusal({ isDirectory: st.isDirectory(), isSymbolicLink: st.isSymbolicLink(), uid: st.uid, mode: st.mode }, process.getuid?.() ?? -1)
    if (refused) throw new Error(refused)
    if ((st.mode & 0o777) !== 0o700) chmodSync(TEST_RUN_FOLDER, 0o700)
  } catch (err) {
    fatal(err)
  }
  Object.assign(process.env, isolatedEnv(process.env, isolation))
}

// Before anything opens the profile: never Electron CCCC's folder, and an
// override only where paths.ts allows it (D-008, MIP2-1408).
try {
  app.setPath('userData', resolveUserData(process.env, app.getPath('appData')))
} catch (err) {
  fatal(err)
}
// One instance per data folder: Electron keys the lock to userData, so it
// comes after setPath, and Electron CCCC's lock is its own (MIP2-1404).
if (!app.requestSingleInstanceLock()) {
  app.exit(0)
  process.exit(0)
}
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0]
  if (win) (win.isMinimized() && win.restore(), win.focus())
})
// Claude Code's user settings: the first run's mailbox step edits only
// this file, and only a copy (CCC_CLAUDE_SETTINGS) during development.
let claudeSettings = ''
try {
  claudeSettings = isolation ? isolation.claudeSettings : claudeSettingsPath(process.env, app.isPackaged)
} catch (err) {
  fatal(err)
}
// QA's ⌘O stand-in, refused outside an unpackaged CCC_QA=1 run (MIP2-1413).
let pickPaths: string[] | null = null
try {
  pickPaths = qaPickPaths(process.env, app.isPackaged)
} catch (err) {
  fatal(err)
}
try {
  checkClaudeBinOverride(process.env, app.isPackaged)
} catch (err) {
  fatal(err)
}
// Chromium opens the debugging port at ready; drop the switch before then
// unless this is an unpackaged QA run (MIP2-1408).
if (app.commandLine.hasSwitch('remote-debugging-port') && !debugPortAllowed(process.env, app.isPackaged)) {
  app.commandLine.removeSwitch('remote-debugging-port')
  console.warn('remote debugging refused: it needs CCC_QA=1 and an unpackaged build')
}
applyBeforeReady()

let poller: FleetPoller | null = null
let hub: ChannelHub | null = null
let watchdog: SupervisorWatchdog | null = null
let pool: AttachPool | null = null
let summaries: Summaries | null = null
/** The Needs-you line for sessions blocked with nothing the card can answer (MIP2-1485). */
let waits: Summaries | null = null
/** Simulated spend (MIP2-1498 §5); saved on quit. */
let spendLedger: SpendLedger | null = null
/** Notes the local last-line excerpts for blocked sessions; set up with `waits`. */
/** Adds a poll's session costs to the spend ledger; set up with it. */
let noteSpend: (sessions: readonly SessionSnapshot[]) => void = () => {}
let noteLastLines: (blocked: string[], live: ReadonlySet<string>) => void = () => {}

function broadcast(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, ...args)
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1100,
    minHeight: 640,
    title: 'CC Command Center',
    webPreferences: {
      preload: join(DIST, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
    },
  })
  void win.loadURL(`${APP_ORIGIN}/index.html`)
  return win
}

app.whenReady().then(start).catch(fatal)

async function start(): Promise<void> {
  applyWhenReady(join(DIST, 'renderer'))
  // Settings… (⌘,) in the app menu (MIP2-1459).
  Menu.setApplicationMenu(Menu.buildFromTemplate(appMenuTemplate(app.name, () => broadcast(IPC.openSettings))))
  // Alex's login PATH for every claude the app runs: from the Finder the app has launchd's minimal one (MIP2-1457).
  // Resolved in the background; every claude the runner starts waits for it, so start() doesn't (pass 8, L-2).
  const loginReady = resolveLoginPath().then(login => {
    setLoginPath(login.path)
    console.warn(`claude PATH from ${login.from}: ${login.path}`)
  })
  awaitLoginPath(loginReady)

  // Each app-launched session's mod talks to the app over its channel. A
  // packaged app runs it from a copy in its data folder (reporter-mod.ts).
  // The packaged mod copy is checked against what shipped now and every minute (gate M-2).
  let modChanged: ModHealed | null = null
  let selfCheckRef: SelfCheck | null = null
  let storeRef: AppStoreService | null = null
  let hostRef: SupervisorHost | null = null
  // Channels found squatted while recovering, before the host exists, are stopped once it does.
  const stopsWaiting: string[] = []
  // Stopped, then given a new secret with the mark kept: a wake from the CLI or the supervisor reads a secret the
  // impostor never saw, and the card stays off until a resume from the app (pass 4, M-2, L-5).
  const untrustedStop = (id: string) => {
    if (!hostRef) return void stopsWaiting.push(id)
    void hostRef
      .stop(id)
      .catch(err => console.warn(`stopping ${id.slice(0, 8)} after its channel changed: ${String(err)}`))
      .then(() => hub?.rekey(id, { keepMark: true }))
      .catch(err => console.warn(`new secret for ${id.slice(0, 8)} after its channel changed: ${String(err)}`))
  }
  // Mod versions whose changed copy couldn't be moved aside: the watchdog doesn't respawn their sessions (pass 5, H-1).
  const stuckVersions = new Set<string>()
  const onModHeal = (h: ModHealed) => {
    modChanged = h
    if (h.movedTo) stuckVersions.delete(basename(h.dir))
    else stuckVersions.add(basename(h.dir))
    // The sessions launched on that copy, so the band can name them (gate run 2, L-1).
    const version = basename(h.dir)
    const names = Object.entries(storeRef?.get().sessions ?? {})
      .filter(([, m]) => m.launch?.mod === version && !m.archivedAt)
      .map(([id, m]) => m.name ?? id.slice(0, 8))
    selfCheckRef?.markModChanged(Date.now(), h.movedTo, names, h.why)
    console.warn(`reporter mod: ${h.dir} was changed outside the app; ${h.movedTo ? `moved to ${h.movedTo}` : `couldn't be set aside (${h.why})`}`)
  }
  // The app's own records: categories, names, settings (MIP2-1409). Read before the channels, which
  // take each session's launch options and untrusted mark from it (pass 4, H-1, M-2).
  const store = new AppStoreService(join(app.getPath('userData'), 'store.json'))
  storeRef = store
  // A copy that can't be repaired is replaced by a fresh one under another name; only a failure to make any good
  // copy stops the start, with a dialog (pass 5, H-1, M-5).
  // Folders that couldn't be moved aside are tried once per start (pass 6, M-3).
  const modOps = { stuck: new Set<string>() }
  let pluginDir = await modDir(DIST, app.isPackaged, app.getPath('userData'), onModHeal, modOps)
  // The current copy and the older versions are checked on their own, so one failing doesn't skip the other (gate run 3, L-4).
  // A check that throws leaves its copy unchecked, so it fails the mod-integrity item (pass 4, M-3).
  let checkFailed: { what: string; why: string } | null = null
  const guarded = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn()
    } catch (err) {
      console.warn(`reporter mod check (${what}): ${String(err)}`)
      checkFailed = { what: what === 'current' ? 'the current copy' : 'the older versions', why: err instanceof Error ? err.message : String(err) }
      selfCheckRef?.markModCheckFailed(Date.now(), checkFailed.what, checkFailed.why)
      // No good current copy: nothing launches until there is one (pass 5, H-1).
      if (what === 'current') hub?.blockLaunches(`the reporter mod's copy is changed and couldn't be replaced (${checkFailed.why})`)
    }
  }
  // The versions verified by the latest completed round, and whether it left any unchecked (pass 7, H-1).
  let verifiedVersions = new Set<string>([basename(pluginDir)])
  let uncheckedVersions = 0
  const checkVersions = async () => {
    // The versions unarchived sessions use: checked first; folders nothing uses are removed.
    const referenced = new Set(
      Object.values(store.get().sessions)
        .filter(m => !m.archivedAt && !m.removedAt && m.launch?.mod)
        .map(m => m.launch!.mod!),
    )
    referenced.add(basename(pluginDir))
    const r = await checkModFolders(app.getPath('userData'), pluginDir, onModHeal, Date.now, modOps, referenced)
    verifiedVersions = new Set([...r.verified, basename(pluginDir)])
    uncheckedVersions = r.unchecked.length
    if (r.unchecked.length) throw new Error(`${r.unchecked.length} reporter mod folders over the ${MOD_FOLDERS_MAX} the app checks were left unchecked`)
  }
  if (app.isPackaged) {
    await guarded('versions', checkVersions)
    // One round at a time, async between folders and for chflags. Hashing a folder is still synchronous, so a
    // round with a large changed folder holds the main thread while it's hashed (pass 6, M-3; pass 7, L-3).
    let checking = false
    setInterval(() => {
      if (checking) return
      checking = true
      void (async () => {
        await guarded('current', async () => {
          const dir = await modDir(DIST, true, app.getPath('userData'), onModHeal, modOps)
          if (dir !== pluginDir) {
            pluginDir = dir
            hub?.setModDir(dir)
          }
          verifiedVersions.add(basename(dir))
          hub?.blockLaunches(null)
        })
        await guarded('versions', checkVersions)
      })().finally(() => (checking = false))
    }, 60_000).unref()
  }
  // Whether a session may start again on its saved mod copy: resume and the watchdog both ask (pass 7, H-1, L-4).
  const sessionModVerdict = (id: string): string | null =>
    modVerdict(store.get().sessions[id]?.launch?.mod, {
      packaged: app.isPackaged,
      stuck: stuckVersions,
      verified: verifiedVersions,
      unchecked: uncheckedVersions,
      launchBlocked: hub?.launchBlocked() ?? null,
    }, store.get().sessions[id]?.origin === 'app')
  // Channels whose settings were brought up to date at recovery, for the self-check (pass 7, M-1).
  const migrated: string[] = []
  hub = new ChannelHub({
    modDir: pluginDir,
    // The whole mod root, every version's folder, is denied to sessions (gate run 2, L-1).
    ...(app.isPackaged ? { modRoot: join(app.getPath('userData'), 'reporter-mod') } : {}),
    // The app's data folder, store included, so a session's Edit tool can't change it (pass 5, M-3).
    denyAlso: [app.getPath('userData')],
    root: resolveChannelRoot(process.env, DEFAULT_CHANNEL_ROOT),
    // Card summaries (MIP2-1422); set up below, once the store and key exist.
    onAnswer: (id, post) => (void summaries?.offer(id, post), void waits?.offer(id, post)),
    // Every connection must come from the session's own process (gate M-1).
    sessionPid: id => poller?.current()?.sessions.find(s => s.sessionId === id && !s.pid.stale)?.pid.value ?? null,
    // A swapped or squatted channel: stop the session, so an impostor holding its secret loses its mod (gate run 2, M-1).
    // The settings file a re-key writes comes from the app's record of the launch (pass 4, H-1).
    launchOf: id => store.get().sessions[id]?.launch ?? null,
    // Each channel's settings version, kept in the store, not the channel's folder (pass 7, M-1).
    versions: store.channelVersions(),
    onMigrated: (id, from, to) => migrated.push(`${id} from version ${from} to ${to}`),
    onUntrusted: (id, why) => {
      if (!id) return
      store.markUntrusted(id, why)
      untrustedStop(id)
      broadcast(IPC.appNotice, `Stopped a session: ${why}. Resuming it from the app gives its channel a new secret first.`)
    },
  })
  // Refuses a channel folder, or its parent, that other users can open (D-005).
  await hub.recover()
  // The store's copy of each mark covers a lost folder mark; same-user code can write the store too (pass 5, M-3).
  hub.restoreMarks(store.untrustedMarks())
  await removeLegacyReporterDir()
  const channels = hub
  // Every lifecycle command's arguments, exit code and output, prompts and secrets cut (MIP2-1446).
  const commandLog = new CommandLog(join(app.getPath('userData'), 'claude-commands.log'))
  const run = commandLog.wrap(createClaudeRunner())
  // Detect and degrade (DECISION item 4): results per Claude Code version.
  const selfCheck = new SelfCheck(fileStore(join(app.getPath('userData'), 'self-check.json')))
  selfCheckRef = selfCheck
  selfCheck.noteMigrated(migrated)
  if (modChanged) selfCheck.markModChanged(Date.now(), (modChanged as ModHealed).movedTo, [], (modChanged as ModHealed).why)
  if (checkFailed) selfCheck.markModCheckFailed(Date.now(), (checkFailed as { what: string }).what, (checkFailed as { why: string }).why)
  const binary = resolveClaudeBinary()
  // When the Claude Code the app runs was installed: the creation time of the file the binary's link resolves to.
  const installedAt = (bin: string): number | null => {
    try {
      return statSync(realpathSync(bin)).birthtimeMs || null
    } catch {
      return null
    }
  }
  // Whether the shared supervisor can find claude and Alex's tools; read at start and every 5 minutes (MIP2-1457).
  const readSupervisorPath = () =>
    void checkSupervisorPath(run, binary).then(
      async r => {
        selfCheck.noteSupervisorPath(r)
        // What may have cut sessions off from the app, for the channel band (MIP2-1488).
        selfCheck.noteCauses({ claudeInstalledAt: installedAt(binary), supervisorStartedAt: r ? await processStartedAt(r.pid) : null })
      },
      err => console.warn(`supervisor PATH: ${String(err)}`),
    )
  readSupervisorPath()
  setInterval(readSupervisorPath, 5 * 60_000).unref()
  // `claude daemon run`, as the watchdog starts it: the user's environment, none of the session switches (MIP2-1463).
  const spawnClaude = commandLog.wrapSpawner(createClaudeSpawner())
  // One start for the host and the watchdog, at most one per 10 s, so they never start two at once (pass 9, L-5).
  const startDaemon = sharedSupervisorStart(() => spawnClaude(['daemon', 'run']))
  const host = new SupervisorHost({
    run,
    binary,
    channels,
    startSupervisor: () => void startDaemon(),
    // A session command ran with its reload switch in its settings file only (MIP2-1463).
    onSwitchUnconfirmed: () => selfCheck.noteSwitchUnconfirmed(Date.now()),
    // A state, status or wait the app doesn't know, raw, for the record (MIP2-1447).
    onUnknown: raw => void commandLog.note('unknown-state', raw),
    // New sessions an operation couldn't account for are reported, not removed (pass 6, H-2).
    // Kept as a security item until they leave the list (pass 7, L-1).
    onStrays: ids => {
      selfCheck.addStrays(ids)
      broadcast(IPC.appNotice, `Claude Code started ${ids.length === 1 ? 'a session' : `${ids.length} sessions`} the app can't account for (${ids.map(i => i.slice(0, 8)).join(', ')}). Check the session list.`)
    },
  })
  hostRef = host
  for (const id of stopsWaiting.splice(0)) untrustedStop(id)
  poller = new FleetPoller({
    host,
    readReporter: () => channels.readReporter(),
    readPending: () => channels.pendingRequests(),
    readUsage: () => readUsageDir(),
    selfCheck,
    readChannels: () => channels.health(),
    readVersion: async () => parseVersion(await run(['--version'])),
  })
  const fleet = poller

  // Keeps Claude Code's supervisor up while the app hosts sessions (DECISION item 2, MIP2-1377 §3).
  watchdog = new SupervisorWatchdog({
    exitCode: createClaudeExitCode(),
    // The watchdog spawns only `daemon run`; it goes through the shared start.
    spawn: args => (args[0] === 'daemon' && args[1] === 'run' ? startDaemon() : spawnClaude(args)),
    // Through the host, so the respawn carries the session's reload switch (MIP2-1463).
    respawn: id => host.respawn(id),
    sessions: () => fleet.current()?.sessions ?? [],
    // Nor one whose mod copy is stuck or unverified (pass 5, H-1; pass 7, H-1).
    skip: id => channels.untrustedReason(id) !== null || sessionModVerdict(id) !== null,
  })
  // After the login PATH, so a supervisor it starts gets it (pass 8, L-2).
  void loginReady.then(() => watchdog?.start())

  // Focus: `claude attach` views, and the controls behind window.ccc.
  pool = new AttachPool(host, {
    data: (id, data) => broadcast(IPC.focusData, id, data),
    exit: (id, code) => broadcast(IPC.focusExit, id, code),
  })
  // A move from 0.24, through the move sheet or a parked session's trust step: its launch settings and source.
  const recordMoved = (from: string, to: string) => {
    const r = moveRequest(store.get().sessions[from], undefined)
    store.recordMove(from, to, { model: r?.model, effort: r?.effort, mode: r?.permissionMode, ...(app.isPackaged ? { mod: basename(pluginDir) } : {}) })
  }
  const trust = new TrustRuns(
    host,
    binary,
    {
      data: (id, data) => broadcast(IPC.trustData, id, data),
      done: (id, sid, err, cwd, resumed) => {
        // A parked 0.24 session resumed through the trust step is recorded as a move (MIP2-1461).
        if (sid && resumed) recordMoved(resumed, sid)
        else if (sid) store.touch(sid, Date.now(), 'app')
        if (sid && cwd && !resumed) store.assignLaunched(sid, cwd)
        broadcast(IPC.trustDone, id, sid, err)
      },
    },
    // The trust run's command line and exit code, not its output (MIP2-1446).
    commandLog.wrapTrust(spawnAttach),
  )
  registerControl({
    host,
    hub: channels,
    pool,
    trust,
    control: new SessionControl({ host, hub: channels, current: () => fleet.current() }),
    onActivity: id => store.touch(id, Date.now()),
    onLaunched: (id, r, source) => {
      store.recordLaunch(
        id,
        { model: r.model, effort: r.effort, mode: r.permissionMode, isolation: r.isolation, ultracode: r.ultracode, extraArgs: r.extraArgs, ...(app.isPackaged ? { mod: basename(pluginDir) } : {}) },
        source,
      )
      // On Auto, place it now rather than wait for a poll that won't (MIP2-1432). A copy keeps its
      // source's category, and its request carries no folder of its own.
      if (!source.copyOf) store.assignLaunched(id, r.cwd)
    },
    qaPickPaths: pickPaths,
    snapshotOf: id => fleet.current()?.sessions.find(s => s.sessionId === id),
    metaOf: id => store.get().sessions[id],
    terminalHost: pid => terminalHostOf(pid),
    launchedHere: id => store.get().sessions[id]?.origin === 'app',
    onRekeyed: id => store.clearUntrusted(id),
    // A resume keeps the session's saved --plugin-dir, so one on a stuck copy is refused (pass 6, H-1).
    modStuck: sessionModVerdict,
    // A copy a resume started: a stray until it leaves the list, and listed as a session, not hidden as a
    // background contractor (MIP2-1467).
    onResumedAsCopy: (from, short) =>
      void host.list().then(({ sessions }) => {
        const copy = sessions.find(s => s.shortId.value === short && s.sessionId !== from)
        if (!copy) return
        selfCheck.addStrays([copy.sessionId])
        store.setKind(copy.sessionId, 'session', null, Date.now())
        broadcast(IPC.appNotice, `Resuming started a copy (${short}) instead of the session itself. Check it in the session list.`)
      }),
    moveTarget: id => moveRequest(store.get().sessions[id], fleet.current()?.sessions.find(s => s.sessionId === id)?.cwd.value || undefined),
    onMoved: (from, to) => recordMoved(from, to),
    readOnly: () => {
      const r = fleet.current()?.selfCheck
      return r?.state === 'too-old' ? `Claude Code ${r.claudeVersion} is older than this app supports. Update Claude Code.` : null
    },
  })

  const seen = () => (fleet.current()?.sessions ?? []).map(s => ({ sessionId: s.sessionId, cwd: s.cwd.value }))
  const importFolder = resolveImportFolder(process.env, app.getPath('appData'))
  registerStore({ store, importFolder, sessions: seen })
  registerArtifacts(() => fleet.current())
  const arbiterKey = new ArbiterKey(join(app.getPath('userData'), 'arbiter-key.bin'), safeStorage)
  // The Arbiter (MIP2-1411): off until a key is saved; reruns only when the waiting set changes.
  const arbiterLog = new ArbiterLog(join(app.getPath('userData'), 'arbiter-log.jsonl'))
  const arbiter = new Arbiter({
    ask: createAsk(() => arbiterKey.get()),
    log: arbiterLog,
    capUsd: () => store.get().settings.arbiterCapUsd ?? 1,
    enabled: () => store.get().settings.arbiterEnabled !== false && arbiterKey.has(),
  })
  // Card summaries of the last turn (MIP2-1422): the Arbiter's key, cap and log, opted-in categories only.
  const cardText = {
    summarize: createSummarize(() => arbiterKey.get()),
    log: arbiterLog,
    capUsd: () => store.get().settings.arbiterCapUsd ?? 1,
    enabled: () => store.get().settings.arbiterEnabled !== false && arbiterKey.has(),
    optedIn: (id: string) => {
      const s = store.get()
      const cat = s.categories.find(c => c.id === s.sessions[id]?.categoryId)
      return cat?.arbiterReadsText === true
    },
  }
  summaries = new Summaries({ ...cardText, onChange: all => broadcast(IPC.summariesUpdate, all) })
  // The Needs-you line (MIP2-1485): the same key, cap, log and opt-in, written only when the poll finds a session blocked on Alex.
  // For categories not opted in, the turn's own last question, read here and never sent (MIP2-1485).
  const lastLines = new Map<string, TurnSummary>()
  const allWaits = () => ({ ...Object.fromEntries(lastLines), ...(waits?.current() ?? {}) })
  waits = new Summaries({ ...cardText, mode: 'wait', onChange: () => broadcast(IPC.waitsUpdate, allWaits()) })
  // The usage help panel's tips (MIP2-1498 §4.5): the Arbiter's key, cap and log; windows and session fields only.
  const usageTips = new UsageTips({ call: createTips(() => arbiterKey.get()), log: arbiterLog, capUsd: cardText.capUsd, enabled: cardText.enabled })
  ipcMain.handle(IPC.usageTips, (event, facts: unknown) => {
    if (!isTrustedSender(event)) return { ok: false, reason: 'error', error: 'untrusted sender' }
    const checked = checkTipFacts(facts)
    return checked ? usageTips.get(checked) : { ok: false, reason: 'error', error: 'bad request' }
  })
  // Spend (MIP2-1498 §5): simulated from each session's cost, real from the Console with a Console key.
  const adminKey = new ArbiterKey(join(app.getPath('userData'), 'admin-key.bin'), safeStorage, 'spend')
  const ledger = new SpendLedger(join(app.getPath('userData'), 'spend.json'))
  spendLedger = ledger
  const spendState = (): SpendState => ({
    source: store.get().settings.spendSource ?? (adminKey.has() ? 'real' : 'simulated'),
    simulated: ledger.current(Date.now()),
    real: realSpend.current(),
  })
  const sendSpend = () => broadcast(IPC.spendUpdate, spendState())
  const realSpend = new RealSpendPoller(() => adminKey.get(), fetch as unknown as Fetch, sendSpend)
  noteSpend = sessions => ledger.observe(sessions, Date.now()) && sendSpend()
  registerSpend({ state: spendState, real: realSpend, adminKey, setSource: s => store.setSpendSource(s), changed: sendSpend })
  void realSpend.poll()
  setInterval(() => void realSpend.poll(), REAL_POLL_MS).unref()
  ipcMain.handle(IPC.waitsGet, event => (isTrustedSender(event) ? allWaits() : {}))
  noteLastLines = (blocked: string[], live: ReadonlySet<string>) => {
    let changed = false
    for (const id of [...lastLines.keys()]) if (!live.has(id)) (lastLines.delete(id), (changed = true))
    for (const id of blocked) {
      if (cardText.optedIn(id)) continue
      const post = channels.lastAnswer(id)
      if (!post || lastLines.get(id)?.turnAt === post.at) continue
      const text = lastQuestion(post.text)
      if (text) (lastLines.set(id, { text, turnAt: post.at, lastLine: true }), (changed = true))
    }
    if (changed) broadcast(IPC.waitsUpdate, allWaits())
  }
  ipcMain.handle(IPC.summariesGet, event => (isTrustedSender(event) ? (summaries?.current() ?? {}) : {}))
  ipcMain.handle(IPC.arbiterGet, event => (isTrustedSender(event) ? arbiter.current() : null))
  ipcMain.handle(IPC.arbiterLog, event => (isTrustedSender(event) ? arbiterLog.entries(200) : []))
  registerSettings({ key: arbiterKey, selfCheck, watchdog: () => watchdog })
  // App updates (MIP2-1469): checked at start and every few hours; nothing downloads until Download.
  const updates = setUpUpdates(app.isPackaged, s => broadcast(IPC.updateUpdate, s), () => betaUpdatesOn(store.get().settings.betaUpdates, app.getVersion()))
  registerUpdates(updates)
  updates.start()
  registerFirstRun({
    store,
    key: arbiterKey,
    settingsFile: claudeSettings,
    importAvailable: () => registryPresent(importFolder),
  })
  store.subscribe(s => broadcast(IPC.storeUpdate, s))

  ipcMain.handle(IPC.fleetGet, event => {
    if (!isTrustedSender(event)) throw new Error('untrusted sender')
    return poller?.current() ?? null
  })

  // Notifications (MIP2-1412): Needs you and Your turn, never while the app is in front.
  const notifyMemory = newMemory()
  const notify = (sessions: Parameters<typeof decide>[1]['sessions'], listOk: boolean) => {
    const focused = BrowserWindow.getFocusedWindow() !== null
    for (const n of decide(notifyMemory, { sessions, store: store.get(), focused, now: Date.now(), listOk })) {
      if (!Notification.isSupported()) break
      const shown = new Notification({ title: n.title, subtitle: n.subtitle, body: n.body, silent: n.cls === 'turn' })
      shown.on('click', () => {
        const win = BrowserWindow.getAllWindows()[0] ?? createWindow()
        if (win.isMinimized()) win.restore()
        win.show()
        win.focus()
        // The startup summary opens Fleet on Needs you; the rest open their session.
        if (n.sessionId) broadcast(IPC.openSession, n.sessionId)
        else broadcast(IPC.openNeeds)
      })
      shown.show()
    }
  }
  /** The last name each session had, for the toast once it has left the list. */
  const lastNames = new Map<string, string>()
  poller.subscribe(snapshot => {
    // A control path the self-check failed is switched off; its sessions keep their dialog.
    channels.setControl(snapshot.selfCheck?.controlOff ?? [])
    // New sessions take a category by folder before the renderer sees them (spec MIP2-1370 §7).
    store.assignNew(seen())
    // The lifecycle (MIP2-1410): roll-off, removal, contractor links. A failed list removes nothing.
    const listOk = snapshot.sources.find(s => s.source === 'agents-json')?.ok === true
    const life = store.observe(snapshot.sessions, listOk, Date.now())
    for (const id of life.stop) void host.stop(id).catch(err => console.warn(`roll-off stop ${id.slice(0, 8)}: ${err}`))
    // Named as everywhere else: Claude Code's name, 0.24's, then the folder. Never an id.
    const displayName = (id: string, claudeName: string | null, cwd: string | undefined) => {
      const meta = store.get().sessions[id]
      return meta?.name || claudeName || (cwd ?? meta?.cwd)?.split('/').filter(Boolean).at(-1) || 'A session'
    }
    for (const id of life.removed) {
      broadcast(IPC.appNotice, `${lastNames.get(id) ?? displayName(id, null, undefined)} was removed outside the app. It won't be offered for resume.`)
    }
    for (const s of snapshot.sessions) lastNames.set(s.sessionId, displayName(s.sessionId, s.name.value, s.cwd.value))
    notify(snapshot.sessions, listOk)
    void arbiter.consider(waitingItems(snapshot.sessions, store.get())).then(s => s && broadcast(IPC.arbiterUpdate, s))
    if (listOk) summaries?.forget(new Set(snapshot.sessions.map(s => s.sessionId)))
    if (listOk) waits?.forget(new Set(snapshot.sessions.map(s => s.sessionId)))
    const blocked = snapshot.sessions.filter(blockedOnAlex).map(s => s.sessionId)
    for (const id of blocked) void waits?.wanted(id)
    // Each on its own, so one that throws can't stop the rest of this poll's work (gate pass 15, M-2).
    const guard = (what: string, fn: () => void) => {
      try {
        fn()
      } catch (err) {
        console.warn(`${what}: ${String(err)}`)
      }
    }
    if (listOk) guard('last lines', () => noteLastLines(blocked, new Set(snapshot.sessions.map(s => s.sessionId))))
    guard('spend ledger', () => noteSpend(snapshot.sessions))
    broadcast(IPC.fleetUpdate, snapshot)
  })
  poller.start()
  // QA runs log each channel's connections and requests, for the peer check's cost (MIP2-1435).
  if (debugPortAllowed(process.env, app.isPackaged)) {
    setInterval(() => {
      for (const h of channels.health()) if (h.stats) console.log(`channel stats ${h.sessionId?.slice(0, 8) ?? '?'} connections=${h.stats.connections} requests=${h.stats.requests}`)
    }, 15_000).unref()
  }

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
}

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  poller?.stop()
  spendLedger?.save()
  // The supervisor the watchdog started is detached and stays: sessions outlive the app.
  watchdog?.stop()
  // Ending each attach frees its supervisor spare; the sessions keep running.
  pool?.leaveAll()
  void hub?.closeAll()
})
