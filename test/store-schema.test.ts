// The app's records are checked when read from disk (gate L-3, MIP2-1431).

import { describe, expect, it } from 'vitest'
import { checkSelfCheckFile, checkStore } from '../src/main/store-schema.ts'

const SID = 'c0ffee01-0000-4000-8000-000000000001'

describe('checkStore', () => {
  it('keeps a launched mode only when it is a known one (gate pass 27, L-4)', () => {
    const at = (mode: unknown) => checkStore({ version: 1, categories: [], sessions: { [SID]: { categoryId: null, placedBy: null, launch: { mode, model: 'opus' } } }, settings: {} }).sessions[SID]?.launch
    expect(at('bypassPermissions')).toEqual({ mode: 'bypassPermissions', model: 'opus' })
    expect(at('yolo')).toEqual({ model: 'opus' })
    expect(at('constructor')).toEqual({ model: 'opus' })
  })

  it('keeps a confirmed mode only when a confirmation can hold it, never a launch-only one (gate pass 22, L-2)', () => {
    const at = (mode: unknown) => checkStore({ version: 1, categories: [], sessions: { [SID]: { categoryId: null, placedBy: null, confirmed: { mode, addDirs: ['/opt/a', 'rel'] } } }, settings: {} }).sessions[SID]?.confirmed
    expect(at('auto')).toEqual({ mode: 'auto', addDirs: ['/opt/a'] })
    expect(at('bypassPermissions')).toEqual({ addDirs: ['/opt/a'] })
    expect(at('dontAsk')).toEqual({ addDirs: ['/opt/a'] })
    expect(at('yolo')).toEqual({ addDirs: ['/opt/a'] })
  })

  it('moves a copy an earlier build recorded at "/" to its source\'s recorded folder, or keeps "/" (MIP2-1602 gate pass 39, L-1; pass 40, M-1)', () => {
    const SRC = 'c0ffee02-0000-4000-8000-000000000002'
    const load = (source: Record<string, unknown> | null, copy: Record<string, unknown>) =>
      checkStore({ version: 1, categories: [], sessions: { [SID]: { categoryId: null, placedBy: null, ...copy }, ...(source ? { [SRC]: { categoryId: null, placedBy: null, ...source } } : {}) }, settings: {} }).sessions[SID]?.launch
    // The source's launch folder first, then its own; never the copy's polled folder.
    expect(load({ launch: { cwd: '/w/app' }, cwd: '/w/other' }, { copyOf: SRC, cwd: '/tmp/x', launch: { model: 'haiku', cwd: '/' } })).toEqual({ model: 'haiku', cwd: '/w/app' })
    expect(load({ cwd: '/w/app' }, { copyOf: SRC, cwd: '/tmp/x', launch: { model: 'haiku', cwd: '/' } })).toEqual({ model: 'haiku', cwd: '/w/app' })
    expect(load({ launch: { cwd: '/w/app' } }, { copyOf: SRC, launch: { model: 'haiku', cwd: '/./' } })).toEqual({ model: 'haiku', cwd: '/w/app' })
    // No source record: kept at "/", which the restart check refuses.
    expect(load(null, { copyOf: SRC, cwd: '/tmp/x', launch: { model: 'haiku', cwd: '/' } })).toEqual({ model: 'haiku', cwd: '/' })
    expect(load({ launch: { cwd: '/' } }, { copyOf: SRC, launch: { model: 'haiku', cwd: '/' } })).toEqual({ model: 'haiku', cwd: '/' })
    // A legacy copy ran in the source's listed folder; the source's launch folder is preferred, and a mismatch refuses
    // at the check (gate pass 41, L-1).
    expect(load({ launch: { cwd: '/w/launched' }, cwd: '/w/listed' }, { copyOf: SRC, launch: { cwd: '/' } })).toEqual({ cwd: '/w/launched' })
    // A copy with a real folder, and a session that isn't a copy, are left as they are.
    expect(load({ launch: { cwd: '/w/app' } }, { copyOf: SRC, launch: { model: 'haiku', cwd: '/w' } })).toEqual({ model: 'haiku', cwd: '/w' })
    expect(load(null, { launch: { model: 'haiku', cwd: '/' } })).toEqual({ model: 'haiku', cwd: '/' })
  })

  it('follows a chain of legacy copies to the first recorded folder, whatever the order of the records (gate pass 41, L-2)', () => {
    const A = 'c0ffee0a-0000-4000-8000-00000000000a'
    const B = 'c0ffee0b-0000-4000-8000-00000000000b'
    const C = 'c0ffee0c-0000-4000-8000-00000000000c'
    const rec = (s: Record<string, unknown>) => ({ categoryId: null, placedBy: null, ...s })
    const a = rec({ launch: { cwd: '/w/app' } })
    const b = rec({ copyOf: A, launch: { cwd: '/' } })
    const c = rec({ copyOf: B, launch: { cwd: '/' } })
    for (const sessions of [{ [C]: c, [B]: b, [A]: a }, { [A]: a, [B]: b, [C]: c }]) {
      const s = checkStore({ version: 1, categories: [], sessions, settings: {} }).sessions
      expect([s[B]?.launch?.cwd, s[C]?.launch?.cwd]).toEqual(['/w/app', '/w/app'])
    }
    // A loop of legacy copies keeps "/".
    const loop = checkStore({ version: 1, categories: [], sessions: { [B]: rec({ copyOf: C, launch: { cwd: '/' } }), [C]: rec({ copyOf: B, launch: { cwd: '/' } }) }, settings: {} }).sessions
    expect([loop[B]?.launch?.cwd, loop[C]?.launch?.cwd]).toEqual(['/', '/'])
  })

  it('keeps well-formed records as they are', () => {
    const good = {
      version: 1,
      categories: [{ id: 'c3', name: 'Acme General', color: '#4ac0e2', label: 'AC-gen', emoji: '', sort: 1, folders: ['/Users/x/acme'], notFolders: [], isolation: 'none', arbiterReadsText: true, notifyNeeds: 'on', collapsed: false }],
      sessions: { [SID]: { categoryId: 'c3', placedBy: 'hand', name: 'site', cwd: '/Users/x/acme', origin: 'app', launch: { model: 'opus', mode: 'auto', extraArgs: ['--verbose'] } } },
      settings: { recentFolders: ['/Users/x/acme'], showOutside: true, notifyEnabled: true, terminalFont: 'Fira Mono', terminalFontSize: 18, arbiterCapUsd: 2, rollOffDays: 10 },
      importedAt: 5,
    }
    expect(checkStore(good)).toEqual(good)
  })

  it('drops what a tampered or broken file gets wrong, field by field', () => {
    const s = checkStore({
      version: 1,
      categories: [{ id: 'c3', name: 'ok', color: '#4ac0e2', folders: ['relative', '/abs'], isolation: 'everywhere' }, { id: 'BAD ID', name: 'x', color: '#000000' }, 'junk'],
      sessions: { [SID]: { categoryId: 'c3', placedBy: 'nobody', cwd: 'relative', name: 42, resumeFlags: { model: 'opus', mode: 7 } }, 'not-a-uuid': { categoryId: null } },
      settings: { terminalFont: 'x}; body{display:none', terminalFontSize: 400, lastMode: 'yolo', arbiterCapUsd: 1e9, rollOffDays: 2, showOutside: 'no' },
    })
    expect(s.categories).toEqual([{ id: 'c3', name: 'ok', color: '#4ac0e2', label: '', emoji: '', sort: 0, folders: ['/abs'], notFolders: [], isolation: 'none', arbiterReadsText: false, collapsed: false }])
    expect(s.sessions).toEqual({ [SID]: { categoryId: 'c3', placedBy: null, resumeFlags: { model: 'opus' } } })
    expect(s.settings).toEqual({ recentFolders: [], showOutside: true, notifyEnabled: true })
    expect(s.importedAt).toBeNull()
  })

  it("keeps the switcher's session ids, once each, recents not pinned, at most five (MIP2-1494)", () => {
    const id = (n: number) => `c0ffee01-0000-4000-8000-00000000000${n}`
    const s = checkStore({ version: 1, settings: { switcherPins: [id(1), 'nope', id(1), id(2)], switcherRecent: [id(2), id(3), id(4), id(5), id(6), id(7), id(8), 42] } })
    expect(s.settings.switcherPins).toEqual([id(1), id(2)])
    expect(s.settings.switcherRecent).toEqual([id(4), id(5), id(6), id(7), id(8)])
  })

  it('reads any other version as empty', () => {
    expect(checkStore({ version: 2, categories: [] }).categories).toEqual([])
    expect(checkStore('nonsense').version).toBe(1)
  })
})

describe('checkSelfCheckFile', () => {
  it('keeps each version\'s pass and fail results, and drops the rest', () => {
    expect(
      checkSelfCheckFile({
        '2.1.311': { channel: { state: 'pass', detail: null }, 'event:turn.start': { state: 'fail', detail: 'x', rule: 2 }, bad: { state: 'maybe' } },
        latest: { channel: { state: 'pass' } },
      }),
    ).toEqual({ '2.1.311': { channel: { state: 'pass', detail: null }, 'event:turn.start': { state: 'fail', detail: 'x', rule: 2 } } })
    expect(checkSelfCheckFile(null)).toEqual({})
  })
})

describe('checkImportedSettings (gate L-2)', () => {
  it("drops 0.24 values the app wouldn't accept if typed, the CSS-breaking font name included", async () => {
    const { checkImportedSettings } = await import('../src/main/validate.ts')
    expect(
      checkImportedSettings({ terminalFont: 'Fira}body{display:none', terminalFontSize: 18, lastModel: 'opus', lastEffort: 'ultra', lastMode: 'auto', lastFolder: 'relative' }),
    ).toEqual({ terminalFontSize: 18, lastModel: 'opus', lastMode: 'auto' })
    expect(checkImportedSettings({ terminalFont: 'Fira Mono', terminalFontSize: 100 })).toEqual({ terminalFont: 'Fira Mono' })
  })
})

describe('category ids (MIP2-1433)', () => {
  it('makes a valid id on a collision', async () => {
    const { uniqueCategoryId } = await import('../src/main/store-schema.ts')
    const { isCategoryId } = await import('../src/main/validate.ts')
    const taken = new Set(['nmvqedl90'])
    const id = uniqueCategoryId('nmvqedl90', taken)
    expect(id).not.toBe('nmvqedl90')
    expect(isCategoryId(id)).toBe(true)
  })

  it('renames an old "-2" id on load and moves its sessions and ties with it', () => {
    const s = checkStore({
      version: 1,
      categories: [
        { id: 'nmvqedl90', name: 'One', color: '#4ac0e2' },
        { id: 'nmvqedl90-2', name: 'Two', color: '#9bbf4a' },
      ],
      sessions: { [SID]: { categoryId: 'nmvqedl90-2', placedBy: 'hand', tie: ['nmvqedl90', 'nmvqedl90-2'] } },
    })
    const two = s.categories.find(c => c.name === 'Two')!
    expect(two.id).toBe('nmvqedl902')
    expect(s.sessions[SID]).toMatchObject({ categoryId: 'nmvqedl902', tie: ['nmvqedl90', 'nmvqedl902'] })
  })
})

describe('the untrusted mark (pass 4, M-2)', () => {
  it('keeps a session\'s mark as a short string, and drops anything else', () => {
    const id = 'c0ffee01-0000-4000-8000-000000000001'
    const read = (untrusted: unknown) => checkStore({ version: 1, sessions: { [id]: { categoryId: null, untrusted } } }).sessions[id]?.untrusted
    expect(read('the socket file was moved or replaced')).toBe('the socket file was moved or replaced')
    expect(read(1)).toBeUndefined()
    expect(read('x'.repeat(301))).toBeUndefined()
  })
})

describe('parked-session fields (MIP2-1465)', () => {
  it('keeps parkedHidden and showParked as booleans and drops anything else', () => {
    const id = 'c0ffee01-0000-4000-8000-000000000001'
    const st = checkStore({ version: 1, sessions: { [id]: { categoryId: null, parkedHidden: true } }, settings: { showParked: false } })
    expect(st.sessions[id]?.parkedHidden).toBe(true)
    expect(st.settings.showParked).toBe(false)
    const bad = checkStore({ version: 1, sessions: { [id]: { categoryId: null, parkedHidden: 'yes' } }, settings: { showParked: 1 } })
    expect(bad.sessions[id]?.parkedHidden).toBeUndefined()
    expect(bad.settings.showParked).toBeUndefined()
  })
})
