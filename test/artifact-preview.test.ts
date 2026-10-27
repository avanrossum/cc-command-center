// Artifact previews (MIP2-1412, DECISION item 8, D-019): hostile files
// can't produce script, event handlers, live links or frames, and the page's
// CSP allows no script and no inline style but its own hashed one.

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { buildPreview, kindOf, PREVIEW_CSP, renderMarkdown } from '../src/main/artifact-preview.ts'

const HOSTILE_MD = [
  '# Title <script>alert(1)</script>',
  '<img src=x onerror="window.ccc.launch({cwd:\'/\'})">',
  '[click](javascript:alert(document.cookie)) and [ok](https://example.com)',
  '![x](https://evil.example/track.png)',
  '<iframe src="app://ccc/index.html"></iframe>',
  '<a href="javascript:alert(1)">raw</a> <svg onload=alert(1)>',
  '```html',
  '<script>fetch("https://evil.example")</script>',
  '```',
  '> quote <b onmouseover=alert(1)>x</b>',
  '- item `<script>`',
  '**bold** and *em* <style>body{display:none}</style>',
].join('\n')

/** Any tag the renderer can emit; anything else in the output must be escaped text. */
const ALLOWED = /^(<\/?(p|h[1-4]|pre|code|blockquote|ul|ol|li|strong|em)>|<span class="href">|<\/span>)$/

function tags(html: string): string[] {
  return html.match(/<[^>]*>/g) ?? []
}

describe('artifact previews', () => {
  it('renders hostile markdown with only its own tags, and no live link, handler, script or frame', () => {
    const html = renderMarkdown(HOSTILE_MD)
    expect(tags(html).filter(t => !ALLOWED.test(t))).toEqual([])
    expect(html).not.toMatch(/<(script|img|iframe|svg|a|style|b)[\s>]/i)
    // Handlers and addresses appear only as escaped text, never inside a tag.
    expect(tags(html).join('')).not.toMatch(/\son\w+=|href=|src=/i)
    // The text survives, escaped: nothing is silently dropped.
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    // An address with parentheses ends at the first ")": still text, never a link.
    expect(html).toContain('click <span class="href">(javascript:alert(document.cookie)</span>)')
    expect(html).toContain('[image: x]')
    expect(html).toContain('<strong>bold</strong> and <em>em</em>')
  })

  it('shows an SVG only as an image, where its script never runs', () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script><foreignObject><iframe src="app://ccc"/></foreignObject></svg>')
    const { html, open } = buildPreview({ path: '/w/evil.svg', bytes: svg })
    expect(open).toBeNull()
    const body = html.slice(html.indexOf('<body>'))
    expect(tags(body)).toEqual(['<body>', `<img alt="" src="data:image/svg+xml;base64,${svg.toString('base64')}">`, '</body>', '</html>'])
  })

  it('escapes text and code, and refuses binary, HTML, PDF, office, large and unreadable files with the Open card', () => {
    expect(buildPreview({ path: '/w/a.ts', bytes: Buffer.from('const x = "</pre><script>1</script>"') }).html).toContain('&lt;/pre&gt;&lt;script&gt;')
    expect(buildPreview({ path: '/w/page.html', bytes: Buffer.from('<script>1</script>') })).toMatchObject({ open: 'html' })
    expect(buildPreview({ path: '/w/a.pdf', bytes: Buffer.from('%PDF') }).open).toBe('pdf')
    expect(buildPreview({ path: '/w/a.docx', bytes: Buffer.from('x') }).open).toBe('office')
    expect(buildPreview({ path: '/w/a.txt', bytes: Buffer.alloc(3 * 1024 * 1024, 65) }).open).toBe('large')
    expect(buildPreview({ path: '/w/a.txt', bytes: null }).open).toBe('unreadable')
    expect(buildPreview({ path: '/w/a.txt', bytes: Buffer.from([0x61, 0, 0x62]) }).open).toBe('binary')
    expect([kindOf('/a/B.MD'), kindOf('/a/x.png'), kindOf('/a/Makefile'), kindOf('/a/x.zip')]).toEqual(['markdown', 'image', 'text', 'binary'])
  })

  it('shows markdown raw as escaped text when asked (MIP2-1407)', () => {
    const { html } = buildPreview({ path: '/w/a.md', bytes: Buffer.from('# Title <b>x</b>'), raw: true })
    expect(html).toContain('<pre># Title &lt;b&gt;x&lt;/b&gt;</pre>')
    expect(html).not.toContain('<h1>')
  })

  it('serves a CSP with no script, no unsafe-inline, and only its own hashed style', () => {
    expect(PREVIEW_CSP).not.toMatch(/script-src|unsafe-inline|unsafe-eval/)
    expect(PREVIEW_CSP).toContain("default-src 'none'")
    expect(PREVIEW_CSP).toContain('sandbox')
    const { html } = buildPreview({ path: '/w/a.md', bytes: Buffer.from('# hi') })
    const style = /<style>([\s\S]*?)<\/style>/.exec(html)![1]!
    expect(PREVIEW_CSP).toContain(`'sha256-${createHash('sha256').update(style).digest('base64')}'`)
    expect(html.match(/<style>/g)).toHaveLength(1)
    expect(html).not.toMatch(/\sstyle=/)
  })
})
