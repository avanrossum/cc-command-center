// Which reporter mod copy a session with no record of it uses, checked before it resumes (MIP2-1504).

import { describe, expect, it } from 'vitest'
import { backfillVersion, pathFold, realPath, savedFlagsCheck, savedFlagsRefusal, savedOptionsCheck, savedOptionsRefusal, type BackfillDeps, type DirRules } from '../src/main/mod-backfill.ts'

const ROOT = '/data/reporter-mod'
const H = 'abcdef0123456789'
const CUR = '0123456789abcdef'

function deps(over: Partial<BackfillDeps> & { files?: Record<string, string> } = {}) {
  const files = new Map(Object.entries({ '/app/dist/mod': CUR, ...(over.files ?? { [`${ROOT}/${H}`]: H, [`${ROOT}/${CUR}`]: CUR }) }))
  const restored: [string, string][] = []
  const d: BackfillDeps = {
    modRoot: ROOT,
    current: `${ROOT}/${CUR}`,
    source: '/app/dist/mod',
    stuck: new Set(),
    exists: p => files.has(p),
    isDir: p => files.has(p),
    hash: p => files.get(p) ?? '',
    restore: (from, to) => (restored.push([from, to]), files.set(to, files.get(from)!)),
    ...over,
  }
  return { d, restored }
}

describe('backfillVersion (MIP2-1504)', () => {
  it('takes a copy that hashes to its name when it resumes', () => {
    expect(backfillVersion({ dir: `${ROOT}/${H}` }, deps().d)).toEqual({ version: H, restored: false })
    expect(backfillVersion({ dir: `${ROOT}/${H}-r1700000000000` }, deps({ files: { [`${ROOT}/${H}-r1700000000000`]: H } }).d)).toEqual({ version: `${H}-r1700000000000`, restored: false })
  })

  it('hashes the folder at every resume, so a current copy changed since the last round is refused (MIP2-1508)', () => {
    const changed = deps({ files: { [`${ROOT}/${CUR}`]: 'changed after startup' } })
    expect(backfillVersion({ dir: `${ROOT}/${CUR}` }, changed.d)).toEqual({ refused: 'its saved reporter mod copy no longer matches its name' })
    const unreadable = deps({
      hash: () => {
        throw new Error('EACCES')
      },
    })
    expect(backfillVersion({ dir: `${ROOT}/${H}` }, unreadable.d)).toEqual({ refused: "its saved reporter mod copy couldn't be read (EACCES)" })
  })

  it("refuses a copy that no longer matches its name, a stuck one, one outside the app's folder, or a link", () => {
    expect(backfillVersion({ dir: `${ROOT}/${H}` }, deps({ files: { [`${ROOT}/${H}`]: 'changed' } }).d)).toEqual({ refused: 'its saved reporter mod copy no longer matches its name' })
    expect(backfillVersion({ dir: `${ROOT}/${H}` }, deps({ stuck: new Set([H]) }).d)).toMatchObject({ refused: expect.stringMatching(/moved aside/) })
    expect(backfillVersion({ dir: `/elsewhere/${H}` }, deps().d)).toMatchObject({ refused: expect.stringMatching(/isn't one of the app's copies/) })
    expect(backfillVersion({ dir: `${ROOT}/not-a-hash` }, deps().d)).toMatchObject({ refused: expect.stringMatching(/isn't one of the app's copies/) })
    expect(backfillVersion({ dir: `${ROOT}/${H}` }, deps({ isDir: () => false }).d)).toMatchObject({ refused: expect.stringMatching(/isn't a folder/) })
    expect(backfillVersion({ refused: 'unreadable' }, deps().d)).toEqual({ refused: 'unreadable' })
  })

  it("restores a pruned copy of the current version from the build's own mod, then checks it again", () => {
    const cur = deps({ files: { [`${ROOT}/${CUR}`]: CUR } })
    expect(backfillVersion({ dir: `${ROOT}/${CUR}-r1700000000000` }, cur.d)).toEqual({ version: `${CUR}-r1700000000000`, restored: true })
    expect(cur.restored).toEqual([['/app/dist/mod', `${ROOT}/${CUR}-r1700000000000`]])
    // The current copy itself pruned while the app runs: restored from the build, not from the missing folder (MIP2-1508).
    const gone = deps({ files: {} })
    expect(backfillVersion({ dir: `${ROOT}/${CUR}` }, gone.d)).toEqual({ version: CUR, restored: true })
    expect(gone.restored).toEqual([['/app/dist/mod', `${ROOT}/${CUR}`]])
    // A restore that throws is a refusal with its reason, never a raw error.
    const failing = deps({
      files: {},
      restore: () => {
        throw new Error("ENOENT: no such file or directory, lstat '/x'")
      },
    })
    expect(backfillVersion({ dir: `${ROOT}/${CUR}` }, failing.d)).toEqual({ refused: "its saved reporter mod copy was removed and couldn't be restored (ENOENT: no such file or directory, lstat '/x')" })
    const other = deps({ files: { [`${ROOT}/${CUR}`]: CUR } })
    expect(backfillVersion({ dir: `${ROOT}/${H}` }, other.d)).toMatchObject({ refused: expect.stringMatching(/isn't the app's current version/) })
    expect(other.restored).toEqual([])
    const bad = deps({ files: { [`${ROOT}/${CUR}`]: CUR }, restore: () => {} })
    expect(backfillVersion({ dir: `${ROOT}/${CUR}-r1` }, bad.d)).toMatchObject({ refused: expect.stringMatching(/didn't check out/) })
  })
})

describe('savedOptionsRefusal, on every restart (gate pass 17, M-1; pass 18, M-1)', () => {
  const launch = { model: 'opus', effort: 'high', mode: 'default', extraArgs: ['--verbose'], name: 'Pagination tests' }
  const rec = { modRoot: ROOT, mod: H, settings: '/ch/1/settings.json', launch, cwd: '/w/app' }
  // As 2.1.312 saves them: the app's flags, in its own order, no --bg and no prompt (Research MIP2-1506).
  const flags = (...extra: string[]) => ['--name', 'Pagination tests', '--settings', '/ch/1/settings.json', '--plugin-dir', `${ROOT}/${H}`, '--effort', 'high', '--permission-mode', 'default', '--model', 'opus', '--verbose', ...extra]
  const saved = (f = flags(), over: Partial<{ dir: string; settings: string; cwd: string }> = {}) => ({ dir: `${ROOT}/${H}`, settings: '/ch/1/settings.json', flags: f, cwd: '/w/app', ...over })

  it("passes only the recorded copy, its channel's settings file and the recorded launch", () => {
    expect(savedOptionsRefusal(saved(), rec)).toBeNull()
  })

  it('refuses when the store records copy A and Claude Code would load B, or another settings file', () => {
    expect(savedOptionsRefusal(saved(flags(), { dir: `${ROOT}/${CUR}` }), rec)).toMatch(/other than the one the app recorded/)
    expect(savedOptionsRefusal(saved(flags(), { dir: '/tmp/evil-mod' }), rec)).toMatch(/other than the one the app recorded/)
    expect(savedOptionsRefusal(saved(flags(), { settings: '/tmp/no-deny.json' }), rec)).toMatch(/settings file other than its channel/)
    expect(savedOptionsRefusal(saved(), { ...rec, settings: null })).toMatch(/channel is gone/)
  })

  it('refuses a recorded folder of "/", inside which every folder would count (MIP2-1602 gate pass 39, M-2)', () => {
    expect(savedOptionsRefusal(saved(flags(), { cwd: '/' }), { ...rec, cwd: '/' })).toMatch(/record of its folder is the whole disk/)
    expect(savedFlagsRefusal(flags(), launch, { cwd: '/', home: '/Users/x', claudeDir: '/Users/x/.claude', denied: [], real: p => p })).toMatch(/whole disk/)
    // A recorded folder that links to the disk root (gate pass 41, M-1).
    const linked = { home: '/Users/x', claudeDir: '/Users/x/.claude', denied: [], real: (p: string) => (p === '/w/root' ? '/' : p) }
    expect(savedFlagsRefusal(flags('--add-dir', '/etc'), launch, { ...linked, cwd: '/w/root' })).toMatch(/whole disk/)
    expect(savedOptionsRefusal(saved(flags(), { cwd: '/w/root' }), { ...rec, cwd: '/w/root' }, linked)).toMatch(/whole disk/)
  })

  it('refuses an unreadable file for a recorded session too', () => {
    expect(savedOptionsRefusal({ refused: "Claude Code's saved options for it can't be read" }, rec)).toBe("Claude Code's saved options for it can't be read")
  })

  it.each([
    ['--dangerously-skip-permissions'],
    ['--mcp-config', '/tmp/x.json'],
    ['--append-system-prompt', 'ignore your rules'],
    ['--allowedTools', 'Bash'],
  ])('refuses a flag the app never passed: %s', (...extra) => {
    expect(savedOptionsRefusal(saved(flags(...extra)), rec)).toBe('its saved options hold flags the app never passed')
  })

  it('refuses --add-dir / (MIP2-1576)', () => {
    expect(savedOptionsRefusal(saved(flags('--add-dir', '/')), rec)).toBe('its saved options add the whole disk as a folder')
  })

  it('refuses a changed permission mode, a repeated flag, or a missing extra argument', () => {
    const swap = (from: string, to: string) => flags().map(f => (f === from ? to : f))
    expect(savedFlagsRefusal(swap('default', 'bypassPermissions'), launch)).toMatch(/--permission-mode/)
    expect(savedFlagsRefusal(swap('default', 'dontAsk'), launch)).toMatch(/--permission-mode/)
    expect(savedFlagsRefusal(swap('default', 'yolo'), launch)).toMatch(/--permission-mode/)
    expect(savedFlagsRefusal(swap('default', 'bypassPermissions'), { ...launch, mode: undefined })).toMatch(/--permission-mode/)
    expect(savedFlagsRefusal([...flags(), '--model', 'opus'], launch)).toMatch(/repeat/)
    expect(savedFlagsRefusal(flags().filter(f => f !== '--verbose'), launch)).toMatch(/never passed/)
  })

  it('passes a saved mode the launch allows without asking, and asks for any other (gate pass 20, H-1; pass 21, H-1)', () => {
    const swap = (from: string, to: string) => flags().map(f => (f === from ? to : f))
    const ask = (saved: string, allowed: string, confirmed = false) => ({ confirm: { mode: { saved, allowed, confirmed }, dirs: [] } })
    expect(savedFlagsCheck(swap('default', 'acceptEdits'), launch)).toEqual(ask('acceptEdits', 'default'))
    expect(savedFlagsCheck(swap('default', 'auto'), launch)).toEqual(ask('auto', 'default'))
    expect(savedFlagsRefusal(swap('default', 'auto'), launch)).toBe('Saved settings: auto. Launched as default.')
    // plan isn't below default: where auto mode is available it runs classifier-approved shell commands.
    expect(savedFlagsCheck(swap('default', 'plan'), launch)).toEqual(ask('plan', 'default'))
    expect(savedFlagsCheck(swap('default', 'plan'), { ...launch, mode: 'acceptEdits' })).toEqual(ask('plan', 'acceptEdits'))
    expect(savedFlagsRefusal(swap('default', 'plan'), { ...launch, mode: 'auto' })).toBeNull()
    expect(savedFlagsRefusal(swap('default', 'plan'), { ...launch, mode: 'bypassPermissions' })).toBeNull()
    // From plan, only default passes; auto and acceptEdits ask.
    expect(savedFlagsRefusal(swap('default', 'default'), { ...launch, mode: 'plan' })).toBeNull()
    expect(savedFlagsCheck(swap('default', 'auto'), { ...launch, mode: 'plan' })).toEqual(ask('auto', 'plan'))
    expect(savedFlagsCheck(swap('default', 'acceptEdits'), { ...launch, mode: 'plan' })).toEqual(ask('acceptEdits', 'plan'))
    // No recorded mode: it ran in default.
    expect(savedFlagsCheck(swap('default', 'acceptEdits'), { ...launch, mode: undefined })).toEqual(ask('acceptEdits', 'default'))
    expect(savedFlagsRefusal(swap('default', 'default'), { ...launch, mode: undefined })).toBeNull()
    // Launched higher, saved lower: passes.
    expect(savedFlagsRefusal(swap('default', 'acceptEdits'), { ...launch, mode: 'auto' })).toBeNull()
    // Launch-only modes pass only as the recorded one.
    expect(savedFlagsRefusal(swap('default', 'bypassPermissions'), { ...launch, mode: 'bypassPermissions' })).toBeNull()
    expect(savedFlagsRefusal(swap('default', 'dontAsk'), { ...launch, mode: 'dontAsk' })).toBeNull()
    expect(savedFlagsRefusal(swap('default', 'bypassPermissions'), { ...launch, mode: 'auto' })).toMatch(/never launched it with/)
    expect(savedFlagsRefusal(swap('default', 'dontAsk'), launch)).toMatch(/never launched it with/)
    // A name an object inherits isn't a mode (gate pass 24, M-1).
    for (const inherited of ['constructor', '__proto__', 'toString', 'hasOwnProperty', 'valueOf'])
      expect(savedFlagsRefusal(swap('default', inherited), launch)).toMatch(/never launched it with/)
    // Nor as a launched or confirmed mode: nothing passes under it, and nothing throws.
    expect(savedFlagsCheck(swap('default', 'auto'), { ...launch, mode: 'constructor' })).toEqual(ask('auto', 'constructor'))
    expect(savedFlagsCheck(swap('default', 'auto'), launch, undefined, { mode: 'constructor' })).toEqual(ask('auto', 'constructor', true))
  })

  it('passes what Alex confirmed, kept apart from the launch, and names it in the wording (gate pass 21, L-3)', () => {
    const swap = (from: string, to: string) => flags().map(f => (f === from ? to : f))
    expect(savedFlagsRefusal(swap('default', 'auto'), launch, undefined, { mode: 'auto' })).toBeNull()
    expect(savedFlagsRefusal(swap('default', 'acceptEdits'), launch, undefined, { mode: 'auto' })).toBeNull()
    expect(savedFlagsRefusal(swap('default', 'bypassPermissions'), launch, undefined, { mode: 'auto' })).toMatch(/never launched it with/)
    expect(savedFlagsRefusal(swap('default', 'auto'), launch, undefined, { mode: 'acceptEdits' })).toBe('Saved settings: auto. Confirmed as acceptEdits.')
    // A launch-only mode in the confirmed record, as only a hand edit could put there, still refuses (gate pass 22, L-2).
    expect(savedFlagsRefusal(swap('default', 'bypassPermissions'), launch, undefined, { mode: 'bypassPermissions' })).toMatch(/never launched it with/)
  })

  it('accepts a model or effort changed in the session, or saved where the launch had none (MIP2-1572)', () => {
    const swap = (from: string, to: string) => flags().map(f => (f === from ? to : f))
    expect(savedFlagsRefusal(swap('opus', 'fable'), launch)).toBeNull()
    expect(savedFlagsRefusal(swap('high', 'max'), launch)).toBeNull()
    expect(savedFlagsRefusal(flags(), { ...launch, model: undefined, effort: undefined })).toBeNull()
    // Still a value, never a flag.
    expect(savedFlagsRefusal(swap('opus', '--dangerously-skip-permissions'), launch)).toMatch(/repeat a flag or leave out a value/)
  })

  // Home /Users/x, Claude Code's folder /Users/x/.claude, the app's data /Users/x/Library/App; /Users/x/link points into the session's folder.
  const rules: Omit<DirRules, 'cwd'> = {
    home: '/Users/x',
    claudeDir: '/Users/x/.claude',
    denied: ['/Users/x/Library/App', '/Users/x/.ccc/ch'],
    real: p => (p.startsWith('/Users/x/link') ? p.replace('/Users/x/link', '/w/app/sub') : p.replace(/\/+$/, '') || '/'),
    fold: p => p.normalize('NFC').toLowerCase(),
  }
  const check = (...extra: string[]) => savedOptionsCheck(saved(flags(...extra)), rec, rules)

  it('passes --proactivity with any value, and --add-dir inside the session folder or confirmed (MIP2-1576; D-040)', () => {
    expect(check('--proactivity', 'high')).toBeNull()
    expect(check('--add-dir', '/w/app/docs', '--add-dir', '/w/app')).toBeNull()
    // Resolved first: a link into the session folder passes.
    expect(check('--add-dir', '/Users/x/link')).toBeNull()
    expect(savedOptionsCheck(saved(flags('--add-dir', '/opt/shared')), { ...rec, confirmed: { addDirs: ['/opt/shared'] } }, rules)).toBeNull()
    // A name that differs only by case is another folder to the pass checks, as on a case-sensitive volume; on a
    // case-insensitive one realpathSync.native gives it the confirmed name (gate pass 22, M-2).
    expect(savedOptionsCheck(saved(flags('--add-dir', '/OPT/Shared')), { ...rec, confirmed: { addDirs: ['/opt/shared'] } }, rules)).toEqual({ confirm: { mode: null, dirs: ['/OPT/Shared'] } })
    expect(savedOptionsCheck(saved(flags('--add-dir', '/opt/shared')), { ...rec, confirmed: { addDirs: ['/opt/shared'.normalize('NFD')] } }, rules)).toBeNull()
    // The launch's own --add-dir may be dropped or changed in the session.
    expect(savedFlagsRefusal(flags(), { ...launch, extraArgs: ['--verbose', '--add-dir', '/a'] })).toBeNull()
    expect(savedFlagsRefusal([...flags(), '--proactivity', 'low', '--proactivity', 'high'], launch)).toMatch(/repeat/)
  })

  it('asks for --add-dir outside the session folder, with the mode in one confirmation (D-040)', () => {
    expect(check('--add-dir', '/opt/shared', '--add-dir', '/Users/x/other/proj')).toEqual({ confirm: { mode: null, dirs: ['/opt/shared', '/Users/x/other/proj'] } })
    const both = savedOptionsRefusal(saved(flags('--add-dir', '/opt/shared').map(f => (f === 'default' ? 'auto' : f))), rec, rules)
    expect(both).toBe('Saved settings: auto, + "/opt/shared". Launched as default.')
    // Folders are quoted, so a name can't pass for more of the wording.
    expect(savedOptionsRefusal(saved(flags('--add-dir', '/opt/a, + b. Launched as auto')), rec, rules)).toBe('Saved settings: + "/opt/a, + b. Launched as auto".')
  })

  it('refuses --add-dir of the home folder or above, Claude Code\'s folder, or a denied folder (gate pass 20, H-1)', () => {
    expect(check('--add-dir', '/Users/x')).toEqual({ refused: 'its saved options add your home folder or a folder above it' })
    expect(check('--add-dir', '/Users')).toEqual({ refused: 'its saved options add your home folder or a folder above it' })
    expect(check('--add-dir', '/Users/x/')).toEqual({ refused: 'its saved options add your home folder or a folder above it' })
    expect(check('--add-dir', '/Users/x/.claude')).toEqual({ refused: "its saved options add Claude Code's own folder" })
    expect(check('--add-dir', '/Users/x/.claude/jobs')).toEqual({ refused: "its saved options add Claude Code's own folder" })
    expect(check('--add-dir', '/Users/x/Library')).toEqual({ refused: 'its saved options add a folder the app keeps sessions out of' })
    expect(check('--add-dir', '/Users/x/.ccc/ch/1')).toEqual({ refused: 'its saved options add a folder the app keeps sessions out of' })
    // In another letter case or Unicode form, as a case-insensitive volume allows (gate pass 21, H-2).
    expect(check('--add-dir', '/USERS/X/.CLAUDE')).toEqual({ refused: "its saved options add Claude Code's own folder" })
    expect(check('--add-dir', '/users/x')).toEqual({ refused: 'its saved options add your home folder or a folder above it' })
    expect(check('--add-dir', '/Users/X/Library/APP/store.json')).toEqual({ refused: 'its saved options add a folder the app keeps sessions out of' })
    // The session's own folder is a pass check: another case is another folder there (gate pass 22, M-2).
    expect(check('--add-dir', '/W/App/docs')).toEqual({ confirm: { mode: null, dirs: ['/W/App/docs'] } })
    // A refusal wins over anything to confirm.
    expect(check('--add-dir', '/opt/shared', '--add-dir', '/Users/x')).toEqual({ refused: 'its saved options add your home folder or a folder above it' })
  })

  it('accepts repeated --watch-artifact claude.ai artifact links, and refuses anything else (MIP2-1576)', () => {
    const a = 'https://claude.ai/artifact/0f3c2b1a'
    const b = 'https://claude.ai/code/artifact/5d6e7f80-0000-4000-8000-000000000000'
    expect(savedFlagsRefusal([...flags(), '--watch-artifact', a, '--watch-artifact', b], launch)).toBeNull()
    expect(savedFlagsRefusal(flags(), { ...launch, extraArgs: ['--verbose', '--watch-artifact', a] })).toBeNull()
    for (const bad of ['https://example.com/artifact/x', 'http://claude.ai/artifact/x', 'https://claude.ai/artifact/', 'https://claude.ai.evil.com/artifact/x', `${a}\0`, `${a}${'x'.repeat(2048)}`])
      expect(savedFlagsRefusal([...flags(), '--watch-artifact', bad], launch)).toMatch(/claude.ai artifact link/)
    expect(savedFlagsRefusal([...flags(), '--watch-artifact', '--mcp-config'], launch)).toMatch(/leave out a value/)
  })

  it('refuses an --add-dir with control or bidi characters (gate pass 21, L-2)', () => {
    for (const bad of ['/opt/a\nb', '/opt/a\u202eb', '/opt/a\u2066b', '/opt/\u0007', '/opt/a\u200bb', '/opt/a\u200db', '/opt/a\u2028b', '/opt/a\u2029b', '/opt/a\u2060b', '/opt/a\ufeffb', '/opt/a\u00adb', '/opt/shared\ufe0f', '/opt/a\u034fb', '/opt/a\u115fb', '/opt/a\u3164b', '/opt/a\u2800b', '/opt/a\u00a0b', '/opt/a\u2003b', '/opt/a\u3000b', '/opt/a\ue000b', '/opt/a\ud800b', '/opt/a\u{e0100}b', '/opt/a\uffa0b'])
      expect(savedFlagsRefusal([...flags(), '--add-dir', bad], launch)).toMatch(/plain absolute path/)
  })

  it("refuses a folder whose real name, reached through a link, can't be shown plainly (gate pass 24, M-4)", () => {
    const viaLink: DirRules = { ...rules, cwd: '/w/app', real: p => (p === '/opt/plain' ? '/opt/a\u202eb' : p) }
    expect(savedFlagsCheck([...flags(), '--add-dir', '/opt/plain'], launch, viaLink)).toEqual({ refused: "its saved options add a folder whose real name can't be shown plainly" })
  })

  it('passes a plain space and an accented name in either Unicode form (gate pass 23, L-2)', () => {
    for (const ok of ['/opt/Application Support/x', '/opt/Caf\u00e9', '/opt/Cafe\u0301'])
      expect(savedFlagsRefusal([...flags(), '--add-dir', ok], launch)).not.toMatch(/plain absolute path/)
  })

  it('refuses an --add-dir that is relative, missing, flag-shaped, holds a NUL or is too long (MIP2-1576)', () => {
    expect(savedFlagsRefusal([...flags(), '--add-dir', 'rel/path'], launch)).toMatch(/plain absolute path/)
    expect(savedFlagsRefusal([...flags(), '--add-dir', '/a\0b'], launch)).toMatch(/plain absolute path/)
    expect(savedFlagsRefusal([...flags(), '--add-dir', `/${'a'.repeat(4096)}`], launch)).toMatch(/plain absolute path/)
    expect(savedFlagsRefusal([...flags(), '--add-dir', '--dangerously-skip-permissions'], launch)).toMatch(/leave out a value/)
    expect(savedFlagsRefusal([...flags(), '--add-dir'], launch)).toMatch(/leave out a value/)
    for (const root of ['/', '//', '/.', '/tmp/..']) expect(savedFlagsRefusal([...flags(), '--add-dir', root], launch)).toMatch(/whole disk/)
    // Two paths after one --add-dir: the second is a flag the app never passed.
    expect(savedFlagsRefusal([...flags(), '--add-dir', '/a', '/b'], launch)).toMatch(/never passed/)
  })

  it('accepts a model, effort or mode Claude Code left out, which grants nothing (QA MIP2-1507)', () => {
    expect(savedFlagsRefusal(flags().filter((f, i, a) => f !== '--model' && a[i - 1] !== '--model'), launch)).toBeNull()
  })

  it('refuses a flag-shaped value or another folder, and accepts a renamed session (gate pass 19, L-1, M-2; MIP2-1572)', () => {
    const swap = (from: string, to: string) => flags().map(f => (f === from ? to : f))
    expect(savedFlagsRefusal(swap('Pagination tests', '--dangerously-skip-permissions'), launch)).toMatch(/repeat a flag or leave out a value/)
    expect(savedFlagsRefusal(swap('Pagination tests', 'Something else'), launch)).toBeNull()
    expect(savedFlagsRefusal(swap('Pagination tests', 'Something else'), { ...launch, name: undefined })).toBeNull()
    expect(savedOptionsRefusal(saved(flags(), { cwd: '/' }), rec)).toMatch(/folder other than the one the app launched it in/)
    expect(savedOptionsRefusal(saved(), { ...rec, cwd: null })).toMatch(/no record of its folder/)
  })
})

describe('realPath (D-040)', () => {
  // /Users/x/link is a link to /w/app; nothing under /w/app/new exists yet.
  const real = (p: string) => {
    const known: Record<string, string> = { '/': '/', '/Users': '/Users', '/Users/x': '/Users/x', '/Users/x/link': '/w/app', '/w': '/w', '/w/app': '/w/app' }
    if (known[p] === undefined) throw new Error(`ENOENT ${p}`)
    return known[p]
  }
  it('resolves links through the nearest existing parent of a path that does not exist yet', () => {
    expect(realPath('/Users/x/link', real)).toBe('/w/app')
    expect(realPath('/Users/x/link/new/deeper', real)).toBe('/w/app/new/deeper')
    expect(realPath('/Users/x/link/../x', real)).toBe('/Users/x/x')
  })
})

describe('pathFold (gate pass 21, H-2)', () => {
  it('folds case only where the upper-cased home resolves to the same folder, and always normalizes to NFC', () => {
    const insensitive = pathFold('/Users/x', p => (p.toLowerCase() === '/users/x' ? '/Users/x' : p))
    expect(insensitive('/USERS/X/Café')).toBe('/users/x/café')
    const sensitive = pathFold('/Users/x', p => {
      if (p !== '/Users/x') throw new Error('ENOENT')
      return p
    })
    expect(sensitive('/USERS/X')).toBe('/USERS/X')
    expect(sensitive('/a/Cafe\u0301')).toBe('/a/Caf\u00e9')
  })
})

