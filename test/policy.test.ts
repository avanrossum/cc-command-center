import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CONTENT_SECURITY_POLICY, isAllowedExternal, isAppUrl, resolveAppPath } from '../src/main/policy.ts'

describe('isAllowedExternal', () => {
  it.each([
    ['https://code.claude.com/docs', true],
    ['http://example.com', false],
    ['file:///etc/passwd', false],
    ['javascript:alert(1)', false],
    ['smb://host/share', false],
    ['not a url', false],
  ])('%s → %s', (url, ok) => expect(isAllowedExternal(url)).toBe(ok))
})

describe('isAppUrl', () => {
  it.each([
    ['app://ccc/index.html', true],
    ['app://other/index.html', false],
    ['https://ccc/index.html', false],
    ['file:///index.html', false],
    [undefined, false],
  ])('%s → %s', (url, ok) => expect(isAppUrl(url)).toBe(ok))
})

describe('resolveAppPath', () => {
  const root = '/app/dist/renderer'
  it.each([
    ['app://ccc/', '/app/dist/renderer/index.html'],
    ['app://ccc/index.html', '/app/dist/renderer/index.html'],
    ['app://ccc/renderer.js', '/app/dist/renderer/renderer.js'],
    // WHATWG URL parsing folds `..` segments at the root, so these stay inside it.
    ['app://ccc/%2e%2e/main.cjs', '/app/dist/renderer/main.cjs'],
    ['app://ccc/../../main.cjs', '/app/dist/renderer/main.cjs'],
    // An encoded slash survives parsing and is caught after decoding.
    ['app://ccc/..%2fmain.cjs', null],
    ['app://ccc/%E0%A4%A', null],
    ['app://evil/index.html', null],
    ['https://ccc/index.html', null],
  ])('%s → %s', (url, expected) => expect(resolveAppPath(root, url)).toBe(expected))
})

describe('CONTENT_SECURITY_POLICY', () => {
  const directive = (name: string) =>
    CONTENT_SECURITY_POLICY.split('; ').find(d => d.startsWith(`${name} `))

  it('allows scripts from the app only and denies by default', () => {
    expect(directive('default-src')).toBe("default-src 'none'")
    expect(directive('script-src')).toBe("script-src 'self'")
  })

  it('allows inline styles for xterm.js and nothing else unsafe (MIP2-1389)', () => {
    expect(directive('style-src')).toBe("style-src 'self' 'unsafe-inline'")
    const others = CONTENT_SECURITY_POLICY.split('; ').filter(d => !d.startsWith('style-src '))
    expect(others.join('; ')).not.toContain('unsafe')
  })

  it('keeps every directive that could load or send something closed', () => {
    expect(directive('img-src')).toBe("img-src 'self' data:")
    expect(directive('font-src')).toBe("font-src 'self'")
    expect(directive('connect-src')).toBe("connect-src 'none'")
    // Frames: artifact previews only (MIP2-1412).
    expect(directive('frame-src')).toBe('frame-src ccc-artifact:')
  })

  it('matches the meta tag in the page', () => {
    const html = readFileSync(join(import.meta.dirname, '../src/renderer/index.html'), 'utf8')
    const meta = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)?.[1]
    expect(meta).toBe(CONTENT_SECURITY_POLICY.replace("; frame-ancestors 'none'", ''))
  })
})

describe('userDataPath', () => {
  it("is never one of Electron CCCC's data folders", async () => {
    const { ELECTRON_CCCC_FOLDERS, userDataPath } = await import('../src/main/paths.ts')
    const appData = '/Users/x/Library/Application Support'
    const path = userDataPath(appData)
    for (const f of ELECTRON_CCCC_FOLDERS) expect(path).not.toBe(`${appData}/${f}`)
    expect(path).toBe(`${appData}/CC Command Center App`)
  })

  it('is set before the security baseline runs, so nothing opens the default profile first', () => {
    const main = readFileSync(join(import.meta.dirname, '../src/main/index.ts'), 'utf8')
    expect(main.indexOf("app.setPath('userData'")).toBeGreaterThan(0)
    expect(main.indexOf("app.setPath('userData'")).toBeLessThan(main.indexOf('applyBeforeReady()'))
  })
})

describe('control checks', async () => {
  const { checkAnswer, checkLaunch, isSessionId } = await import('../src/main/validate.ts')

  it('takes a well-formed launch and drops nothing it knows', () => {
    expect(checkLaunch({ cwd: '/w', name: 'my session', model: 'sonnet', effort: 'low', permissionMode: 'default', prompt: 'go', isolation: 'worktree' })).toEqual({
      cwd: '/w', name: 'my session', model: 'sonnet', effort: 'low', permissionMode: 'default', prompt: 'go', isolation: 'worktree',
    })
  })

  it.each([
    [{ cwd: 'relative' }],
    [{ cwd: '/w\0x' }],
    [{ cwd: '/w', name: '--settings=/evil' }],
    [{ cwd: '/w', model: '--plugin-dir' }],
    [{ cwd: '/w', effort: 'extreme' }],
    [{ cwd: '/w', permissionMode: 'yolo' }],
    [{ cwd: '/w', isolation: 'sometimes' }],
    // The app's own flags, however the window sends them (MIP2-1407).
    [{ cwd: '/w', extraArgs: ['--settings', '/evil.json'] }],
    [{ cwd: '/w', extraArgs: ['--plugin-dir=/evil'] }],
    [{ cwd: '/w', extraArgs: ['--', 'prompt'] }],
    [{ cwd: '/w', extraArgs: '--verbose' }],
    [{ cwd: '/w', ultracode: 'yes' }],
    [null],
  ])('refuses %o', req => expect(checkLaunch(req)).toBeNull())

  it('accepts only known settings with sane values (MIP2-1407)', async () => {
    const { checkSettings } = await import('../src/main/validate.ts')
    expect(checkSettings({ notifyTurn: true, rollOffDays: 10, arbiterCapUsd: 2.5 })).toEqual({ notifyTurn: true, rollOffDays: 10, arbiterCapUsd: 2.5 })
    // The settings window's terminal and General values (MIP2-1424); an empty font clears it.
    expect(checkSettings({ showOutside: false, terminalFont: ' Fira Mono ', terminalFontSize: 18 })).toEqual({ showOutside: false, terminalFont: 'Fira Mono', terminalFontSize: 18 })
    expect(checkSettings({ terminalFont: '' })).toEqual({ terminalFont: '' })
    // The sidebar's width, 200–480 px (MIP2-1495).
    expect(checkSettings({ sidebarWidth: 320 })).toEqual({ sidebarWidth: 320 })
    for (const bad of [
      { sidebarWidth: 199 },
      { sidebarWidth: 481 },
      { sidebarWidth: 300.5 },
      { rollOffDays: 6 },
      { rollOffDays: 15 },
      { rollOffDays: 7.5 },
      { arbiterCapUsd: -1 },
      { arbiterCapUsd: 1e6 },
      { notifyEnabled: 'yes' },
      { firstRunDoneAt: 0 },
      { recentFolders: [] },
      { terminalFont: 'Fira", serif; x' },
      { terminalFont: 'a'.repeat(65) },
      { terminalFontSize: 8 },
      { terminalFontSize: 33 },
      { terminalFontSize: 12.5 },
      { showOutside: 'no' },
      null,
    ]) {
      expect(checkSettings(bad)).toBeNull()
    }
  })

  it('passes Ultracode and allowed extra flags through, and refuses one that changes posture (MIP2-1407, gate M-4)', () => {
    expect(checkLaunch({ cwd: '/w', ultracode: true, extraArgs: ['--fallback-model', 'claude sonnet'] })).toEqual({ cwd: '/w', ultracode: true, extraArgs: ['--fallback-model', 'claude sonnet'] })
    expect(checkLaunch({ cwd: '/w', permissionMode: 'default', extraArgs: ['--dangerously-skip-permissions'] })).toBeNull()
    expect(checkLaunch({ cwd: '/w', extraArgs: ['--add-dir', '/x y'] })).toBeNull()
  })

  it('checks answers', () => {
    expect(checkAnswer({ verdict: 'deny', extra: 1 })).toEqual({ verdict: 'deny' })
    expect(checkAnswer({ verdict: 'allow', answers: { Q: 'A' } })).toEqual({ verdict: 'allow', answers: { Q: 'A' } })
    expect(checkAnswer({ verdict: 'allow', answers: { Q: 1 } })).toBeNull()
    expect(checkAnswer({ verdict: 'setMode' })).toBeNull()
  })

  it('takes only session UUIDs', () => {
    expect(isSessionId('c0ffee01-0000-4000-8000-000000000001')).toBe(true)
    expect(isSessionId('c0ffee01')).toBe(false)
  })
})

describe('QA isolation (MIP2-1408)', async () => {
  const { debugPortAllowed, qaPackagedPaths, qaPickPaths, qaUsageDir, resolveChannelRoot, resolveUserData } = await import('../src/main/paths.ts')
  const appData = '/Users/x/Library/Application Support'
  const root = '/Users/x/.ccc/ch'

  it('takes a QA data folder, and refuses the defaults and every Electron CCCC folder', () => {
    expect(resolveUserData({}, appData)).toBe(`${appData}/CC Command Center App`)
    expect(resolveUserData({ CCC_USER_DATA: '/Users/x/ccc-qa/data' }, appData)).toBe('/Users/x/ccc-qa/data')
    expect(() => resolveUserData({ CCC_USER_DATA: `${appData}/CC Command Center App` }, appData)).toThrow("app's own")
    expect(() => resolveUserData({ CCC_USER_DATA: `${appData}/CC Command Center` }, appData)).toThrow('Electron CCCC')
    expect(() => resolveUserData({ CCC_USER_DATA: `${appData}/CC Command Center/sub` }, appData)).toThrow('Electron CCCC')
    expect(() => resolveUserData({ CCC_USER_DATA: 'relative' }, appData)).toThrow('absolute')
  })

  it('takes a short QA channel root, and refuses the default, an overlap or a long path', () => {
    expect(resolveChannelRoot({}, root)).toBe(root)
    expect(resolveChannelRoot({ CCC_CHANNEL_ROOT: '/tmp/ccc-qa/ch' }, root)).toBe('/tmp/ccc-qa/ch')
    expect(() => resolveChannelRoot({ CCC_CHANNEL_ROOT: root }, root)).toThrow('overlap')
    expect(() => resolveChannelRoot({ CCC_CHANNEL_ROOT: `${root}/qa` }, root)).toThrow('overlap')
    expect(() => resolveChannelRoot({ CCC_CHANNEL_ROOT: '/Users/x/.ccc' }, root)).toThrow('overlap')
    expect(() => resolveChannelRoot({ CCC_CHANNEL_ROOT: `/tmp/${'a'.repeat(90)}` }, root)).toThrow('too long')
  })

  it('opens the debugging port only for an unpackaged QA run', () => {
    expect(debugPortAllowed({ CCC_QA: '1' }, false)).toBe(true)
    expect(debugPortAllowed({}, false)).toBe(false)
    expect(debugPortAllowed({ CCC_QA: 'yes' }, false)).toBe(false)
    expect(debugPortAllowed({ CCC_QA: '1' }, true)).toBe(false)
    // QA's packaged-path switch: both variables, unpackaged only; a packaged build ignores it (MIP2-1507).
    expect(qaPackagedPaths({ CCC_QA: '1', CCC_QA_PACKAGED_PATHS: '1' }, false)).toBe(true)
    expect(qaPackagedPaths({ CCC_QA: '1', CCC_QA_PACKAGED_PATHS: '1' }, true)).toBe(false)
    expect(qaPackagedPaths({ CCC_QA_PACKAGED_PATHS: '1' }, false)).toBe(false)
    expect(qaPackagedPaths({ CCC_QA: '1' }, false)).toBe(false)
    expect(qaPackagedPaths({ CCC_QA: '1', CCC_QA_PACKAGED_PATHS: 'yes' }, false)).toBe(false)
    // QA's synthetic usage readings: same gate, an absolute folder, refused otherwise (MIP2-1516).
    expect(qaUsageDir({}, false)).toBeNull()
    expect(qaUsageDir({ CCC_QA: '1', CCC_QA_USAGE_DIR: '/tmp/qa-usage' }, false)).toBe('/tmp/qa-usage')
    expect(() => qaUsageDir({ CCC_QA: '1', CCC_QA_USAGE_DIR: '/tmp/qa-usage' }, true)).toThrow('needs CCC_QA=1')
    expect(() => qaUsageDir({ CCC_QA_USAGE_DIR: '/tmp/qa-usage' }, false)).toThrow('needs CCC_QA=1')
    expect(() => qaUsageDir({ CCC_QA: '1', CCC_QA_USAGE_DIR: 'rel' }, false)).toThrow('absolute')
    // The ⌘O stand-in follows the port's rule (MIP2-1413).
    expect(qaPickPaths({}, false)).toBeNull()
    expect(qaPickPaths({ CCC_QA: '1', CCC_QA_PICK_PATHS: '/a b/c:/d' }, false)).toEqual(['/a b/c', '/d'])
    expect(() => qaPickPaths({ CCC_QA_PICK_PATHS: '/a' }, false)).toThrow('CCC_QA=1')
    expect(() => qaPickPaths({ CCC_QA: '1', CCC_QA_PICK_PATHS: '/a' }, true)).toThrow('unpackaged')
    expect(() => qaPickPaths({ CCC_QA: '1', CCC_QA_PICK_PATHS: 'rel:/a' }, false)).toThrow('absolute')
  })

  it('drops the debugging switch in main before anything else runs', () => {
    const main = readFileSync(join(import.meta.dirname, '../src/main/index.ts'), 'utf8')
    const gate = main.indexOf("removeSwitch('remote-debugging-port')")
    expect(gate).toBeGreaterThan(0)
    expect(gate).toBeLessThan(main.indexOf('applyBeforeReady()'))
    expect(gate).toBeLessThan(main.indexOf('app.whenReady()'))
  })
})
