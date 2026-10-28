// Detect-and-degrade (MIP2-1395): the self-check on a version the app hasn't
// seen, how its failures degrade fields and control paths, and the
// supervisor watchdog.

import { readFileSync } from 'node:fs'
import { field, type SessionSnapshot } from '@ccc/contract'
import { describe, expect, it } from 'vitest'
import type { ReporterEvent, ReporterFile } from '../../../mod/hooks/wire.ts'
import { FleetPoller } from '../src/fleet-poller.ts'
import { parseReporterFile } from '../src/reporter.ts'
import { CHANNEL_DEADLINE_MS, CHANNEL_SOCKETS, memoryStore, MOD_INTEGRITY, MOD_RELOAD, OFFER_DEADLINE_MS, parseVersion, SelfCheck, STRAY_SESSIONS, SUPERVISOR_PATH, UNKNOWN_GRACE_MS, type ChannelHealth } from '../src/self-check.ts'
import { SupervisorHost } from '../src/supervisor-host.ts'
import { SupervisorWatchdog } from '../src/watchdog.ts'

const NOW = 1_800_000_000_000
const A_TEXT = readFileSync(new URL('./fixtures/reporter-2.1.311-scratch-a.json', import.meta.url), 'utf8')
const A_ID = 'c0ffee05-0000-4000-8000-000000000005'
const NEW = '2.1.400'

function session(over: Partial<SessionSnapshot> = {}): SessionSnapshot {
  const f = <T>(v: T) => field(v, 'agents-json', NOW)
  return {
    contractVersion: 1,
    sessionId: A_ID,
    kind: f('background'),
    cwd: f('/x'),
    startedAt: f(NOW - 60_000),
    name: f('a'),
    shortId: f('c0ffee05'),
    pid: f(10),
    activity: f('idle'),
    needsYou: f(null),
    ...over,
  }
}

/** The scratch capture, as if it ran on `version`, with the given main-loop events. */
function file(version: string, types: ReporterEvent['type'][], measure = true): ReporterFile {
  const base = parseReporterFile(A_TEXT).file
  const events = types.map((type, i) => ({ seq: i + 1, at: NOW - 60_000 + i, agentId: null, type }) as unknown as ReporterEvent)
  return { ...base, latest: { ...base.latest, version, measure: measure ? base.latest.measure : null }, events }
}

function channel(over: Partial<ChannelHealth> = {}): ChannelHealth {
  return { sessionId: A_ID, createdAt: NOW - 1000, contactAt: NOW - 1000, launched: true, offered: 0, prompts: [], ...over }
}

function run(check: SelfCheck, over: { sessions?: SessionSnapshot[]; channels?: ChannelHealth[]; files?: ReporterFile[]; now?: number; rejected?: number; changing?: string[] } = {}) {
  check.evaluate({
    now: over.now ?? NOW,
    sessions: over.sessions ?? [session()],
    rejectedEntries: over.rejected ?? 0,
    channels: over.channels ?? [channel()],
    files: new Map((over.files ?? []).map(f => [f.sessionId, f])),
    changing: new Set(over.changing ?? []),
  })
  return check.report()!
}

const states = (r: ReturnType<SelfCheck['report']>) => Object.fromEntries(r!.checks.map(c => [c.id, c.state]))

describe('SelfCheck', () => {
  it('passes a version whose sources all answered, and remembers it', () => {
    const store = memoryStore()
    const check = new SelfCheck(store)
    check.setVersion(NEW)
    expect(check.report()?.state).toBe('new')
    const r = run(check, { files: [file(NEW, ['session.start', 'turn.start', 'turn.step', 'session.measure', 'turn.complete'])] })
    expect(r.state).toBe('passed')
    expect(r.controlOff).toEqual([])

    const again = new SelfCheck(store)
    again.setVersion(NEW)
    expect(again.report()?.state).toBe('passed')
  })

  it('fails the session list on a state this version of the app does not know, once it lasts 10 s (MIP2-1447)', () => {
    const check = new SelfCheck(memoryStore())
    check.setVersion(NEW)
    const unknown = [session({ activity: field('unknown', 'agents-json', NOW) })]
    expect(states(run(check, { sessions: unknown }))['agents-json']).not.toBe('fail')
    const r = run(check, { sessions: unknown, now: NOW + UNKNOWN_GRACE_MS })
    expect(states(r)['agents-json']).toBe('fail')
    expect(r.state).toBe('degraded')
  })

  it("doesn't fail on an unknown state that clears quickly, or on a session the app is changing (MIP2-1447)", () => {
    const check = new SelfCheck(memoryStore())
    check.setVersion(NEW)
    const unknown = [session({ activity: field('unknown', 'agents-json', NOW) })]
    run(check, { sessions: unknown })
    run(check, { sessions: [session()], now: NOW + 2_000 })
    run(check, { sessions: unknown, now: NOW + 9_000 })
    expect(states(run(check, { sessions: [session()], now: NOW + 12_000 }))['agents-json']).toBe('pass')
    const changing = new SelfCheck(memoryStore())
    changing.setVersion(NEW)
    const id = unknown[0]!.sessionId
    run(changing, { sessions: unknown, changing: [id] })
    expect(states(run(changing, { sessions: unknown, changing: [id], now: NOW + 30_000 }))['agents-json']).not.toBe('fail')
  })

  it('takes an undocumented wait as it is, and fails on unreadable entries (Research MIP2-1448)', () => {
    const check = new SelfCheck(memoryStore())
    check.setVersion(NEW)
    const r = run(check, { sessions: [session({ needsYou: field({ kind: 'other', detail: 'goal proposal' }, 'agents-json', NOW) })] })
    expect(states(r)['agents-json']).toBe('pass')
    const unread = new SelfCheck(memoryStore())
    unread.setVersion(NEW)
    expect(run(unread, { rejected: 2 }).checks.find(c => c.id === 'agents-json')?.detail).toBe('2 entries unreadable')
  })

  it('a simulated unknown version that drops turn.step marks model and effort stale, and nothing else', async () => {
    const check = new SelfCheck(memoryStore())
    const broken = file(NEW, ['session.start', 'turn.start', 'session.measure', 'turn.complete'])
    const listing = JSON.stringify([{ pid: 10, cwd: '/x', kind: 'background', startedAt: 1, sessionId: A_ID, id: 'c0ffee05', name: 'a', status: 'idle', state: 'done' }])
    const poller = new FleetPoller({
      host: new SupervisorHost({ run: async () => listing }),
      readReporter: () => ({ files: new Map([[A_ID, { file: broken, mtimeMs: Date.now() }]]), rejected: [] }),
      readChannels: () => [channel({ contactAt: Date.now() })],
      readVersion: async () => NEW,
      selfCheck: check,
      log: () => {},
    })
    await poller.pollOnce()
    const snap = await poller.pollOnce()
    expect(states(snap.selfCheck)['event:turn.step']).toBe('fail')
    const s = snap.sessions[0]!
    expect([s.model?.stale, s.effort?.stale]).toEqual([true, true])
    expect([s.tokens?.stale, s.context?.stale, s.turn?.stale]).toEqual([false, false, false])
    expect(snap.selfCheck?.controlOff).toEqual([])
  })

  it('waits for session.measure a little after a turn, then fails it', () => {
    const check = new SelfCheck(memoryStore())
    check.setVersion(NEW)
    const f = file(NEW, ['turn.start', 'turn.step', 'turn.complete'], false)
    expect(states(run(check, { files: [f], now: NOW - 59_990 + 5_000 }))['event:session.measure']).toBe('pending')
    expect(states(run(check, { files: [f], now: NOW + 60_000 }))['event:session.measure']).toBe('fail')
  })

  it('judges only turns seen from their start: an app restart mid-turn is no verdict (MIP2-1418)', () => {
    const fresh = () => {
      const c = new SelfCheck(memoryStore())
      c.setVersion(NEW)
      return c
    }
    // Seen mid-way: the events begin at the reconnect.
    expect(states(run(fresh(), { files: [file(NEW, ['turn.step', 'session.measure', 'turn.complete'])] }))['event:turn.start']).toBe('pending')
    // The second turn is seen whole, after the first one's completion.
    const two = file(NEW, ['turn.step', 'turn.complete', 'turn.start', 'turn.step', 'session.measure', 'turn.complete'])
    expect(states(run(fresh(), { files: [two] }))['event:turn.start']).toBe('pass')
    // Seen whole without turn.start: a real failure.
    const broken = file(NEW, ['turn.complete', 'turn.step', 'session.measure', 'turn.complete'])
    expect(states(run(fresh(), { files: [broken] }))['event:turn.start']).toBe('fail')
  })

  it('drops a turn-event failure saved under the old rule, and keeps one saved under the new (MIP2-1418)', () => {
    const store = memoryStore()
    store.save({ [NEW]: { 'event:turn.start': { state: 'fail', detail: 'no turn.start before a completed turn' }, 'event:turn.complete': { state: 'pass', detail: null } } })
    const old = new SelfCheck(store)
    old.setVersion(NEW)
    expect(states(run(old, {}))['event:turn.start']).toBe('pending')
    const broken = file(NEW, ['turn.complete', 'turn.step', 'session.measure', 'turn.complete'])
    run(old, { files: [broken] })
    const again = new SelfCheck(store)
    again.setVersion(NEW)
    expect(states(run(again, {}))['event:turn.start']).toBe('fail')
  })

  it('judges only sessions on the installed version', () => {
    const check = new SelfCheck(memoryStore())
    check.setVersion(NEW)
    const r = run(check, { files: [file('2.1.311', ['turn.start', 'turn.complete'])] })
    expect(states(r)['event:turn.step']).toBe('pending')
  })

  it('fails the channel when a launched session never reaches the app, and switches every control path off', () => {
    const check = new SelfCheck(memoryStore())
    check.setVersion(NEW)
    const quiet = channel({ contactAt: 0, createdAt: NOW - CHANNEL_DEADLINE_MS - 1 })
    expect(states(run(check, { channels: [{ ...quiet, createdAt: NOW - 1000 }] })).channel).toBe('pending')
    const r = run(check, { channels: [quiet] })
    expect(states(r).channel).toBe('fail')
    expect(r.controlOff).toEqual(['card-answers', 'prompt-relay'])
    expect([...check.degradedFields()]).toContain('tokens')
  })

  it('names every late channel and fails while any is late, whatever the order (MIP2-1488)', () => {
    const check = new SelfCheck(memoryStore())
    check.setVersion(NEW)
    const B = 'c0ffee05-0000-4000-8000-00000000000b'
    const late = channel({ sessionId: B, contactAt: 0, createdAt: NOW - CHANNEL_DEADLINE_MS - 1 })
    // A heard channel after a late one no longer turns the check back to pass.
    for (const channels of [[late, channel()], [channel(), late]]) {
      const r = run(check, { channels })
      expect(states(r).channel).toBe('fail')
      expect(r.unconnected).toEqual([{ sessionId: B, since: late.createdAt }])
    }
    // An untrusted channel has its own item, and isn't counted here.
    const r = run(check, { channels: [{ ...late, untrusted: 'socket replaced' }, channel()] })
    expect(states(r).channel).toBe('pass')
    expect(r.unconnected).toEqual([])
  })

  it('Check again for the channel starts the deadline over and keeps the other results (MIP2-1488)', () => {
    const check = new SelfCheck(memoryStore())
    check.setVersion(NEW)
    const late = channel({ contactAt: 0, createdAt: NOW - CHANNEL_DEADLINE_MS - 1 })
    run(check, { channels: [late], files: [file(NEW, ['session.start', 'turn.start', 'turn.complete'])] })
    const before = states(check.report())
    check.recheckChannel(NOW)
    const r = run(check, { channels: [late] })
    expect(states(r).channel).toBe('pending')
    expect(states(r)['event:turn.start']).toBe(before['event:turn.start'])
    expect(r.controlOff).toEqual([])
    expect(states(run(check, { channels: [late], now: NOW + CHANNEL_DEADLINE_MS + 1 })).channel).toBe('fail')
    // The whole Check again starts it over too.
    check.recheck(NOW + CHANNEL_DEADLINE_MS + 1)
    expect(states(run(check, { channels: [late], now: NOW + CHANNEL_DEADLINE_MS + 2 })).channel).toBe('pending')
  })

  it('reports the likely causes it was given (MIP2-1488)', () => {
    const check = new SelfCheck(memoryStore())
    check.setVersion(NEW)
    check.noteCauses({ claudeInstalledAt: NOW - 5000 })
    check.noteCauses({ supervisorStartedAt: NOW - 4000 })
    expect(check.report()?.causes).toEqual({ claudeInstalledAt: NOW - 5000, supervisorStartedAt: NOW - 4000 })
  })

  it('Check again forgets the results, so a failed check is observed afresh (MIP2-1424)', () => {
    const check = new SelfCheck(memoryStore())
    check.setVersion(NEW)
    expect(check.report()?.checkedAt).toBeNull()
    run(check, { channels: [channel({ contactAt: 0, createdAt: NOW - CHANNEL_DEADLINE_MS - 1 })] })
    expect(check.report()?.checkedAt).toBe(NOW)
    check.recheck()
    expect(check.report()?.checks.filter(c => c.id !== MOD_INTEGRITY && c.id !== CHANNEL_SOCKETS && c.id !== MOD_RELOAD && c.id !== STRAY_SESSIONS && c.id !== SUPERVISOR_PATH).every(c => c.state === 'pending')).toBe(true)
    expect(check.controlOff()).toEqual([])
  })

  it('reports a changed reporter mod as its own failed item, without calling the version degraded (gate M-2)', () => {
    const check = new SelfCheck(memoryStore())
    check.setVersion(NEW)
    expect(check.report()?.checks.find(c => c.id === MOD_INTEGRITY)?.state).toBe('pass')
    check.markModChanged(NOW, '/data/reporter-mod/abc.changed-1', ['site', 'qa'])
    const r = check.report()!
    expect(r.checks.find(c => c.id === MOD_INTEGRITY)).toMatchObject({ state: 'fail', detail: expect.stringContaining('abc.changed-1') })
    // It names the sessions started on that copy (gate run 2, L-1).
    expect(r.checks.find(c => c.id === MOD_INTEGRITY)?.detail).toContain('sessions started on it: site, qa')
    expect(r.state).not.toBe('degraded')
  })

  it("fails the mod item when a changed copy couldn't be moved, or a check threw (pass 4, M-3)", () => {
    const check = new SelfCheck(memoryStore())
    check.setVersion(NEW)
    check.markModChanged(NOW, null, [], 'EPERM')
    expect(check.report()?.checks.find(c => c.id === MOD_INTEGRITY)).toMatchObject({ state: 'fail', detail: expect.stringContaining("couldn't be set aside (EPERM)") })
    const other = new SelfCheck(memoryStore())
    other.setVersion(NEW)
    other.markModCheckFailed(NOW, 'the older versions', 'EACCES: permission denied')
    expect(other.report()?.checks.find(c => c.id === MOD_INTEGRITY)).toMatchObject({ state: 'fail', detail: expect.stringContaining('the check of the older versions failed') })
  })

  it("names a live session whose mod would reload from a changed folder (gate run 2, L-3)", () => {
    const check = new SelfCheck(memoryStore())
    check.setVersion(NEW)
    const f = file(NEW, ['session.start'])
    const item = (files: ReporterFile[]) => run(check, { files }).checks.find(c => c.id === MOD_RELOAD)!
    expect(item([{ ...f, latest: { ...f.latest, pluginDirWatch: '0' } }]).state).toBe('pass')
    // A mod before 0.6.1 doesn't say, which isn't a failure.
    expect(item([f]).state).toBe('pass')
    const bad = item([{ ...f, latest: { ...f.latest, pluginDirWatch: null } }])
    expect(bad).toMatchObject({ state: 'fail', detail: expect.stringContaining(A_ID.slice(0, 8)) })
    expect(item([{ ...f, latest: { ...f.latest, pluginDirWatch: '1' } }]).state).toBe('fail')
  })

  it('lets a later success clear a channel failure, but not an event failure', () => {
    const check = new SelfCheck(memoryStore())
    check.setVersion(NEW)
    run(check, { channels: [channel({ contactAt: 0, createdAt: NOW - CHANNEL_DEADLINE_MS - 1 })] })
    run(check, { files: [file(NEW, ['session.start', 'turn.start', 'turn.complete'])] })
    const r = run(check, { channels: [channel()], files: [file(NEW, ['session.start', 'turn.start', 'turn.step', 'turn.complete'])] })
    expect(states(r).channel).toBe('pass')
    expect(r.controlOff).toEqual([])
    expect(states(r)['event:turn.step']).toBe('fail')
  })

  it('leaves a recovered channel of a session that has ended alone', () => {
    const check = new SelfCheck(memoryStore())
    check.setVersion(NEW)
    const old = channel({ contactAt: 0, launched: false, createdAt: NOW - 10 * CHANNEL_DEADLINE_MS })
    expect(states(run(check, { channels: [old], sessions: [session({ pid: field(null, 'agents-json', NOW) })] })).channel).toBe('pending')
  })

  it('fails card answers when a hosted session sits at a permission prompt it never offered', () => {
    const check = new SelfCheck(memoryStore())
    check.setVersion(NEW)
    const waiting = session({ activity: field('waiting', 'agents-json', NOW), needsYou: field({ kind: 'permission', detail: 'permission prompt' }, 'agents-json', NOW) })
    expect(states(run(check, { sessions: [waiting], now: NOW }))['control:card-answers']).toBe('pending')
    const r = run(check, { sessions: [waiting], now: NOW + OFFER_DEADLINE_MS + 1, channels: [channel({ contactAt: NOW + OFFER_DEADLINE_MS })] })
    expect(states(r)['control:card-answers']).toBe('fail')
    expect(r.controlOff).toEqual(['card-answers'])
  })

  it('passes and fails the prompt relay', () => {
    const check = new SelfCheck(memoryStore())
    check.setVersion(NEW)
    expect(states(run(check, { channels: [channel({ prompts: [{ at: NOW - 1000, submitted: true }] })] }))['control:prompt-relay']).toBe('pass')
    const other = new SelfCheck(memoryStore())
    other.setVersion(NEW)
    const r = run(other, { channels: [channel({ prompts: [{ at: NOW - 61_000, submitted: false }] })] })
    expect(r.controlOff).toEqual(['prompt-relay'])
  })

  it('starts over on a new version', () => {
    const check = new SelfCheck(memoryStore())
    check.setVersion(NEW)
    run(check, { sessions: [session({ activity: field('unknown', 'agents-json', NOW) })] })
    check.setVersion('2.1.401')
    expect(check.report()?.state).toBe('new')
  })

  it('below the floor, runs read-only with every control path off, and says so (MIP2-1406)', () => {
    const check = new SelfCheck(memoryStore())
    check.setVersion('2.1.290')
    const r = run(check, { files: [file('2.1.290', ['turn.start', 'turn.step', 'session.measure', 'turn.complete'])] })
    expect(r.state).toBe('too-old')
    expect(r.controlOff).toEqual(['card-answers', 'prompt-relay'])
    expect(r.checks[0]).toMatchObject({ id: 'version-floor', state: 'fail', detail: '2.1.290 is older than this app supports' })
    // At the floor and above, the normal self-check applies.
    check.setVersion('2.1.311')
    expect(check.report()?.state).not.toBe('too-old')
    check.setVersion('2.2.0')
    expect(check.report()?.controlOff).toEqual([])
  })

  it('compares versions numerically', async () => {
    const { compareVersions, belowFloor } = await import('@ccc/contract')
    expect(compareVersions('2.1.99', '2.1.311')).toBe(-1)
    expect(compareVersions('2.10.0', '2.9.9')).toBe(1)
    expect(compareVersions('2.1.311-dev.20261027', '2.1.311')).toBe(0)
    expect(belowFloor('2.1.310')).toBe(true)
    expect(belowFloor('2.1.311')).toBe(false)
  })

  it('reads the version line', () => {
    expect(parseVersion('2.1.311 (Claude Code)\n')).toBe('2.1.311')
    expect(parseVersion('garbage')).toBeNull()
  })
})

describe('SupervisorWatchdog', () => {
  const hosted = (over: Partial<SessionSnapshot> = {}) => session(over)

  function dog(codes: number[], sessions: SessionSnapshot[]) {
    let t = NOW
    const spawned: string[][] = []
    const respawned: string[] = []
    const w = new SupervisorWatchdog({
      exitCode: async () => codes.shift() ?? 1,
      spawn: args => (spawned.push(args), 4242),
      respawn: async id => void respawned.push(id),
      sessions: () => sessions,
      now: () => t,
      log: () => {},
    })
    return { w, spawned, respawned, advance: (ms: number) => void (t += ms) }
  }

  it('does nothing while the supervisor is up', async () => {
    const { w, spawned } = dog([0], [hosted()])
    expect((await w.tick()).kind).toBe('up')
    expect(spawned).toEqual([])
  })

  it('does nothing when no session needs a supervisor', async () => {
    const { w, spawned } = dog([1], [hosted({ kind: field('interactive', 'agents-json', NOW) }), hosted({ pid: field(null, 'agents-json', NOW) })])
    expect((await w.tick()).kind).toBe('idle')
    expect(spawned).toEqual([])
  })

  it('starts daemon run once per gap while hosted sessions need it, then reports it back', async () => {
    const { w, spawned, advance } = dog([1, 1, 1, 0], [hosted()])
    await w.tick()
    advance(5_000)
    await w.tick()
    expect(spawned).toEqual([['daemon', 'run']])
    advance(5_000)
    await w.tick()
    expect(spawned.length).toBe(2)
    expect((await w.tick()).kind).toBe('up')
    // One restart counted, for the settings window (MIP2-1424).
    expect(w.restartsSince(NOW)).toBe(1)
    expect(w.restartsSince(NOW + 60_000)).toBe(0)
  })

  it('respawns as a last resort, once each, never a session waiting on Alex', async () => {
    const waiting = hosted({ shortId: field('wait1', 'agents-json', NOW), activity: field('waiting', 'agents-json', NOW), needsYou: field({ kind: 'permission', detail: 'permission prompt' }, 'agents-json', NOW) })
    const { w, respawned, advance } = dog([1, 1, 1], [hosted(), waiting])
    await w.tick()
    advance(31_000)
    await w.tick()
    advance(5_000)
    await w.tick()
    expect(respawned).toEqual(['c0ffee05'])
  })

  it("doesn't respawn a session whose channel isn't trusted (gate run 3, M-1)", async () => {
    let t = NOW
    const respawned: string[] = []
    const w = new SupervisorWatchdog({
      exitCode: async () => 1,
      spawn: () => 1,
      respawn: async id => void respawned.push(id),
      sessions: () => [hosted()],
      skip: id => id === A_ID,
      now: () => t,
      log: () => {},
    })
    await w.tick()
    t += 31_000
    await w.tick()
    expect(respawned).toEqual([])
  })

  it('reports an unexpected status code without acting', async () => {
    const { w, spawned } = dog([-1], [hosted()])
    expect(await w.tick()).toEqual({ kind: 'unknown', detail: 'daemon status exited -1' })
    expect(spawned).toEqual([])
  })
})

describe('strays and migrations (pass 7, L-1 and M-1)', () => {
  it('shows a stray the app left running until it leaves the list, and a migration as information', () => {
    const check = new SelfCheck(memoryStore())
    check.setVersion(NEW)
    const s = session()
    check.addStrays([s.sessionId])
    expect(run(check, { sessions: [s] }).checks.find(c => c.id === STRAY_SESSIONS)?.state).toBe('fail')
    expect(run(check, { sessions: [] }).checks.find(c => c.id === STRAY_SESSIONS)?.state).toBe('pass')
    check.noteMigrated(['ab12cd34 from version 1 to 2'])
    const r = run(check)
    expect(r.checks.find(c => c.id === 'channel-settings')).toMatchObject({ state: 'pass', detail: 'ab12cd34 from version 1 to 2' })
    expect(r.state).not.toBe('degraded')
  })
})

describe("the supervisor's PATH (MIP2-1457)", () => {
  it('fails when the supervisor lacks the folder claude is in, and passes otherwise', () => {
    const check = new SelfCheck(memoryStore())
    check.setVersion(NEW)
    check.noteSupervisorPath({ pid: 79806, path: '/usr/bin:/bin:/usr/sbin:/sbin', claudeDir: '/Users/x/.local/bin', ok: false })
    const item = run(check).checks.find(c => c.id === SUPERVISOR_PATH)!
    expect(item.state).toBe('fail')
    expect(item.detail).toContain('without /Users/x/.local/bin')
    check.noteSupervisorPath({ pid: 79806, path: '/Users/x/.local/bin:/usr/bin', claudeDir: '/Users/x/.local/bin', ok: true })
    expect(run(check).checks.find(c => c.id === SUPERVISOR_PATH)!.state).toBe('pass')
    check.noteSupervisorPath(null)
    expect(run(check).checks.find(c => c.id === SUPERVISOR_PATH)!.state).toBe('pass')
  })
})
