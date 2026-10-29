// The app's own records: categories, what it knows about each session, and
// its settings (MIP2-1409). Main keeps them in a JSON file in the app's data
// folder; the renderer reads them through window.ccc. Nothing here comes from
// Claude Code; imported values come from Electron CCCC's registry, read only.

import type { QuitReport, QuitSessions } from './quit.ts'

export type Isolation = 'none' | 'worktree'
export type NotifyOverride = 'auto' | 'on' | 'off'

export interface Category {
  id: string
  name: string
  /** A hex color from the category palette. */
  color: string
  /** The short label for chips and blocks, at most 8 characters; empty means the first word of the name. */
  label: string
  emoji: string
  sort: number
  /** Folders listed for auto-assign (spec MIP2-1370 §7). */
  folders: string[]
  /** Folders that must never match this category ("Not <category>"). */
  notFolders: string[]
  /** Where sessions edit (MIP2-1387 §3). */
  isolation: Isolation
  /** The Arbiter may read session text (D-016: imported categories yes, new ones no). */
  arbiterReadsText: boolean
  /** Notify me, per class (MIP2-1387 §3): `auto` follows Settings → Notifications; `on`/`off` override it. Absent is auto. */
  notifyNeeds?: NotifyOverride
  notifyTurn?: NotifyOverride
  collapsed: boolean
}

/** How a session got its category: by Alex's hand, by the 0.24 import, or by auto-assign. */
export type Placement = 'hand' | 'import' | 'auto'

export interface SessionMeta {
  categoryId: string | null
  placedBy: Placement | null
  /** Alex has opened the session since auto-assign placed it, so its chip drops `· auto`. */
  autoSeen?: boolean
  /** The session's folder when last seen, so placements still teach auto-assign after it leaves the fleet. */
  cwd?: string
  /** Its folder key (the repository root, spec §7), for learned folders. */
  folderKey?: string
  /** Two categories matched its folder equally: the card offers "Category? A · B" (§7). */
  tie?: string[]
  name?: string
  /** 0.24's mailbox handle (`ensureAlias`), minted from the name; kept for reference, never shown as the name. */
  alias?: string
  theme?: string
  /** Archived by hand (0.24's `archived_at` imports here), Unix milliseconds. */
  archivedAt?: number
  /** Rolled off to the archive (MIP2-1370 §4.1), Unix milliseconds. Cleared on resurrect. */
  rolledOffAt?: number
  /** Last activity the app saw itself: a turn starting, a resume, Alex opening or answering it. */
  activityAt?: number
  /** D-020: never assumed dead, never rolled off. */
  neverRollOff?: boolean
  /** Who started it, when the app knows: `app` from a launch here, `import` from 0.24's registry. */
  origin?: 'app' | 'import'
  /** When it moved in from CC Command Center 0.24 (MIP2-1425). */
  movedAt?: number
  /** The session that started this one, once a parent's mod reported it (MIP2-1392). Kept after the report rolls off. */
  parentId?: string
  /** A headless child that fit more than one parent: a contractor with no parent named (D-018). */
  headlessChild?: boolean
  /** Alex's correction: `Keep as my session` or `Treat as a contractor` (MIP2-1393 §3). */
  kindOverride?: 'session' | 'contractor'
  /** How the lifecycle step last classified it (MIP2-1393 §3), for after it leaves the list. */
  contractor?: boolean
  /** Listed by `claude agents --json --all` at least once. Leaving the list after that means `claude rm` (MIP2-1393 §4.5). */
  listed?: boolean
  /** Left `--all`: removed outside the app, never offered for resume. */
  removedAt?: number
  /** A parked 0.24 session Alex hid from the sidebar; still in the move sheet behind Show hidden (MIP2-1465). */
  parkedHidden?: boolean
  /** Why its channel stopped being trustworthy, until a resume from the app re-keys it: the app's copy of the channel folder's mark (pass 4, M-2). */
  untrusted?: string
  /** The settings it was launched with here, for Launch settings… and Start a session from this one (MIP2-1387 §2.3). */
  /** `mod`: the reporter mod version (its folder's hash) a packaged app launched it with (gate run 2, L-1). */
  /** What the app launched the session with; `cwd` and `name` are checked against Claude Code's saved options on every restart (gate pass 19). */
  launch?: { model?: string; effort?: string; mode?: string; isolation?: 'none' | 'worktree'; ultracode?: boolean; extraArgs?: string[]; mod?: string; cwd?: string; name?: string }
  /** Started as a copy of this session, with new settings: the card reads "copy of <name>". */
  copyOf?: string
  /** Started from this session (D-014): the card reads "from <name>". */
  fromSession?: string
  /** 0.24's launch settings for this session, kept for its one resume with them (MIP2-1387 §2.4). */
  resumeFlags?: { model?: string; context?: string; effort?: string; mode?: string }
}

export interface AppSettings {
  recentFolders: string[]
  lastFolder?: string
  lastModel?: string
  lastEffort?: string
  lastMode?: string
  terminalFont?: string
  terminalFontSize?: number
  showOutside: boolean
  /** Show sessions parked in 0.24 in the sidebar; on unless turned off (MIP2-1465). */
  showParked?: boolean
  /** Get beta updates (MIP2-1497). Unset: on in a beta build, off otherwise (shared/update-state.ts, betaUpdatesOn). */
  betaUpdates?: boolean
  /**
   * 0.24's `hideUnmanaged`, kept from the import but not applied: outside
   * sessions start shown, and the N4 move-in step offers it once Alex's
   * sessions are in (ruling on MIP2-1424).
   */
  importedHideUnmanaged?: boolean
  /** The move sheet asked about it once (MIP2-1425). */
  hideOutsideAsked?: boolean
  /** The master switch (spec MIP2-1387 §4.3). */
  notifyEnabled: boolean
  /** Needs you: approvals, questions, requests. Absent means on (D-016). */
  notifyNeedsYou?: boolean
  /** Your turn, which includes Finished. Absent means off (D-016). */
  notifyTurn?: boolean
  /** When the first run finished or was skipped through; absent shows it (MIP2-1412). */
  firstRunDoneAt?: number
  /** The Arbiter's daily cap in US dollars (spec MIP2-1370 §14 step 4), $1.00 by default. */
  arbiterCapUsd?: number
  arbiterEnabled?: boolean
  /** "Archive assumed-dead sessions after [7] days", 7–14 (§4.1). */
  rollOffDays?: number
  /** Sessions the open roll-off notice covers; empty when dismissed. It survives restarts. */
  rollOffNotice?: string[]
  /** Which spend the top bar shows (MIP2-1498 §5.2); absent is Real once a Console key is saved, else Simulated. */
  spendSource?: 'real' | 'simulated' | 'credits'
  /** Settings → General → "When the app quits" (MIP2-1528); absent is `ask`. */
  quitSessions?: QuitSessions
  /** The toast for a remembered close has shown once (§6); cleared when a close is remembered again. */
  quitClosedNoticed?: boolean
  /** The sidebar's width in px, SIDEBAR_WIDTH.min–max; absent is the default (MIP2-1495). */
  sidebarWidth?: number
  /** The switcher's pinned sessions, in Alex's order; kept from roll-off while pinned (MIP2-1494 §5.5). */
  switcherPins?: string[]
  /** The switcher's recent sessions, left to right, at most SWITCHER_RECENT_MAX (MIP2-1494 §5.3). */
  switcherRecent?: string[]
}

/** The sidebar's width limits and default, px (MIP2-1495). */
export const SIDEBAR_WIDTH = { min: 200, max: 480, default: 236 } as const

/** A width the sidebar can take: rounded and kept within SIDEBAR_WIDTH. */
export function clampSidebarWidth(px: number): number {
  return Number.isFinite(px) ? Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, Math.round(px))) : SIDEBAR_WIDTH.default
}

/** Recent sessions the switcher keeps (MIP2-1494 §5.3). */
export const SWITCHER_RECENT_MAX = 5
/** A bound on pins, so a bad write can't grow the store; the spec sets no cap. */
export const SWITCHER_PINS_MAX = 50

export interface AppStore {
  version: 1
  categories: Category[]
  sessions: Record<string, SessionMeta>
  settings: AppSettings
  /** When settings were imported from 0.24, Unix milliseconds. */
  importedAt: number | null
  /** Each channel's settings version, by channel id: kept here, outside the channel's folder (pass 7, M-1). */
  channelVersions?: Record<string, number>
  /** What the last quit closed and failed to, for the toast on the next launch (MIP2-1528); cleared once shown. */
  lastQuit?: QuitReport
}

export function emptyStore(): AppStore {
  return { version: 1, categories: [], sessions: {}, settings: { recentFolders: [], showOutside: true, notifyEnabled: true }, importedAt: null }
}

/** The ten category colors, unchanged from Electron (UX tokens). */
export const CATEGORY_COLORS = ['#e2b34a', '#4ac0e2', '#e2724a', '#9b6ff0', '#d14a9b', '#2fb8a0', '#e0625f', '#9bbf4a', '#6d7cf0', '#857c6c']

/** The colors a category can take: the palette without the gray Uncategorized uses (UX, MIP2-1409 review). */
export const PICKABLE_COLORS = CATEGORY_COLORS.filter(c => c !== '#857c6c')
