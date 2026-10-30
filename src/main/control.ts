// The control handlers behind window.ccc (src/shared/ipc.ts). Each checks its
// sender (the app's own top frame) and its arguments before acting; the
// renderer is treated as able to send anything.

import { BrowserWindow, clipboard, dialog, ipcMain, shell, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron'
import {
  quotePath,
  ResumedAsCopy,
  WorkspaceNotTrusted,
  type AttachPool,
  type ChannelHub,
  type SessionControl,
  type SessionHost,
  type TrustRuns,
} from '@ccc/coupling'
import type { SessionSnapshot } from '@ccc/contract'
import type { SessionMeta } from '../shared/store.ts'
import { copyRefusal, movePreflight, terminalMessage } from './move.ts'
import { ModStuck, ResumeGate, resumeFromApp } from './resume.ts'
import { IPC, type LaunchRequest, type Result } from '../shared/ipc.ts'
import { lookup as dnsLookup } from 'node:dns/promises'
import { openTerminalLink, type LinkResult } from './policy.ts'
import { isTrustedSender } from './security.ts'
import { checkAnswer, checkLaunch, droppedPaths, isSessionId, isSize, isText } from './validate.ts'

function fail(err: unknown): Result {
  if (err instanceof WorkspaceNotTrusted) return { ok: false, error: err.message, kind: 'untrusted', variant: err.variant }
  if (err instanceof ResumedAsCopy) return { ok: false, error: err.message, kind: 'copy' }
  if (err instanceof ModStuck) return { ok: false, error: err.message, kind: 'mod-stuck' }
  return { ok: false, error: err instanceof Error ? err.message : String(err) }
}

/** Channels that act on sessions: refused while the app is read-only. */
const WRITES = new Set<string>([IPC.launch, IPC.startCopy, IPC.moveIn, IPC.resume, IPC.stop, IPC.answer, IPC.sendPrompt, IPC.focusOpen, IPC.trustStart])

export interface ControlDeps {
  host: SessionHost
  hub: ChannelHub
  control: SessionControl
  pool: AttachPool
  trust: TrustRuns
  /** Below the Claude Code floor the app is read-only (MIP2-1406). */
  readOnly: () => string | null
  /** Activity for the lifecycle (MIP2-1410): a resume. */
  onActivity?: (sessionId: string) => void
  /** A launch or copy here: its settings and source (MIP2-1407). */
  onLaunched?: (sessionId: string, req: LaunchRequest, source: { copyOf?: string; fromSession?: string }) => void
  /** QA only (paths.ts qaPickPaths): ⌘O inserts these instead of opening the panel. */
  qaPickPaths?: string[] | null
  /** A 0.24 session's folder, name and saved launch settings, already checked; null when the app doesn't know it (MIP2-1425). */
  moveTarget?: (sessionId: string) => LaunchRequest | null
  /** A move finished: the old id and the session it became. */
  onMoved?: (from: string, to: string, sameId: boolean) => void
  /** The app's record of a session, for the move preflight (pass 8, M-2). */
  metaOf?: (sessionId: string) => SessionMeta | undefined
  /** The session as last polled, for checks before acting on it. */
  snapshotOf?: (sessionId: string) => SessionSnapshot | undefined
  /** A session's current id for the id it was launched under before a /clear; resume and stop act on it (MIP2-1557). */
  currentIdOf?: (sessionId: string) => string | undefined
  /** The app launched it, so its mod will report (MIP2-1434 follow-up). */
  launchedHere?: (sessionId: string) => boolean
  /** A resume from the app re-keyed its channel: the app's copy of the untrusted mark is cleared (pass 4, M-2). */
  onRekeyed?: (sessionId: string) => void
  /** Why the session's mod copy can't be resumed on, or null (pass 6, H-1). */
  modStuck?: (sessionId: string) => string | null
  /** App-launched with no record of its mod copy: found from its saved options and checked first (MIP2-1504). */
  unrecorded?: (sessionId: string) => boolean
  backfill?: (sessionId: string) => string | null
  /** The terminal app a process runs under, or null (MIP2-1466). */
  terminalHost?: (pid: number) => Promise<string | null>
  /** A resume from the app started a copy (Claude Code's note says so): kept visible and alerted on (MIP2-1467). */
  onResumedAsCopy?: (sessionId: string, copyShortId: string) => void
}

export function registerControl({
  host,
  hub,
  control,
  pool,
  trust,
  readOnly,
  onActivity = () => {},
  onLaunched = () => {},
  qaPickPaths = null,
  moveTarget = () => null,
  onMoved = () => {},
  snapshotOf = () => undefined,
  currentIdOf = () => undefined,
  metaOf = () => undefined,
  launchedHere = () => false,
  onRekeyed = () => {},
  modStuck = () => null,
  unrecorded = () => false,
  backfill = () => null,
  onResumedAsCopy = () => {},
  terminalHost = async () => null,
}: ControlDeps): void {
  // One resume per session at a time, and none again right after one (MIP2-1467).
  const resumes = new ResumeGate()
  const invoke = <A extends unknown[], R>(channel: string, fn: (...args: A) => Promise<R>, refused: R) =>
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!isTrustedSender(event)) return refused
      const why = WRITES.has(channel) ? readOnly() : null
      if (why) return { ok: false, error: why }
      return fn(...(args as A))
    })
  const on = <A extends unknown[]>(channel: string, fn: (...args: A) => void) =>
    ipcMain.on(channel, (event: IpcMainEvent, ...args: unknown[]) => {
      if (isTrustedSender(event as unknown as IpcMainInvokeEvent)) fn(...(args as A))
    })
  const untrusted: Result = { ok: false, error: 'untrusted sender' }

  invoke(IPC.launch, async (req: unknown) => {
    const r = checkLaunch(req)
    if (!r) return { ok: false, error: 'bad launch request' }
    try {
      const { fromSession, ...opts } = r
      const launched = await host.launch(opts)
      onLaunched(launched.sessionId, r, fromSession ? { fromSession } : {})
      return { ok: true, ...launched }
    } catch (err) {
      return fail(err)
    }
  }, untrusted)

  // A copy with new settings; the folder is the session's own (MIP2-1387 §2.3).
  invoke(IPC.startCopy, async (id: unknown, req: unknown) => {
    const r = checkLaunch({ ...(typeof req === 'object' && req ? req : {}), cwd: '/' })
    if (!isSessionId(id) || !r) return { ok: false, error: 'bad request' }
    const why = copyRefusal(snapshotOf(id), launchedHere(id))
    if (why) return { ok: false, error: why }
    try {
      const { cwd: _cwd, prompt: _prompt, fromSession: _from, ...opts } = r
      const copy = await host.startCopy(id, opts)
      onLaunched(copy.sessionId, r, { copyOf: id })
      return { ok: true, ...copy }
    } catch (err) {
      return fail(err)
    }
  }, untrusted)

  // Moving a 0.24 session in (MIP2-1425): only once its process there has exited; host.moveIn checks again.
  // The same checks for the move sheet and the trust step's resume (pass 8, M-2).
  const preflight = (id: string) => movePreflight(metaOf(id), snapshotOf(id), hub.untrustedReason(id))
  invoke(IPC.moveIn, async (id: unknown) => {
    if (!isSessionId(id)) return { ok: false, error: 'not a session id' }
    const refused = preflight(id)
    if (refused) return { ok: false, error: refused }
    const target = moveTarget(id)
    if (!target) return { ok: false, error: "the app doesn't know this session's folder" }
    try {
      const { cwd, name, model, effort, permissionMode, isolation } = target
      const moved = await host.moveIn(id, { cwd, name, model, effort, permissionMode, isolation })
      onMoved(id, moved.sessionId, moved.sameId)
      return { ok: true, ...moved }
    } catch (err) {
      return fail(err)
    }
  }, untrusted)

  invoke(IPC.copyLastOutput, async (id: unknown): Promise<Result> => {
    if (!isSessionId(id)) return { ok: false, error: 'not a session id' }
    const post = hub.lastAnswer(id)
    if (!post) return { ok: false, error: "Nothing to copy yet. It's kept from the next turn that ends while the app is open." }
    clipboard.writeText(post.text)
    return { ok: true }
  }, untrusted)

  for (const [channel, act] of [
    [
      IPC.resume,
      async (id: string) => {
        // A job still listed and waiting on something in the session has no process to wake: a resume would start a
        // second job beside it (QA MIP2-1559, r8). Opening it attaches, where Alex answers (MIP2-1558).
        if (snapshotOf(id)?.jobNeeds) throw new Error("it's waiting on something in the session. Open it to answer there; resuming would start a copy beside it")
        await resumes
          .run(id, () => resumeFromApp(id, { host, hub, onRekeyed, modStuck, unrecorded, backfill }))
          .catch(err => {
            if (err instanceof ResumedAsCopy) onResumedAsCopy(id, err.copyId)
            throw err
          })
        onActivity(id)
      },
    ],
    [IPC.stop, (id: string) => host.stop(id)],
  ] as const) {
    invoke(channel, async (given: unknown) => {
      if (!isSessionId(given)) return { ok: false, error: 'not a session id' }
      const id = currentIdOf(given) ?? given
      try {
        await act(id)
        return { ok: true }
      } catch (err) {
        return fail(err)
      }
    }, untrusted)
  }

  invoke(IPC.answer, async (requestId: unknown, answer: unknown) => {
    const a = checkAnswer(answer)
    if (!isSessionId(requestId) || !a) return { ok: false, error: 'bad answer' }
    const r = hub.answer(requestId, a)
    if (r === 'session-only') return { ok: false, error: "the card can't show all of it; answer it in the session" }
    return r ? { ok: true } : { ok: false, error: 'the prompt was already answered or has ended' }
  }, untrusted)

  invoke(IPC.sendPrompt, async (id: unknown, text: unknown) => {
    if (!isSessionId(id) || !isText(text) || text.trim() === '') return { ok: false, error: 'bad prompt' }
    try {
      await control.sendPrompt(id, text)
      return { ok: true }
    } catch (err) {
      return fail(err)
    }
  }, untrusted)

  invoke(IPC.chooseFolder, async () => {
    const win = BrowserWindow.getFocusedWindow()
    const opts = { properties: ['openDirectory' as const, 'createDirectory' as const] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return r.canceled ? null : (r.filePaths[0] ?? null)
  }, null)

  invoke(IPC.focusOpen, async (id: unknown, cols: unknown, rows: unknown) => {
    if (!isSessionId(id) || !isSize(cols) || !isSize(rows)) return { ok: false, error: 'bad request' }
    // An interactive session running in a terminal can't be attached to: say where it runs, and offer the move
    // (MIP2-1466). The app never ends that process.
    const s = snapshotOf(id)
    if (s?.kind.value === 'interactive' && s.pid.value !== null && !s.pid.stale && metaOf(id)?.origin !== 'app') {
      return { ok: false, error: terminalMessage(await terminalHost(s.pid.value).catch(() => null), s.startedAt.value), kind: 'terminal' }
    }
    try {
      await pool.open(id, cols, rows)
      return { ok: true }
    } catch (err) {
      return fail(err)
    }
  }, untrusted)

  on(IPC.focusInput, (id: unknown, data: unknown) => {
    if (isSessionId(id) && isText(data)) pool.write(id, data)
  })
  on(IPC.focusResize, (id: unknown, cols: unknown, rows: unknown) => {
    if (isSessionId(id) && isSize(cols) && isSize(rows)) pool.resize(id, cols, rows)
  })
  // A link clicked in a session's terminal view: the steps are in policy.ts, openTerminalLink.
  invoke(IPC.openLink, async (url: unknown, text: unknown, atEdge: unknown): Promise<LinkResult> => {
    if (typeof url !== 'string' || (text !== undefined && (typeof text !== 'string' || text.length > 4096))) return { ok: false, error: 'bad request' }
    return openTerminalLink(url, text, atEdge === true, {
      ask: async (message, detail) => {
        const win = BrowserWindow.getFocusedWindow()
        const opts = { type: 'warning' as const, buttons: ['Cancel', 'Open'], defaultId: 0, cancelId: 0, message, detail }
        const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts)
        return response === 1
      },
      lookup: h => dnsLookup(h, { all: true }),
      open: href => shell.openExternal(href),
    })
  }, untrusted)
  on(IPC.copyText, (text: unknown) => {
    if (isText(text) && text !== '') clipboard.writeText(text)
  })
  on(IPC.focusLeave, (id: unknown) => {
    if (isSessionId(id)) pool.leave(id)
  })
  // Text, or (from a drop) a list of paths to insert as quoted words.
  on(IPC.focusPaste, (id: unknown, text: unknown, submit: unknown, paths: unknown) => {
    if (!isSessionId(id)) return
    if (Array.isArray(paths)) {
      const ok = droppedPaths(paths)
      if (ok.length) pool.paste(id, ok.map(quotePath).join(' ') + ' ', false)
      return
    }
    if (isText(text)) pool.paste(id, text, submit === true)
  })
  invoke(IPC.focusPickPaths, async (id: unknown) => {
    if (!isSessionId(id) || !pool.has(id)) return 0
    if (qaPickPaths) {
      pool.paste(id, qaPickPaths.map(quotePath).join(' ') + ' ', false)
      return qaPickPaths.length
    }
    const win = BrowserWindow.getFocusedWindow()
    const opts = { properties: ['openFile' as const, 'openDirectory' as const, 'multiSelections' as const] }
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    if (r.canceled || r.filePaths.length === 0) return 0
    pool.paste(id, r.filePaths.map(quotePath).join(' ') + ' ', false)
    return r.filePaths.length
  }, 0)

  // The trust step: the same launch, in a terminal view, on Alex's click (MIP2-1388).
  invoke(IPC.trustStart, async (req: unknown, cols: unknown, rows: unknown) => {
    const r0 = checkLaunch(req)
    if (!r0 || !isSize(cols) || !isSize(rows)) return { ok: false, error: 'bad request' }
    // A resume's trust run is a move: the same preflight, and the move's own request (MIP2-1461; pass 8, M-2).
    const refused = r0.resume ? preflight(r0.resume) : null
    if (refused) return { ok: false, error: refused }
    const target = r0.resume ? moveTarget(r0.resume) : null
    if (r0.resume && !target) return { ok: false, error: "the app doesn't know this session's folder" }
    const r = target ? { ...target, resume: r0.resume } : r0
    try {
      return { ok: true, runId: await trust.start(r, cols, rows) }
    } catch (err) {
      return fail(err)
    }
  }, untrusted)
  on(IPC.trustInput, (id: unknown, data: unknown) => {
    if (isSessionId(id) && isText(data)) trust.write(id, data)
  })
  on(IPC.trustResize, (id: unknown, cols: unknown, rows: unknown) => {
    if (isSessionId(id) && isSize(cols) && isSize(rows)) trust.resize(id, cols, rows)
  })
  on(IPC.trustCancel, (id: unknown) => {
    if (isSessionId(id)) trust.cancel(id)
  })
}
