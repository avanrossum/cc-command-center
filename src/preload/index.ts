// Runs in the sandboxed renderer with contextIsolation on. It exposes only
// the CccApi in src/shared/ipc.ts; no Electron or Node object reaches the page.

import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron'
import type { FleetSnapshot } from '@ccc/contract'
import { IPC, type CccApi } from '../shared/ipc.ts'
import type { ArbiterState } from '../shared/arbiter-state.ts'
import type { TurnSummary } from '../shared/summaries.ts'
import type { AppStore } from '../shared/store.ts'
import type { UpdateState } from '../shared/update-state.ts'
import type { SpendState } from '../shared/spend.ts'

function listen<A extends unknown[]>(channel: string, listener: (...args: A) => void): () => void {
  const handler = (_event: IpcRendererEvent, ...args: unknown[]) => listener(...(args as A))
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: CccApi = {
  getFleet: () => ipcRenderer.invoke(IPC.fleetGet),
  onFleet: listener => listen<[FleetSnapshot]>(IPC.fleetUpdate, listener),

  launch: req => ipcRenderer.invoke(IPC.launch, req),
  resume: id => ipcRenderer.invoke(IPC.resume, id),
  startCopy: (id, req) => ipcRenderer.invoke(IPC.startCopy, id, req),
  moveIn: id => ipcRenderer.invoke(IPC.moveIn, id),
  stop: id => ipcRenderer.invoke(IPC.stop, id),
  answer: (requestId, answer) => ipcRenderer.invoke(IPC.answer, requestId, answer),
  sendPrompt: (id, text) => ipcRenderer.invoke(IPC.sendPrompt, id, text),
  chooseFolder: () => ipcRenderer.invoke(IPC.chooseFolder),
  copyText: text => ipcRenderer.send(IPC.copyText, text),
  openLink: (url, text, atEdge) => ipcRenderer.invoke(IPC.openLink, url, text, atEdge),
  copyLastOutput: id => ipcRenderer.invoke(IPC.copyLastOutput, id),

  focusOpen: (id, cols, rows) => ipcRenderer.invoke(IPC.focusOpen, id, cols, rows),
  focusInput: (id, data) => ipcRenderer.send(IPC.focusInput, id, data),
  focusResize: (id, cols, rows) => ipcRenderer.send(IPC.focusResize, id, cols, rows),
  focusLeave: id => ipcRenderer.send(IPC.focusLeave, id),
  focusPaste: (id, text, submit) => ipcRenderer.send(IPC.focusPaste, id, text, submit),
  focusPickPaths: id => ipcRenderer.invoke(IPC.focusPickPaths, id),
  // A sandboxed page can't read a dropped file's path; webUtils can, here.
  focusDropFiles: (id, files) => ipcRenderer.send(IPC.focusPaste, id, null, false, files.map(f => webUtils.getPathForFile(f)).filter(Boolean)),
  onFocusData: listener => listen<[string, string]>(IPC.focusData, listener),
  onFocusExit: listener => listen<[string, number]>(IPC.focusExit, listener),

  trustStart: (req, cols, rows) => ipcRenderer.invoke(IPC.trustStart, req, cols, rows),
  trustInput: (id, data) => ipcRenderer.send(IPC.trustInput, id, data),
  trustResize: (id, cols, rows) => ipcRenderer.send(IPC.trustResize, id, cols, rows),
  trustCancel: id => ipcRenderer.send(IPC.trustCancel, id),
  onTrustData: listener => listen<[string, string]>(IPC.trustData, listener),
  onTrustDone: listener => listen<[string, string | null, string | null]>(IPC.trustDone, listener),

  getStore: () => ipcRenderer.invoke(IPC.storeGet),
  onStore: listener => listen<[AppStore]>(IPC.storeUpdate, listener),
  importAvailable: () => ipcRenderer.invoke(IPC.storeImportAvailable),
  importSettings: parts => ipcRenderer.invoke(IPC.storeImport, parts),
  artifactPreview: (id, path, raw) => ipcRenderer.invoke(IPC.artifactPreview, id, path, raw === true),
  artifactReveal: (id, path) => ipcRenderer.invoke(IPC.artifactReveal, id, path),
  artifactOpen: (id, target, confirmed) => ipcRenderer.invoke(IPC.artifactOpen, id, target, confirmed === true),
  getArbiter: () => ipcRenderer.invoke(IPC.arbiterGet),
  onArbiter: listener => listen<[ArbiterState]>(IPC.arbiterUpdate, listener),
  getSummaries: () => ipcRenderer.invoke(IPC.summariesGet),
  onSummaries: listener => listen<[Record<string, TurnSummary>]>(IPC.summariesUpdate, listener),
  getWaits: () => ipcRenderer.invoke(IPC.waitsGet),
  onWaits: listener => listen<[Record<string, TurnSummary>]>(IPC.waitsUpdate, listener),
  usageTips: facts => ipcRenderer.invoke(IPC.usageTips, facts),
  getSpend: () => ipcRenderer.invoke(IPC.spendGet),
  onSpend: listener => listen<[SpendState]>(IPC.spendUpdate, listener),
  setSpendSource: source => ipcRenderer.invoke(IPC.spendSource, source),
  adminKeyStatus: () => ipcRenderer.invoke(IPC.adminKeyStatus),
  testAdminKey: key => ipcRenderer.invoke(IPC.adminKeyTest, key),
  saveAdminKey: key => ipcRenderer.invoke(IPC.adminKeySave, key),
  removeAdminKey: () => ipcRenderer.invoke(IPC.adminKeyRemove),
  arbiterLog: () => ipcRenderer.invoke(IPC.arbiterLog),
  firstRunInfo: () => ipcRenderer.invoke(IPC.firstRunInfo),
  removeMailboxRules: () => ipcRenderer.invoke(IPC.firstRunRemoveMailbox),
  setArbiterKey: key => ipcRenderer.invoke(IPC.arbiterSetKey, key),
  appStatus: () => ipcRenderer.invoke(IPC.appStatus),
  selfCheckAgain: () => ipcRenderer.invoke(IPC.selfCheckAgain),
  channelCheckAgain: () => ipcRenderer.invoke(IPC.channelCheckAgain),
  removeArbiterKey: () => ipcRenderer.invoke(IPC.arbiterKeyRemove),
  finishFirstRun: opts => ipcRenderer.invoke(IPC.firstRunFinish, opts),
  place: (id, categoryId) => ipcRenderer.invoke(IPC.storePlace, id, categoryId),
  setName: (id, name) => ipcRenderer.invoke(IPC.storeSetName, id, name),
  setSwitcher: (pins, recent) => ipcRenderer.invoke(IPC.storeSetSwitcher, pins, recent),
  notCategory: id => ipcRenderer.invoke(IPC.storeNotCategory, id),
  markSeen: id => ipcRenderer.invoke(IPC.storeSeen, id),
  guessCategory: cwd => ipcRenderer.invoke(IPC.storeGuess, cwd),
  onNotice: listener => listen<[string]>(IPC.appNotice, listener),
  startupNotices: () => ipcRenderer.invoke(IPC.startupNotices),
  clearGoneMark: id => ipcRenderer.invoke(IPC.clearGoneMark, id),
  onOpenSession: listener => listen<[string]>(IPC.openSession, listener),
  onOpenNeeds: listener => listen<[]>(IPC.openNeeds, listener),
  onOpenSettings: listener => listen<[]>(IPC.openSettings, listener),
  resurrect: (ids, keep) => ipcRenderer.invoke(IPC.lifeResurrect, ids, keep === true),
  archive: id => ipcRenderer.invoke(IPC.lifeArchive, id),
  setNeverRollOff: (id, on) => ipcRenderer.invoke(IPC.lifeNeverRollOff, id, on),
  setSessionKind: (id, kind, parentId) => ipcRenderer.invoke(IPC.lifeSetKind, id, kind, parentId),
  setParkedHidden: (ids, hidden) => ipcRenderer.invoke(IPC.storeParkedHidden, ids, hidden),
  dismissRollOffNotice: () => ipcRenderer.invoke(IPC.lifeDismissNotice),
  setRollOffDays: days => ipcRenderer.invoke(IPC.lifeRollOffDays, days),
  updateSettings: patch => ipcRenderer.invoke(IPC.settingsUpdate, patch),
  rememberLaunch: (folder, values) => ipcRenderer.send(IPC.storeRememberLaunch, folder, values),
  saveCategory: category => ipcRenderer.invoke(IPC.categorySave, category),
  deleteCategory: id => ipcRenderer.invoke(IPC.categoryDelete, id),
  undoDeleteCategory: id => ipcRenderer.invoke(IPC.categoryUndoDelete, id),
  reorderCategories: ids => ipcRenderer.invoke(IPC.categoryReorder, ids),
  getUpdate: () => ipcRenderer.invoke(IPC.updateGet),
  onUpdate: listener => listen<[UpdateState]>(IPC.updateUpdate, listener),
  checkForUpdate: () => ipcRenderer.invoke(IPC.updateCheck),
  downloadUpdate: () => ipcRenderer.invoke(IPC.updateDownload),
  updateLater: () => ipcRenderer.invoke(IPC.updateLater),
  restartToUpdate: () => ipcRenderer.invoke(IPC.updateRestart),
}

contextBridge.exposeInMainWorld('ccc', api)
