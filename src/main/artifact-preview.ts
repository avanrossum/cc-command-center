// Artifact previews (MIP2-1412; spec MIP2-1370 §10.2; DECISION item 8,
// D-007, D-019). Pure, so a hostile file is tested without Electron.
//
// Every preview is a page this module builds and main serves on its own
// scheme (ARTIFACT_SCHEME), loaded in an iframe with `sandbox=""`: no
// script, an opaque origin, no preload, no IPC. Its CSP has no
// `unsafe-inline` (D-019): the one stylesheet is allowed by its hash.
// Defense in depth: the content is also escaped or confined before it gets
// there.
// - Markdown: escaped first, then a small set of block and inline forms.
//   Links show as text with their address; nothing in a preview navigates.
// - SVG and images: only as <img> with a data: URL, where SVG script never runs.
// - Text and code: escaped in <pre>.
// - Anything else: an Open card, opened outside the app.

import { createHash } from 'node:crypto'
import { lstatSync, realpathSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'

export const ARTIFACT_SCHEME = 'ccc-artifact'
/** Larger files get the "Too large" card (Electron's limit for inline previews). */
export const PREVIEW_MAX_BYTES = 2 * 1024 * 1024

export type PreviewKind = 'markdown' | 'svg' | 'image' | 'text' | 'html' | 'pdf' | 'office' | 'binary'

const KINDS: Record<string, PreviewKind> = {
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.svg': 'svg',
  '.png': 'image',
  '.jpg': 'image',
  '.jpeg': 'image',
  '.gif': 'image',
  '.webp': 'image',
  '.html': 'html',
  '.htm': 'html',
  '.pdf': 'pdf',
  '.docx': 'office',
  '.doc': 'office',
  '.xlsx': 'office',
  '.xls': 'office',
  '.pptx': 'office',
  '.ppt': 'office',
  '.pages': 'office',
  '.numbers': 'office',
  '.key': 'office',
}

const TEXT = new Set(['.txt', '.json', '.jsonl', '.ts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.py', '.rb', '.go', '.rs', '.swift', '.java', '.kt', '.c', '.h', '.cpp', '.css', '.scss', '.yaml', '.yml', '.toml', '.ini', '.sh', '.zsh', '.bash', '.csv', '.tsv', '.log', '.xml', '.sql', '.cls', '.trigger', '.env.example', ''])

const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' }

export function kindOf(path: string): PreviewKind {
  const ext = extname(path).toLowerCase()
  return KINDS[ext] ?? (TEXT.has(ext) ? 'text' : 'binary')
}

/** Electron's copy for the Open card (spec §10.2). */
export const OPEN_COPY: Record<'html' | 'pdf' | 'office' | 'binary' | 'large' | 'unreadable', string> = {
  html: 'Opens in your browser.',
  pdf: 'PDF — open to view it.',
  office: 'Opens in your default app.',
  binary: 'Opens in your default app.',
  large: 'Too large to preview inline.',
  unreadable: 'Could not read this file.',
}

const STYLE = `body{margin:0;padding:16px 20px;font:13px/1.55 -apple-system,system-ui,sans-serif;color:#e8e4dc;background:#0b0d12;word-wrap:break-word}
pre,code{font:12px/1.5 ui-monospace,Menlo,monospace}pre{white-space:pre-wrap;background:#14161c;padding:10px;border-radius:6px;margin:8px 0}
code{background:#14161c;padding:1px 4px;border-radius:3px}pre code{background:none;padding:0}h1,h2,h3,h4{margin:14px 0 6px;line-height:1.25}
h1{font-size:20px}h2{font-size:17px}h3{font-size:15px}blockquote{margin:8px 0;padding-left:10px;border-left:3px solid #48433a;color:#b6afa1}
.href{color:#8a919d;font:11px ui-monospace,Menlo,monospace}img{max-width:100%;height:auto;display:block;margin:0 auto}
.card{margin:40px auto;max-width:360px;text-align:center;color:#b6afa1}`

const STYLE_HASH = createHash('sha256').update(STYLE).digest('base64')

/** The preview page's CSP: nothing but its own hashed style and data: images. No script at all. */
export const PREVIEW_CSP = [
  "default-src 'none'",
  `style-src 'sha256-${STYLE_HASH}'`,
  'img-src data:',
  "base-uri 'none'",
  "form-action 'none'",
  // Only the app's own window may frame it.
  'frame-ancestors app://ccc',
  // The CSP sandbox, on top of the iframe's own sandbox attribute.
  'sandbox',
].join('; ')

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

function page(body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>${STYLE}</style></head><body>${body}</body></html>`
}

/** Inline forms on already-escaped text: code spans, bold, italic, and links as text with their address. */
function inline(escaped: string): string {
  const codes: string[] = []
  let t = escaped.replace(/`([^`]+)`/g, (_m, c: string) => `\u0000${codes.push(c) - 1}\u0000`)
  t = t
    .replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt: string) => `[image: ${alt || 'untitled'}]`)
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, (_m, text: string, href: string) => `${text} <span class="href">(${href})</span>`)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>')
  return t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${codes[Number(i)]}</code>`)
}

/** Markdown to HTML, every character escaped before any tag is added. */
export function renderMarkdown(src: string): string {
  const lines = escapeHtml(src.replace(/\r\n?/g, '\n')).split('\n')
  const out: string[] = []
  let para: string[] = []
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '))}</p>`)
    para = []
    if (list) out.push(`<${list.tag}>${list.items.map(i => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`)
    list = null
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const fence = /^\s*(```|~~~)/.exec(line)
    if (fence) {
      flush()
      const body: string[] = []
      while (++i < lines.length && !lines[i]!.trimStart().startsWith(fence[1]!)) body.push(lines[i]!)
      out.push(`<pre><code>${body.join('\n')}</code></pre>`)
      continue
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line)
    if (h) {
      flush()
      out.push(`<h${h[1]!.length}>${inline(h[2]!)}</h${h[1]!.length}>`)
      continue
    }
    const q = /^&gt;\s?(.*)$/.exec(line)
    if (q) {
      flush()
      out.push(`<blockquote>${inline(q[1]!)}</blockquote>`)
      continue
    }
    const li = /^\s*(?:([-*+])|(\d+)[.)])\s+(.*)$/.exec(line)
    if (li) {
      const tag = li[1] ? 'ul' : 'ol'
      if (para.length || (list && list.tag !== tag)) flush()
      list ??= { tag, items: [] }
      list.items.push(li[3]!)
      continue
    }
    if (!line.trim()) {
      flush()
      continue
    }
    if (list) flush()
    para.push(line.trim())
  }
  flush()
  return out.join('\n')
}

export interface PreviewInput {
  path: string
  bytes: Buffer | null
  /** Markdown as plain text instead of rendered (the drawer's raw toggle). */
  raw?: boolean
}

/** The page for a file: a rendering, or the Open card with Electron's copy. */
export function buildPreview({ path, bytes, raw = false }: PreviewInput): { html: string; open: keyof typeof OPEN_COPY | null } {
  const found = kindOf(path)
  const kind = raw && found === 'markdown' ? 'text' : found
  const card = (why: keyof typeof OPEN_COPY) => ({ html: page(`<div class="card">${escapeHtml(OPEN_COPY[why])}</div>`), open: why })
  if (!bytes) return card('unreadable')
  if (kind === 'html' || kind === 'pdf' || kind === 'office' || kind === 'binary') return card(kind)
  if (bytes.length > PREVIEW_MAX_BYTES) return card('large')
  if (kind === 'svg') return { html: page(`<img alt="" src="data:image/svg+xml;base64,${bytes.toString('base64')}">`), open: null }
  if (kind === 'image') return { html: page(`<img alt="" src="data:${IMAGE_TYPES[extname(path).toLowerCase()]};base64,${bytes.toString('base64')}">`), open: null }
  const text = bytes.toString('utf8')
  if (text.includes('\u0000')) return card('binary')
  if (kind === 'markdown') return { html: page(renderMarkdown(text)), open: null }
  return { html: page(`<pre>${escapeHtml(text)}</pre>`), open: null }
}

/** Types that open straight away in their default app: documents and images (gate M-3). */
// .doc, .xls and .ppt can carry macros, so they ask first (gate run 2, L-2).
const OPEN_TYPES = new Set(['.md', '.markdown', '.txt', '.log', '.csv', '.tsv', '.json', '.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.rtf', '.docx', '.xlsx', '.pptx', '.pages', '.numbers', '.key'])

/**
 * Types whose default app runs code or follows a link: never opened from
 * the drawer, only revealed in Finder (gate M-3). A browser runs an HTML or
 * SVG file's script from file://.
 */
const REFUSED_TYPES = new Set([
  '.command', '.terminal', '.tool', '.app', '.workflow', '.action', '.webloc', '.fileloc', '.inetloc', '.url',
  '.html', '.htm', '.xhtml', '.shtml', '.svg', '.svgz', '.scpt', '.scptd', '.applescript', '.pkg', '.mpkg', '.prefpane', '.saver', '.plugin', '.bundle',
])

export type OpenVerdict = { kind: 'open' } | { kind: 'confirm'; type: string } | { kind: 'refuse'; why: string }

/**
 * Whether "Open in its app" may open a file a session reported writing
 * (gate M-3, MIP2-1430's forged paths included). `st` is the path's
 * `lstat`, so a symlink is seen as one.
 */
export function openVerdict(path: string, st: { isSymbolicLink(): boolean; isFile(): boolean; mode: number }): OpenVerdict {
  if (st.isSymbolicLink()) return { kind: 'refuse', why: "It's a link to another file, so it opens only from Finder." }
  if (!st.isFile()) return { kind: 'refuse', why: "It's a folder or an app bundle, so it opens only from Finder." }
  if (st.mode & 0o111) return { kind: 'refuse', why: 'It can run as a program, so it opens only from Finder.' }
  const ext = extname(path).toLowerCase()
  if (REFUSED_TYPES.has(ext)) return { kind: 'refuse', why: `A ${ext} file can run code when opened, so it opens only from Finder.` }
  if (OPEN_TYPES.has(ext)) return { kind: 'open' }
  return { kind: 'confirm', type: ext ? `${ext} file` : 'file with no extension' }
}

/**
 * The path to open, checked again right before opening (gate run 2, L-2;
 * gate run 3, L-3): a session that can write it could swap it for a link
 * between the first check and the open. The leaf must resolve to itself
 * under its folder's real path (a folder like /tmp or a linked project may
 * be a symlink) and still be the same file, by inode.
 */
export function recheckBeforeOpen(target: string, first: { ino: number }): string | { error: string } {
  try {
    const real = realpathSync(target)
    const now = lstatSync(real)
    const expected = join(realpathSync(dirname(target)), basename(target))
    if (real !== expected || now.ino !== first.ino || openVerdict(real, now).kind === 'refuse') return { error: 'The file changed while opening it, so it opens only from Finder.' }
    return real
  } catch {
    return { error: "the file isn't there any more" }
  }
}
