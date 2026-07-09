import { contextBridge, ipcRenderer, webUtils } from 'electron'

interface OpenOpts {
  sessionId?: string
  pid?: number
  cwd: string
  resume: boolean
  cols: number
  rows: number
}

function sub<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

contextBridge.exposeInMainWorld('cc', {
  // app
  appVersion: () => ipcRenderer.invoke('app:version'),

  // status board
  getSessions: () => ipcRenderer.invoke('cc:getSessions'),
  onSessions: (cb: (snapshot: unknown) => void) => sub('cc:sessions', cb),

  // categories
  catCreate: (name: string) => ipcRenderer.invoke('cat:create', name),
  catRename: (id: number, name: string) => ipcRenderer.invoke('cat:rename', id, name),
  catDelete: (id: number) => ipcRenderer.invoke('cat:delete', id),
  catSetLabel: (id: number, label: string | null) => ipcRenderer.invoke('cat:setLabel', id, label),
  catSetColor: (id: number, color: string) => ipcRenderer.invoke('cat:setColor', id, color),
  catAssign: (sessionId: string, categoryId: number | null) =>
    ipcRenderer.invoke('cat:assign', sessionId, categoryId),

  // task-tree edges
  edgeSet: (childId: string, parentId: string, type: 'blocking' | 'tangential') =>
    ipcRenderer.invoke('edge:set', childId, parentId, type),
  edgeClear: (childId: string) => ipcRenderer.invoke('edge:clear', childId),
  edgeTrust: (childId: string, trusted: boolean) =>
    ipcRenderer.invoke('edge:trust', childId, trusted),
  awarenessPause: (paused: boolean) => ipcRenderer.invoke('awareness:pause', paused),
  settingsSet: (key: string, value: string) => ipcRenderer.invoke('settings:set', key, value),
  settingsGrantMail: () => ipcRenderer.invoke('settings:grantMail'),

  // per-terminal theme
  themeSet: (sessionId: string, theme: string | null) =>
    ipcRenderer.invoke('theme:set', sessionId, theme),

  // scrollback snapshot (resume-on-restart)
  snapshotSave: (sessionId: string, data: string) =>
    ipcRenderer.send('snapshot:save', sessionId, data),

  // sessions
  sessionNew: () => ipcRenderer.invoke('session:new'),
  sessionCreate: (opts: {
    cwd: string
    flags?: string
    categoryId?: number | null
    name?: string
    instructions?: string
  }) => ipcRenderer.invoke('session:create', opts),
  sessionStartFresh: (cwd: string) => ipcRenderer.invoke('session:startFresh', cwd),
  sessionRemove: (sessionId: string) => ipcRenderer.invoke('session:remove', sessionId),
  sessionSpawnChild: (
    parentSessionId: string,
    cwd: string,
    type: 'blocking' | 'tangential',
    note?: string,
    name?: string,
  ) => ipcRenderer.invoke('session:spawnChild', parentSessionId, cwd, type, note, name),
  pickFolder: () => ipcRenderer.invoke('dialog:pickFolder'),
  pickPath: (sessionId?: string) => ipcRenderer.invoke('dialog:pickPath', sessionId),
  // Electron 43 removed File.path; this is the supported way to resolve a dropped
  // file's absolute path.
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  sessionSend: (sessionId: string, text: string) =>
    ipcRenderer.invoke('session:send', sessionId, text) as Promise<{ ok: boolean; reason?: string }>,
  copyOutput: (sessionId: string, cwd: string) =>
    ipcRenderer.invoke('session:copyOutput', sessionId, cwd) as Promise<{
      ok: boolean
      chars?: number
    }>,

  // workspace state (resume-on-restart)
  stateGet: (key: string) => ipcRenderer.invoke('state:get', key),
  stateSet: (key: string, value: string) => ipcRenderer.send('state:set', key, value),

  // terminals — keyed by a stable string (session id, or `new:<pid>`)
  termOpen: (key: string, opts: OpenOpts) => ipcRenderer.invoke('term:open', key, opts),
  termAttach: (key: string) => ipcRenderer.send('term:attach', key),
  termInput: (key: string, data: string) => ipcRenderer.send('term:input', key, data),
  termOpenPath: (key: string, path: string) => ipcRenderer.invoke('term:openPath', key, path),
  termResize: (key: string, cols: number, rows: number) =>
    ipcRenderer.send('term:resize', key, cols, rows),
  termClose: (key: string) => ipcRenderer.send('term:close', key),
  onTermData: (cb: (p: { key: string; data: string }) => void) => sub('term:data', cb),
  onTermExit: (cb: (p: { key: string; code: number }) => void) => sub('term:exit', cb),
  onTermShow: (cb: (p: { key: string; pid?: number; name: string; cwd: string }) => void) =>
    sub('term:show', cb),
  onTermRecover: (cb: (p: { key: string; sessionId: string; cwd: string }) => void) =>
    sub('term:recover', cb),
})
