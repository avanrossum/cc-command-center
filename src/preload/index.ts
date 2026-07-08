import { contextBridge, ipcRenderer } from 'electron'

interface OpenOpts {
  sessionId?: string
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
  // status board
  getSessions: () => ipcRenderer.invoke('cc:getSessions'),
  onSessions: (cb: (snapshot: unknown) => void) => sub('cc:sessions', cb),

  // categories
  catCreate: (name: string) => ipcRenderer.invoke('cat:create', name),
  catRename: (id: number, name: string) => ipcRenderer.invoke('cat:rename', id, name),
  catDelete: (id: number) => ipcRenderer.invoke('cat:delete', id),
  catAssign: (sessionId: string, categoryId: number | null) =>
    ipcRenderer.invoke('cat:assign', sessionId, categoryId),

  // task-tree edges
  edgeSet: (childId: string, parentId: string, type: 'blocking' | 'tangential') =>
    ipcRenderer.invoke('edge:set', childId, parentId, type),
  edgeClear: (childId: string) => ipcRenderer.invoke('edge:clear', childId),

  // terminals
  termOpen: (pid: number, opts: OpenOpts) => ipcRenderer.invoke('term:open', pid, opts),
  termAttach: (pid: number) => ipcRenderer.send('term:attach', pid),
  termInput: (pid: number, data: string) => ipcRenderer.send('term:input', pid, data),
  termResize: (pid: number, cols: number, rows: number) =>
    ipcRenderer.send('term:resize', pid, cols, rows),
  termClose: (pid: number) => ipcRenderer.send('term:close', pid),
  onTermData: (cb: (p: { pid: number; data: string }) => void) => sub('term:data', cb),
  onTermExit: (cb: (p: { pid: number; code: number }) => void) => sub('term:exit', cb),
  onTermShow: (cb: (p: { pid: number; name: string; cwd: string }) => void) => sub('term:show', cb),
})
