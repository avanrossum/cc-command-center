// The app's store service (MIP2-1409): import, auto-assign for new
// sessions, placement by hand, and the category editor's changes.

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppStoreService } from '../src/main/app-store.ts'
import { A, B, C, makeRegistry } from './registry-fixture.ts'

const HOME = '/Users/x'
const REPOS = new Set(['/Users/x/acme', '/Users/x/bbrl', '/Users/x/site'])
const D = '11111111-1111-4111-8111-111111111111'
const E = '22222222-2222-4222-8222-222222222222'
const F = '33333333-3333-4333-8333-333333333333'

let dir: string
let reg: string
const open = () => new AppStoreService(join(dir, 'store.json'), HOME, d => REPOS.has(d))

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccc-store-'))
  reg = mkdtempSync(join(dir, 'reg-'))
  makeRegistry(reg)
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('AppStoreService', () => {
  it('imports categories and sessions, then reports auto-assign of the uncategorized', () => {
    const s = open()
    const sum = s.importFrom(reg, [
      { sessionId: A, cwd: '/Users/x/acme' },
      { sessionId: C, cwd: '/Users/x/bbrl' },
    ])
    expect(sum).toMatchObject({ categories: 3, assigned: 0, uncategorized: 1 })
    expect(s.get().categories.map(c => c.name)).toEqual(['Acme - Platform v2', 'Acme General', 'Acme Governance'])
    expect(s.get().sessions[A]).toMatchObject({ categoryId: 'c3', placedBy: 'import', name: 'production-log' })
    expect(s.get().importedAt).not.toBeNull()
    // 0.24's hideUnmanaged is kept for the move-in step, not applied (ruling on MIP2-1424).
    expect(s.get().settings).toMatchObject({ showOutside: true, importedHideUnmanaged: true })
  })

  it('leaves a new session uncategorized when its folder has sessions in two categories', () => {
    const s = open()
    s.importFrom(reg, [])
    // A (c3) and B (c12) both sit in /Users/x/acme.
    expect(s.assignNew([{ sessionId: D, cwd: '/Users/x/acme/src' }])).toBe(0)
    expect(s.get().sessions[D]).toMatchObject({ categoryId: null, placedBy: null })
  })

  it("assigns by a category's own folders and learns from placements by hand", () => {
    const s = open()
    s.importFrom(reg, [])
    const site = s.saveCategory({ name: 'Site', folders: ['/Users/x/site', 'relative'] })
    expect(site.folders).toEqual(['/Users/x/site'])
    expect(site.arbiterReadsText).toBe(false)
    expect(s.assignNew([{ sessionId: D, cwd: '/Users/x/site/web' }])).toBe(1)
    expect(s.get().sessions[D]).toMatchObject({ categoryId: site.id, placedBy: 'auto' })

    s.place(C, 'c21')
    expect(s.assignNew([{ sessionId: E, cwd: '/Users/x/bbrl' }])).toBe(1)
    expect(s.get().sessions[E]?.categoryId).toBe('c21')
  })

  it('never re-assigns a session it has seen', () => {
    const s = open()
    s.assignNew([{ sessionId: D, cwd: '/Users/x/site' }])
    s.saveCategory({ name: 'Site', folders: ['/Users/x/site'] })
    expect(s.assignNew([{ sessionId: D, cwd: '/Users/x/site' }])).toBe(0)
    expect(s.get().sessions[D]?.categoryId).toBeNull()
  })

  it('keeps a placement by hand through a second import', () => {
    const s = open()
    s.importFrom(reg, [])
    s.place(A, 'c21')
    s.importFrom(reg, [])
    expect(s.get().sessions[A]).toMatchObject({ categoryId: 'c21', placedBy: 'hand' })
    expect(s.get().categories).toHaveLength(3)
  })

  it('"Not <category>" uncategorizes and stops the folder matching again', () => {
    const s = open()
    const site = s.saveCategory({ name: 'Site', folders: ['/Users/x/site'] })
    s.assignNew([{ sessionId: D, cwd: '/Users/x/site' }])
    s.notCategory(D)
    expect(s.get().sessions[D]).toMatchObject({ categoryId: null, placedBy: 'hand' })
    expect(s.get().categories.find(c => c.id === site.id)?.notFolders).toEqual(['/Users/x/site'])
    expect(s.assignNew([{ sessionId: F, cwd: '/Users/x/site' }])).toBe(0)
  })

  it('reorders, deletes and persists', () => {
    const s = open()
    s.importFrom(reg, [])
    s.reorder(['c21', 'c3'])
    expect(s.get().categories.map(c => c.id)).toEqual(['c21', 'c3', 'c12'])
    s.deleteCategory('c3')
    expect(s.get().sessions[A]).toMatchObject({ categoryId: null, placedBy: null })
    expect(() => s.place(B, 'c3')).toThrow()

    const again = open()
    expect(again.get().categories.map(c => c.id)).toEqual(['c21', 'c12'])
    expect(again.get().sessions[B]?.alias).toBe('platform-investigation')
  })

  it('guesses for the sheet and clears `· auto` once seen', () => {
    const s = open()
    const site = s.saveCategory({ name: 'Site', folders: ['/Users/x/site'] })
    expect(s.guess('/Users/x/site/web/src')).toEqual({ categoryId: site.id, folderKey: '/Users/x/site' })
    expect(s.guess('/Users/x/other')).toEqual({ categoryId: null, folderKey: '/Users/x/other' })
    s.assignNew([{ sessionId: D, cwd: '/Users/x/site' }])
    s.markSeen(D)
    expect(s.get().sessions[D]).toMatchObject({ placedBy: 'auto', autoSeen: true })
    s.place(E, site.id)
    s.markSeen(E)
    expect(s.get().sessions[E]?.autoSeen).toBeUndefined()
  })

  it('undoes the last delete, leaving sessions placed since where they are', () => {
    const s = open()
    s.importFrom(reg, [])
    s.place(C, 'c3')
    s.deleteCategory('c3')
    s.place(C, 'c21')
    expect(s.undoDelete('c12')).toBe(false)
    expect(s.undoDelete('c3')).toBe(true)
    expect(s.get().categories.map(c => c.id)).toEqual(['c12', 'c3', 'c21'])
    expect(s.get().sessions[A]).toMatchObject({ categoryId: 'c3', placedBy: 'import' })
    expect(s.get().sessions[C]).toMatchObject({ categoryId: 'c21', placedBy: 'hand' })
    expect(s.undoDelete('c3')).toBe(false)
  })

  it('never gives a new category the Uncategorized gray', () => {
    const s = open()
    const colors = Array.from({ length: 12 }, (_, i) => s.saveCategory({ name: `k${i}` }).color)
    expect(colors).not.toContain('#857c6c')
  })

  describe('observe: the lifecycle step (MIP2-1410)', () => {
    const DAY = 86_400_000
    const T = 1_793_000_000_000
    const f = <V,>(value: V) => ({ value, source: 'agents-json' as const, observedAt: T, stale: false })
    const snap = (id: string, over: { pid?: number | null; startedAt?: number; contractors?: { shortId: string; name: string | null; startedAt: number }[] } = {}) =>
      ({
        contractVersion: 1,
        sessionId: id,
        kind: f('background'),
        cwd: f('/Users/x/site'),
        startedAt: f(over.startedAt ?? T),
        name: f(null),
        shortId: f(id.slice(0, 8)),
        pid: f(over.pid === undefined ? 1 : over.pid),
        activity: f('idle'),
        needsYou: f(null),
        ...(over.contractors ? { contractors: { ...f(over.contractors), source: 'mod' as const } } : {}),
      }) as never

    it('counts the first sighting as activity, so old sessions never roll off on first run', () => {
      const s = open()
      s.observe([snap(D, { startedAt: T - 60 * DAY })], true, T)
      expect(s.get().sessions[D]?.rolledOffAt).toBeUndefined()
      expect(s.get().sessions[D]?.activityAt).toBe(T)
    })

    it("rolls off Alex's session after the dead period, notes it, and stops it only if launched here", () => {
      const s = open()
      s.touch(D, T, 'app')
      s.touch(E, T)
      s.importFrom(reg, [])
      s.observe([snap(D), snap(E)], true, T)
      const out = s.observe([snap(D), snap(E)], true, T + 8 * DAY)
      expect(out.stop).toEqual([D])
      expect(s.get().sessions[D]?.rolledOffAt).toBe(T + 8 * DAY)
      // E has no known origin and runs in the background: a contractor, rolled off a day in, with no notice.
      expect(s.get().sessions[E]?.rolledOffAt).toBe(T + 8 * DAY)
      expect(s.get().settings.rollOffNotice).toEqual([D])
    })

    it('links a child to its parent, rolls it off with the parent, and never notes contractors', () => {
      const s = open()
      s.touch(D, T, 'app')
      s.observe([snap(D, { contractors: [{ shortId: E.slice(0, 8), name: 'probe', startedAt: T }] }), snap(E)], true, T + 1000)
      expect(s.get().sessions[E]?.parentId).toBe(D)
      s.archive(D, T + 2000)
      s.observe([snap(D), snap(E)], true, T + 3000)
      expect(s.get().sessions[E]?.rolledOffAt).toBe(T + 3000)
      expect(s.get().settings.rollOffNotice ?? []).toEqual([])
    })

    it('marks sessions that left --all as removed, only on a good poll, and toasts only for Alex\'s', () => {
      const s = open()
      s.touch(D, T, 'app')
      s.observe([snap(D), snap(E)], true, T)
      expect(s.observe([], false, T + 1).removed).toEqual([])
      expect(s.get().sessions[D]?.removedAt).toBeUndefined()
      expect(s.observe([], true, T + 2).removed).toEqual([D])
      expect(s.get().sessions[E]?.removedAt).toBe(T + 2)
    })

    it('resurrects with the clock reset, and never-roll-off holds until cleared', () => {
      const s = open()
      s.touch(D, T, 'app')
      s.setNeverRollOff(D, true, T)
      s.observe([snap(D)], true, T + 30 * DAY)
      expect(s.get().sessions[D]?.rolledOffAt).toBeUndefined()
      s.setNeverRollOff(D, false, T + 30 * DAY)
      s.observe([snap(D)], true, T + 30 * DAY + 2 * DAY)
      expect(s.get().sessions[D]?.rolledOffAt).toBeUndefined()
      s.observe([snap(D)], true, T + 30 * DAY + 8 * DAY)
      expect(s.get().sessions[D]?.rolledOffAt).toBe(T + 38 * DAY)
      expect(s.resurrect([D], T + 40 * DAY)).toBe(1)
      expect(s.get().sessions[D]).toMatchObject({ activityAt: T + 40 * DAY })
      expect(s.get().settings.rollOffNotice).toEqual([])
    })

    it('keeps a contractor Alex calls his as a session', () => {
      const s = open()
      s.setKind(E, 'session', null, T)
      s.observe([snap(E)], true, T + 2 * DAY)
      expect(s.get().sessions[E]?.rolledOffAt).toBeUndefined()
    })
  })

  it('imports only the parts chosen in first run step 2', () => {
    const s = open()
    s.importFrom(reg, [], { categories: false, sessions: true, defaults: true, prefs: false })
    expect(s.get().categories).toEqual([])
    // Named, but its 0.24 category wasn't brought over.
    expect(s.get().sessions[A]).toMatchObject({ name: 'production-log', categoryId: null, origin: 'import' })
    expect(s.get().settings).toMatchObject({ lastModel: 'opus', recentFolders: [] })
    expect(s.get().settings.terminalFont).toBeUndefined()
  })

  it("records a launch's settings, and gives a copy or a session started from another its source's category (MIP2-1407)", () => {
    const s = open()
    const site = s.saveCategory({ name: 'Site' })
    s.place(D, site.id)
    s.recordLaunch(E, { model: 'opus', effort: 'high', mode: 'auto', ultracode: true }, { copyOf: D }, 5)
    expect(s.get().sessions[E]).toMatchObject({ launch: { model: 'opus', ultracode: true }, copyOf: D, origin: 'app', activityAt: 5, categoryId: site.id, placedBy: 'hand' })
    s.recordLaunch(F, { model: 'haiku' }, { fromSession: D })
    expect(s.get().sessions[F]).toMatchObject({ fromSession: D, categoryId: site.id })
  })

  it('offers a tie instead of guessing, clears it on placement, and keys learned folders by repository (MIP2-1407)', () => {
    const s = open()
    // Two categories list the same folder: a new session there is a tie.
    const one = s.saveCategory({ name: 'One', folders: ['/Users/x/acme'] })
    const two = s.saveCategory({ name: 'Two', folders: ['/Users/x/acme'] })
    s.assignNew([{ sessionId: D, cwd: '/Users/x/acme/src' }])
    expect(s.get().sessions[D]).toMatchObject({ categoryId: null, folderKey: '/Users/x/acme' })
    expect(one.id).not.toBe(two.id)
    // Both pass the app's own id check, so every category call takes them (MIP2-1433).
    expect([one.id, two.id].every(id => /^[a-z][a-z0-9]{0,15}$/.test(id))).toBe(true)
    expect(s.get().sessions[D]?.tie?.sort()).toEqual([one.id, two.id].sort())
    s.place(D, one.id)
    expect(s.get().sessions[D]?.tie).toBeUndefined()
  })

  it('keeps a name from Rename…, tidied and clipped, and clears it when empty (MIP2-1407)', () => {
    const s = open()
    s.setName(D, '  site   build  ')
    expect(s.get().sessions[D]?.name).toBe('site build')
    s.setName(D, 'x'.repeat(200))
    expect(s.get().sessions[D]?.name).toHaveLength(80)
    s.setName(D, '   ')
    expect(s.get().sessions[D]?.name).toBeUndefined()
  })

  it('auto-assigns a session launched here on Auto, or offers the tie, though the launch recorded it first (MIP2-1432)', () => {
    const s = open()
    const site = s.saveCategory({ name: 'Site', folders: ['/Users/x/site'] })
    s.recordLaunch(D, { model: 'opus' })
    s.assignLaunched(D, '/Users/x/site/src')
    expect(s.get().sessions[D]).toMatchObject({ categoryId: site.id, placedBy: 'auto', origin: 'app' })
    // Two equal matches: the offer, not a guess.
    s.saveCategory({ name: 'Also', folders: ['/Users/x/site'] })
    s.recordLaunch(E, {})
    s.assignLaunched(E, '/Users/x/site')
    expect(s.get().sessions[E]).toMatchObject({ categoryId: null, tie: expect.arrayContaining([site.id]) })
    // A copy keeps its source's category, and a choice by hand stands.
    s.place(D, site.id)
    s.recordLaunch(F, {}, { copyOf: D })
    s.assignLaunched(F, '/Users/x/elsewhere')
    expect(s.get().sessions[F]).toMatchObject({ categoryId: site.id, placedBy: 'hand' })
  })

  it('tells subscribers about each change', () => {
    const s = open()
    let n = 0
    const off = s.subscribe(() => (n += 1))
    s.saveCategory({ name: 'One' })
    off()
    s.saveCategory({ name: 'Two' })
    expect(n).toBe(1)
  })
})

describe('setParkedHidden (MIP2-1465)', () => {
  it('hides and shows imported sessions only, all at once with "all", and keeps it across a reload', () => {
    const s = open()
    s.importFrom(reg, [])
    const imported = Object.entries(s.get().sessions).filter(([, m]) => m.origin === 'import').map(([id]) => id)
    expect(imported.length).toBeGreaterThan(0)
    s.recordLaunch(D, {})
    expect(s.setParkedHidden([imported[0]!, D], true)).toBe(1)
    expect(s.get().sessions[imported[0]!]?.parkedHidden).toBe(true)
    expect(s.get().sessions[D]?.parkedHidden).toBeUndefined()
    expect(open().get().sessions[imported[0]!]?.parkedHidden).toBe(true)
    expect(s.setParkedHidden('all', false)).toBe(1)
    expect(s.get().sessions[imported[0]!]?.parkedHidden).toBeUndefined()
  })
})
