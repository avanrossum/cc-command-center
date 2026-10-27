// The renderer-security rules as plain functions, so they're tested without
// Electron (DECISION item 8). security.ts applies them.

import { isAbsolute, relative, resolve } from 'node:path'

/** The app's own pages are served from this origin; nothing else is trusted. */
export const APP_SCHEME = 'app'
export const APP_HOST = 'ccc'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`

export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  // xterm.js draws colors through <style> elements and style attributes it
  // generates at run time, with no nonce option (MIP2-1389, D-004 here).
  // Inline styles can't load anything: img-src, font-src and connect-src
  // stay closed to everything but the app.
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'none'",
  "object-src 'none'",
  // Artifact previews only, each a page with its own strict CSP (MIP2-1412).
  'frame-src ccc-artifact:',
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

/** Schemes `shell.openExternal` may open. Everything else is refused. */
const EXTERNAL_SCHEMES = new Set(['https:'])

export function isAllowedExternal(url: string): boolean {
  try {
    return EXTERNAL_SCHEMES.has(new URL(url).protocol)
  } catch {
    return false
  }
}

/** True when a URL belongs to the app's own origin. */
export function isAppUrl(url: string | undefined | null): boolean {
  if (!url) return false
  try {
    const u = new URL(url)
    return u.protocol === `${APP_SCHEME}:` && u.host === APP_HOST
  } catch {
    return false
  }
}

/**
 * Maps an app:// request to a file under `root`, or null when the path
 * leaves `root` or the host isn't the app's.
 */
export function resolveAppPath(root: string, requestUrl: string): string | null {
  let u: URL
  let pathname: string
  try {
    u = new URL(requestUrl)
    pathname = decodeURIComponent(u.pathname)
  } catch {
    return null
  }
  if (u.protocol !== `${APP_SCHEME}:` || u.host !== APP_HOST) return null
  const file = resolve(root, '.' + (pathname === '/' ? '/index.html' : pathname))
  const rel = relative(root, file)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return file
}
