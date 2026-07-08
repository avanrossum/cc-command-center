export {}

interface OpenOpts {
  sessionId?: string
  cwd: string
  resume: boolean
  cols: number
  rows: number
}

declare global {
  interface Window {
    cc: {
      getSessions: () => Promise<unknown>
      onSessions: (cb: (snapshot: unknown) => void) => () => void
      catCreate: (name: string) => Promise<{ id: number; name: string; color: string }>
      catRename: (id: number, name: string) => Promise<boolean>
      catDelete: (id: number) => Promise<boolean>
      catAssign: (sessionId: string, categoryId: number | null) => Promise<boolean>
      termOpen: (pid: number, opts: OpenOpts) => Promise<boolean>
      termAttach: (pid: number) => void
      termInput: (pid: number, data: string) => void
      termResize: (pid: number, cols: number, rows: number) => void
      termClose: (pid: number) => void
      onTermData: (cb: (p: { pid: number; data: string }) => void) => () => void
      onTermExit: (cb: (p: { pid: number; code: number }) => void) => () => void
      onTermShow: (cb: (p: { pid: number; name: string; cwd: string }) => void) => () => void
    }
  }
}
