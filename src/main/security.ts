// The renderer-security baseline (DECISION item 8), applied before any
// window opens: sandboxed renderers, the app's own origin served with a
// strict CSP, every permission denied, no navigation, no remote requests,
// IPC accepted only from the app's own top frame, and `openExternal` limited
// to an allowlist of schemes.

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { app, protocol, session, shell, type IpcMainInvokeEvent, type WebContents } from 'electron'
import { ARTIFACT_SCHEME } from './artifact-preview.ts'
import { APP_SCHEME, CONTENT_SECURITY_POLICY, isAllowedExternal, isAppUrl, resolveAppPath } from './policy.ts'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
}

/** Must run before `app` is ready. */
export function applyBeforeReady(): void {
  app.enableSandbox()
  protocol.registerSchemesAsPrivileged([
    { scheme: APP_SCHEME, privileges: { standard: true, secure: true } },
    // Artifact previews (MIP2-1412): served by main, framed sandboxed.
    { scheme: ARTIFACT_SCHEME, privileges: { standard: true, secure: true } },
  ])
  app.on('web-contents-created', (_event, contents) => hardenContents(contents))
}

/** Runs once `app` is ready. `rendererRoot` is the folder of built renderer files. */
export function applyWhenReady(rendererRoot: string): void {
  const ses = session.defaultSession

  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  ses.setPermissionCheckHandler(() => false)
  ses.setDevicePermissionHandler(() => false)

  // No remote content: the renderer loads only app:// files.
  ses.webRequest.onBeforeRequest(
    { urls: ['http://*/*', 'https://*/*', 'ws://*/*', 'wss://*/*', 'file://*/*'] },
    (_details, callback) => callback({ cancel: true }),
  )

  protocol.handle(APP_SCHEME, async request => {
    const file = resolveAppPath(rendererRoot, request.url)
    if (!file) return new Response('Not found', { status: 404 })
    try {
      const body = await readFile(file)
      return new Response(body, {
        headers: {
          'Content-Type': MIME[extname(file)] ?? 'application/octet-stream',
          'Content-Security-Policy': CONTENT_SECURITY_POLICY,
          'X-Content-Type-Options': 'nosniff',
          // A rebuilt or updated app must never run a cached older renderer.
          'Cache-Control': 'no-store',
        },
      })
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

function hardenContents(contents: WebContents): void {
  contents.on('will-navigate', event => event.preventDefault())
  // A frame may load only an artifact preview; nothing inside one navigates (MIP2-1412).
  contents.on('will-frame-navigate', details => {
    if (!details.isMainFrame && !details.url.startsWith(`${ARTIFACT_SCHEME}://`)) details.preventDefault()
  })
  contents.on('will-redirect', event => event.preventDefault())
  contents.on('will-attach-webview', event => event.preventDefault())
  contents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternal(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
}

/** IPC is answered only for the app's own top-level frame. */
export function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  const frame = event.senderFrame
  if (!frame || frame.parent !== null) return false
  return isAppUrl(frame.url)
}
