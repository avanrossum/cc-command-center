// Read-only import from Electron CCCC's registry (MIP2-1409; FRAGO-001
// constraint 3: nothing writes Electron's registry while it runs).
//
// The registry is SQLite in WAL mode, and even a read-only SQLite connection
// can write the -shm file. So the app never opens Electron's files with
// SQLite: it copies registry.db and its -wal and -shm into a private
// temporary folder with plain reads, opens the copy, and deletes it.

import { copyFileSync, existsSync, mkdtempSync, rmSync, constants } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CATEGORY_COLORS, type AppSettings, type Category, type SessionMeta } from '../shared/store.ts'

export const REGISTRY_FILE = 'registry.db'
/** The schema version this import reads (registry.db `user_version`). */
export const REGISTRY_VERSION = 18

export interface ImportResult {
  categories: (Category & { oldId: number })[]
  sessions: Record<string, Omit<SessionMeta, 'cwd'> & { cwd: string | null; oldCategoryId: number | null }>
  settings: Partial<AppSettings>
  counts: { categories: number; sessions: number; named: number; categorized: number }
}

/** Copies the registry and its WAL files into a private folder; the copy is the only thing SQLite opens. */
function privateCopy(folder: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'ccc-import-'))
  for (const suffix of ['', '-wal', '-shm']) {
    const from = join(folder, REGISTRY_FILE + suffix)
    // COPYFILE_EXCL: never write through something already at the target.
    if (existsSync(from)) copyFileSync(from, join(dir, REGISTRY_FILE + suffix), constants.COPYFILE_EXCL)
  }
  return dir
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const num = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'bigint' ? Number(v) : undefined)

function json<T>(text: unknown): T | undefined {
  if (typeof text !== 'string') return undefined
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

export function importRegistry(folder: string): ImportResult {
  if (!existsSync(join(folder, REGISTRY_FILE))) throw new Error(`no ${REGISTRY_FILE} in ${folder}`)
  const dir = privateCopy(folder)
  try {
    const db = new DatabaseSync(join(dir, REGISTRY_FILE))
    try {
      const version = num((db.prepare('PRAGMA user_version').get() as Record<string, unknown>).user_version)
      if (version !== REGISTRY_VERSION) throw new Error(`registry schema ${version}, this import reads ${REGISTRY_VERSION}`)

      const rows = db.prepare('SELECT id, name, color, sort, label, emoji, arbiter_context, notify_permission, notify_question FROM category ORDER BY sort, id').all() as Record<string, unknown>[]
      // 0.24's notify columns: 1 on, 0 off, NULL unset (MIP2-1387 §3.1, UX ruling on MIP2-1407).
      // Its permission and question classes are both Needs you here; permission
      // wins when both are set. notify_done (turns ending on a statement) is dropped.
      const notify = (v: unknown): 'on' | 'off' | null => (num(v) === 1 ? 'on' : num(v) === 0 ? 'off' : null)
      const categories = rows.map((r, i) => {
        const color = str(r.color) ?? CATEGORY_COLORS[i % CATEGORY_COLORS.length]!
        return {
          oldId: num(r.id)!,
          id: `c${num(r.id)}`,
          name: str(r.name) ?? `Category ${i + 1}`,
          color: /^#[0-9a-f]{6}$/i.test(color) ? color : CATEGORY_COLORS[i % CATEGORY_COLORS.length]!,
          label: (str(r.label) ?? '').replace(/^\[|\]$/g, '').slice(0, 8),
          emoji: str(r.emoji) ?? '',
          sort: i,
          folders: [],
          notFolders: [],
          isolation: 'none' as const,
          // D-016 ("Import as they are"): each imported category keeps its own setting.
          arbiterReadsText: num(r.arbiter_context) === 1,
          notifyNeeds: notify(r.notify_permission) ?? notify(r.notify_question) ?? ('auto' as const),
          notifyTurn: 'auto' as const,
          collapsed: false,
        }
      })
      const byOld = new Map(categories.map(c => [c.oldId, c.id]))

      const nodes = db.prepare('SELECT session_id, cwd, name, alias, category_id, theme, archived_at, resume_flags FROM node').all() as Record<string, unknown>[]
      const sessions: ImportResult['sessions'] = {}
      for (const n of nodes) {
        const id = str(n.session_id)
        if (!id || !/^[0-9a-f-]{36}$/.test(id)) continue
        const oldCategoryId = num(n.category_id) ?? null
        const categoryId = oldCategoryId !== null ? (byOld.get(oldCategoryId) ?? null) : null
        const flags = json<SessionMeta['resumeFlags']>(n.resume_flags)
        sessions[id] = {
          cwd: str(n.cwd) ?? null,
          oldCategoryId,
          categoryId,
          placedBy: categoryId ? 'import' : null,
          ...(str(n.name) ? { name: str(n.name)! } : {}),
          ...(str(n.alias) ? { alias: str(n.alias)! } : {}),
          ...(str(n.theme) ? { theme: str(n.theme)! } : {}),
          ...(num(n.archived_at) ? { archivedAt: num(n.archived_at)! } : {}),
          ...(flags && typeof flags === 'object' ? { resumeFlags: flags } : {}),
        }
      }

      const state = new Map(
        (db.prepare('SELECT key, value FROM app_state').all() as Record<string, unknown>[]).map(r => [str(r.key) ?? '', r.value]),
      )
      const recent = json<unknown[]>(state.get('recentFolders'))
      const size = Number(str(state.get('terminalFontSize')))
      const settings: Partial<AppSettings> = {
        recentFolders: Array.isArray(recent) ? recent.filter((f): f is string => typeof f === 'string' && f.startsWith('/')).slice(0, 8) : [],
        ...(str(state.get('lastFolder')) ? { lastFolder: str(state.get('lastFolder'))! } : {}),
        ...(str(state.get('lastModel')) ? { lastModel: str(state.get('lastModel'))! } : {}),
        // 0.24's `ultracode` effort becomes xhigh (MIP2-1387 §2.4); Ultracode itself is MIP2-1407.
        ...(str(state.get('lastEffort')) ? { lastEffort: str(state.get('lastEffort')) === 'ultracode' ? 'xhigh' : str(state.get('lastEffort'))! } : {}),
        ...(str(state.get('lastMode')) ? { lastMode: str(state.get('lastMode'))! } : {}),
        ...(str(state.get('terminalFont')) ? { terminalFont: str(state.get('terminalFont'))! } : {}),
        ...(Number.isFinite(size) && size > 6 && size < 48 ? { terminalFontSize: size } : {}),
        // 0.24 hid sessions it didn't start. Kept, not applied: today nearly every session started outside this app (ruling on MIP2-1424).
        ...(state.has('hideUnmanaged') ? { importedHideUnmanaged: str(state.get('hideUnmanaged')) === 'true' } : {}),
        ...(state.has('notifyEnabled') ? { notifyEnabled: str(state.get('notifyEnabled')) !== 'false' } : {}),
      }
      // 0.24's sessionNames map fills names its node rows lack.
      for (const [id, name] of Object.entries(json<Record<string, unknown>>(state.get('sessionNames')) ?? {})) {
        if (sessions[id] && !sessions[id].name && typeof name === 'string') sessions[id].name = name
      }

      const all = Object.values(sessions)
      return {
        categories,
        sessions,
        settings,
        counts: { categories: categories.length, sessions: all.length, named: all.filter(s => s.name || s.alias).length, categorized: all.filter(s => s.categoryId).length },
      }
    } finally {
      db.close()
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
