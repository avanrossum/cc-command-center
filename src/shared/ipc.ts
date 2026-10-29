// The bridge between the main process and the renderer. The renderer sees
// only `window.ccc`, typed here, and only contract types and plain values
// cross it. Main checks every message (src/main/control.ts).

import type { FleetSnapshot } from '@ccc/contract'
import type { ArbiterLogEntry, ArbiterState } from './arbiter-state.ts'
import type { TurnSummary } from './summaries.ts'
import type { AppStore, Category } from './store.ts'
import type { UpdateState } from './update-state.ts'
import type { TipFacts, TipsResult } from './usage.ts'
import type { SpendState } from './spend.ts'

export const IPC = {
  /** Renderer → main: the latest fleet snapshot, or null before the first poll. */
  fleetGet: 'fleet:get',
  /** Main → renderer: a new fleet snapshot. */
  fleetUpdate: 'fleet:update',

  launch: 'session:launch',
  startCopy: 'session:start-copy',
  moveIn: 'session:move-in',
  resume: 'session:resume',
  stop: 'session:stop',
  answer: 'session:answer',
  sendPrompt: 'session:send-prompt',
  chooseFolder: 'session:choose-folder',
  copyText: 'app:copy-text',
  openLink: 'app:open-link',
  copyLastOutput: 'session:copy-last-output',

  focusOpen: 'focus:open',
  focusInput: 'focus:input',
  focusResize: 'focus:resize',
  focusLeave: 'focus:leave',
  focusPaste: 'focus:paste',
  focusPickPaths: 'focus:pick-paths',
  /** Main → renderer: output of an attached view. */
  focusData: 'focus:data',
  /** Main → renderer: an attached view's process ended. */
  focusExit: 'focus:exit',

  trustStart: 'trust:start',
  trustInput: 'trust:input',
  trustResize: 'trust:resize',
  trustCancel: 'trust:cancel',
  /** Main → renderer: output of a trust-step run. */
  trustData: 'trust:data',
  /** Main → renderer: a trust-step run ended, with the new session's id or null. */
  trustDone: 'trust:done',

  /** The app's own records (src/shared/store.ts, MIP2-1409). */
  storeGet: 'store:get',
  /** Main → renderer: the store changed. */
  storeUpdate: 'store:update',
  storeImportAvailable: 'store:import-available',
  storeImport: 'store:import',
  storePlace: 'store:place',
  storeSetName: 'store:set-name',
  storeSetSwitcher: 'store:set-switcher',
  storeNotCategory: 'store:not-category',
  storeSeen: 'store:seen',
  storeGuess: 'store:guess',
  artifactPreview: 'artifact:preview',
  artifactOpen: 'artifact:open',
  artifactReveal: 'artifact:reveal',
  arbiterGet: 'arbiter:get',
  arbiterLog: 'arbiter:log',
  /** Main → renderer: the Arbiter's state changed. */
  arbiterUpdate: 'arbiter:update',
  summariesGet: 'summaries:get',
  /** Main → renderer: the card summaries changed (MIP2-1422). */
  summariesUpdate: 'summaries:update',
  waitsGet: 'waits:get',
  waitsUpdate: 'waits:update',
  usageTips: 'usage:tips',
  spendGet: 'spend:get',
  spendUpdate: 'spend:update',
  spendSource: 'spend:source',
  adminKeyStatus: 'spend:admin-key-status',
  adminKeyTest: 'spend:admin-key-test',
  adminKeySave: 'spend:admin-key-save',
  adminKeyRemove: 'spend:admin-key-remove',
  firstRunInfo: 'first-run:info',
  appStatus: 'settings:app-status',
  selfCheckAgain: 'settings:self-check-again',
  channelCheckAgain: 'settings:channel-check-again',
  arbiterKeyRemove: 'settings:arbiter-key-remove',
  firstRunRemoveMailbox: 'first-run:remove-mailbox',
  firstRunFinish: 'first-run:finish',
  arbiterSetKey: 'arbiter:set-key',
  /** Main → renderer: open this session in Focus (a notification was clicked). */
  openSession: 'app:open-session',
  /** Main → renderer: show Fleet filtered to Needs you (the startup summary was clicked). */
  openNeeds: 'app:open-needs',
  /** The app menu's Settings… item (MIP2-1459). */
  openSettings: 'app:open-settings',
  /** App updates (MIP2-1469). */
  updateGet: 'update:get',
  updateCheck: 'update:check',
  updateDownload: 'update:download',
  updateLater: 'update:later',
  updateRestart: 'update:restart',
  /** Main → renderer: the update state changed. */
  updateUpdate: 'update:update',
  /** Main → renderer: a one-line toast (a session removed outside the app). */
  appNotice: 'app:notice',
  startupNotices: 'app:startup-notices',
  lifeResurrect: 'life:resurrect',
  lifeArchive: 'life:archive',
  lifeNeverRollOff: 'life:never-roll-off',
  lifeSetKind: 'life:set-kind',
  /** Hide or show parked 0.24 sessions (MIP2-1465). */
  storeParkedHidden: 'store:parked-hidden',
  lifeDismissNotice: 'life:dismiss-notice',
  lifeRollOffDays: 'life:roll-off-days',
  settingsUpdate: 'settings:update',
  storeRememberLaunch: 'store:remember-launch',
  categorySave: 'category:save',
  categoryDelete: 'category:delete',
  categoryUndoDelete: 'category:undo-delete',
  categoryReorder: 'category:reorder',
} as const

export type Result<T = object> =
  | ({ ok: true } & T)
  | { ok: false; error: string; kind?: 'untrusted' | 'copy' | 'mod-stuck' | 'terminal'; variant?: 'trust' | 'home' | 'missing' }

export interface LaunchRequest {
  cwd: string
  name?: string
  model?: string
  effort?: string
  permissionMode?: string
  prompt?: string
  isolation?: 'none' | 'worktree'
  ultracode?: boolean
  /** Extra flags, already split (src/shared/flags.ts); main checks them again. */
  extraArgs?: string[]
  /** Started from this session (D-014). */
  fromSession?: string
  /** The trust step resumes this session instead of starting a new one: a parked 0.24 session (MIP2-1461). */
  resume?: string
}

/** What the first run needs to know (MIP2-1412). */
export interface FirstRunInfo {
  done: boolean
  /** The old mailbox's rules still in Claude Code's settings. */
  mailboxRules: string[]
  settingsFile: string
  importAvailable: boolean
  arbiterKeySet: boolean
}

/** First run step 2's checkboxes (spec MIP2-1370 §14), all on by default. */
export interface ImportParts {
  categories: boolean
  /** Session names, aliases, categories and saved launch settings. */
  sessions: boolean
  /** Launch defaults: last folder, model, effort, mode. */
  defaults: boolean
  /** Terminal font, notifications, recent folders. */
  prefs: boolean
}

/** What the import from 0.24 found, and auto-assign right after it. */
export interface ImportSummary {
  categories: number
  named: number
  categorized: number
  assigned: number
  uncategorized: number
}

export type AnswerRequest =
  | { verdict: 'allow'; answers?: Record<string, string> }
  | { verdict: 'deny' }

export interface CccApi {
  getFleet(): Promise<FleetSnapshot | null>
  /** Calls `listener` on each update; returns a function that stops it. */
  onFleet(listener: (snapshot: FleetSnapshot) => void): () => void

  launch(req: LaunchRequest): Promise<Result<{ sessionId: string }>>
  resume(sessionId: string): Promise<Result>
  /** Launch settings… and Resume with different settings: a copy under a new id (MIP2-1387 §2.3). `req.cwd` is ignored; the session's own folder is used. */
  startCopy(sessionId: string, req: LaunchRequest): Promise<Result<{ sessionId: string }>>
  /** Moves a session from CC Command Center 0.24 once its process there has exited (MIP2-1425). `sameId` false means it came back under a new id. */
  moveIn(sessionId: string): Promise<Result<{ sessionId: string; sameId: boolean }>>
  stop(sessionId: string): Promise<Result>
  answer(requestId: string, answer: AnswerRequest): Promise<Result>
  sendPrompt(sessionId: string, text: string): Promise<Result>
  /** The macOS open panel for a folder; null when canceled. */
  chooseFolder(): Promise<string | null>
  /** Writes text to the system clipboard. */
  copyText(text: string): void
  /** Opens a link clicked in a terminal view in the default browser: http and https only (MIP2-1471). `text` is an OSC 8 link's visible text, `atEdge` whether it touches the terminal's edge; main asks first when either hides where it goes. */
  openLink(url: string, text?: string, atEdge?: boolean): Promise<Result | { ok: false; error: string; canceled: true }>
  /** Copies the session's last turn's whole final text as Markdown; main writes the clipboard, so the text never reaches the window (D-014 parity item 9). */
  copyLastOutput(sessionId: string): Promise<Result>

  focusOpen(sessionId: string, cols: number, rows: number): Promise<Result>
  focusInput(sessionId: string, data: string): void
  focusResize(sessionId: string, cols: number, rows: number): void
  focusLeave(sessionId: string): void
  /** Bracketed paste into the attached view; `submit` presses Return after it. */
  focusPaste(sessionId: string, text: string, submit: boolean): void
  /** The open panel for files and folders, inserted as quoted paths. Resolves to how many. */
  focusPickPaths(sessionId: string): Promise<number>
  /** Quoted paths for files dropped on a view, inserted as one paste. */
  focusDropFiles(sessionId: string, files: File[]): void
  onFocusData(listener: (sessionId: string, data: string) => void): () => void
  onFocusExit(listener: (sessionId: string, code: number) => void): () => void

  /** The trust step (MIP2-1388): the same launch in a terminal view where Alex answers Claude Code's own trust question. */
  trustStart(req: LaunchRequest, cols: number, rows: number): Promise<Result<{ runId: string }>>
  trustInput(runId: string, data: string): void
  trustResize(runId: string, cols: number, rows: number): void
  trustCancel(runId: string): void
  onTrustData(listener: (runId: string, data: string) => void): () => void
  onTrustDone(listener: (runId: string, sessionId: string | null, error: string | null) => void): () => void

  getStore(): Promise<AppStore>
  onStore(listener: (store: AppStore) => void): () => void
  /** Whether Electron CCCC's registry is there to import from. */
  importAvailable(): Promise<boolean>
  /** Reads 0.24's registry through a private copy; never writes it. */
  importSettings(parts?: ImportParts): Promise<Result<{ summary: ImportSummary }>>
  /** A preview page for a file the session wrote: its URL for a sandboxed iframe, and which Open card it shows, if any. */
  artifactPreview(sessionId: string, path: string, raw?: boolean): Promise<Result<{ url: string; open: string | null }>>
  /** Shows a file the session wrote in the Finder. */
  artifactReveal(sessionId: string, path: string): Promise<Result>
  /** Opens a file the session wrote in its default app, or a published artifact's https link. */
  /** Opens a file the session wrote, or an https link. An unknown file type answers `confirm` first; `confirmed` opens it (gate M-3). */
  artifactOpen(sessionId: string, target: string, confirmed?: boolean): Promise<Result | { ok: false; error: string; confirm: string }>
  getArbiter(): Promise<ArbiterState | null>
  onArbiter(listener: (state: ArbiterState) => void): () => void
  /** One-line summaries of each opted-in session's last turn, by session id (MIP2-1422). */
  getSummaries(): Promise<Record<string, TurnSummary>>
  onSummaries(listener: (all: Record<string, TurnSummary>) => void): () => void
  /** What each waiting session waits on, for Needs-you cards in opted-in categories (MIP2-1485). */
  getWaits(): Promise<Record<string, TurnSummary>>
  onWaits(listener: (all: Record<string, TurnSummary>) => void): () => void
  /** The usage help panel's tips from the Arbiter, cached 10 minutes (MIP2-1498 §4.5). */
  usageTips(facts: TipFacts): Promise<TipsResult>
  /** Spend (MIP2-1498 §5): this month's simulated and real amounts, and which one shows. */
  getSpend(): Promise<SpendState | null>
  onSpend(listener: (s: SpendState) => void): () => void
  setSpendSource(source: 'real' | 'simulated'): Promise<Result>
  /** Null with no Console key; `end` is its last four characters. */
  adminKeyStatus(): Promise<{ end: string | null } | null>
  /** Tests a pasted key, or the saved one with no argument; the API's own message on failure. */
  testAdminKey(key?: string): Promise<Result>
  /** Stored encrypted like the Arbiter's; never read back by the window. */
  saveAdminKey(key: string): Promise<Result>
  removeAdminKey(): Promise<Result>
  /** The Arbiter log, newest last (D-014). */
  arbiterLog(): Promise<ArbiterLogEntry[]>
  firstRunInfo(): Promise<FirstRunInfo | null>
  /** Step 1: removes the old mailbox rules from Claude Code's settings, after a backup. Only on Alex's press. */
  removeMailboxRules(): Promise<Result<{ removed: string[]; backup: string | null }>>
  /** Stored encrypted; never read back by the window. */
  setArbiterKey(key: string): Promise<Result>
  appStatus(): Promise<AppStatus | null>
  /** Check again: the self-check forgets this version's results and observes afresh. */
  selfCheckAgain(): Promise<Result>
  /** Check again for the channel only: the deadline starts over, other results stand (MIP2-1488). */
  channelCheckAgain(): Promise<Result>
  removeArbiterKey(): Promise<Result>
  finishFirstRun(opts: { capUsd: number; arbiterEnabled: boolean }): Promise<Result>
  /** A placement by hand; null is Uncategorized. */
  place(sessionId: string, categoryId: string | null): Promise<Result>
  /** Rename…: the app's name for a session, over Claude Code's; empty clears it. */
  setName(sessionId: string, name: string): Promise<Result>
  /** The switcher's pins and recents, in order (MIP2-1494 §5.5). */
  setSwitcher(pins: string[], recent: string[]): Promise<Result>
  /** "Not <category>": Uncategorized, and the folder stops matching that category. */
  notCategory(sessionId: string): Promise<Result>
  /** Alex opened the session; an auto placement stops showing `· auto`. */
  markSeen(sessionId: string): Promise<Result>
  onNotice(listener: (text: string) => void): () => void
  /** Notices from the app's start, before the window could show them; each is returned once. */
  startupNotices(): Promise<string[]>
  onOpenSession(listener: (sessionId: string) => void): () => void
  onOpenNeeds(listener: () => void): () => void
  /** The app menu's Settings… (⌘,) was chosen (MIP2-1459). */
  onOpenSettings(listener: () => void): () => void
  /** Out of the archive, as Ended with its clock reset; `keep` also sets Never roll off. Resolves to how many. */
  resurrect(sessionIds: string[], keep?: boolean): Promise<Result<{ count: number }>>
  /** Archive by hand (MIP2-1370 §4.1). */
  archive(sessionId: string): Promise<Result>
  setNeverRollOff(sessionId: string, on: boolean): Promise<Result>
  /** Hides or shows parked 0.24 sessions in the sidebar; `all` with false shows every hidden one (MIP2-1465). */
  setParkedHidden(ids: string[] | 'all', hidden: boolean): Promise<Result<{ count: number }>>
  /** `Keep as my session`, or `Treat as a contractor` with a parent or none (MIP2-1393 §3). */
  setSessionKind(sessionId: string, kind: 'session' | 'contractor', parentId: string | null): Promise<Result>
  dismissRollOffNotice(): Promise<Result>
  setRollOffDays(days: number): Promise<Result>
  /** The settings sheet (MIP2-1407): notifications, roll-off days, Arbiter switch and cap. */
  updateSettings(patch: {
    notifyEnabled?: boolean
    notifyNeedsYou?: boolean
    notifyTurn?: boolean
    rollOffDays?: number
    arbiterEnabled?: boolean
    arbiterCapUsd?: number
    showOutside?: boolean
    showParked?: boolean
    hideOutsideAsked?: boolean
    terminalFont?: string
    terminalFontSize?: number
    betaUpdates?: boolean
    sidebarWidth?: number
  }): Promise<Result>
  /** The category auto-assign would give a session in this folder, and the folder it keys on. */
  guessCategory(cwd: string): Promise<{ categoryId: string | null; folderKey: string } | null>
  rememberLaunch(folder: string, values: { model?: string; effort?: string; mode?: string }): void
  saveCategory(category: Partial<Category>): Promise<Result<{ category: Category }>>
  deleteCategory(id: string): Promise<Result>
  /** Undo for the last delete, while its toast shows. */
  undoDeleteCategory(id: string): Promise<Result>
  reorderCategories(ids: string[]): Promise<Result>
  /** App updates (MIP2-1469): nothing downloads until Download is pressed. */
  getUpdate(): Promise<UpdateState | null>
  onUpdate(listener: (state: UpdateState) => void): () => void
  /** Check for updates, by hand. */
  checkForUpdate(): Promise<Result>
  downloadUpdate(): Promise<Result>
  updateLater(): Promise<Result>
  restartToUpdate(): Promise<Result>
}

/** The settings window's About, Claude Code and Arbiter key lines (MIP2-1424). */
export interface AppStatus {
  version: string
  /** Short git commit the bundle was built from, `-dirty` with uncommitted changes. */
  commit: string
  /** ISO date of the build. */
  builtAt: string
  electron: string
  chrome: string
  node: string
  /** The oldest Claude Code version this app supports (MIP2-1406). */
  floor: string
  /** The watchdog's state: `up`, `idle` (no supervisor needed), `restarting` or `unknown`. */
  supervisor: string
  restartsToday: number
  /** Null with no key; `end` is its last four characters, null if it can't be read. */
  arbiterKey: { end: string | null } | null
  /** The Arbiter's slot holds an Admin key saved before 1.0.1; it isn't used (gate pass 16, M-2). */
  arbiterKeyIsAdmin?: boolean
}

declare global {
  interface Window {
    ccc: CccApi
  }
}
