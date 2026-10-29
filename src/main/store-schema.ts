// Checks the app's own records when they're read from disk (gate L-3,
// MIP2-1431). store.json and self-check.json live in a folder anything
// running as Alex can write, so neither is trusted wholesale: each field is
// kept only with the right type and shape, the way validate.ts checks what
// the window sends. A category or session that fails its core fields is
// dropped; a bad optional field is dropped alone.

import { emptyStore, SIDEBAR_WIDTH, SWITCHER_PINS_MAX, SWITCHER_RECENT_MAX, type AppSettings, type AppStore, type Category, type SessionMeta } from '../shared/store.ts'
import { checkImportedSettings, FONT_NAME, isCategoryId, isSessionId } from './validate.ts'

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !v.includes('\0')
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const bool = (v: unknown): v is boolean => typeof v === 'boolean'
const absPath = (v: unknown): v is string => str(v, 4096) && v.startsWith('/')
const paths = (v: unknown, max = 64): string[] => (Array.isArray(v) ? v.filter(absPath).slice(0, max) : [])
const COLOR = /^#[0-9a-f]{6}$/i
const oneOf = <T extends string>(v: unknown, set: readonly T[]): v is T => typeof v === 'string' && (set as readonly string[]).includes(v)

function category(v: unknown): Category | null {
  if (!isObj(v) || !isCategoryId(v.id) || !str(v.name, 60) || !(typeof v.color === 'string' && COLOR.test(v.color))) return null
  return {
    id: v.id,
    name: v.name,
    color: v.color,
    label: str(v.label, 8) ? v.label : '',
    emoji: str(v.emoji, 8) ? v.emoji : '',
    sort: num(v.sort) ? v.sort : 0,
    folders: paths(v.folders),
    notFolders: paths(v.notFolders),
    isolation: oneOf(v.isolation, ['none', 'worktree'] as const) ? v.isolation : 'none',
    arbiterReadsText: v.arbiterReadsText === true,
    ...(oneOf(v.notifyNeeds, ['auto', 'on', 'off'] as const) ? { notifyNeeds: v.notifyNeeds } : {}),
    ...(oneOf(v.notifyTurn, ['auto', 'on', 'off'] as const) ? { notifyTurn: v.notifyTurn } : {}),
    collapsed: v.collapsed === true,
  }
}

const FLAGS = { model: 64, context: 16, effort: 16, mode: 32 } as const

function stringFields<K extends string>(v: unknown, limits: Record<K, number>): Partial<Record<K, string>> | undefined {
  if (!isObj(v)) return undefined
  const out: Partial<Record<K, string>> = {}
  for (const [k, max] of Object.entries(limits) as [K, number][]) if (str(v[k], max)) out[k] = v[k] as string
  return out
}

function session(v: unknown): SessionMeta | null {
  if (!isObj(v)) return null
  const categoryId = v.categoryId === null || isCategoryId(v.categoryId) ? (v.categoryId as string | null) : null
  const placedBy = oneOf(v.placedBy, ['hand', 'import', 'auto'] as const) ? v.placedBy : null
  const m: SessionMeta = { categoryId, placedBy: categoryId ? placedBy : null }
  for (const k of ['autoSeen', 'neverRollOff', 'headlessChild', 'contractor', 'listed', 'parkedHidden'] as const) if (bool(v[k])) m[k] = v[k]
  for (const k of ['archivedAt', 'rolledOffAt', 'activityAt', 'movedAt', 'removedAt'] as const) if (num(v[k])) m[k] = v[k]
  for (const k of ['cwd', 'folderKey'] as const) if (absPath(v[k])) m[k] = v[k]
  for (const [k, max] of [['name', 80], ['alias', 120], ['theme', 64], ['untrusted', 300]] as const) if (str(v[k], max)) m[k] = v[k]
  for (const k of ['parentId', 'copyOf', 'fromSession', 'launchSessionId'] as const) if (isSessionId(v[k])) m[k] = v[k]
  if (oneOf(v.origin, ['app', 'import'] as const)) m.origin = v.origin
  if (oneOf(v.kindOverride, ['session', 'contractor'] as const)) m.kindOverride = v.kindOverride
  if (Array.isArray(v.tie)) m.tie = v.tie.filter(isCategoryId).slice(0, 8)
  const rf = stringFields(v.resumeFlags, FLAGS)
  if (rf) m.resumeFlags = rf
  if (isObj(v.launch)) {
    const l = v.launch
    m.launch = {
      ...stringFields(l, { model: 64, effort: 16, mode: 32 }),
      ...(typeof l.mod === 'string' && /^[0-9a-f]{16}(-r\d{1,16})?$/.test(l.mod) ? { mod: l.mod } : {}),
      ...(oneOf(l.isolation, ['none', 'worktree'] as const) ? { isolation: l.isolation } : {}),
      ...(bool(l.ultracode) ? { ultracode: l.ultracode } : {}),
      ...(Array.isArray(l.extraArgs) && l.extraArgs.every(a => str(a, 1024)) ? { extraArgs: (l.extraArgs as string[]).slice(0, 32) } : {}),
      ...(typeof l.cwd === 'string' && l.cwd.startsWith('/') && l.cwd.length <= 4096 && !l.cwd.includes('\0') ? { cwd: l.cwd } : {}),
      ...(str(l.name, 1000) ? { name: l.name as string } : {}),
    }
  }
  return m
}

function settings(v: unknown): AppSettings {
  const base = emptyStore().settings
  if (!isObj(v)) return base
  const out: AppSettings = { ...base, recentFolders: paths(v.recentFolders, 8) }
  Object.assign(
    out,
    checkImportedSettings({
      ...(typeof v.lastFolder === 'string' ? { lastFolder: v.lastFolder } : {}),
      ...(typeof v.lastModel === 'string' ? { lastModel: v.lastModel } : {}),
      ...(typeof v.lastEffort === 'string' ? { lastEffort: v.lastEffort } : {}),
      ...(typeof v.lastMode === 'string' ? { lastMode: v.lastMode } : {}),
      ...(typeof v.terminalFont === 'string' && (v.terminalFont === '' || FONT_NAME.test(v.terminalFont)) ? { terminalFont: v.terminalFont } : {}),
      ...(num(v.terminalFontSize) ? { terminalFontSize: v.terminalFontSize } : {}),
    }),
  )
  for (const k of ['showOutside', 'notifyEnabled', 'showParked', 'betaUpdates'] as const) if (bool(v[k])) out[k] = v[k]
  for (const k of ['importedHideUnmanaged', 'hideOutsideAsked', 'notifyNeedsYou', 'notifyTurn', 'arbiterEnabled', 'quitClosedNoticed'] as const) if (bool(v[k])) out[k] = v[k]
  if (num(v.firstRunDoneAt)) out.firstRunDoneAt = v.firstRunDoneAt
  if (num(v.arbiterCapUsd) && v.arbiterCapUsd >= 0 && v.arbiterCapUsd <= 100) out.arbiterCapUsd = v.arbiterCapUsd
  if (Number.isInteger(v.rollOffDays) && (v.rollOffDays as number) >= 7 && (v.rollOffDays as number) <= 14) out.rollOffDays = v.rollOffDays as number
  if (Array.isArray(v.rollOffNotice)) out.rollOffNotice = v.rollOffNotice.filter(isSessionId).slice(0, 200)
  if (v.spendSource === 'real' || v.spendSource === 'simulated' || v.spendSource === 'credits') out.spendSource = v.spendSource
  if (v.quitSessions === 'ask' || v.quitSessions === 'close' || v.quitSessions === 'keep') out.quitSessions = v.quitSessions
  if (Number.isInteger(v.sidebarWidth) && (v.sidebarWidth as number) >= SIDEBAR_WIDTH.min && (v.sidebarWidth as number) <= SIDEBAR_WIDTH.max) out.sidebarWidth = v.sidebarWidth as number
  if (Array.isArray(v.switcherPins)) out.switcherPins = [...new Set(v.switcherPins.filter(isSessionId))].slice(0, SWITCHER_PINS_MAX)
  if (Array.isArray(v.switcherRecent)) out.switcherRecent = [...new Set(v.switcherRecent.filter(isSessionId))].filter(id => !out.switcherPins?.includes(id)).slice(-SWITCHER_RECENT_MAX)
  return out
}

/** `base`, or `base` plus a letter or digit, not already in `taken`; always a valid category id (MIP2-1433). */
export function uniqueCategoryId(base: string, taken: ReadonlySet<string>): string {
  const stem = base.slice(0, 14)
  if (!taken.has(stem) && isCategoryId(stem)) return stem
  for (let k = 2; k < 36 * 36; k++) {
    const id = `${stem}${k.toString(36)}`
    if (!taken.has(id) && isCategoryId(id)) return id
  }
  throw new Error('no category id left')
}

/**
 * Renames category ids made with the old "-<n>" collision suffix to valid
 * ones, and moves every session's link with them (MIP2-1433). Done before
 * the check below, which would otherwise drop those categories.
 */
function repairCategoryIds(raw: Obj): void {
  if (!Array.isArray(raw.categories)) return
  const taken = new Set(raw.categories.filter(isObj).map(c => c.id).filter((id): id is string => typeof id === 'string'))
  const renamed = new Map<string, string>()
  for (const c of raw.categories) {
    if (!isObj(c) || typeof c.id !== 'string' || isCategoryId(c.id)) continue
    const m = /^([a-z][a-z0-9]{0,15})-(\d{1,3})$/.exec(c.id)
    if (!m) continue
    const id = uniqueCategoryId(`${m[1]!}${m[2]!}`, taken)
    taken.add(id)
    renamed.set(c.id, id)
    c.id = id
  }
  if (!renamed.size || !isObj(raw.sessions)) return
  for (const s of Object.values(raw.sessions)) {
    if (!isObj(s)) continue
    if (typeof s.categoryId === 'string' && renamed.has(s.categoryId)) s.categoryId = renamed.get(s.categoryId)
    if (Array.isArray(s.tie)) s.tie = s.tie.map(t => (typeof t === 'string' ? (renamed.get(t) ?? t) : t))
  }
}

/** The store as read from disk, every field checked; the empty store for anything that isn't version 1. */
export function checkStore(raw: unknown): AppStore {
  const empty = emptyStore()
  if (!isObj(raw) || raw.version !== 1) return empty
  repairCategoryIds(raw)
  const categories = (Array.isArray(raw.categories) ? raw.categories : []).map(category).filter((c): c is Category => c !== null)
  const sessions: Record<string, SessionMeta> = {}
  if (isObj(raw.sessions)) {
    for (const [id, v] of Object.entries(raw.sessions)) {
      const m = isSessionId(id) ? session(v) : null
      if (m) sessions[id] = m
    }
  }
  const channelVersions: Record<string, number> = {}
  if (isObj(raw.channelVersions)) {
    for (const [id, v] of Object.entries(raw.channelVersions)) if (/^[0-9a-f]{8}$/.test(id) && Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 99) channelVersions[id] = v as number
  }
  const q = isObj(raw.lastQuit) ? raw.lastQuit : null
  const lastQuit =
    q && Number.isInteger(q.closed) && (q.closed as number) >= 0 && bool(q.silent) && Array.isArray(q.failed)
      ? { closed: Math.min(q.closed as number, 1000), silent: q.silent as boolean, failed: q.failed.filter(n => str(n, 200)).slice(0, 50) as string[] }
      : null
  return { version: 1, categories, sessions, settings: settings(raw.settings), importedAt: num(raw.importedAt) ? raw.importedAt : null, ...(Object.keys(channelVersions).length ? { channelVersions } : {}), ...(lastQuit ? { lastQuit } : {}) }
}

/** self-check.json as read from disk: per version, each check's state, detail and rule (gate L-3). */
export function checkSelfCheckFile(raw: unknown): Record<string, Record<string, { state: 'pass' | 'fail'; detail: string | null; rule?: number }>> {
  const out: Record<string, Record<string, { state: 'pass' | 'fail'; detail: string | null; rule?: number }>> = {}
  if (!isObj(raw)) return out
  for (const [version, checks] of Object.entries(raw)) {
    if (!/^\d+\.\d+\.\d+$/.test(version) || !isObj(checks)) continue
    const kept: (typeof out)[string] = {}
    for (const [id, c] of Object.entries(checks)) {
      if (!str(id, 64) || !isObj(c) || !oneOf(c.state, ['pass', 'fail'] as const)) continue
      kept[id] = { state: c.state, detail: str(c.detail, 500) ? c.detail : null, ...(Number.isInteger(c.rule) ? { rule: c.rule as number } : {}) }
    }
    out[version] = kept
  }
  return out
}
