// Moving CC Command Center 0.24's sessions in (MIP2-1425).

import { field, type SessionSnapshot } from '@ccc/contract'
import { describe, expect, it } from 'vitest'
import { movePreflight, moveRequest, terminalMessage } from '../src/main/move.ts'
import { cardView } from '../src/renderer/model/card-state.ts'
import { UNCAT_REF, type Entry } from '../src/renderer/model/fleet.ts'
import { inElectron, movable, nextToResume, parkedSessions, readiness, stopWaiting, type MovePhase } from '../src/renderer/model/move.ts'
import { emptyStore } from '../src/shared/store.ts'

const NOW = 1_800_000_000_000

function snap(over: Partial<SessionSnapshot> & { activityValue?: SessionSnapshot['activity']['value'] } = {}): SessionSnapshot {
  const f = <T>(v: T) => field(v, 'agents-json', NOW)
  const { activityValue = 'idle', ...rest } = over
  return {
    contractVersion: 1,
    sessionId: 's1',
    kind: f('interactive'),
    cwd: f('/Users/example/app'),
    startedAt: f(NOW - 60_000),
    name: f('app-1'),
    shortId: f('abc'),
    pid: f(42),
    activity: f(activityValue),
    needsYou: f(null),
    ...rest,
  }
}

function entry(id: string, over: Parameters<typeof snap>[0] = {}): Entry {
  const session = snap({ sessionId: id, ...over })
  return { session, view: cardView(session, NOW), since: null, cat: UNCAT_REF, name: id, contractor: null, life: { stage: 'live', deadAt: null }, neverRollOff: false, children: [], parentName: null }
}

describe('which sessions move, and when', () => {
  it('counts a session as 0.24\'s only when imported, interactive and not moved yet', () => {
    const e = entry('a')
    expect(inElectron(e, { categoryId: null, placedBy: null, origin: 'import' })).toBe(true)
    expect(inElectron(e, { categoryId: null, placedBy: null, origin: 'import', movedAt: 1 })).toBe(false)
    expect(inElectron(e, { categoryId: null, placedBy: null, origin: 'app' })).toBe(false)
    expect(inElectron(entry('b', { kind: field('background', 'agents-json', NOW) }), { categoryId: null, placedBy: null, origin: 'import' })).toBe(false)
  })

  it('offers only idle sessions; working waits, needing Alex is answered first, an exited one is closed', () => {
    expect(readiness(entry('a'))).toBe('ready')
    expect(readiness(entry('w', { activityValue: 'working' }))).toBe('wait')
    expect(readiness(entry('n', { activityValue: 'waiting', needsYou: field({ kind: 'permission', detail: null }, 'agents-json', NOW) }))).toBe('answer')
    expect(readiness(entry('c', { pid: field(null, 'agents-json', NOW) }))).toBe('closed')
    expect(readiness(undefined)).toBe('closed')
  })

  it('resumes one at a time, in order, only once its 0.24 process has exited', () => {
    const open = new Map([['a', entry('a')]])
    const of = (id: string) => open.get(id)
    const phases: Record<string, MovePhase> = { a: { kind: 'waiting' }, b: { kind: 'waiting' } }
    // a is still open in 0.24; b is closed (no longer listed).
    expect(nextToResume(['a', 'b'], phases, of)).toBe('b')
    expect(nextToResume(['a', 'b'], { ...phases, b: { kind: 'resuming' } }, of)).toBeNull()
    open.clear()
    expect(nextToResume(['a', 'b'], phases, of)).toBe('a')
    expect(stopWaiting({ a: { kind: 'waiting' }, b: { kind: 'moved' } })).toEqual({ a: { kind: 'idle' }, b: { kind: 'moved' } })
  })
})

describe('moveRequest', () => {
  it("resumes with 0.24's saved model, 1M context, effort and mode, in the session's folder", () => {
    const meta = { categoryId: 'c3', placedBy: 'import' as const, origin: 'import' as const, name: 'site', cwd: '/old', resumeFlags: { model: 'opus', context: '1m', effort: 'ultracode', mode: 'auto' } }
    expect(moveRequest(meta, '/Users/x/site')).toEqual({ cwd: '/Users/x/site', name: 'site', model: 'opus[1m]', effort: 'xhigh', permissionMode: 'auto' })
    expect(moveRequest(meta, undefined)?.cwd).toBe('/old')
  })

  it("drops a saved value the app doesn't accept, and needs a folder", () => {
    const meta = { categoryId: null, placedBy: null, name: 'x', cwd: '/w', resumeFlags: { mode: 'yolo' } }
    expect(moveRequest(meta, undefined)).toEqual({ cwd: '/w', name: 'x' })
    expect(moveRequest(undefined, undefined)).toBeNull()
  })
})

describe('copyRefusal (MIP2-1434)', () => {
  it("refuses to copy a session that hasn't had a message, live or stopped, and allows one that has", async () => {
    const { copyRefusal } = await import('../src/main/move.ts')
    const fresh = snap({ name: field('C1', 'agents-json', NOW), awaitingFirstPrompt: field(true, 'mod', NOW) })
    expect(copyRefusal(fresh)).toBe("C1 hasn't had a message yet, and Claude Code can't copy a session before its first turn. Send it a message, then try again.")
    expect(copyRefusal({ ...fresh, awaitingFirstPrompt: { ...field(true, 'mod', NOW), stale: true } })).not.toBeNull()
    expect(copyRefusal(snap({ awaitingFirstPrompt: field(false, 'mod', NOW) }))).toBeNull()
    // Not listed yet, or launched here with no report yet: wait (QA's follow-up).
    expect(copyRefusal(undefined)).toBe('Wait a moment for the session to report, then try again.')
    expect(copyRefusal(snap(), true)).toBe('Wait a moment for the session to report, then try again.')
    // Without the mod: copied once the agent list shows it idle or working, refused otherwise.
    expect(copyRefusal(snap({ activityValue: 'idle' }))).toBeNull()
    expect(copyRefusal(snap({ name: field('X', 'agents-json', NOW), activityValue: 'waiting' }))).toBe("X can't be copied until it has had a message.")
  })
})

describe('parkedSessions (MIP2-1461)', () => {
  it("lists imported sessions Claude Code doesn't list, not moved, archived or removed, with a folder, most recent first", () => {
    const store = emptyStore()
    store.categories = [{ id: 'work', name: 'Work', color: '#112233', label: '', emoji: '', sort: 0, folders: [], notFolders: [], isolation: 'none', arbiterReadsText: false, collapsed: false }]
    const id = (n: number) => `0000000${n}-0000-4000-8000-000000000000`
    store.sessions = {
      [id(1)]: { categoryId: 'work', placedBy: 'import', origin: 'import', cwd: '/w/a', name: 'alpha', activityAt: 5 },
      [id(2)]: { categoryId: null, placedBy: null, origin: 'import', cwd: '/w/b', activityAt: 9 },
      [id(3)]: { categoryId: null, placedBy: null, origin: 'import', cwd: '/w/c', movedAt: 1 },
      [id(4)]: { categoryId: null, placedBy: null, origin: 'import', cwd: '/w/d', archivedAt: 1 },
      [id(5)]: { categoryId: null, placedBy: null, origin: 'import' },
      [id(6)]: { categoryId: null, placedBy: null, origin: 'app', cwd: '/w/f' },
      [id(7)]: { categoryId: null, placedBy: null, origin: 'import', cwd: '/w/g', removedAt: 1 },
      [id(8)]: { categoryId: null, placedBy: null, origin: 'import', cwd: '/w/h' },
    }
    const parked = parkedSessions(store, new Set([id(8)]))
    expect(parked.map(p => [p.id, p.name, p.cat.name, p.cwd])).toEqual([
      [id(2), 'b', 'Uncategorized', '/w/b'],
      [id(1), 'alpha', 'Work', '/w/a'],
    ])
  })
})

describe('movePreflight (pass 8, M-2)', () => {
  const meta = { categoryId: null, placedBy: null, origin: 'import' as const, cwd: '/w' }
  const listed = (pid: number | null, stale = false) => ({ pid: { ...field(pid, 'agents-json', 1), stale } }) as unknown as SessionSnapshot
  it('allows an import not yet moved, archived or removed, with no process and no untrusted mark', () => {
    expect(movePreflight(meta, undefined, null)).toBeNull()
    expect(movePreflight(meta, listed(null), null)).toBeNull()
    expect(movePreflight(meta, listed(42, true), null)).toBeNull()
  })
  it('refuses each other case, for the move sheet and the trust resume alike', () => {
    // A session started outside the app, a 0.24 import or a terminal's, may move; one started here may not (MIP2-1466).
    expect(movePreflight(undefined, undefined, null)).toBeNull()
    expect(movePreflight({ ...meta, origin: undefined }, undefined, null)).toBeNull()
    expect(movePreflight({ ...meta, origin: 'app' }, undefined, null)).toMatch(/started in this app/)
    expect(movePreflight({ ...meta, movedAt: 1 }, undefined, null)).toMatch(/already moved/)
    expect(movePreflight({ ...meta, archivedAt: 1 }, undefined, null)).toMatch(/archived/)
    // removedAt is the store's mark for leaving the list, which an interactive session does when it exits: allowed (MIP2-1466).
    expect(movePreflight({ ...meta, removedAt: 1 }, undefined, null)).toBeNull()
    expect(movePreflight(meta, listed(42), null)).toMatch(/still running/)
    expect(movePreflight(meta, undefined, 'the socket file was moved or replaced')).toMatch(/can't be trusted/)
  })
  it('is asked by both the move and the trust step resume in main', async () => {
    const { readFileSync } = await import('node:fs')
    const control = readFileSync(new URL('../src/main/control.ts', import.meta.url), 'utf8')
    expect(control.match(/preflight\((id|r0\.resume)\)/g)).toEqual(['preflight(id)', 'preflight(r0.resume)'])
  })
})

describe('hidden parked sessions (MIP2-1465)', () => {
  it('leaves hidden ones out of the sidebar list, and keeps them for the move sheet', () => {
    const store = emptyStore()
    const id = (n: number) => `0000000${n}-0000-4000-8000-000000000000`
    store.sessions = {
      [id(1)]: { categoryId: null, placedBy: null, origin: 'import', cwd: '/w/a', parkedHidden: true },
      [id(2)]: { categoryId: null, placedBy: null, origin: 'import', cwd: '/w/b' },
    }
    expect(parkedSessions(store, new Set()).map(p => p.id)).toEqual([id(2)])
    const all = parkedSessions(store, new Set(), true)
    expect(all.map(p => [p.id, p.hidden])).toEqual(expect.arrayContaining([[id(1), true], [id(2), false]]))
  })
})

describe('sessions running in a terminal (MIP2-1466)', () => {
  it('says where it runs and since when, and what to do', () => {
    const at = new Date(2026, 9, 21, 12).getTime()
    expect(terminalMessage('iTerm2', at)).toBe('Running in a terminal (iTerm2, since Oct 21). Close it there, then the app can resume it.')
    expect(terminalMessage(null, at)).toBe('Running in a terminal (since Oct 21). Close it there, then the app can resume it.')
  })

  it('offers the move for any interactive session started outside the app, not one started here', async () => {
    const { field } = await import('@ccc/contract')
    const e = (kind: 'interactive' | 'background') => ({ session: { kind: field(kind, 'agents-json', 1) } }) as unknown as Entry
    expect(movable(e('interactive'), undefined)).toBe(true)
    expect(movable(e('interactive'), { categoryId: null, placedBy: null, origin: 'import' })).toBe(true)
    expect(movable(e('interactive'), { categoryId: null, placedBy: null, origin: 'app' })).toBe(false)
    expect(movable(e('interactive'), { categoryId: null, placedBy: null, movedAt: 1 })).toBe(false)
    expect(movable(e('background'), undefined)).toBe(false)
  })
})
