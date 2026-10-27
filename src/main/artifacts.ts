// The artifact drawer's main side (MIP2-1412; spec MIP2-1370 §10.2). The
// window asks for a file a session reported writing; main reads it, builds
// the preview page (artifact-preview.ts), and serves it once on its own
// scheme to a sandboxed iframe. Opening is only for files the session
// reported, or an https link.

import { randomBytes } from 'node:crypto'
import { lstatSync, readFileSync, statSync } from 'node:fs'
import type { FleetSnapshot } from '@ccc/contract'
import { ipcMain, protocol, shell, type IpcMainInvokeEvent } from 'electron'
import { IPC, type Result } from '../shared/ipc.ts'
import { ARTIFACT_SCHEME, buildPreview, openVerdict, PREVIEW_CSP, PREVIEW_MAX_BYTES, recheckBeforeOpen } from './artifact-preview.ts'
import { isAllowedExternal } from './policy.ts'
import { isTrustedSender } from './security.ts'
import { isSessionId } from './validate.ts'

/** A preview page lives this long after it's made; the iframe loads it at once. */
const PAGE_TTL_MS = 60_000

/** Whether `path` is a file the session reported writing. */
export function reportedFile(fleet: FleetSnapshot | null, sessionId: string, path: string): boolean {
  const s = fleet?.sessions.find(x => x.sessionId === sessionId)
  return Boolean(s?.filesWritten?.value.some(w => w.path === path && w.url === null))
}

export function registerArtifacts(current: () => FleetSnapshot | null): void {
  const pages = new Map<string, { html: string; at: number }>()

  protocol.handle(ARTIFACT_SCHEME, request => {
    const token = new URL(request.url).pathname.replace(/^\//, '')
    const page = pages.get(token)
    pages.delete(token)
    if (!page || Date.now() - page.at > PAGE_TTL_MS) return new Response('Gone', { status: 410 })
    return new Response(page.html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': PREVIEW_CSP,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-store',
      },
    })
  })

  const untrusted: Result = { ok: false, error: 'untrusted sender' }
  const invoke = <A extends unknown[], R>(channel: string, fn: (...args: A) => R | Promise<R>, refused: R) =>
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => (isTrustedSender(event) ? fn(...(args as A)) : refused))

  invoke(IPC.artifactPreview, (sessionId: unknown, path: unknown, raw: unknown): Result<{ url: string; open: string | null }> | Result => {
    if (!isSessionId(sessionId) || typeof path !== 'string' || !reportedFile(current(), sessionId, path)) return { ok: false, error: 'not a file this session wrote' }
    let bytes: Buffer | null = null
    try {
      const size = statSync(path).size
      bytes = size > PREVIEW_MAX_BYTES ? Buffer.alloc(PREVIEW_MAX_BYTES + 1) : readFileSync(path)
    } catch {
      bytes = null
    }
    const { html, open } = buildPreview({ path, bytes, raw: raw === true })
    for (const [k, v] of pages) if (Date.now() - v.at > PAGE_TTL_MS) pages.delete(k)
    const token = randomBytes(16).toString('hex')
    pages.set(token, { html, at: Date.now() })
    return { ok: true, url: `${ARTIFACT_SCHEME}://view/${token}`, open }
  }, untrusted)

  // Reveal in Finder, for a file the session reported writing (spec §10.2, from 0.24).
  invoke(IPC.artifactReveal, (sessionId: unknown, path: unknown): Result => {
    if (!isSessionId(sessionId) || typeof path !== 'string' || !reportedFile(current(), sessionId, path)) return { ok: false, error: 'not a file this session wrote' }
    shell.showItemInFolder(path)
    return { ok: true }
  }, untrusted)

  invoke(IPC.artifactOpen, async (sessionId: unknown, target: unknown, confirmed: unknown): Promise<Result | { ok: false; error: string; confirm: string }> => {
    if (typeof target !== 'string') return { ok: false, error: 'bad request' }
    // A published artifact's link: https only (the openExternal allowlist).
    if (/^[a-z]+:\/\//i.test(target)) {
      if (!isAllowedExternal(target)) return { ok: false, error: 'only https links open' }
      await shell.openExternal(target)
      return { ok: true }
    }
    if (!isSessionId(sessionId) || !reportedFile(current(), sessionId, target)) return { ok: false, error: 'not a file this session wrote' }
    // Never a launcher, a script with the execute bit, a bundle or a link; ask first for an unknown type (gate M-3).
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(target)
    } catch {
      return { ok: false, error: "the file isn't there any more" }
    }
    const verdict = openVerdict(target, st)
    if (verdict.kind === 'refuse') return { ok: false, error: verdict.why }
    if (verdict.kind === 'confirm' && confirmed !== true) return { ok: false, error: `Open this ${verdict.type} in its default app?`, confirm: verdict.type }
    // Right before opening, the path must still be the file just checked (gate run 2 and 3, L-2, L-3).
    const real = recheckBeforeOpen(target, st)
    if (typeof real !== 'string') return { ok: false, error: real.error }
    const err = await shell.openPath(real)
    return err ? { ok: false, error: err } : { ok: true }
  }, untrusted)
}
