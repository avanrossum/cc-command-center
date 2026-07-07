import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('ptyApi', {
  start: (cols: number, rows: number) => ipcRenderer.send('pty:start', { cols, rows }),
  input: (data: string) => ipcRenderer.send('pty:input', data),
  resize: (cols: number, rows: number) => ipcRenderer.send('pty:resize', { cols, rows }),
  onData: (cb: (data: string) => void) => {
    const listener = (_e: unknown, data: string) => cb(data)
    ipcRenderer.on('pty:data', listener)
    return () => ipcRenderer.off('pty:data', listener)
  },
  onInfo: (cb: (msg: string) => void) => {
    ipcRenderer.on('pty:info', (_e, msg: string) => cb(msg))
  },
  onExit: (cb: (code: number) => void) => {
    ipcRenderer.on('pty:exit', (_e, code: number) => cb(code))
  },
})
