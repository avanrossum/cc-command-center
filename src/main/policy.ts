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

/** The longest link a terminal click may open. */
const LINK_MAX = 2048

/**
 * Whether `host` (a URL's hostname) is this machine or its local network:
 * loopback, link-local, RFC 1918, CGNAT (100.64/10, which Tailscale uses for
 * the user's own devices) and IPv6 unique-local, in every form the URL parser
 * writes, a trailing dot included. A plain-http link there can send a GET to
 * a local developer tool (pass 9, M-3; pass 10, M-1). Names are checked by
 * `hostReach`.
 */
export function isPrivateHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  if (h === 'localhost' || h.endsWith('.localhost')) return true
  const v4 = (text: string) => {
    const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text)
    if (!m) return null
    const [a, b] = [Number(m[1]), Number(m[2])]
    return a === 0 || a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127)
  }
  const plain = v4(h)
  if (plain !== null) return plain
  if (!h.includes(':')) return false
  if (h === '::1' || h === '::') return true
  // IPv4-mapped and IPv4-compatible, dotted as a resolver may write them (::ffff:127.0.0.1, pass 11, L-4).
  const dotted = /^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/.exec(h)
  if (dotted) return v4(dotted[1] as string) === true
  // And in hex, as the URL parser writes them (::ffff:7f00:1, ::7f00:1).
  const embedded = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h)
  if (embedded) {
    const hi = parseInt(embedded[1] as string, 16)
    const lo = parseInt(embedded[2] as string, 16)
    return v4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`) === true
  }
  return /^fe[89ab][0-9a-f]?:/.test(h) || /^f[cd][0-9a-f]{0,2}:/.test(h)
}

/**
 * Where a host name points, for a plain-http link (pass 10, M-1): `private`
 * when any address is this machine or the local network (`localtest.me`,
 * `127.0.0.1.nip.io`), `public` when none is, and `unknown` when the lookup
 * fails or takes longer than timeoutMs. Unknown isn't taken as public: a
 * nameserver that answers late, with a private address the browser then
 * finds cached, would otherwise get through, so the caller asks (pass 12,
 * M-3). The browser resolves again when it opens the link, so a name that
 * rebinds between the two lookups gets through: that residual is accepted.
 */
export async function hostReach(host: string, lookup: (host: string) => Promise<{ address: string }[]>, timeoutMs = 2_000): Promise<'private' | 'public' | 'unknown'> {
  const h = host.replace(/^\[|\]$/g, '')
  if (/^[\d.]+$/.test(h) || h.includes(':')) return isPrivateHost(h) ? 'private' : 'public'
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>(resolve => (timer = setTimeout(() => resolve(null), timeoutMs)))
  try {
    const addresses = await Promise.race([lookup(h), late])
    if (addresses === null) return 'unknown'
    return addresses.some(a => isPrivateHost(a.address)) ? 'private' : 'public'
  } catch {
    return 'unknown'
  } finally {
    clearTimeout(timer)
  }
}

/**
 * A link clicked in a session's terminal view, checked (MIP2-1471; pass 9,
 * M-3 and L-1). Session output is untrusted text, and an OSC 8 link's text
 * can differ from its target, so only `https` and `http` open, in the
 * default browser. No `file:`, `javascript:` or app schemes; no user or
 * password part, which can make `https://github.com@evil.example` read as
 * GitHub; and no plain `http` to this machine or the local network. The
 * parsed `href` is what opens, so the string checked is the string opened.
 * Window opens and artifact links stay https only.
 */
export function checkTerminalLink(url: string): { ok: true; href: string; host: string } | { ok: false; error: string } {
  if (url.length > LINK_MAX) return { ok: false, error: 'the link is too long to open' }
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return { ok: false, error: "that isn't a web address" }
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return { ok: false, error: `${u.protocol.replace(/:$/, '')} links don't open from the terminal; only web (http and https) links do` }
  if (u.username !== '' || u.password !== '') return { ok: false, error: "links with a user name or password in them don't open from the terminal" }
  if (u.protocol === 'http:' && isPrivateHost(u.hostname)) return { ok: false, error: `plain http links to this Mac or the local network (${u.hostname}) don't open from the terminal` }
  return { ok: true, href: u.href, host: u.hostname }
}

/**
 * The link text as it reads (pass 10, M-2; pass 11, M-1 and L-1): NFKC,
 * without format characters or other default-ignorable code points (the
 * combining grapheme joiner, variation selectors, Mongolian selectors), and
 * with the ideographic and full-width full stops the URL parser reads as dots
 * turned into dots. This is a best-effort aid; the hover tip that shows the
 * real target is the control.
 */
function visible(text: string): string {
  return text
    .normalize('NFKC')
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
    .replace(/[\u3002\uff0e\uff61]/g, '.')
}

/**
 * The first host a link's visible text names (`github.com`,
 * `https://x.example/y`, `**github.com**`, `see:github.com`), or null. The
 * text is normalized first, and a host may sit after any character that
 * isn't a letter, digit, dot or hyphen in any script (pass 10, M-2).
 */
export function textHost(text: string): string | null {
  const m = /(?<![\p{L}\p{M}\p{N}.-])(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^\s/@]+@)?((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}|\[[0-9a-f:.]+\]|\d{1,3}(?:\.\d{1,3}){3})(?![\p{L}\p{N}-])/iu.exec(visible(text))
  if (!m) return null
  try {
    return new URL(`http://${m[1]}`).hostname
  } catch {
    return null
  }
}

/** Dotted words in the text with letters outside ASCII (`gіthub.com` with a Cyrillic і), as the hosts they'd be. */
function lookalikeHosts(text: string): string[] {
  const out: string[] = []
  for (const m of visible(text).matchAll(/[\p{L}\p{M}\p{N}-]+(?:\.[\p{L}\p{M}\p{N}-]+)+/gu)) {
    if (!/[^\x00-\x7f]/.test(m[0])) continue
    try {
      out.push(new URL(`http://${m[0]}`).hostname)
    } catch {
      out.push(m[0])
    }
  }
  return out
}

/**
 * The question to ask before opening, or null (pass 9, M-3; pass 10, M-2;
 * MIP2-1472): when the link's visible text names a host other than the one
 * it opens, when it holds a host-like word in non-ASCII letters whose
 * punycode isn't the target, or when the text touches the terminal's edge
 * and so may continue on the next line, where it can't be read. `www.` on
 * either side doesn't count as a difference.
 */
export function linkMismatch(text: string | undefined, host: string, atEdge = false): string | null {
  if (!text) return null
  const bare = (h: string) => h.toLowerCase().replace(/^www\./, '').replace(/\.$/, '')
  const shown = textHost(text)
  if (shown && bare(shown) !== bare(host)) return `This link's text says ${shown}, but it opens ${host}.`
  const lookalike = lookalikeHosts(text).find(h => bare(h) !== bare(host))
  if (lookalike) return `This link's text has the look-alike name ${lookalike}, but it opens ${host}.`
  if (atEdge) return `This link's text runs to the edge of the terminal, so all of it can't be read here. It opens ${host}.`
  return null
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

/**
 * What a plain-http link's host lookup means (pass 14, L-2): `refuse` for
 * this Mac or the local network (pass 10, M-1), `ask` when it couldn't be
 * checked (pass 12, M-3), `open` for a public address.
 */
export function reachDecision(reach: 'private' | 'public' | 'unknown'): 'refuse' | 'ask' | 'open' {
  return reach === 'private' ? 'refuse' : reach === 'unknown' ? 'ask' : 'open'
}

export interface LinkDeps {
  /** Shows a warning with Cancel and Open; true for Open. */
  ask: (message: string, detail: string) => Promise<boolean>
  lookup: (host: string) => Promise<{ address: string }[]>
  open: (href: string) => Promise<void>
}

export type LinkResult = { ok: true } | { ok: false; error: string; canceled?: true }

/**
 * A link clicked in a session's terminal view (MIP2-1471; pass 9, M-3,
 * L-1): web links only, in the default browser. In order: the link's own
 * check; a question when its text names another host than it opens; then,
 * for plain http only, where the name points. The lookup comes after any
 * question, so a canceled link is never looked up (pass 11, L-3).
 */
export async function openTerminalLink(url: string, text: string | undefined, atEdge: boolean, deps: LinkDeps): Promise<LinkResult> {
  const link = checkTerminalLink(url)
  if (!link.ok) return link
  const canceled = { ok: false, error: 'canceled', canceled: true } as const
  const mismatch = linkMismatch(text, link.host, atEdge)
  if (mismatch !== null && !(await deps.ask(mismatch, link.href))) return canceled
  if (link.href.startsWith('http:')) {
    const decision = reachDecision(await hostReach(link.host, deps.lookup))
    if (decision === 'refuse') return { ok: false, error: `plain http links to this Mac or the local network (${link.host}) don't open from the terminal` }
    if (decision === 'ask' && !(await deps.ask(`The app couldn't check where ${link.host} points. It may be this Mac or the local network.`, link.href))) return canceled
  }
  try {
    await deps.open(link.href)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
