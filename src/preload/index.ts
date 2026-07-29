import { contextBridge, ipcRenderer, webUtils } from 'electron'

interface ResumeFlags {
  model: string
  context: string
  effort: string
  mode: string
}

interface OpenOpts {
  sessionId?: string
  pid?: number
  cwd: string
  resume: boolean
  cols: number
  rows: number
  // One-shot launch params from the resume modal, for a session with none stored.
  resumeFlags?: ResumeFlags
}

function sub<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: unknown, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.off(channel, listener)
}

contextBridge.exposeInMainWorld('cc', {
  // app
  appVersion: () => ipcRenderer.invoke('app:version'),

  // auto-update
  updateCheck: () => ipcRenderer.invoke('update:check'),
  updateInstall: () => ipcRenderer.invoke('update:install'),
  updateInstallOnQuit: () => ipcRenderer.invoke('update:installOnQuit'),
  updateSkip: (version: string) => ipcRenderer.invoke('update:skip', version),
  updateJustUpdated: () => ipcRenderer.invoke('update:justUpdated'),
  onUpdateAvailable: (cb: (p: unknown) => void) => sub('update:available', cb),
  onUpdateNone: (cb: () => void) => sub('update:none', cb),
  onUpdateDownloading: (cb: () => void) => sub('update:downloading', cb),
  onUpdateProgress: (cb: (p: { percent: number }) => void) => sub('update:progress', cb),
  onUpdateStaged: (cb: () => void) => sub('update:staged', cb),
  onUpdateError: (cb: (p: { message: string }) => void) => sub('update:error', cb),
  onMenuSettings: (cb: () => void) => sub('menu:settings', cb),
  // Clicking an OS notification asks the renderer to open that session.
  onFocusSession: (cb: (sessionId: string) => void) => sub('cc:focusSession', cb),

  // status board
  getSessions: () => ipcRenderer.invoke('cc:getSessions'),
  onSessions: (cb: (snapshot: unknown) => void) => sub('cc:sessions', cb),

  // categories
  catCreate: (name: string) => ipcRenderer.invoke('cat:create', name),
  catRename: (id: number, name: string) => ipcRenderer.invoke('cat:rename', id, name),
  sessionSetName: (sessionId: string, name: string) =>
    ipcRenderer.invoke('session:setName', sessionId, name),
  catDelete: (id: number) => ipcRenderer.invoke('cat:delete', id),
  catSetLabel: (id: number, label: string | null) => ipcRenderer.invoke('cat:setLabel', id, label),
  catSetArbiterContext: (id: number, on: boolean) =>
    ipcRenderer.invoke('cat:setArbiterContext', id, on),
  arbiterSetEnabled: (on: boolean) => ipcRenderer.invoke('arbiter:setEnabled', on),
  arbiterSetKey: (keyId: number | null) => ipcRenderer.invoke('arbiter:setKey', keyId),
  arbiterSetCap: (usd: number) => ipcRenderer.invoke('arbiter:setCap', usd),
  arbiterSetModel: (model: string) => ipcRenderer.invoke('arbiter:setModel', model),
  arbiterSetPaused: (paused: boolean) => ipcRenderer.invoke('arbiter:setPaused', paused),
  arbiterPoke: () => ipcRenderer.invoke('arbiter:poke'),
  catSetColor: (id: number, color: string) => ipcRenderer.invoke('cat:setColor', id, color),
  catReorder: (ids: number[]) => ipcRenderer.invoke('cat:reorder', ids),
  catSetEmoji: (id: number, emoji: string | null) => ipcRenderer.invoke('cat:setEmoji', id, emoji),
  // null clears the override, so the category inherits the global switch again.
  catSetNotify: (id: number, cls: 'permission' | 'question' | 'done', on: boolean | null) =>
    ipcRenderer.invoke('cat:setNotify', id, cls, on),
  // Remember a session's launch parameters. sticky=false still records them
  // (so the modal prefills next time) but keeps gating.
  resumeFlagsSet: (sessionId: string, flags: unknown, sticky: boolean) =>
    ipcRenderer.invoke('resume-flags:set', sessionId, flags, sticky),
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
  settingsInstallStatusHooks: () => ipcRenderer.invoke('settings:installStatusHooks'),
  settingsRemoveStatusHooks: () => ipcRenderer.invoke('settings:removeStatusHooks'),
  apiKeysList: () => ipcRenderer.invoke('apikeys:list'),
  apiKeysAdd: (name: string, rawKey: string) => ipcRenderer.invoke('apikeys:add', name, rawKey),
  apiKeysRemove: (id: number) => ipcRenderer.invoke('apikeys:remove', id),

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
    apiKeyId?: number
    resumeFlags?: ResumeFlags
    resumeSticky?: boolean
  }) => ipcRenderer.invoke('session:create', opts),
  sessionStartFresh: (cwd: string) => ipcRenderer.invoke('session:startFresh', cwd),
  sessionRemove: (sessionId: string) => ipcRenderer.invoke('session:remove', sessionId),
  sessionSpawnChild: (
    parentSessionId: string,
    cwd: string,
    type: 'blocking' | 'tangential',
    note?: string,
    name?: string,
    autoMode?: boolean,
    apiKeyId?: number,
    flags?: ResumeFlags,
    categoryId?: number | null,
  ) =>
    ipcRenderer.invoke(
      'session:spawnChild',
      parentSessionId,
      cwd,
      type,
      note,
      name,
      autoMode,
      apiKeyId,
      flags,
      categoryId,
    ),
  grantSet: (a: string, b: string, dir: 'both' | 'to' | 'from' | 'none') =>
    ipcRenderer.invoke('grant:set', a, b, dir) as Promise<boolean>,
  grantRevoke: (a: string, b: string) => ipcRenderer.invoke('grant:revoke', a, b) as Promise<boolean>,
  messageBody: (id: string) => ipcRenderer.invoke('message:body', id) as Promise<string | null>,
  messageResend: (id: string) =>
    ipcRenderer.invoke('message:resend', id) as Promise<{ ok: boolean; reason?: string }>,
  messageCancel: (id: string) =>
    ipcRenderer.invoke('message:cancel', id) as Promise<{ ok: boolean; reason?: string }>,
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
  // Read-only tail of each session's output, for the overview grid thumbnails.
  // Never attaches, so it can't disturb the live terminal underneath.
  termPeek: (sessionIds: string[]) =>
    ipcRenderer.invoke('term:peek', sessionIds) as Promise<{ sessionId: string; tail: string }[]>,
  termInput: (key: string, data: string) => ipcRenderer.send('term:input', key, data),
  termOpenPath: (key: string, path: string) => ipcRenderer.invoke('term:openPath', key, path),
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
  artifactOpen: (path: string) =>
    ipcRenderer.invoke('artifact:open', path) as Promise<{ ok: boolean }>,
  artifactReveal: (path: string) =>
    ipcRenderer.invoke('artifact:reveal', path) as Promise<{ ok: boolean }>,
  artifactRead: (path: string) =>
    ipcRenderer.invoke('artifact:read', path) as Promise<{
      ok: boolean
      dataUrl?: string
      text?: string
      tooBig?: boolean
    }>,
  termResize: (key: string, cols: number, rows: number) =>
    ipcRenderer.send('term:resize', key, cols, rows),
  termRedraw: (key: string) => ipcRenderer.send('term:redraw', key),
  termClose: (key: string) => ipcRenderer.send('term:close', key),
  onTermData: (cb: (p: { key: string; data: string }) => void) => sub('term:data', cb),
  onTermExit: (cb: (p: { key: string; code: number }) => void) => sub('term:exit', cb),
  onSessionsRemoved: (cb: (p: { ids: string[] }) => void) => sub('session:removed', cb),
  onTermShow: (cb: (p: { key: string; pid?: number; name: string; cwd: string }) => void) =>
    sub('term:show', cb),
  onTermRecover: (cb: (p: { key: string; sessionId: string; cwd: string }) => void) =>
    sub('term:recover', cb),
})
