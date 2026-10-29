// The app's own records in its data folder (src/shared/store.ts), and the
// operations on them: the 0.24 import, auto-assign for new sessions (spec
// MIP2-1370 §7), placement by hand, and the category editor's changes.

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { SessionSnapshot } from '@ccc/contract'
import { autoAssign, folderKeyOf } from '../shared/auto-assign.ts'
import { AMBIGUOUS, classify, inArchive, lastActivityOf, lifeOf, parentsOf } from '../shared/lifecycle.ts'
import type { ImportParts, ImportSummary } from '../shared/ipc.ts'
import { emptyStore, PICKABLE_COLORS, type AppStore, type Category, type SessionMeta } from '../shared/store.ts'
import type { QuitReport } from '../shared/quit.ts'
import { importRegistry } from './registry-import.ts'
import { checkStore, uniqueCategoryId } from './store-schema.ts'
import { checkImportedSettings } from './validate.ts'

/** The longest session name Rename keeps. */
export const NAME_CHARS = 80

/** What the store needs from a fleet session. */
export interface SeenSession {
  sessionId: string
  cwd: string | null
}

/** A repository's root holds .git: a folder, or a file in a worktree or submodule. */
const isRepoRoot = (dir: string) => existsSync(join(dir, '.git'))

/** First run step 2's checkboxes (spec MIP2-1370 §14), all on by default. */
export const ALL_PARTS: ImportParts = { categories: true, sessions: true, defaults: true, prefs: true }

export class AppStoreService {
  private data: AppStore
  private readonly keyCache = new Map<string, string>()
  private readonly listeners = new Set<(s: AppStore) => void>()
  /** The category deleted last and how its sessions were placed, for Undo (MIP2-1387 §3). */
  private deleted: { category: Category; members: Record<string, SessionMeta['placedBy']> } | null = null

  constructor(
    private readonly path: string,
    private readonly home: string = homedir(),
    private readonly repoRoot: (dir: string) => boolean = isRepoRoot,
  ) {
    this.data = this.load()
  }

  get(): AppStore {
    return this.data
  }

  subscribe(fn: (s: AppStore) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** Imports 0.24's registry, read only (MIP2-1409), then auto-assigns what's still uncategorized. */
  importFrom(registryFolder: string, sessions: SeenSession[], parts: ImportParts = ALL_PARTS): ImportSummary {
    const r = importRegistry(registryFolder)
    const d = this.data
    if (parts.categories) {
      for (const { oldId: _oldId, ...category } of r.categories) {
        if (!d.categories.some(c => c.id === category.id)) d.categories.push({ ...category, sort: d.categories.length })
      }
    }
    // A session placed in a category that wasn't brought over stays Uncategorized.
    const known = new Set(d.categories.map(c => c.id))
    for (const [id, { cwd, oldCategoryId: _old, ...imported }] of parts.sessions ? Object.entries(r.sessions) : []) {
      const meta = imported.categoryId && !known.has(imported.categoryId) ? { ...imported, categoryId: null, placedBy: null } : imported
      const mine = d.sessions[id]
      // 0.24 knew it, so it's Alex's session, not a contractor (MIP2-1393 §3); a launch here stays `app`.
      const next = { ...mine, ...meta, ...(cwd ? { cwd } : {}), origin: mine?.origin ?? ('import' as const) }
      // A placement Alex made in this app wins over 0.24's.
      if (mine?.placedBy === 'hand') Object.assign(next, { categoryId: mine.categoryId, placedBy: 'hand' })
      d.sessions[id] = next
    }
    // Checked like values typed here; a bad one is dropped (gate L-2).
    const { recentFolders, lastFolder, lastModel, lastEffort, lastMode, terminalFont, terminalFontSize, importedHideUnmanaged, notifyEnabled } = checkImportedSettings(r.settings)
    const pick = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>
    if (parts.defaults) d.settings = { ...d.settings, ...pick({ lastFolder, lastModel, lastEffort, lastMode }) }
    if (parts.prefs) {
      d.settings = { ...d.settings, ...pick({ terminalFont, terminalFontSize, importedHideUnmanaged, notifyEnabled }) }
      if (recentFolders?.length) d.settings.recentFolders = recentFolders
    }
    d.importedAt = Date.now()
    const uncategorized = sessions.filter(s => !d.sessions[s.sessionId]?.categoryId).length
    const assigned = this.assign(sessions, true)
    this.save()
    return { categories: r.counts.categories, named: r.counts.named, categorized: r.counts.categorized, assigned, uncategorized }
  }

  /**
   * Gives sessions seen for the first time a category by the §7 rule and
   * saves when anything changed. Never touches a placement by hand.
   */
  assignNew(sessions: SeenSession[]): number {
    const before = JSON.stringify(this.data.sessions)
    const n = this.assign(sessions, false)
    if (JSON.stringify(this.data.sessions) !== before) this.save()
    return n
  }

  /**
   * The lifecycle step, once per poll (MIP2-1410):
   * - records listing, parent links and activity the app sees;
   * - marks sessions that left `--all` as removed (`listOk` only, so a failed poll removes nothing);
   * - rolls off what lifeOf says.
   * Returns the sessions main should stop (rolled off with a process, and
   * launched here as background sessions), and Alex's sessions just
   * removed outside the app, for a one-time toast.
   */
  observe(sessions: readonly SessionSnapshot[], listOk: boolean, now: number): { stop: string[]; removed: string[] } {
    const d = this.data
    const rollOffDays = d.settings.rollOffDays ?? 7
    const parents = parentsOf(sessions)
    const listed = new Set(sessions.map(s => s.sessionId))
    const stop: string[] = []
    const removed: string[] = []
    let changed = false
    const meta = (id: string) => (d.sessions[id] ??= { categoryId: null, placedBy: null })

    for (const s of sessions) {
      const m = meta(s.sessionId)
      // The first sighting counts as activity. A session without the mod
      // shows only its start time, and on first run every one started more
      // than 8 days ago would roll off at once, used yesterday or not.
      if (!m.listed) ((m.listed = true), (m.activityAt = Math.max(m.activityAt ?? 0, now)), (changed = true))
      if (s.cwd.value && (m.cwd !== s.cwd.value || !m.folderKey)) ((m.cwd = s.cwd.value), (m.folderKey = this.folderKey(s.cwd.value)), (changed = true))
      if (m.removedAt) (delete m.removedAt, (changed = true))
      const parent = (s.shortId.value ? parents.get(s.shortId.value) : undefined) ?? parents.get(s.sessionId)
      if (parent && parent !== s.sessionId && m.parentId !== parent) ((m.parentId = parent), (changed = true))
      if (parent === AMBIGUOUS && !m.headlessChild) ((m.headlessChild = true), (changed = true))
      // Remembered for when it leaves the list: a removed contractor goes silently.
      const contractor = classify(s, m, parents).kind === 'contractor'
      if (m.contractor !== contractor) ((m.contractor = contractor), (changed = true))
      // A turn running is activity; recorded at most every 5 minutes.
      if ((s.activity.value === 'working' || s.turn?.value.running) && now - (m.activityAt ?? 0) > 5 * 60_000) ((m.activityAt = now), (changed = true))
    }

    if (listOk) {
      for (const [id, m] of Object.entries(d.sessions)) {
        if (!m.listed || m.removedAt || listed.has(id)) continue
        m.removedAt = now
        changed = true
        // One toast for Alex's own: launched here, from 0.24, or kept by hand. Not for anything that came and went unseen.
        if (!m.contractor && !inArchive(m) && (m.origin || m.kindOverride === 'session')) removed.push(id)
      }
    }

    const gone = (id: string | null) => {
      const p = id ? d.sessions[id] : undefined
      return Boolean(p && (inArchive(p) || p.removedAt))
    }
    for (const s of sessions) {
      const m = meta(s.sessionId)
      if (inArchive(m)) continue
      const cls = classify(s, m, parents)
      const contractor = cls.kind === 'contractor'
      const life = lifeOf({
        lastActivityAt: lastActivityOf(s, m),
        needsYou: s.needsYou.value !== null,
        // A pin keeps a session from roll-off while it's pinned (MIP2-1494 §5.3).
        neverRollOff: m.neverRollOff === true || (d.settings.switcherPins ?? []).includes(s.sessionId),
        contractor,
        parentGone: contractor && gone(cls.parentId),
        rollOffDays,
        now,
      })
      if (life.stage !== 'rolled') continue
      m.rolledOffAt = now
      changed = true
      // Contractor turnover never makes a notice (MIP2-1393 §5).
      if (!contractor) d.settings.rollOffNotice = [...new Set([...(d.settings.rollOffNotice ?? []), s.sessionId])]
      if (s.pid.value !== null && s.kind.value === 'background' && m.origin === 'app') stop.push(s.sessionId)
    }
    if (changed) this.save()
    return { stop, removed }
  }

  /**
   * A launch here: its settings, and where it came from. A copy or a session
   * started from another takes that session's category, placed by hand
   * since Alex chose the source.
   */
  recordLaunch(sessionId: string, launch: NonNullable<SessionMeta['launch']>, source: { copyOf?: string; fromSession?: string } = {}, now: number = Date.now()): void {
    const m = (this.data.sessions[sessionId] ??= { categoryId: null, placedBy: null })
    Object.assign(m, { launch, origin: 'app', activityAt: now }, source)
    const from = source.copyOf ?? source.fromSession
    const src = from ? this.data.sessions[from] : undefined
    if (src?.categoryId && !m.categoryId) Object.assign(m, { categoryId: src.categoryId, placedBy: 'hand' })
    this.save()
  }

  /** The mod copy a session's saved options name, once the app checked it (MIP2-1504). */
  recordMod(sessionId: string, mod: string): void {
    const m = this.data.sessions[sessionId]
    if (!m) return
    m.launch = { ...(m.launch ?? {}), mod }
    this.save()
  }

  /**
   * A session moved in from 0.24 (MIP2-1425): now the app's, in its imported
   * category. Under a different id, the new session takes the old one's
   * category and is marked a copy; the old one stays as it was.
   */
  recordMove(from: string, to: string, launch: NonNullable<SessionMeta['launch']>, now: number = Date.now()): void {
    if (from === to) {
      const m = (this.data.sessions[from] ??= { categoryId: null, placedBy: null })
      Object.assign(m, { launch, origin: 'app', movedAt: now, activityAt: now })
      this.save()
      return
    }
    this.recordLaunch(to, launch, { copyOf: from }, now)
  }

  /**
   * A session the app just launched in `cwd`, with no category picked
   * (Auto): auto-assign it now, or offer the tie, as the poll would for a
   * session it saw first (MIP2-1432). The launch records the session before
   * the poll lists it, and the poll assigns only sessions it hasn't seen.
   */
  assignLaunched(sessionId: string, cwd: string): void {
    const m = this.data.sessions[sessionId]
    if (m?.categoryId || m?.placedBy === 'hand') return
    this.assign([{ sessionId, cwd }], true)
    this.save()
  }

  /** Each channel's settings version, for the hub (pass 7, M-1). */
  channelVersions(): { get(id: string): number | undefined; set(id: string, v: number): void; delete(id: string): void } {
    return {
      get: id => this.data.channelVersions?.[id],
      set: (id, v) => {
        if (this.data.channelVersions?.[id] === v) return
        this.data.channelVersions = { ...this.data.channelVersions, [id]: v }
        this.save()
      },
      delete: id => {
        if (this.data.channelVersions?.[id] === undefined) return
        const { [id]: _, ...rest } = this.data.channelVersions!
        this.data.channelVersions = rest
        this.save()
      },
    }
  }

  /**
   * A /clear gave a session a new id under the same job (MIP2-1557): its
   * record moves to the new id, keeping the id it was launched under, and
   * every list that names it follows. Nothing is lost or left behind under
   * the old id.
   */
  renameSession(from: string, to: string): void {
    const old = this.data.sessions[from]
    if (!old || from === to) return
    const { tie: _tie, ...meta } = old
    this.data.sessions[to] = { ...(this.data.sessions[to] ?? {}), ...meta, launchSessionId: old.launchSessionId ?? from }
    delete this.data.sessions[from]
    for (const m of Object.values(this.data.sessions)) {
      if (m.copyOf === from) m.copyOf = to
      if (m.fromSession === from) m.fromSession = to
    }
    const s = this.data.settings
    const swap = (list: string[] | undefined) => list?.map(id => (id === from ? to : id))
    s.rollOffNotice = swap(s.rollOffNotice)
    s.switcherPins = swap(s.switcherPins)
    s.switcherRecent = swap(s.switcherRecent)
    this.save()
  }

  /** Each session's id and the one it was launched under, where a /clear changed it (MIP2-1557). */
  launchIds(): [current: string, launch: string][] {
    return Object.entries(this.data.sessions).flatMap(([id, m]) => (m.launchSessionId ? [[id, m.launchSessionId] as [string, string]] : []))
  }

  /** A session whose channel stopped being trustworthy, recorded outside the channel's folder (pass 4, M-2). */
  markUntrusted(sessionId: string, why: string): void {
    const m = (this.data.sessions[sessionId] ??= { categoryId: null, placedBy: null })
    if (m.untrusted) return
    m.untrusted = why.slice(0, 300)
    this.save()
  }

  /** Its channel was re-keyed by a resume from the app. */
  clearUntrusted(sessionId: string): void {
    const m = this.data.sessions[sessionId]
    if (!m?.untrusted) return
    delete m.untrusted
    this.save()
  }

  /** Every session the app recorded as untrusted, with why. */
  untrustedMarks(): [string, string][] {
    return Object.entries(this.data.sessions).flatMap(([id, m]) => (m.untrusted ? [[id, m.untrusted] as [string, string]] : []))
  }

  /** Activity the app saw itself: launch, resume, Alex opening or answering it (§4.1). */
  touch(sessionId: string, now: number, origin?: 'app'): void {
    const m = (this.data.sessions[sessionId] ??= { categoryId: null, placedBy: null })
    m.activityAt = now
    if (origin) m.origin = origin
    this.save()
  }

  /** Back from the archive, as Ended with its clock reset (§4.1). `keep` also sets never roll off. */
  resurrect(ids: readonly string[], now: number, keep = false): number {
    let n = 0
    for (const id of ids) {
      const m = this.data.sessions[id]
      if (!m || !inArchive(m)) continue
      delete m.rolledOffAt
      delete m.archivedAt
      m.activityAt = now
      if (keep) m.neverRollOff = true
      // Its category may be gone: then Uncategorized.
      if (m.categoryId && !this.data.categories.some(c => c.id === m.categoryId)) Object.assign(m, { categoryId: null, placedBy: null })
      n += 1
    }
    this.data.settings.rollOffNotice = (this.data.settings.rollOffNotice ?? []).filter(id => !ids.includes(id))
    if (n) this.save()
    return n
  }

  archive(sessionId: string, now: number): void {
    const m = (this.data.sessions[sessionId] ??= { categoryId: null, placedBy: null })
    m.archivedAt = now
    // Archiving unpins and leaves the switcher; the renderer's Undo pins it again (MIP2-1494 §5.3).
    const s = this.data.settings
    if (s.switcherPins?.includes(sessionId)) s.switcherPins = s.switcherPins.filter(x => x !== sessionId)
    if (s.switcherRecent?.includes(sessionId)) s.switcherRecent = s.switcherRecent.filter(x => x !== sessionId)
    this.save()
  }

  /** Which spend the top bar shows (MIP2-1498 §5.2). */
  setSpendSource(source: 'real' | 'simulated' | 'credits'): void {
    this.data.settings.spendSource = source
    this.save()
  }

  /**
   * The switcher's pins and recents (MIP2-1494 §5.5), each already checked
   * (store-control.ts). A session that leaves the pins counts as active now,
   * as clearing Never roll off does, so it doesn't roll off at once.
   */
  setSwitcher(pins: string[], recent: string[], now: number): void {
    const s = this.data.settings
    for (const id of s.switcherPins ?? []) {
      const m = this.data.sessions[id]
      if (m && !pins.includes(id)) m.activityAt = now
    }
    s.switcherPins = pins
    s.switcherRecent = recent.filter(id => !pins.includes(id))
    this.save()
  }

  /** `Never roll off` (D-020). Clearing it counts as activity, so nothing disappears at once. */
  setNeverRollOff(sessionId: string, on: boolean, now: number): void {
    const m = (this.data.sessions[sessionId] ??= { categoryId: null, placedBy: null })
    if (on) m.neverRollOff = true
    else ((m.neverRollOff = false), (m.activityAt = now))
    this.save()
  }

  /**
   * Hides or shows parked 0.24 sessions in the sidebar (MIP2-1465): the
   * app's own metadata, never 0.24's registry. `all` with `hidden` false
   * shows every hidden one again. Returns how many changed.
   */
  setParkedHidden(ids: readonly string[] | 'all', hidden: boolean): number {
    let n = 0
    const targets = ids === 'all' ? Object.keys(this.data.sessions) : ids
    for (const id of targets) {
      const m = this.data.sessions[id]
      if (!m || m.origin !== 'import' || !!m.parkedHidden === hidden) continue
      if (hidden) m.parkedHidden = true
      else delete m.parkedHidden
      n += 1
    }
    if (n) this.save()
    return n
  }

  /** `Keep as my session` or `Treat as a contractor` (MIP2-1393 §3); parentId only with contractor. */
  setKind(sessionId: string, kind: 'session' | 'contractor', parentId: string | null, now: number): void {
    const m = (this.data.sessions[sessionId] ??= { categoryId: null, placedBy: null })
    m.kindOverride = kind
    if (kind === 'contractor') {
      if (parentId) m.parentId = parentId
      else delete m.parentId
    }
    // Becoming a session starts its clock now, as a resume would.
    m.activityAt = now
    this.save()
  }

  finishFirstRun(values: { arbiterCapUsd: number; arbiterEnabled: boolean }): void {
    Object.assign(this.data.settings, values, { firstRunDoneAt: Date.now() })
    this.save()
  }

  /** The settings sheet's switches, each already checked (validate.ts checkSettings). */
  updateSettings(
    patch: Partial<Pick<AppStore['settings'], 'notifyEnabled' | 'notifyNeedsYou' | 'notifyTurn' | 'rollOffDays' | 'arbiterEnabled' | 'arbiterCapUsd' | 'showOutside' | 'hideOutsideAsked' | 'terminalFont' | 'terminalFontSize' | 'betaUpdates' | 'sidebarWidth' | 'quitSessions' | 'quitClosedNoticed'>>,
  ): void {
    Object.assign(this.data.settings, patch)
    this.save()
  }

  /** What the quit did, written as the app quits, for the next launch's toast (MIP2-1528). */
  setLastQuit(r: QuitReport): void {
    this.data.lastQuit = r
    this.save()
  }

  /** The last quit's report, once: it's cleared as it's read. */
  takeLastQuit(): QuitReport | null {
    const r = this.data.lastQuit ?? null
    if (r) {
      delete this.data.lastQuit
      this.save()
    }
    return r
  }

  dismissRollOffNotice(): void {
    this.data.settings.rollOffNotice = []
    this.save()
  }

  setRollOffDays(days: number): void {
    this.data.settings.rollOffDays = Math.min(14, Math.max(7, Math.round(days)))
    this.save()
  }

  /** Alex placed a session by hand (drag, the chip menu, the sheet, the tie offer). */
  place(sessionId: string, categoryId: string | null): void {
    if (categoryId !== null && !this.data.categories.some(c => c.id === categoryId)) throw new Error('no such category')
    const { tie: _tie, ...meta } = this.data.sessions[sessionId] ?? { categoryId: null, placedBy: null }
    this.data.sessions[sessionId] = { ...meta, categoryId, placedBy: 'hand' }
    this.save()
  }

  /** Rename…: Alex's name for a session, shown over Claude Code's, as in 0.24. Empty clears it. */
  setName(sessionId: string, name: string): void {
    const meta = (this.data.sessions[sessionId] ??= { categoryId: null, placedBy: null })
    const clean = name.replace(/\s+/g, ' ').trim().slice(0, NAME_CHARS)
    if (clean) meta.name = clean
    else delete meta.name
    this.save()
  }

  /**
   * Alex opened or answered a session: activity for the lifecycle (§4.1),
   * and an auto placement drops its `· auto`.
   */
  markSeen(sessionId: string, now: number = Date.now()): void {
    const meta = (this.data.sessions[sessionId] ??= { categoryId: null, placedBy: null })
    if (meta.placedBy === 'auto') meta.autoSeen = true
    meta.activityAt = now
    this.save()
  }

  /** "Not <category>": back to Uncategorized, and the session's folder never matches that category again. */
  notCategory(sessionId: string): void {
    const meta = this.data.sessions[sessionId]
    const cat = this.data.categories.find(c => c.id === meta?.categoryId)
    if (!meta || !cat) return
    if (meta.cwd) cat.notFolders = [...new Set([...cat.notFolders, this.folderKey(meta.cwd)])]
    this.data.sessions[sessionId] = { ...meta, categoryId: null, placedBy: 'hand' }
    this.save()
  }

  saveCategory(input: Partial<Category>): Category {
    const d = this.data
    const old = input.id ? d.categories.find(c => c.id === input.id) : undefined
    if (input.id && !old) throw new Error('no such category')
    const paths = (v: unknown) => (Array.isArray(v) ? v.filter((f): f is string => typeof f === 'string' && f.startsWith('/')) : undefined)
    const next: Category = {
      id: old?.id ?? this.newCategoryId(),
      name: (input.name?.trim() || old?.name || 'New category').slice(0, 60),
      color: /^#[0-9a-f]{6}$/i.test(input.color ?? '') ? input.color! : (old?.color ?? PICKABLE_COLORS[d.categories.length % PICKABLE_COLORS.length]!),
      label: (input.label ?? old?.label ?? '').slice(0, 8),
      emoji: (input.emoji ?? old?.emoji ?? '').slice(0, 8),
      sort: old?.sort ?? d.categories.length,
      folders: paths(input.folders) ?? old?.folders ?? [],
      notFolders: paths(input.notFolders) ?? old?.notFolders ?? [],
      isolation: input.isolation === 'worktree' || input.isolation === 'none' ? input.isolation : (old?.isolation ?? 'none'),
      // D-016: a new category starts with session text withheld from the Arbiter.
      arbiterReadsText: typeof input.arbiterReadsText === 'boolean' ? input.arbiterReadsText : (old?.arbiterReadsText ?? false),
      notifyNeeds: input.notifyNeeds ?? old?.notifyNeeds ?? 'auto',
      notifyTurn: input.notifyTurn ?? old?.notifyTurn ?? 'auto',
      collapsed: typeof input.collapsed === 'boolean' ? input.collapsed : (old?.collapsed ?? false),
    }
    d.categories = old ? d.categories.map(c => (c.id === next.id ? next : c)) : [...d.categories, next]
    this.save()
    return next
  }

  /**
   * Time-based, with a letter or digit added when two are made in the same
   * millisecond. Every id fits validate.ts's CATEGORY_ID (MIP2-1433: the
   * earlier "-2" suffix didn't, and every category call refused it).
   */
  private newCategoryId(): string {
    return uniqueCategoryId(`n${Date.now().toString(36)}`, new Set(this.data.categories.map(c => c.id)))
  }

  deleteCategory(id: string): void {
    const d = this.data
    const category = d.categories.find(c => c.id === id)
    if (category) {
      const members = Object.entries(d.sessions).filter(([, m]) => m.categoryId === id)
      this.deleted = { category, members: Object.fromEntries(members.map(([sid, m]) => [sid, m.placedBy])) }
    }
    d.categories = d.categories.filter(c => c.id !== id).map((c, i) => ({ ...c, sort: i }))
    for (const m of Object.values(d.sessions)) {
      if (m.categoryId === id) Object.assign(m, { categoryId: null, placedBy: null })
    }
    this.save()
  }

  /** Puts back the category deleted last, with its sessions, if nothing has taken their place. */
  undoDelete(id: string): boolean {
    const del = this.deleted
    if (!del || del.category.id !== id || this.data.categories.some(c => c.id === id)) return false
    const d = this.data
    const at = Math.min(del.category.sort, d.categories.length)
    d.categories.splice(at, 0, del.category)
    d.categories = d.categories.map((c, i) => ({ ...c, sort: i }))
    for (const [sid, placedBy] of Object.entries(del.members)) {
      const m = d.sessions[sid]
      // A session Alex placed somewhere since stays where he put it.
      if (m && m.categoryId === null) Object.assign(m, { categoryId: id, placedBy })
    }
    this.deleted = null
    this.save()
    return true
  }

  reorder(ids: string[]): void {
    const order = new Map(ids.map((id, i) => [id, i]))
    this.data.categories = [...this.data.categories]
      .sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity) || a.sort - b.sort)
      .map((c, i) => ({ ...c, sort: i }))
    this.save()
  }

  rememberLaunch(folder: string, values: { model?: string; effort?: string; mode?: string }): void {
    const s = this.data.settings
    s.recentFolders = [folder, ...s.recentFolders.filter(f => f !== folder)].slice(0, 8)
    s.lastFolder = folder
    s.lastModel = values.model ?? ''
    s.lastEffort = values.effort ?? ''
    s.lastMode = values.mode ?? 'default'
    this.save()
  }

  /** With `all`, every unplaced session is tried (after import); otherwise only ones the store hasn't seen. */
  private assign(sessions: SeenSession[], all: boolean): number {
    const d = this.data
    for (const s of sessions) {
      if (s.cwd && d.sessions[s.sessionId] && d.sessions[s.sessionId]!.cwd !== s.cwd) d.sessions[s.sessionId]!.cwd = s.cwd
    }
    const placed = this.placed()
    let assigned = 0
    for (const s of sessions) {
      const meta = d.sessions[s.sessionId]
      if (meta ? !all || meta.categoryId || meta.placedBy === 'hand' : false) continue
      const r = s.cwd ? autoAssign({ folderKey: this.folderKey(s.cwd), home: this.home, categories: d.categories, placed }) : { kind: 'none' as const }
      const { tie: _old, ...rest } = meta ?? { categoryId: null, placedBy: null }
      d.sessions[s.sessionId] = {
        ...rest,
        ...(s.cwd ? { cwd: s.cwd, folderKey: this.folderKey(s.cwd) } : {}),
        categoryId: r.kind === 'assign' ? r.categoryId : null,
        placedBy: r.kind === 'assign' ? 'auto' : null,
        // Two equal matches: offered on the card instead of guessed (§7).
        ...(r.kind === 'ambiguous' ? { tie: r.categoryIds } : {}),
      }
      if (r.kind === 'assign') assigned += 1
    }
    return assigned
  }

  /** What auto-assign would give a session in `cwd`, for the New Session sheet's `Auto:` line. */
  guess(cwd: string): { categoryId: string | null; folderKey: string } {
    const folderKey = this.folderKey(cwd)
    const r = autoAssign({ folderKey, home: this.home, categories: this.data.categories, placed: this.placed() })
    return { categoryId: r.kind === 'assign' ? r.categoryId : null, folderKey }
  }

  /** Sessions placed by hand or imported, with their folder keys: what auto-assign learns from. */
  private placed(): { folderKey: string; categoryId: string }[] {
    return Object.values(this.data.sessions).flatMap(m =>
      m.categoryId && m.cwd && (m.placedBy === 'hand' || m.placedBy === 'import') ? [{ folderKey: this.folderKey(m.cwd), categoryId: m.categoryId }] : [],
    )
  }

  private folderKey(cwd: string): string {
    let key = this.keyCache.get(cwd)
    if (key === undefined) {
      key = folderKeyOf(cwd, this.repoRoot)
      this.keyCache.set(cwd, key)
    }
    return key
  }

  private load(): AppStore {
    const empty = emptyStore()
    try {
      // Checked field by field: the file sits in a folder anything running as Alex can write (gate L-3).
      const data = checkStore(JSON.parse(readFileSync(this.path, 'utf8')))
      if (data.version !== 1) return empty
      // Stores imported before `origin` existed: 0.24's sessions carry its alias or an import placement.
      for (const m of Object.values(data.sessions ?? {})) if (!m.origin && (m.alias || m.placedBy === 'import')) m.origin = 'import'
      return { ...empty, ...data, settings: { ...empty.settings, ...data.settings } }
    } catch {
      return empty
    }
  }

  private save(): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    writeFileSync(`${this.path}.tmp`, JSON.stringify(this.data), { mode: 0o600 })
    renameSync(`${this.path}.tmp`, this.path)
    for (const fn of this.listeners) fn(this.data)
  }
}

export function registryPresent(folder: string): boolean {
  try {
    return statSync(join(folder, 'registry.db')).isFile()
  } catch {
    return false
  }
}
