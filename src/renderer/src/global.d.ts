export {}

interface OpenOpts {
  sessionId?: string
  pid?: number
  cwd: string
  resume: boolean
  cols: number
  rows: number
}

declare global {
  interface Window {
    cc: {
      appVersion: () => Promise<{ full: string; version: string; hash: string; time: string }>
      getSessions: () => Promise<unknown>
      onSessions: (cb: (snapshot: unknown) => void) => () => void
      catCreate: (name: string) => Promise<{ id: number; name: string; color: string }>
      catRename: (id: number, name: string) => Promise<boolean>
      catDelete: (id: number) => Promise<boolean>
      catAssign: (sessionId: string, categoryId: number | null) => Promise<boolean>
      edgeSet: (
        childId: string,
        parentId: string,
        type: 'blocking' | 'tangential',
      ) => Promise<boolean>
      edgeClear: (childId: string) => Promise<boolean>
      themeSet: (sessionId: string, theme: string | null) => Promise<boolean>
      snapshotSave: (sessionId: string, data: string) => void
      sessionNew: () => Promise<{ pid: number; cwd: string } | null>
      sessionStartFresh: (cwd: string) => Promise<{ pid: number; cwd: string } | null>
      sessionRemove: (sessionId: string) => Promise<boolean>
      sessionSpawnChild: (
        parentSessionId: string,
        cwd: string,
        type: 'blocking' | 'tangential',
        note?: string,
      ) => Promise<{ pid: number; cwd: string } | null>
      pickFolder: () => Promise<string | null>
      stateGet: (key: string) => Promise<string | null>
      stateSet: (key: string, value: string) => void
      termOpen: (key: string, opts: OpenOpts) => Promise<boolean>
      termAttach: (key: string) => void
      termInput: (key: string, data: string) => void
      termResize: (key: string, cols: number, rows: number) => void
      termClose: (key: string) => void
      onTermData: (cb: (p: { key: string; data: string }) => void) => () => void
      onTermExit: (cb: (p: { key: string; code: number }) => void) => () => void
      onTermShow: (
        cb: (p: { key: string; pid?: number; name: string; cwd: string }) => void,
      ) => () => void
      onTermRecover: (
        cb: (p: { key: string; sessionId: string; cwd: string }) => void,
      ) => () => void
    }
  }
}
