// A /clear keeps the job and process and changes the sessionId (MIP2-1557, Research MIP2-1556).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { AppStoreService } from '../src/main/app-store.ts'
import { CLEAR_CONFIRM_MS, ClearConfirm, ClearWatch } from '../src/shared/clear.ts'
import { RestartWatch } from '../src/main/restart-watch.ts'
import { LiftedRefusals } from '../src/main/resume.ts'

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

describe('ClearConfirm (MIP2-2072)', () => {
  const A = 'c0ffee01-0000-4000-8000-000000000001'
  const B = 'c0ffee02-0000-4000-8000-000000000002'
  const m = { from: A, to: B }
  const inPlace = () => true

  it('moves a /clear whose mod says so a poll or two later, as on 2026-11-20', () => {
    const c = new ClearConfirm()
    let said = false
    expect(c.step([m], 0, () => said, inPlace)).toEqual({ move: [], gaveUp: [], fresh: [m] })
    // The next poll: ClearWatch reports nothing new, the move still waits.
    expect(c.step([], 2_000, () => said, inPlace)).toEqual({ move: [], gaveUp: [], fresh: [] })
    said = true
    expect(c.step([], 4_000, () => said, inPlace)).toEqual({ move: [{ ...m, via: [] }], gaveUp: [], fresh: [] })
    expect(c.step([], 6_000, () => said, inPlace).move).toEqual([])
  })

  it('moves at once when the mod said so, or the session has no mod', () => {
    expect(new ClearConfirm().step([m], 0, () => true, inPlace)).toEqual({ move: [{ ...m, via: [] }], gaveUp: [], fresh: [] })
  })

  it('gives a move up after CLEAR_CONFIRM_MS, or once it is no longer in place', () => {
    const c = new ClearConfirm()
    c.step([m], 0, () => false, inPlace)
    expect(c.step([], CLEAR_CONFIRM_MS + 1, () => false, inPlace).gaveUp).toEqual([m])
    const d = new ClearConfirm()
    d.step([m], 0, () => false, inPlace)
    // The old id is listed again, or the new one left: it wasn't a /clear.
    expect(d.step([], 2_000, () => true, () => false)).toEqual({ move: [], gaveUp: [m], fresh: [] })
  })

  it('makes a second /clear while the first waits one move, judged by the first id\'s mod (gate pass 63, M-1)', () => {
    const C = 'c0ffee03-0000-4000-8000-000000000003'
    const c = new ClearConfirm()
    let said = false
    // The mod is A's: B never had a channel, so it can't count as "no mod".
    const confirmed = (from: string) => from === A && said
    c.step([m], 0, confirmed, inPlace)
    expect(c.holding()).toEqual(new Set([A]))
    const r = c.step([{ from: B, to: C }], 30_000, confirmed, (from, to) => from === A && to === C)
    expect(r).toEqual({ move: [], gaveUp: [], fresh: [] })
    said = true
    expect(c.step([], 32_000, confirmed, (from, to) => from === A && to === C).move).toEqual([{ from: A, to: C, via: [B] }])
    // Timed from A's wait.
    const t = new ClearConfirm()
    t.step([m], 0, () => false, inPlace)
    t.step([{ from: B, to: C }], 60_000, () => false, inPlace)
    expect(t.step([], CLEAR_CONFIRM_MS + 1, () => false, inPlace).gaveUp).toEqual([{ from: A, to: C }])
  })
})

describe('AppStoreService.renameSession', () => {
  let dir: string
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'ccc-clear-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('drops a removal the old id took while the move waited, keeps the ids it had, and finds the session by any of them (gate pass 63, L-1, L-2)', () => {
    const store = new AppStoreService(join(dir, 'store.json'), '/Users/x', () => false)
    store.recordLaunch(OLD, { cwd: '/w' }, {}, 1)
    const C = 'c0ffee0c-0000-4000-8000-00000000000c'
    store.renameSession(OLD, NEW)
    store.renameSession(NEW, C)
    const m = store.get().sessions[C]
    expect(m?.formerIds).toEqual([OLD, NEW])
    expect(m?.removedAt).toBeUndefined()
    expect([store.currentIdOf(OLD), store.currentIdOf(NEW), store.currentIdOf(C), store.currentIdOf(OTHER)]).toEqual([C, C, C, undefined])
    expect(new AppStoreService(join(dir, 'store.json'), '/Users/x', () => false).get().sessions[C]?.formerIds).toEqual([OLD, NEW])
  })

  it('keeps when the last move was made, and the id the mod reports under, across app starts (gate pass 66, M1, L2)', () => {
    const store = new AppStoreService(join(dir, 'store.json'), '/Users/x', () => false)
    store.recordLaunch(OLD, { cwd: '/w' }, {}, 1)
    store.renameSession(OLD, NEW, [], 5_000)
    store.setReportingId(NEW, OLD)
    store.setReportingId(NEW, NEW)
    const again = new AppStoreService(join(dir, 'store.json'), '/Users/x', () => false).get().sessions[NEW]
    expect([again?.clearedAt, again?.reportingId]).toEqual([5_000, OLD])
  })

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
    expect(store.get().sessions[OLD]?.refuseNextProcess).toBe(true)
    expect(store.get().sessions[OTHER]?.refuseNextProcess).toBeUndefined()
    // A mark made since is never flagged.
    const LATER = 'd00dfeed-0000-4000-8000-000000000004'
    store.recordLaunch(LATER, { cwd: '/w' }, {}, 20)
    store.markUntrusted(LATER, 'the socket file was replaced')
    expect(store.flagLegacyMarks(30)).toBe(0)
    expect(store.get().sessions[LATER]?.refuseNextProcess).toBeUndefined()
    expect(new AppStoreService(join(dir, 'store.json'), '/Users/x', () => false).get()).toMatchObject({ refusedStartsSince: 10, sessions: { [OLD]: { refuseNextProcess: true } } })
    store.clearUntrusted(OLD)
    expect(store.get().sessions[OLD]?.refuseNextProcess).toBeUndefined()
  })

  it('lets a resume from the app start the process a refusal at recovery would refuse, lifted in memory only (gate pass 32, M-1; pass 35, M-1)', () => {
    const store = new AppStoreService(join(dir, 'store.json'), '/Users/x', () => false)
    store.recordLaunch(OLD, { cwd: '/w' }, {}, 1)
    store.markUntrusted(OLD, 'the socket file was replaced')
    // Recovery marks the channel before any process is seen, so the refusal falls on the next first sighting.
    store.refuseNextSighting(OLD)
    const lifted = new LiftedRefusals()
    const watch = (s: AppStoreService) => new RestartWatch(() => 0, () => undefined, undefined, id => !lifted.has(id) && s.get().sessions[id]?.refuseNextProcess === true)
    const before = watch(store)
    before.observe([{ sessionId: OLD, pid: 300, startedAt: 300 }])
    expect(before.stillRefused).toEqual([OLD])
    // The resume re-keys, then lifts it before the restart; the poll may land before the mark itself is cleared.
    const rearm = lifted.lift(OLD)
    const after = watch(store)
    after.observe([{ sessionId: OLD, pid: 300, startedAt: 300 }])
    expect(after.stillRefused).toEqual([])
    expect(after.unverified).toEqual([OLD])
    // The app exits mid-resume: the saved flag still refuses the next process first seen.
    const reopened = new AppStoreService(join(dir, 'store.json'), '/Users/x', () => false)
    const fresh = new RestartWatch(() => 0, () => undefined, undefined, id => reopened.get().sessions[id]?.refuseNextProcess === true)
    fresh.observe([{ sessionId: OLD, pid: 300, startedAt: 300 }])
    expect(fresh.stillRefused).toEqual([OLD])
    // A failed resume puts the lift back in this run too.
    rearm()
    const again = watch(store)
    again.observe([{ sessionId: OLD, pid: 300, startedAt: 300 }])
    expect(again.stillRefused).toEqual([OLD])
  })

  it('also saves the flag as legacyMark, for a downgrade to 1.0.2-beta.5, and clears both together (gate pass 36, L-3)', () => {
    const store = new AppStoreService(join(dir, 'store.json'), '/Users/x', () => false)
    store.recordLaunch(OLD, { cwd: '/w' }, {}, 1)
    store.markUntrusted(OLD, 'the socket file was replaced')
    store.refuseNextSighting(OLD)
    const saved = () => JSON.parse(readFileSync(join(dir, 'store.json'), 'utf8')).sessions[OLD]
    expect(saved()).toMatchObject({ refuseNextProcess: true, legacyMark: true })
    expect(store.get().sessions[OLD]).not.toHaveProperty('legacyMark')
    store.clearUntrusted(OLD)
    expect(saved()).not.toHaveProperty('refuseNextProcess')
    expect(saved()).not.toHaveProperty('legacyMark')
  })

  it('reads the flag 1.0.2-beta.5 saved as legacyMark (gate pass 35, L-3)', () => {
    writeFileSync(join(dir, 'store.json'), JSON.stringify({ version: 1, sessions: { [OLD]: { categoryId: null, placedBy: null, untrusted: 'x', legacyMark: true } } }))
    const store = new AppStoreService(join(dir, 'store.json'), '/Users/x', () => false)
    expect(store.get().sessions[OLD]?.refuseNextProcess).toBe(true)
  })

  it('refuses the next first sighting, dropping a verified start, when flagging marks or booking a refusal it could not place (gate pass 31, M-1, M-2)', () => {
    const store = new AppStoreService(join(dir, 'store.json'), '/Users/x', () => false)
    store.recordLaunch(OLD, { cwd: '/w' }, {}, 1)
    store.recordLaunch(OTHER, { cwd: '/w' }, {}, 1)
    store.recordVerifiedStarts([[OLD, 200], [OTHER, 300]])
    store.markUntrusted(OLD, 'the socket file was replaced')
    expect(store.flagLegacyMarks(10)).toBe(1)
    expect(store.get().sessions[OLD]).toMatchObject({ refuseNextProcess: true })
    expect(store.get().sessions[OLD]?.verifiedStartedAt).toBeUndefined()
    store.refuseNextSighting(OTHER)
    expect(store.get().sessions[OTHER]).toMatchObject({ refuseNextProcess: true })
    expect(store.get().sessions[OTHER]?.verifiedStartedAt).toBeUndefined()
  })

  it('says which refused start it dropped to keep the latest 16 (gate pass 30, L-4)', () => {
    const store = new AppStoreService(join(dir, 'store.json'), '/Users/x', () => false)
    store.recordLaunch(OLD, { cwd: '/w' }, {}, 1)
    for (let i = 1; i <= 16; i++) expect(store.recordRefusedStart(OLD, i)).toBeUndefined()
    expect(store.get().sessions[OLD]?.refuseNextProcess).toBeUndefined()
    expect(store.recordRefusedStart(OLD, 17)).toBe(1)
    expect(store.get().sessions[OLD]?.refusedStarts).toHaveLength(16)
    // Its process, if it still runs, is refused at its next first sighting (gate pass 31, L-3).
    expect(store.get().sessions[OLD]?.refuseNextProcess).toBe(true)
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
