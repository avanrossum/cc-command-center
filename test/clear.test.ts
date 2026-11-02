// A /clear keeps the job and process and changes the sessionId (MIP2-1557, Research MIP2-1556).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppStoreService } from '../src/main/app-store.ts'
import { ClearWatch } from '../src/shared/clear.ts'

const OLD = 'c0ffee01-0000-4000-8000-000000000001'
const NEW = 'b55a99a6-0000-4000-8000-000000000002'
const OTHER = 'c0ffee03-0000-4000-8000-000000000003'

describe('ClearWatch', () => {
  it('reports a new sessionId on the same job and pid once the old one has left the list', () => {
    const w = new ClearWatch()
    expect(w.observe([{ sessionId: OLD, shortId: 'c0ffee01', pid: 10 }])).toEqual([])
    expect(w.observe([{ sessionId: NEW, shortId: 'c0ffee01', pid: 10 }])).toEqual([{ from: OLD, to: NEW }])
    expect(w.observe([{ sessionId: NEW, shortId: 'c0ffee01', pid: 10 }])).toEqual([])
  })

  it('ignores a new process (a restart), a new job, and an old id still listed (a copy)', () => {
    const w = new ClearWatch()
    w.observe([{ sessionId: OLD, shortId: 'c0ffee01', pid: 10 }])
    expect(w.observe([{ sessionId: NEW, shortId: 'c0ffee01', pid: 11 }])).toEqual([])
    const copy = new ClearWatch()
    copy.observe([{ sessionId: OLD, shortId: 'c0ffee01', pid: 10 }])
    expect(copy.observe([{ sessionId: OLD, shortId: 'aaaaaaaa', pid: 10 }, { sessionId: NEW, shortId: 'c0ffee01', pid: 10 }])).toEqual([])
    expect(new ClearWatch().observe([{ sessionId: OTHER, shortId: 'c0ffee03', pid: 3 }])).toEqual([])
  })

  it('ignores a restart listed under another id for one poll, then under its own again (MIP2-1570)', () => {
    const w = new ClearWatch()
    w.observe([{ sessionId: OLD, shortId: 'c0ffee01', pid: 10 }])
    expect(w.observe([{ sessionId: NEW, shortId: 'c0ffee01', pid: 11 }])).toEqual([])
    expect(w.observe([{ sessionId: OLD, shortId: 'c0ffee01', pid: 11 }])).toEqual([])
    // A /clear after it is still seen.
    expect(w.observe([{ sessionId: OTHER, shortId: 'c0ffee01', pid: 11 }])).toEqual([{ from: OLD, to: OTHER }])
  })
})

describe('AppStoreService.renameSession', () => {
  let dir: string
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'ccc-clear-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps the start of each process that passed the restart check (gate pass 20, M-1)', () => {
    const store = new AppStoreService(join(dir, 'store.json'), '/Users/x', () => false)
    store.recordLaunch(OLD, { cwd: '/w' }, {}, 1)
    store.recordVerifiedStarts([[OLD, 900], [OTHER, 5]])
    expect(store.get().sessions[OLD]?.verifiedStartedAt).toBe(900)
    expect(store.get().sessions[OTHER]).toBeUndefined()
    expect(new AppStoreService(join(dir, 'store.json'), '/Users/x', () => false).get().sessions[OLD]?.verifiedStartedAt).toBe(900)
  })

  it('keeps a refused start until a resume from the app clears the mark, and verifies no start of a marked session (gate pass 28, M-1)', () => {
    const store = new AppStoreService(join(dir, 'store.json'), '/Users/x', () => false)
    store.recordLaunch(OLD, { cwd: '/w' }, {}, 1)
    store.markUntrusted(OLD, 'Claude Code restarted it by itself, and its saved options hold flags the app never passed')
    store.recordRefusedStart(OLD, 200)
    store.recordVerifiedStarts([[OLD, 200]])
    expect(store.get().sessions[OLD]?.verifiedStartedAt).toBeUndefined()
    store.recordRefusedStart(OLD, 300)
    expect(new AppStoreService(join(dir, 'store.json'), '/Users/x', () => false).get().sessions[OLD]?.refusedStarts).toEqual([200, 300])
    store.clearUntrusted(OLD)
    expect(store.get().sessions[OLD]?.refusedStarts).toBeUndefined()
    store.recordVerifiedStarts([[OLD, 300]])
    expect(store.get().sessions[OLD]?.verifiedStartedAt).toBe(300)
    store.clearVerifiedStart(OLD)
    expect(store.get().sessions[OLD]?.verifiedStartedAt).toBeUndefined()
  })

  it('flags, once, the marks made before refused starts were kept, and clears the flag with the mark (gate pass 30, M-2)', () => {
    const store = new AppStoreService(join(dir, 'store.json'), '/Users/x', () => false)
    store.recordLaunch(OLD, { cwd: '/w' }, {}, 1)
    store.recordLaunch(OTHER, { cwd: '/w' }, {}, 1)
    store.markUntrusted(OLD, 'the socket file was replaced')
    store.markUntrusted(OTHER, 'its saved options hold flags the app never passed')
    store.recordRefusedStart(OTHER, 200)
    expect(store.flagLegacyMarks(10)).toBe(1)
    expect(store.get().sessions[OLD]?.legacyMark).toBe(true)
    expect(store.get().sessions[OTHER]?.legacyMark).toBeUndefined()
    // A mark made since is never flagged.
    const LATER = 'd00dfeed-0000-4000-8000-000000000004'
    store.recordLaunch(LATER, { cwd: '/w' }, {}, 20)
    store.markUntrusted(LATER, 'the socket file was replaced')
    expect(store.flagLegacyMarks(30)).toBe(0)
    expect(store.get().sessions[LATER]?.legacyMark).toBeUndefined()
    expect(new AppStoreService(join(dir, 'store.json'), '/Users/x', () => false).get()).toMatchObject({ refusedStartsSince: 10, sessions: { [OLD]: { legacyMark: true } } })
    store.clearUntrusted(OLD)
    expect(store.get().sessions[OLD]?.legacyMark).toBeUndefined()
  })

  it('says which refused start it dropped to keep the latest 16 (gate pass 30, L-4)', () => {
    const store = new AppStoreService(join(dir, 'store.json'), '/Users/x', () => false)
    store.recordLaunch(OLD, { cwd: '/w' }, {}, 1)
    for (let i = 1; i <= 16; i++) expect(store.recordRefusedStart(OLD, i)).toBeUndefined()
    expect(store.recordRefusedStart(OLD, 17)).toBe(1)
    expect(store.get().sessions[OLD]?.refusedStarts).toHaveLength(16)
  })

  it('puts confirmed settings back as they were when a confirmation does not go through (D-043 prototype)', () => {
    const store = new AppStoreService(join(dir, 'store.json'), '/Users/x', () => false)
    store.recordLaunch(OLD, { mode: 'default', cwd: '/w' }, {}, 1)
    store.recordConfirmed(OLD, { mode: 'acceptEdits', dirs: [] })
    const before = store.get().sessions[OLD]?.confirmed
    store.recordConfirmed(OLD, { mode: 'auto', dirs: ['/opt/a'] })
    store.restoreConfirmed(OLD, before)
    expect(store.get().sessions[OLD]?.confirmed).toEqual({ mode: 'acceptEdits' })
    store.restoreConfirmed(OLD, undefined)
    expect(store.get().sessions[OLD]?.confirmed).toBeUndefined()
  })

  it('keeps confirmed settings apart from the launch: the mode, and the folders added to those confirmed before (gate pass 21, L-3)', () => {
    const store = new AppStoreService(join(dir, 'store.json'), '/Users/x', () => false)
    store.recordLaunch(OLD, { mode: 'default', cwd: '/w', mod: 'abcdef0123456789' }, {}, 1)
    store.recordConfirmed(OLD, { mode: 'auto', dirs: ['/opt/a'] })
    store.recordConfirmed(OLD, { mode: null, dirs: ['/opt/a', '/opt/b'] })
    expect(store.get().sessions[OLD]?.confirmed).toEqual({ mode: 'auto', addDirs: ['/opt/a', '/opt/b'] })
    expect(store.get().sessions[OLD]?.launch).toEqual({ mode: 'default', cwd: '/w', mod: 'abcdef0123456789' })
    // It survives a restart.
    expect(new AppStoreService(join(dir, 'store.json'), '/Users/x', () => false).get().sessions[OLD]?.confirmed).toEqual({ mode: 'auto', addDirs: ['/opt/a', '/opt/b'] })
  })

  it('moves the record to the new id, keeps the launch id, and follows every list that names it', () => {
    const store = new AppStoreService(join(dir, 'store.json'), '/Users/x', () => false)
    store.recordLaunch(OLD, { model: 'opus', cwd: '/w', mod: 'abcdef0123456789' }, {}, 1)
    store.setName(OLD, 'Design review')
    store.recordLaunch(OTHER, { cwd: '/w' }, { copyOf: OLD }, 2)
    store.markUntrusted(OLD, 'its socket was replaced')
    store.renameSession(OLD, NEW)
    const s = store.get().sessions
    expect(s[OLD]).toBeUndefined()
    expect(s[NEW]).toMatchObject({ name: 'Design review', origin: 'app', launch: { mod: 'abcdef0123456789' }, launchSessionId: OLD, untrusted: 'its socket was replaced' })
    expect(s[OTHER]?.copyOf).toBe(NEW)
    expect(store.launchIds()).toEqual([[NEW, OLD]])
    // A second clear keeps the first launch id.
    const NEWER = 'd00dfeed-0000-4000-8000-000000000004'
    store.renameSession(NEW, NEWER)
    expect(store.get().sessions[NEWER]?.launchSessionId).toBe(OLD)
    // It survives a restart.
    expect(new AppStoreService(join(dir, 'store.json'), '/Users/x', () => false).get().sessions[NEWER]?.launchSessionId).toBe(OLD)
  })
})
