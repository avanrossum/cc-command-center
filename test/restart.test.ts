// Every restart path asks the verdict at the moment of the restart (gate pass 18, H-1, M-2, L-3).

import { describe, expect, it } from 'vitest'
import { SessionControl, type SessionHost } from '@ccc/coupling'
import { field, type FleetSnapshot } from '@ccc/contract'
import { restartVerdict, type RestartDeps } from '../src/main/mod-verdict.ts'
import { guardRestarts, wireHosts } from '../src/main/restart.ts'
import { ModStuck, resumeFromApp } from '../src/main/resume.ts'
import { removeAdminKeyAtStart } from '../src/main/arbiter-key.ts'

const SID = 'c0ffee01-0000-4000-8000-000000000001'

function fakeHost() {
  const calls: string[] = []
  const host = {
    resume: async (id: string) => void calls.push(`resume ${id}`),
    respawn: async (id: string) => void calls.push(`respawn ${id}`),
    stopIfRunning: async () => (calls.push('stop'), false),
    attach: async () => ({ file: 'claude', args: [], cwd: '/w' }),
  }
  return { host: host as unknown as SessionHost & typeof host, calls }
}

describe('guardRestarts (gate pass 18, H-1)', () => {
  it('refuses resume and respawn when the verdict gives a reason, and leaves other methods alone', async () => {
    const { host, calls } = fakeHost()
    const guarded = guardRestarts(host, () => 'its saved options hold flags the app never passed')
    await expect(guarded.resume(SID)).rejects.toBeInstanceOf(ModStuck)
    await expect(guarded.respawn(SID)).rejects.toThrow(/never passed/)
    expect(calls).toEqual([])
    // An attach to a running session restarts nothing, so it goes through; to a stopped one it's refused (gate pass 19, H-1).
    const running = guardRestarts(host, () => 'refused', () => false)
    expect(await running.attach(SID)).toMatchObject({ file: 'claude' })
    const stopped = guardRestarts(host, () => 'its saved options hold flags the app never passed', () => true)
    await expect(stopped.attach(SID)).rejects.toBeInstanceOf(ModStuck)
    const open = guardRestarts(host, () => null)
    await open.respawn(SID)
    expect(calls).toEqual([`respawn ${SID}`])
  })

  it('resume from the app: asked after the stop and re-key, so a change in between is caught, and the mark stays', async () => {
    const { host, calls } = fakeHost()
    let rewritten = false
    const hub = {
      channelOf: () => 'ch',
      rekey: async () => void ((rewritten = true), calls.push('rekey')),
      untrustedReason: () => null,
      clearMark: async () => (calls.push('clear-mark'), true),
    }
    // Clean when resumeFromApp first asks; rewritten by the time of the restart.
    const guarded = guardRestarts(host, () => (rewritten ? 'its saved options name a reporter mod copy other than the one the app recorded' : null))
    await expect(resumeFromApp(SID, { host: guarded, hub, onRekeyed: () => {}, modStuck: () => null })).rejects.toThrow(/other than the one the app recorded/)
    expect(calls).toEqual(['stop', 'rekey'])
  })

  it('a prompt to a stopped session: no respawn, no relay', async () => {
    const { host, calls } = fakeHost()
    const snap = {
      contractVersion: 1,
      at: 0,
      sessions: [{ sessionId: SID, pid: field(null, 'agents-json', 0), needsYou: field(null, 'agents-json', 0) }],
    } as unknown as FleetSnapshot
    const relayed: string[] = []
    const control = new SessionControl({
      host: guardRestarts(host, () => 'its copy could not be moved aside'),
      hub: { relayPrompt: (_id: string, t: string) => (relayed.push(t), 'r1'), health: () => [] },
      current: () => snap,
    })
    await expect(control.sendPrompt(SID, 'hello')).rejects.toBeInstanceOf(ModStuck)
    expect([calls, relayed]).toEqual([[], []])
  })

  it("the watchdog's respawn: refused through the same host", async () => {
    const { host, calls } = fakeHost()
    const respawn = (id: string) => guardRestarts(host, () => 'launches are paused').respawn(id)
    await expect(respawn(SID)).rejects.toThrow('launches are paused')
    expect(calls).toEqual([])
  })
})

describe('wireHosts (gate pass 19, L-2)', () => {
  it('gives every restart-capable consumer the guarded host', async () => {
    const { host, calls } = fakeHost()
    const hosts = wireHosts(host, () => 'refused', () => true)
    for (const h of [hosts.watchdog, hosts.control, hosts.pool, hosts.trust]) {
      await expect(h.respawn(SID)).rejects.toBeInstanceOf(ModStuck)
      await expect(h.resume(SID)).rejects.toBeInstanceOf(ModStuck)
      await expect(h.attach(SID)).rejects.toBeInstanceOf(ModStuck)
    }
    expect(calls).toEqual([])
  })
})

describe('restartVerdict (gate pass 18, L-3)', () => {
  const mod = { packaged: true, stuck: new Set<string>(), verified: new Set(['v1']), unchecked: 0, launchBlocked: null }
  const deps = (meta: ReturnType<RestartDeps['meta']>, saved: string | null = null): RestartDeps => ({ meta: () => meta, mod, packaged: true, savedRefusal: () => saved })

  it('asks the mod verdict first, then the saved options for a recorded app session', () => {
    expect(restartVerdict(SID, deps({ origin: 'app', launch: { mod: 'v1' } }))).toBeNull()
    expect(restartVerdict(SID, deps({ origin: 'app', launch: { mod: 'v1' } }, 'its saved options hold flags the app never passed'))).toMatch(/never passed/)
    expect(restartVerdict(SID, deps({ origin: 'app', launch: { mod: 'v2' } }))).toMatch(/wasn't verified/)
    expect(restartVerdict(SID, deps({ origin: 'app', launch: {} }))).toMatch(/no record/)
  })

  it('leaves a session started outside the app, and an unpackaged build, to the mod verdict alone', () => {
    expect(restartVerdict(SID, deps(undefined, 'would refuse'))).toBeNull()
    expect(restartVerdict(SID, { ...deps({ origin: 'app', launch: { mod: 'v1' } }, 'would refuse'), packaged: false, mod: { ...mod, packaged: false } })).toBeNull()
  })
})

describe('removeAdminKeyAtStart (gate pass 18, L-2)', () => {
  it('removes the key once with a notice, and a failed delete is a notice, not a failed start', () => {
    let cleared = 0
    expect(removeAdminKeyAtStart({ holdsAdminKey: () => false, clear: () => void cleared++ })).toBeNull()
    expect(removeAdminKeyAtStart({ holdsAdminKey: () => true, clear: () => void cleared++ })).toMatch(/^Removed the Admin API key/)
    expect(cleared).toBe(1)
    const stuck = () => {
      throw new Error('EPERM: operation not permitted')
    }
    expect(removeAdminKeyAtStart({ holdsAdminKey: () => true, clear: stuck })).toMatch(/couldn't be removed \(EPERM.*remove it in Settings › Arbiter/)
  })
})

describe('clearing a gone session\'s mark (MIP2-1518)', () => {
  it('only for a session not listed, or archived or removed, and without a process', async () => {
    const { clearGoneRefusal } = await import('../src/main/resume.ts')
    const running = { pid: { value: 42 } }
    const stopped = { pid: { value: null } }
    expect(clearGoneRefusal(undefined, undefined, false)).toBeNull()
    expect(clearGoneRefusal(stopped, { removedAt: 1 }, false)).toBeNull()
    expect(clearGoneRefusal(stopped, {}, true)).toBeNull()
    expect(clearGoneRefusal(stopped, {}, false)).toMatch(/still exists/)
    expect(clearGoneRefusal(running, { removedAt: 1 }, true)).toMatch(/still exists/)
  })
})
