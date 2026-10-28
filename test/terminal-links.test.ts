// Links in a session's terminal view (MIP2-1471): what main lets open, and
// how the OSC 8 handler and the web-links addon reach it.

import { describe, expect, it, vi } from 'vitest'
import { Terminal } from '@xterm/headless'
import { checkTerminalLink, isAllowedExternal, hostReach, isPrivateHost, linkMismatch, openTerminalLink, reachDecision, textHost, type LinkDeps } from '../src/main/policy.ts'

const terminalLinkRefusal = (url: string) => {
  const r = checkTerminalLink(url)
  return r.ok ? null : r.error
}
import { linkTip, oscLinkHandler, textAt, webLinks, type LinkUi } from '../src/renderer/model/terminal-links.ts'

const ui = () =>
  ({ open: vi.fn<(url: string, text?: string) => void>(), textAt: vi.fn(() => ({ text: 'github.com/avanrossum', atEdge: false })), show: vi.fn<(url: string) => void>(), hide: vi.fn<() => void>() }) satisfies LinkUi
const ev = {} as MouseEvent
const range = { start: { x: 1, y: 1 }, end: { x: 4, y: 1 } }

describe('which links open', () => {
  it('opens https and http links', () => {
    expect(terminalLinkRefusal('https://github.com/avanrossum/cc-command-center/pull/1')).toBeNull()
    expect(terminalLinkRefusal('http://example.com/')).toBeNull()
    expect(terminalLinkRefusal('https://localhost:3000/')).toBeNull()
  })
  it('refuses file:, javascript:, data: and app schemes, with the reason', () => {
    expect(terminalLinkRefusal('file:///etc/passwd')).toMatch(/^file links don't open/)
    expect(terminalLinkRefusal('javascript:alert(1)')).toMatch(/^javascript links/)
    expect(terminalLinkRefusal('data:text/html,<b>x</b>')).toMatch(/^data links/)
    expect(terminalLinkRefusal('vscode://file/x')).toMatch(/^vscode links/)
    expect(terminalLinkRefusal('app://ccc/index.html')).toMatch(/^app links/)
    expect(terminalLinkRefusal('mailto:a@b.c')).toMatch(/^mailto links/)
  })
  it('refuses a user name or password, which can disguise the host', () => {
    expect(terminalLinkRefusal('https://github.com@evil.example/')).toMatch(/user name or password/)
    expect(terminalLinkRefusal('https://u:p@github.com/')).toMatch(/user name or password/)
  })
  it('refuses what isn’t a URL, and very long links', () => {
    expect(terminalLinkRefusal('not a link')).toMatch(/isn't a web address/)
    expect(terminalLinkRefusal(`https://x.example/${'a'.repeat(3000)}`)).toMatch(/too long/)
  })
  it('leaves window opens and artifact links https only', () => {
    expect(isAllowedExternal('http://localhost:3000/')).toBe(false)
  })
})

describe('plain http to this Mac or the local network (pass 9, M-3)', () => {
  it('refuses loopback, link-local, RFC 1918 and unique-local hosts, however they are written', () => {
    for (const url of [
      'http://localhost:3000/',
      'http://app.localhost/',
      'http://127.0.0.1:8080/',
      'http://127.1/',
      'http://2130706433/',
      'http://0.0.0.0/',
      'http://10.1.2.3/',
      'http://172.16.0.1/',
      'http://172.31.255.255/',
      'http://192.168.1.1/admin',
      'http://169.254.169.254/latest/meta-data',
      'http://[::1]/',
      'http://[::ffff:127.0.0.1]/',
      'http://[fe80::1]/',
      'http://[fd12:3456::1]/',
    ]) {
      expect(terminalLinkRefusal(url), url).toMatch(/plain http links to this Mac or the local network/)
    }
  })
  it('opens public hosts over http, and https to any host', () => {
    expect(terminalLinkRefusal('http://172.32.0.1/')).toBeNull()
    expect(terminalLinkRefusal('http://11.0.0.1/')).toBeNull()
    expect(terminalLinkRefusal('https://192.168.1.1/')).toBeNull()
    expect(isPrivateHost('example.com')).toBe(false)
  })
  it('opens the parsed address, so the string checked is the string opened (L-1)', () => {
    expect(checkTerminalLink(' https://Example.COM/a b\t')).toEqual({ ok: true, href: 'https://example.com/a%20b', host: 'example.com' })
  })
})

describe("an OSC 8 link whose text names another host (pass 9, M-3)", () => {
  it('is asked about first', () => {
    expect(linkMismatch('github.com/avanrossum', 'evil.example')).toBe("This link's text says github.com, but it opens evil.example.")
    expect(linkMismatch('see https://docs.example.org/x for more', 'evil.example')).toMatch(/says docs\.example\.org/)
  })
  it("isn't asked about when the hosts match, when www. is the only difference, or when the text names no host", () => {
    expect(linkMismatch('github.com/avanrossum', 'github.com')).toBeNull()
    expect(linkMismatch('www.github.com', 'github.com')).toBeNull()
    expect(linkMismatch('GitHub.com', 'github.com')).toBeNull()
    expect(linkMismatch('the pull request', 'github.com')).toBeNull()
    expect(linkMismatch(undefined, 'github.com')).toBeNull()
  })
  it('reads a host from the text', () => {
    expect(textHost('https://user@x.example:8080/p')).toBe('x.example')
    expect(textHost('(api.example.com)')).toBe('api.example.com')
    expect(textHost('192.168.1.1')).toBe('192.168.1.1')
    expect(textHost('version 1.0.0')).toBeNull()
  })
})

describe('OSC 8 links', () => {
  it('opens the target, not the visible text, and shows the target on hover', () => {
    const u = ui()
    const h = oscLinkHandler(u)
    // xterm's OscLinkProvider calls these with the link's URI.
    h.hover?.(ev, 'https://evil.example/x', range)
    expect(u.show).toHaveBeenCalledWith('https://evil.example/x')
    h.activate(ev, 'https://evil.example/x', range)
    // With the visible text, so main can compare its host with the target's.
    expect(u.textAt).toHaveBeenCalledWith(range)
    expect(u.open).toHaveBeenCalledWith('https://evil.example/x', 'github.com/avanrossum', false)
    h.leave?.(ev, 'https://evil.example/x', range)
    expect(u.hide).toHaveBeenCalled()
  })
  it('passes non-http targets on, so main refuses them with a notice instead of xterm dropping them', () => {
    const u = ui()
    const h = oscLinkHandler(u)
    expect(h.allowNonHttpProtocols).toBe(true)
    h.activate(ev, 'file:///etc/passwd', range)
    expect(u.open).toHaveBeenCalledWith('file:///etc/passwd', 'github.com/avanrossum', false)
  })
})

describe('plain-text links', () => {
  it("routes the web-links addon's clicks and hovers through the same path", () => {
    const u = ui()
    const addon = webLinks(u) as unknown as { _handler: (e: MouseEvent, uri: string) => void; _options: { hover: (e: MouseEvent, t: string) => void; leave: () => void } }
    addon._handler(ev, 'https://example.com/a')
    expect(u.open).toHaveBeenCalledWith('https://example.com/a')
    addon._options.hover(ev, 'https://example.com/a')
    expect(u.show).toHaveBeenCalledWith('https://example.com/a')
    addon._options.leave()
    expect(u.hide).toHaveBeenCalled()
  })
})

describe('the hover line', () => {
  it('shows a long target with both ends', () => {
    const long = `https://example.com/${'a'.repeat(200)}/end`
    const tip = linkTip(long, 40)
    expect(tip).toHaveLength(39)
    expect(tip.startsWith('https://example.com')).toBe(true)
    expect(tip.endsWith('/end')).toBe(true)
    expect(linkTip('https://x.example/')).toBe('https://x.example/')
  })
})

describe('local-network names and forms pass 9 missed (pass 10, M-1)', () => {
  it('refuses a trailing dot, the IPv4-compatible form and CGNAT', () => {
    for (const url of ['http://localhost./', 'http://foo.localhost./', 'http://[::7f00:1]/', 'http://100.64.0.1/', 'http://100.127.255.254/', 'http://127.0.0.1./']) {
      expect(terminalLinkRefusal(url), url).toMatch(/plain http links to this Mac or the local network/)
    }
    expect(terminalLinkRefusal('http://100.128.0.1/')).toBeNull()
  })
  it('refuses a plain-http name that resolves to a private address, and leaves the rest', async () => {
    const dns: Record<string, string[]> = { '127.0.0.1.nip.io': ['127.0.0.1'], 'localtest.me': ['127.0.0.1', '::1'], 'mixed.example': ['93.184.215.14', '10.0.0.5'], 'example.com': ['93.184.215.14'] }
    const lookup = async (h: string) => {
      const a = dns[h]
      if (!a) throw new Error('ENOTFOUND')
      return a.map(address => ({ address }))
    }
    expect(await hostReach('127.0.0.1.nip.io', lookup)).toBe('private')
    expect(await hostReach('localtest.me', lookup)).toBe('private')
    expect(await hostReach('mixed.example', lookup)).toBe('private')
    expect(await hostReach('example.com', lookup)).toBe('public')
    // A name that can't be looked up is unknown, and the app asks before opening it (pass 12, M-3).
    expect(await hostReach('nowhere.invalid', lookup)).toBe('unknown')
    // Literals are isPrivateHost's; they aren't looked up.
    expect(await hostReach('127.0.0.1', async () => { throw new Error('looked up') })).toBe('private')
    expect(await hostReach('93.184.215.14', async () => { throw new Error('looked up') })).toBe('public')
  })
})

describe('link text the host check used to miss (pass 10, M-2)', () => {
  const ZWSP = '\u200b'
  it.each([
    ['github.com', 'github.com'],
    ['**github.com**', 'github.com'],
    ['see:github.com', 'github.com'],
    [`${ZWSP}github.com`, 'github.com'],
    [`github.com${ZWSP}`, 'github.com'],
    [`github.com/org/repo${ZWSP}`, 'github.com'],
    ['[github.com](x)', 'github.com'],
    ['ｇｉｔｈｕｂ.ｃｏｍ', 'github.com'],
  ])('reads %j as %s, and asks when the link opens elsewhere', (text, host) => {
    expect(textHost(text)).toBe(host)
    expect(linkMismatch(text, 'evil.example')).toMatch(/says github\.com, but it opens evil\.example/)
    expect(linkMismatch(text, 'github.com')).toBeNull()
  })
  it('asks about a look-alike host in non-ASCII letters, unless it is the target', () => {
    const cyrillic = 'g\u0456thub.com'
    expect(linkMismatch(cyrillic, 'evil.example')).toMatch(/look-alike name xn--/)
    expect(linkMismatch(cyrillic, 'github.com')).toMatch(/look-alike/)
    expect(linkMismatch(cyrillic, new URL(`http://${cyrillic}`).hostname)).toBeNull()
  })
  it('asks when the text touches the edge of the terminal, since a wrapped link is only partly visible', () => {
    expect(linkMismatch('githu', 'evil.example', true)).toMatch(/runs to the edge of the terminal/)
    expect(linkMismatch('githu', 'evil.example', false)).toBeNull()
  })
})

describe("a link range's text, from a real xterm buffer (pass 10, L-5)", () => {
  const write = (t: Terminal, data: string) => new Promise<void>(resolve => t.write(data, resolve))

  it('reads the OSC 8 link text in 1-based, end-inclusive columns', async () => {
    const t = new Terminal({ cols: 30, rows: 4, allowProposedApi: true })
    await write(t, 'ab \x1b]8;;https://evil.example/x\x07github.com\x1b]8;;\x07 cd')
    const r = textAt(t.buffer.active, t.cols, { start: { x: 4, y: 1 }, end: { x: 13, y: 1 } })
    expect(r).toEqual({ text: 'github.com', atEdge: false })
    t.dispose()
  })
  it('says when the text reaches the last column, or starts a wrapped line', async () => {
    const t = new Terminal({ cols: 10, rows: 4, allowProposedApi: true })
    await write(t, '0123456789abcdef')
    expect(textAt(t.buffer.active, t.cols, { start: { x: 6, y: 1 }, end: { x: 10, y: 1 } })).toEqual({ text: '56789', atEdge: true })
    expect(textAt(t.buffer.active, t.cols, { start: { x: 1, y: 2 }, end: { x: 3, y: 2 } })).toEqual({ text: 'abc', atEdge: true })
    t.dispose()
  })
})

describe('invisible marks and dot look-alikes in link text (pass 11, M-1, L-1, L-4)', () => {
  it.each([
    ['gi͏thub.com', 'combining grapheme joiner'],
    ['gi️thub.com', 'variation selector'],
    ['gi᠋thub.com', 'Mongolian free variation selector'],
    ['github。com', 'ideographic full stop'],
    ['github．com', 'full-width full stop'],
    ['github｡com', 'half-width ideographic full stop'],
  ])('reads %j (%s) as github.com, and asks when the link opens a suffix of it', text => {
    expect(textHost(text)).toBe('github.com')
    expect(linkMismatch(text, 'thub.com')).toMatch(/says github\.com, but it opens thub\.com/)
    expect(linkMismatch(text, 'github.com')).toBeNull()
  })
  it('asks about a host-like word holding a Hangul filler, which is stripped as default-ignorable', () => {
    for (const filler of ['ᅟ', 'ㅤ']) expect(linkMismatch(`gi${filler}thub.com`, 'thub.com'), filler).not.toBeNull()
  })
  it("never reads a host starting right after a combining mark", () => {
    expect(textHost('égithub.com')).toBeNull()
  })
  it('refuses dotted IPv4-mapped and IPv4-compatible forms, as a resolver may write them', () => {
    expect(isPrivateHost('::ffff:127.0.0.1')).toBe(true)
    expect(isPrivateHost('::ffff:10.0.0.5')).toBe(true)
    expect(isPrivateHost('::127.0.0.1')).toBe(true)
    expect(isPrivateHost('::ffff:93.184.215.14')).toBe(false)
  })
})

describe('the DNS check (pass 11, L-3)', () => {
  it('gives up on a stalled resolver and counts it as unknown, so the app asks (pass 12, M-3)', async () => {
    const stalled = () => new Promise<{ address: string }[]>(() => {})
    const t0 = Date.now()
    expect(await hostReach('slow.example', stalled, 50)).toBe('unknown')
    expect(Date.now() - t0).toBeLessThan(1_000)
  })
})

describe('what a click does (pass 14, L-2)', () => {
  it.each([
    ['public', 'open'],
    ['unknown', 'ask'],
    ['private', 'refuse'],
  ] as const)('a plain-http host that is %s: %s', (reach, decision) => {
    expect(reachDecision(reach)).toBe(decision)
  })

  // The handler's steps, with the dialog, the lookup and the browser stubbed.
  const run = (url: string, text: string | undefined, answers: boolean[], addresses: string[] | Error) => {
    const asked: string[] = []
    const looked: string[] = []
    const opened: string[] = []
    const deps: LinkDeps = {
      ask: async message => (asked.push(message), answers.shift() ?? false),
      lookup: async host => {
        looked.push(host)
        if (addresses instanceof Error) throw addresses
        return addresses.map(address => ({ address }))
      },
      open: async href => void opened.push(href),
    }
    return openTerminalLink(url, text, false, deps).then(r => ({ r, asked, looked, opened }))
  }

  it('returns canceled on Cancel, and never looks up a canceled link', async () => {
    const { r, looked, opened } = await run('http://evil.example/', 'github.com', [false], ['93.184.216.34'])
    expect(r).toEqual({ ok: false, error: 'canceled', canceled: true })
    expect(looked).toEqual([])
    expect(opened).toEqual([])
  })

  it('asks a second time when the host could not be checked', async () => {
    const { r, asked, opened } = await run('http://unchecked.example/', undefined, [true], new Error('ENOTFOUND'))
    expect(asked).toEqual([expect.stringContaining("couldn't check where unchecked.example points")])
    expect(r).toEqual({ ok: true })
    expect(opened).toEqual(['http://unchecked.example/'])
  })

  it('refuses a plain-http name for the local network without opening, even after Open on the text question', async () => {
    const { r, opened } = await run('http://evil.example/', 'github.com', [true], ['192.168.1.10'])
    expect(r).toMatchObject({ ok: false, error: expect.stringContaining("don't open from the terminal") })
    expect(opened).toEqual([])
  })

  it('opens https without a lookup or a question when the text matches', async () => {
    const { r, asked, looked, opened } = await run('https://github.com/x', 'github.com/x', [], [])
    expect([r, asked, looked, opened]).toEqual([{ ok: true }, [], [], ['https://github.com/x']])
  })
})
