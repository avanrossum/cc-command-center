import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('cc', {
  getSessions: () => ipcRenderer.invoke('cc:getSessions'),
  onSessions: (cb: (snapshot: unknown) => void) => {
    const listener = (_e: unknown, snapshot: unknown) => cb(snapshot)
    ipcRenderer.on('cc:sessions', listener)
    return () => ipcRenderer.off('cc:sessions', listener)
  },
})
