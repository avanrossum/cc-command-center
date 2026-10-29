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
})

describe('AppStoreService.renameSession', () => {
  let dir: string
  beforeEach(() => (dir = mkdtempSync(join(tmpdir(), 'ccc-clear-'))))
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

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
