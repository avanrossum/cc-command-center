// The app's records are checked when read from disk (gate L-3, MIP2-1431).

import { describe, expect, it } from 'vitest'
import { checkSelfCheckFile, checkStore } from '../src/main/store-schema.ts'

const SID = 'c0ffee01-0000-4000-8000-000000000001'

describe('checkStore', () => {
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
