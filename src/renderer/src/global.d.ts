export {}

interface OpenOpts {
  sessionId?: string
  pid?: number
  cwd: string
  resume: boolean
  cols: number
  rows: number
}

interface ApiKey {
  id: number
  name: string
  hint: string
  created_at: number
}

declare global {
  interface Window {
    cc: {
      appVersion: () => Promise<{ full: string; version: string; hash: string; time: string }>
      getSessions: () => Promise<unknown>
      onSessions: (cb: (snapshot: unknown) => void) => () => void
      catCreate: (name: string) => Promise<{ id: number; name: string; color: string }>
      catRename: (id: number, name: string) => Promise<boolean>
      sessionSetName: (sessionId: string, name: string) => Promise<boolean>
      catDelete: (id: number) => Promise<boolean>
      catSetLabel: (id: number, label: string | null) => Promise<boolean>
      catSetColor: (id: number, color: string) => Promise<boolean>
      catAssign: (sessionId: string, categoryId: number | null) => Promise<boolean>
      edgeSet: (
        childId: string,
        parentId: string,
        type: 'blocking' | 'tangential',
      ) => Promise<boolean>
      edgeClear: (childId: string) => Promise<boolean>
      edgeTrust: (childId: string, trusted: boolean) => Promise<boolean>
      awarenessPause: (paused: boolean) => Promise<boolean>
      settingsSet: (key: string, value: string) => Promise<boolean>
      settingsGrantMail: () => Promise<{ ok: boolean; reason?: string }>
      settingsInstallStatusHooks: () => Promise<{ ok: boolean; reason?: string }>
      settingsRemoveStatusHooks: () => Promise<{ ok: boolean; reason?: string }>
      apiKeysList: () => Promise<ApiKey[]>
      apiKeysAdd: (
        name: string,
        rawKey: string,
      ) => Promise<{ ok: true; key: ApiKey } | { ok: false; reason: string }>
      apiKeysRemove: (id: number) => Promise<{ ok: boolean }>
      themeSet: (sessionId: string, theme: string | null) => Promise<boolean>
      snapshotSave: (sessionId: string, data: string) => void
      sessionNew: () => Promise<{ pid: number; cwd: string } | null>
      sessionCreate: (opts: {
        cwd: string
        flags?: string
        categoryId?: number | null
        name?: string
        instructions?: string
        apiKeyId?: number
      }) => Promise<{ pid: number; cwd: string } | null>
      sessionStartFresh: (cwd: string) => Promise<{ pid: number; cwd: string } | null>
      sessionRemove: (sessionId: string) => Promise<{ removed: string[] }>
      sessionSpawnChild: (
        parentSessionId: string,
        cwd: string,
        type: 'blocking' | 'tangential',
        note?: string,
        name?: string,
        autoMode?: boolean,
        apiKeyId?: number,
      ) => Promise<{ pid: number; cwd: string } | null>
      pickFolder: () => Promise<string | null>
      pickPath: (sessionId?: string) => Promise<string | null>
      getPathForFile: (file: File) => string
      sessionSend: (sessionId: string, text: string) => Promise<{ ok: boolean; reason?: string }>
      copyOutput: (sessionId: string, cwd: string) => Promise<{ ok: boolean; chars?: number }>
      stateGet: (key: string) => Promise<string | null>
      stateSet: (key: string, value: string) => void
      termOpen: (key: string, opts: OpenOpts) => Promise<boolean>
      termAttach: (key: string) => void
      termInput: (key: string, data: string) => void
      termOpenPath: (key: string, path: string) => Promise<{ ok: boolean }>
      openExternal: (url: string) => Promise<{ ok: boolean }>
      termResize: (key: string, cols: number, rows: number) => void
      termRedraw: (key: string) => void
      termClose: (key: string) => void
      onTermData: (cb: (p: { key: string; data: string }) => void) => () => void
      onTermExit: (cb: (p: { key: string; code: number }) => void) => () => void
      onSessionsRemoved: (cb: (p: { ids: string[] }) => void) => () => void
      onTermShow: (
        cb: (p: { key: string; pid?: number; name: string; cwd: string }) => void,
      ) => () => void
      onTermRecover: (
        cb: (p: { key: string; sessionId: string; cwd: string }) => void,
      ) => () => void
    }
  }
}
