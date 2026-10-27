// The store handlers behind window.ccc (MIP2-1409). Like control.ts, each
// checks its sender and arguments. None acts on a session, so none is
// refused while the app is read-only below the Claude Code floor.

import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import { IPC, type ImportSummary, type Result } from '../shared/ipc.ts'
import { registryPresent, type AppStoreService, type SeenSession } from './app-store.ts'
import { isTrustedSender } from './security.ts'
import { checkCategory, checkSettings, isCategoryId, isSessionId } from './validate.ts'

export interface StoreDeps {
  store: AppStoreService
  /** The folder whose registry.db the import reads (paths.ts resolveImportFolder). */
  importFolder: string
  sessions: () => SeenSession[]
}

const err = (e: unknown): Result => ({ ok: false, error: e instanceof Error ? e.message : String(e) })

export function registerStore({ store, importFolder, sessions }: StoreDeps): void {
  const untrusted: Result = { ok: false, error: 'untrusted sender' }
  const invoke = <A extends unknown[], R>(channel: string, fn: (...args: A) => R, refused: R) =>
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!isTrustedSender(event)) return refused
      try {
        return fn(...(args as A))
      } catch (e) {
        return err(e)
      }
    })

  invoke(IPC.storeGet, () => store.get(), null)
  invoke(IPC.storeImportAvailable, () => registryPresent(importFolder), false)
  invoke(IPC.storeImport, (parts: unknown): Result<{ summary: ImportSummary }> => {
    const p = (typeof parts === 'object' && parts !== null ? parts : {}) as Record<string, unknown>
    const on = (k: string) => p[k] !== false
    return { ok: true, summary: store.importFrom(importFolder, sessions(), { categories: on('categories'), sessions: on('sessions'), defaults: on('defaults'), prefs: on('prefs') }) }
  }, untrusted)

  invoke(IPC.storePlace, (id: unknown, categoryId: unknown): Result => {
    if (!isSessionId(id) || (categoryId !== null && !isCategoryId(categoryId))) return { ok: false, error: 'bad request' }
    store.place(id, categoryId)
    return { ok: true }
  }, untrusted)
  invoke(IPC.storeSetName, (id: unknown, name: unknown): Result => {
    if (!isSessionId(id) || typeof name !== 'string' || name.length > 1000) return { ok: false, error: 'bad request' }
    store.setName(id, name)
    return { ok: true }
  }, untrusted)
  invoke(IPC.storeNotCategory, (id: unknown): Result => {
    if (!isSessionId(id)) return { ok: false, error: 'not a session id' }
    store.notCategory(id)
    return { ok: true }
  }, untrusted)

  invoke(IPC.lifeResurrect, (ids: unknown, keep: unknown): Result<{ count: number }> | Result => {
    if (!Array.isArray(ids) || ids.length > 1000 || !ids.every(isSessionId)) return { ok: false, error: 'bad session ids' }
    return { ok: true, count: store.resurrect(ids, Date.now(), keep === true) }
  }, untrusted)
  invoke(IPC.lifeArchive, (id: unknown): Result => {
    if (!isSessionId(id)) return { ok: false, error: 'not a session id' }
    store.archive(id, Date.now())
    return { ok: true }
  }, untrusted)
  invoke(IPC.lifeNeverRollOff, (id: unknown, on: unknown): Result => {
    if (!isSessionId(id) || typeof on !== 'boolean') return { ok: false, error: 'bad request' }
    store.setNeverRollOff(id, on, Date.now())
    return { ok: true }
  }, untrusted)
  invoke(IPC.lifeSetKind, (id: unknown, kind: unknown, parentId: unknown): Result => {
    if (!isSessionId(id) || (kind !== 'session' && kind !== 'contractor') || (parentId !== null && !isSessionId(parentId))) return { ok: false, error: 'bad request' }
    store.setKind(id, kind, kind === 'contractor' ? parentId : null, Date.now())
    return { ok: true }
  }, untrusted)
  invoke(IPC.storeParkedHidden, (ids: unknown, hidden: unknown): Result<{ count: number }> => {
    if (typeof hidden !== 'boolean') return { ok: false, error: 'bad request' }
    const all = ids === 'all' && !hidden
    if (!all && !(Array.isArray(ids) && ids.length <= 1000 && ids.every(isSessionId))) return { ok: false, error: 'bad request' }
    return { ok: true, count: store.setParkedHidden(all ? 'all' : (ids as string[]), hidden) }
  }, untrusted)
  invoke(IPC.lifeDismissNotice, (): Result => (store.dismissRollOffNotice(), { ok: true }), untrusted)
  invoke(IPC.lifeRollOffDays, (days: unknown): Result => {
    if (typeof days !== 'number' || !Number.isFinite(days)) return { ok: false, error: 'bad days' }
    store.setRollOffDays(days)
    return { ok: true }
  }, untrusted)
  invoke(IPC.settingsUpdate, (patch: unknown): Result => {
    const p = checkSettings(patch)
    if (!p) return { ok: false, error: 'bad settings' }
    store.updateSettings(p)
    return { ok: true }
  }, untrusted)
  invoke(IPC.storeGuess, (cwd: unknown) => (typeof cwd === 'string' && cwd.startsWith('/') && cwd.length <= 4096 && !cwd.includes('\0') ? store.guess(cwd) : null), null)
  invoke(IPC.storeSeen, (id: unknown): Result => {
    if (!isSessionId(id)) return { ok: false, error: 'not a session id' }
    store.markSeen(id)
    return { ok: true }
  }, untrusted)

  invoke(IPC.categorySave, (input: unknown) => {
    const c = checkCategory(input)
    return c ? { ok: true, category: store.saveCategory(c) } : { ok: false, error: 'bad category' }
  }, untrusted)
  invoke(IPC.categoryDelete, (id: unknown): Result => {
    if (!isCategoryId(id)) return { ok: false, error: 'bad category id' }
    store.deleteCategory(id)
    return { ok: true }
  }, untrusted)
  invoke(IPC.categoryUndoDelete, (id: unknown): Result => {
    if (!isCategoryId(id)) return { ok: false, error: 'bad category id' }
    return store.undoDelete(id) ? { ok: true } : { ok: false, error: 'nothing to undo' }
  }, untrusted)
  invoke(IPC.categoryReorder, (ids: unknown): Result => {
    if (!Array.isArray(ids) || ids.length > 500 || !ids.every(isCategoryId)) return { ok: false, error: 'bad order' }
    store.reorder(ids)
    return { ok: true }
  }, untrusted)

  ipcMain.on(IPC.storeRememberLaunch, (event: IpcMainEvent, folder: unknown, values: unknown) => {
    if (!isTrustedSender(event as unknown as IpcMainInvokeEvent)) return
    if (typeof folder !== 'string' || !folder.startsWith('/') || folder.length > 4096) return
    const v = (typeof values === 'object' && values !== null ? values : {}) as Record<string, unknown>
    const short = (x: unknown) => (typeof x === 'string' && x.length <= 64 ? x : undefined)
    store.rememberLaunch(folder, { model: short(v.model), effort: short(v.effort), mode: short(v.mode) })
  })
}
