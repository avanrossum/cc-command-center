// App updates (MIP2-1469): the custom provider against a recorded
// releases.atom (test/fixtures/releases-0.24.atom, recorded 2026-10-27),
// the host and size checks, and the update notice's state.

import { readFileSync } from 'node:fs'
import { EventEmitter } from 'node:events'
import { describe, expect, it, vi } from 'vitest'
import { allowedUrl, boundedGet, candidates, compareVersions, feedTags, type Hop, YML_MAX_BYTES } from '../src/main/update-feed.ts'
import { CccProvider, guardExecutor } from '../src/main/update-provider.ts'
import { Updates, shortError } from '../src/main/updater.ts'
import { bandText, checkLine } from '../src/renderer/components/UpdateBand.tsx'
import { INITIAL_UPDATE_STATE, type UpdateState } from '../src/shared/update-state.ts'

const REPO = 'https://github.com/avanrossum/cc-command-center'
const RECORDED = readFileSync(new URL('./fixtures/releases-0.24.atom', import.meta.url), 'utf8')

/** The recorded feed with releases added at the top, newest first, as GitHub lists them. */
function feedWith(...tags: string[]): string {
  const entries = tags
    .map(t => `<entry><id>tag:github.com,2008:Repository/1/${t}</id><link rel="alternate" type="text/html" href="${REPO}/releases/tag/${t}"/><title>${t}</title></entry>`)
    .join('\n')
  return RECORDED.replace('<entry>', `${entries}\n<entry>`)
}

const yml = (v: string) => `version: ${v}\nfiles:\n  - url: cc-command-center-app-${v}-arm64.zip\n    sha512: abc\n    size: 10\npath: cc-command-center-app-${v}-arm64.zip\nsha512: abc\nreleaseDate: '2026-10-27T00:00:00.000Z'\n`

function body(text: string): AsyncIterable<Uint8Array> {
  return (async function* () {
    yield Buffer.from(text)
  })()
}

/** A server: URL → text (200), a redirect target, or absent (404). */
function server(routes: Record<string, string | { redirect: string }>) {
  const seen: string[] = []
  const open = async (url: string): Promise<Hop> => {
    seen.push(url)
    const r = routes[url]
    if (r === undefined) return { kind: 'response', status: 404, length: null, body: body(''), cancel: () => {} }
    if (typeof r === 'object') return { kind: 'redirect', status: 302, location: r.redirect }
    return { kind: 'response', status: 200, length: Buffer.byteLength(r), body: body(r), cancel: () => {} }
  }
  return { open, seen }
}

function provider(current: string, routes: Record<string, string | { redirect: string }>, allowPrerelease = false) {
  const s = server(routes)
  const executor = { createRequest: vi.fn(() => ({ abort: () => {} })) }
  const updater = { currentVersion: { version: current }, allowPrerelease }
  const p = new CccProvider({ base: REPO, testOrigin: null, open: s.open }, updater as never, { isUseMultipleRangeRequest: false, platform: 'darwin', executor } as never)
  return { p, seen: s.seen, executor }
}

describe('the releases feed', () => {
  it('lists every tag in the recorded feed, semver or not', () => {
    const tags = feedTags(RECORDED)
    expect(tags).toHaveLength(10)
    expect(tags).toContain('electron-final')
    expect(tags[0]).toBe('v0.24.2-beta.2')
  })
  it('orders semver with prereleases below their release, and leaves other tags out', () => {
    expect(compareVersions('v1.0.1', '1.0.0')).toBeGreaterThan(0)
    expect(compareVersions('v1.0.0-beta.1', 'v1.0.0')).toBeLessThan(0)
    expect(compareVersions('electron-final', 'v1.0.0')).toBeNull()
  })
  it('offers only semver tags above the running version, newest first, and no prereleases by default', () => {
    const tags = feedTags(feedWith('v1.1.0-beta.1', 'v1.0.2', 'v1.0.1', 'v0.9.0'))
    expect(candidates(tags, '1.0.0', false)).toEqual(['v1.0.2', 'v1.0.1'])
    expect(candidates(tags, '1.0.0', true)).toEqual(['v1.1.0-beta.1', 'v1.0.2', 'v1.0.1'])
    // 0.24's tags are all below a 1.x app.
    expect(candidates(feedTags(RECORDED), '1.0.0', false)).toEqual([])
  })
})

describe('the provider', () => {
  const feed = `${REPO}/releases.atom`
  const asset = (tag: string) => `${REPO}/releases/download/${tag}/ccc-mac.yml`

  it('reports nothing newer when the feed has no release above the running version', async () => {
    const { p, seen } = provider('1.0.0', { [feed]: RECORDED })
    expect((await p.getLatestVersion()).version).toBe('1.0.0')
    expect(seen).toEqual([feed])
  })
  it('reports nothing newer from a feed whose newest release is the tombstone', async () => {
    const { p } = provider('1.0.0', { [feed]: feedWith('v0.24.3'), [`${REPO}/releases/download/v0.24.3/latest-mac.yml`]: yml('0.24.3') })
    expect((await p.getLatestVersion()).version).toBe('1.0.0')
  })
  it('skips the newest tag when it carries no ccc-mac.yml, and takes the next', async () => {
    const { p, seen } = provider('1.0.0', { [feed]: feedWith('v1.0.2', 'v1.0.1'), [asset('v1.0.1')]: yml('1.0.1') })
    expect((await p.getLatestVersion()).version).toBe('1.0.1')
    expect(seen).toEqual([feed, asset('v1.0.2'), asset('v1.0.1')])
    expect(p.resolveFiles(await p.getLatestVersion())[0]?.url.toString()).toBe(`${REPO}/releases/download/v1.0.1/cc-command-center-app-1.0.1-arm64.zip`)
  })
  it('ignores a prerelease and a lower version', async () => {
    const { p, seen } = provider('1.0.0', { [feed]: feedWith('v1.1.0-beta.1', 'v0.9.0'), [asset('v1.1.0-beta.1')]: yml('1.1.0-beta.1'), [asset('v0.9.0')]: yml('0.9.0') })
    expect((await p.getLatestVersion()).version).toBe('1.0.0')
    expect(seen).toEqual([feed])
  })
  it('refuses an update file that names another version', async () => {
    const { p } = provider('1.0.0', { [feed]: feedWith('v1.0.1'), [asset('v1.0.1')]: yml('9.9.9') })
    await expect(p.getLatestVersion()).rejects.toThrow(/names version 9\.9\.9/)
  })
  it('refuses an update file that points outside its release', async () => {
    const { p } = provider('1.0.0', { [feed]: feedWith('v1.0.1'), [asset('v1.0.1')]: yml('1.0.1').replaceAll('cc-command-center-app-1.0.1-arm64.zip', 'https://github.com/someone/else/a.zip') })
    await expect(p.getLatestVersion().then(i => p.resolveFiles(i))).rejects.toThrow(/outside its release/)
  })
  it('follows a redirect to GitHub’s release CDN, and refuses one anywhere else', async () => {
    const cdn = 'https://release-assets.githubusercontent.com/github-production-release-asset/1/x'
    const ok = provider('1.0.0', { [feed]: feedWith('v1.0.1'), [asset('v1.0.1')]: { redirect: cdn }, [cdn]: yml('1.0.1') })
    expect((await ok.p.getLatestVersion()).version).toBe('1.0.1')
    const hostile = provider('1.0.0', { [feed]: feedWith('v1.0.1'), [asset('v1.0.1')]: { redirect: 'https://evil.example/ccc-mac.yml' } })
    await expect(hostile.p.getLatestVersion()).rejects.toThrow(/refused a request to https:\/\/evil\.example/)
    const downgrade = provider('1.0.0', { [feed]: { redirect: 'http://github.com/avanrossum/cc-command-center/releases.atom' } })
    await expect(downgrade.p.getLatestVersion()).rejects.toThrow(/refused/)
  })
})

describe('requests and their size', () => {
  it('allows only HTTPS to GitHub’s hosts, or a dry run’s own origin', () => {
    expect(allowedUrl(`${REPO}/releases.atom`)).toBe(true)
    expect(allowedUrl('https://release-assets.githubusercontent.com/a')).toBe(true)
    expect(allowedUrl('https://github.com.evil.example/a')).toBe(false)
    expect(allowedUrl('https://github.com:8443/a')).toBe(false)
    expect(allowedUrl('https://user@github.com/a')).toBe(false)
    expect(allowedUrl('http://127.0.0.1:8123/releases.atom')).toBe(false)
    expect(allowedUrl('http://127.0.0.1:8123/releases.atom', 'http://127.0.0.1:8123')).toBe(true)
    expect(allowedUrl('not a url')).toBe(false)
  })
  it('refuses a response over its cap, by its length or as it streams', async () => {
    const cancel = vi.fn()
    const big = async (): Promise<Hop> => ({ kind: 'response', status: 200, length: YML_MAX_BYTES + 1, body: body(''), cancel })
    await expect(boundedGet(`${REPO}/a.yml`, YML_MAX_BYTES, big)).rejects.toThrow(/over the/)
    expect(cancel).toHaveBeenCalled()
    const unannounced = async (): Promise<Hop> => ({ kind: 'response', status: 200, length: null, body: body('x'.repeat(20)), cancel })
    await expect(boundedGet(`${REPO}/a.yml`, 10, unannounced)).rejects.toThrow(/over the 10-byte cap/)
  })
  it('stops after five redirects', async () => {
    const loop = async (): Promise<Hop> => ({ kind: 'redirect', status: 302, location: `${REPO}/again` })
    await expect(boundedGet(`${REPO}/a.yml`, 10, loop)).rejects.toThrow(/too many redirects/)
  })
  it("puts the host check on electron-updater's own requests, each redirect hop included, and never lets them follow redirects themselves", () => {
    const create = vi.fn((_o: object, _cb: (r: never) => void) => ({ abort: () => {} }))
    const executor = { createRequest: create }
    guardExecutor(executor, null)
    executor.createRequest({ protocol: 'https:', hostname: 'release-assets.githubusercontent.com', path: '/x' }, () => {})
    expect(create.mock.calls[0]?.[0]).toMatchObject({ redirect: 'manual' })
    expect(() => executor.createRequest({ protocol: 'https:', hostname: 'evil.example', path: '/x.zip' }, () => {})).toThrow(/refused/)
    expect(() => executor.createRequest({ protocol: 'http:', hostname: 'github.com', path: '/x.zip' }, () => {})).toThrow(/refused/)
  })
  it('aborts a download that grows past its cap', () => {
    const abort = vi.fn()
    let respond = null as ((r: never) => void) | null
    const executor = { createRequest: (_o: object, cb: (r: never) => void) => ((respond = cb), { abort }) }
    guardExecutor(executor, null)
    executor.createRequest({ protocol: 'https:', hostname: 'github.com', path: '/a.zip' }, () => {})
    const response = Object.assign(new EventEmitter(), { headers: {} })
    respond?.(response as never)
    response.emit('data', Buffer.alloc(700 * 1024 * 1024, 0))
    expect(abort).toHaveBeenCalled()
  })
})

describe('the update notice', () => {
  function updates(active = true) {
    const emitter = new EventEmitter()
    const updater = {
      checkForUpdates: vi.fn(async () => null),
      downloadUpdate: vi.fn(async () => []),
      quitAndInstall: vi.fn(),
      on: (e: string, fn: (...a: never[]) => void) => emitter.on(e, fn as (...a: unknown[]) => void),
    }
    const changes: UpdateState[] = []
    const u = new Updates(updater, { active, testOrigin: null, onChange: s => changes.push(s), now: () => 1000 })
    return { u, updater, emitter, changes }
  }

  it("doesn't check, or download, in a build that isn't a release", async () => {
    const { u, updater } = updates(false)
    await u.check(true)
    expect(updater.checkForUpdates).not.toHaveBeenCalled()
    expect(u.current().phase).toBe('off')
  })
  it('offers a version, downloads only on Download, then offers Restart to update', async () => {
    const { u, updater, emitter } = updates()
    await u.check()
    emitter.emit('update-available', { version: '1.0.1' })
    expect(updater.downloadUpdate).not.toHaveBeenCalled()
    expect(bandText(u.current())).toEqual({ text: 'Version 1.0.1 is available.', action: 'download' })
    expect(u.restart().ok).toBe(false)
    expect(u.download().ok).toBe(true)
    expect(updater.downloadUpdate).toHaveBeenCalledOnce()
    emitter.emit('download-progress', { percent: 41.6 })
    expect(bandText(u.current())?.text).toBe('Downloading version 1.0.1… 42%')
    await u.check()
    expect(updater.checkForUpdates).toHaveBeenCalledOnce()
    emitter.emit('update-downloaded', { version: '1.0.1' })
    expect(bandText(u.current())?.action).toBe('restart')
    expect(u.restart().ok).toBe(true)
    expect(updater.quitAndInstall).toHaveBeenCalledOnce()
  })
  it('hides the notice on Later until a newer version, or a check by hand', async () => {
    const { u, emitter } = updates()
    emitter.emit('update-available', { version: '1.0.1' })
    u.later()
    expect(bandText(u.current())).toBeNull()
    emitter.emit('update-available', { version: '1.0.1' })
    expect(bandText(u.current())).toBeNull()
    emitter.emit('update-available', { version: '1.0.2' })
    expect(bandText(u.current())?.text).toBe('Version 1.0.2 is available.')
    u.later()
    await u.check(true)
    emitter.emit('update-available', { version: '1.0.2' })
    expect(bandText(u.current())).not.toBeNull()
  })
  it('reports a failed check in one line, with when it ran', async () => {
    const { u, updater } = updates()
    updater.checkForUpdates.mockRejectedValueOnce(new Error('net::ERR_INTERNET_DISCONNECTED\n    at stack'))
    await u.check()
    expect(u.current()).toMatchObject({ phase: 'error', error: 'net::ERR_INTERNET_DISCONNECTED', checkedAt: 1000 })
    expect(checkLine(u.current(), 1000 + 5 * 60_000)).toBe('The last check failed: net::ERR_INTERNET_DISCONNECTED. Checked 5 min ago.')
    expect(shortError('x'.repeat(400))).toHaveLength(301)
  })
  it('says what About shows for each state', () => {
    const s = (patch: Partial<UpdateState>) => ({ ...INITIAL_UPDATE_STATE, ...patch })
    expect(checkLine(s({ phase: 'off' }), 0)).toBe('Updates come with release builds.')
    expect(checkLine(s({ phase: 'none', checkedAt: 0 }), 2 * 3600_000)).toBe('This is the newest version. Checked 2 hours ago.')
    expect(checkLine(s({ phase: 'idle' }), 0)).toBe('Not checked yet.')
  })
})
