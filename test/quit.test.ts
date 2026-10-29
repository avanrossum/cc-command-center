// The app's own Quit (MIP2-1528, spec MIP2-1462 §2, §3, §6, §7).

import { describe, expect, it } from 'vitest'
import { field, type SessionSnapshot } from '@ccc/contract'
import { appMenuTemplate } from '../src/main/app-menu.ts'
import { QuitControl, type QuitDeps } from '../src/main/quit-control.ts'
import { busyOf, checkQuitAnswer, closable, quitNotices, type QuitRow } from '../src/shared/quit.ts'
import type { SessionMeta } from '../src/shared/store.ts'

const f = <T>(v: T) => field(v, 'agents-json', 1)
const id = (n: number) => `c0ffee0${n}-0000-4000-8000-00000000000${n}`

function snap(n: number, over: { pid?: number | null; kind?: 'background' | 'interactive'; activity?: string; running?: boolean; agents?: boolean; pending?: boolean } = {}): SessionSnapshot {
  return {
    contractVersion: 1,
    sessionId: id(n),
    kind: f(over.kind ?? 'background'),
    cwd: f('/w'),
    startedAt: f(1),
    name: f(null),
    shortId: f(`c0ffee0${n}`),
    pid: f(over.pid === undefined ? 100 + n : over.pid),
    activity: f(over.activity ?? 'idle'),
    needsYou: f(null),
    ...(over.running ? { turn: field({ running: true, startedAt: 1, endedAt: null, lastAnswer: null }, 'mod', 1) } : {}),
    ...(over.agents ? { subagents: field([{ agentId: 'a', type: null, description: null, model: null, status: 'running', parentAgentId: null }], 'mod', 1) } : {}),
    ...(over.pending ? { pendingRequests: field([{ requestId: 'r' }], 'mod', 1) } : {}),
  } as unknown as SessionSnapshot
}
const app = (over: Partial<SessionMeta> = {}): SessionMeta => ({ categoryId: null, placedBy: null, origin: 'app', ...over })

describe('closable (§3)', () => {
  it('only running background sessions launched or moved in here, not archived, removed or a contractor', () => {
    const sessions = [snap(1), snap(2), snap(3, { pid: null }), snap(4, { kind: 'interactive' }), snap(5), snap(6), snap(7), snap(8), snap(9)]
    const meta: Record<string, SessionMeta> = {
      [id(1)]: app(),
      [id(2)]: app({ origin: 'import', movedAt: 5 }),
      [id(3)]: app(),
      [id(4)]: app(),
      [id(5)]: app({ origin: 'import' }),
      [id(6)]: app({ archivedAt: 5 }),
      [id(7)]: app({ removedAt: 5 }),
      [id(8)]: app({ contractor: true }),
      // id(9) has no record: started outside the app.
    }
    expect(closable(sessions, meta).map(r => r.sessionId)).toEqual([id(1), id(2)])
  })

  it('marks working (a turn or a subagent running) and waiting on Alex (§5.1)', () => {
    expect(busyOf(snap(1, { activity: 'working' }))).toBe('working')
    expect(busyOf(snap(1, { running: true }))).toBe('working')
    expect(busyOf(snap(1, { agents: true }))).toBe('working')
    expect(busyOf(snap(1, { activity: 'waiting' }))).toBe('waiting')
    expect(busyOf(snap(1, { pending: true }))).toBe('waiting')
    // Blocked on Alex with nothing pending (UX review).
    expect(busyOf({ ...snap(1), needsYou: f({ kind: 'blocked', detail: 'login expired' }) } as SessionSnapshot)).toBe('waiting')
    expect(busyOf(snap(1))).toBeNull()
  })
})

describe('checkQuitAnswer', () => {
  it('takes the three answers and refuses anything else', () => {
    expect(checkQuitAnswer({ action: 'cancel' })).toEqual({ action: 'cancel' })
    expect(checkQuitAnswer({ action: 'keep', remember: true })).toEqual({ action: 'keep', remember: true })
    expect(checkQuitAnswer({ action: 'close', keep: [id(1)] })).toEqual({ action: 'close', keep: [id(1)], remember: false })
    expect(checkQuitAnswer({ action: 'close' })).toBeNull()
    expect(checkQuitAnswer({ action: 'close', keep: [1] })).toBeNull()
    expect(checkQuitAnswer({ action: 'keep', remember: 'yes' })).toBeNull()
    expect(checkQuitAnswer({ action: 'stop-everything' })).toBeNull()
    expect(checkQuitAnswer(null)).toBeNull()
  })
})

function harness(rows: QuitRow[], over: Partial<QuitDeps> = {}) {
  const log: string[] = []
  const deps: QuitDeps = {
    rows: () => rows,
    setting: () => 'ask',
    ask: r => void log.push(`ask ${r.length}`),
    progress: () => {},
    stop: async sid => void log.push(`stop ${sid.slice(0, 8)}`),
    nameOf: sid => `name-${sid.slice(7, 8)}`,
    remember: c => void log.push(`remember ${c}`),
    report: r => void log.push(`report ${JSON.stringify(r)}`),
    quit: () => void log.push('quit'),
    ...over,
  }
  return { q: new QuitControl(deps), log }
}
const settle = () => new Promise(r => setTimeout(r, 20))
const rows: QuitRow[] = [
  { sessionId: id(1), busy: null },
  { sessionId: id(2), busy: 'working' },
  { sessionId: id(3), busy: null },
]

describe('QuitControl (§2, §6, §7)', () => {
  it('quits at once with nothing closable', () => {
    const none = harness([])
    none.q.request()
    expect(none.log).toEqual(['quit'])
  })

  it('keeps the rows it asked about for a window that opens after the ask, until answered', () => {
    const { q } = harness(rows)
    expect(q.pending()).toBeNull()
    q.request()
    expect(q.pending()).toEqual(rows)
    q.answer({ action: 'cancel' })
    expect(q.pending()).toBeNull()
  })

  it('asks; Esc cancels and nothing stops; asking again shows the modal again', () => {
    const { q, log } = harness(rows)
    q.request()
    q.request()
    expect(q.answer({ action: 'cancel' })).toEqual({ ok: true })
    expect(log).toEqual(['ask 3', 'ask 3'])
    // After a cancel, a quit asks again from the start.
    q.request()
    expect(log).toEqual(['ask 3', 'ask 3', 'ask 3'])
  })

  it('Yes stops what the window leaves unchecked, recomputed from what is closable now', async () => {
    let now = rows
    const { q, log } = harness(rows, { rows: () => now })
    q.request()
    // The window keeps the working one, and names a session that isn't closable (it never is stopped).
    now = rows.slice(0, 2)
    q.answer({ action: 'close', keep: [id(2), id(9)], remember: false })
    await settle()
    expect(log).toEqual(['ask 3', 'stop c0ffee01', `report {"closed":1,"failed":[],"silent":false}`, 'quit'])
  })

  it('No quits and stops nothing; remembering sets the choice', () => {
    const { q, log } = harness(rows)
    q.request()
    q.answer({ action: 'keep', remember: true })
    expect(log).toEqual(['ask 3', 'remember keep', 'quit'])
  })

  it('a remembered close stops the idle ones without asking, keeps the busy one, and reports it for the next launch', async () => {
    const { q, log } = harness(rows, { setting: () => 'close' })
    q.request()
    await settle()
    expect(log).toEqual(['stop c0ffee01', 'stop c0ffee03', `report {"closed":2,"failed":[],"silent":true}`, 'quit'])
  })

  it('a remembered keep quits without asking or stopping', () => {
    const { q, log } = harness(rows, { setting: () => 'keep' })
    q.request()
    expect(log).toEqual(['quit'])
  })

  it('a stop that fails or runs past the cap leaves that session running, and the quit goes on', async () => {
    const { q, log } = harness(rows, {
      setting: () => 'close',
      stopMs: 60,
      stop: async sid => {
        if (sid === id(1)) throw new Error('refused')
        await new Promise(r => setTimeout(r, 200))
      },
    })
    q.request()
    await new Promise(r => setTimeout(r, 120))
    expect(log).toEqual([`report {"closed":0,"failed":["name-1","name-3"],"silent":true}`, 'quit'])
  })

  it('refuses an answer when it is not asking', () => {
    const { q } = harness(rows)
    expect(q.answer({ action: 'close', keep: [], remember: false }).ok).toBe(false)
  })
})

describe('the next launch (§6, §7)', () => {
  it('says what a remembered close did, and names any stop that failed', () => {
    expect(quitNotices({ closed: 4, failed: [], silent: true })).toEqual(['Closed 4 sessions when the app quit. Change this in Settings → General.'])
    expect(quitNotices({ closed: 2, failed: [], silent: false })).toEqual([])
    expect(quitNotices({ closed: 1, failed: ['Docs sync'], silent: false })).toEqual(["Couldn't stop 1 session when the app quit: Docs sync. It's still running."])
  })
})

describe('the menu (§2)', () => {
  it("gives Quit its own handler on ⌘Q, so only it asks", () => {
    let asked = 0
    const items = appMenuTemplate('CC Command Center', () => {}, null, () => asked++)[0]!.submenu as { label?: string; role?: string; accelerator?: string; click?: () => void }[]
    const quit = items.find(i => i.label === 'Quit CC Command Center')!
    expect(quit.accelerator).toBe('CmdOrCtrl+Q')
    expect(items.some(i => i.role === 'quit')).toBe(false)
    quit.click!()
    expect(asked).toBe(1)
  })
})

describe('the setting and the report in the store (§6)', () => {
  it('accepts the three settings and refuses others; keeps a well-formed last quit', async () => {
    const { checkSettings } = await import('../src/main/validate.ts')
    const { checkStore } = await import('../src/main/store-schema.ts')
    expect(checkSettings({ quitSessions: 'close' })).toEqual({ quitSessions: 'close' })
    expect(checkSettings({ quitSessions: 'always' })).toBeNull()
    const base = { version: 1, categories: [], sessions: {}, importedAt: null }
    const kept = checkStore({ ...base, settings: { quitSessions: 'keep' }, lastQuit: { closed: 2, failed: ['Docs sync'], silent: true } })
    expect(kept.settings.quitSessions).toBe('keep')
    expect(kept.lastQuit).toEqual({ closed: 2, failed: ['Docs sync'], silent: true })
    const bad = checkStore({ ...base, settings: { quitSessions: 'never' }, lastQuit: { closed: -1, failed: [], silent: true } })
    expect(bad.settings.quitSessions).toBeUndefined()
    expect(bad.lastQuit).toBeUndefined()
  })
})
