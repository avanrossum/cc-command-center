// Gate M-1 (MIP2-1430): a channel answers only the session's own process, and
// stops trusting a socket that another process replaced.

import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { Agent, request } from 'node:http'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { channelCall, channelFrom, channelHello, type ChannelEngine } from '../../../mod/hooks/channel.ts'
import { CHANNEL_PATHS, type PermissionAsk } from '../../../mod/hooks/channel-wire.ts'
import { ChannelHub, memoryVersions, PEER_CHECKS_MAX } from '../src/channel/hub.ts'
import { parseLsof, PeerResolver } from '../src/channel/peer.ts'

const A_TEXT = readFileSync(new URL('./fixtures/reporter-2.1.311-scratch-a.json', import.meta.url), 'utf8')
const A_ID = 'c0ffee05-0000-4000-8000-000000000005'

/** The mod's engine calls, over a real socket, from this test process (as in channel.test.ts). */
const engine: ChannelEngine = {
  clock: { now: async () => Date.now() },
  http: {
    fetch: (url: string, init: { method: string; headers: Record<string, string>; body?: string; socketPath: string }) =>
      new Promise((resolve, reject) => {
        const req = request({ socketPath: init.socketPath, path: new URL(url).pathname, method: init.method, headers: init.headers, agent: (init as { agent?: Agent }).agent ?? false }, res => {
          const parts: Buffer[] = []
          res.on('data', c => parts.push(c))
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              text: Buffer.concat(parts).toString('utf8'),
              headers: Object.fromEntries(Object.entries(res.headers).map(([k, v]) => [k, String(v)])),
            }),
          )
        })
        req.on('error', reject)
        if (init.body) req.write(init.body)
        req.end()
      }),
  },
} as unknown as ChannelEngine

describe('parseLsof', () => {
  it("maps our socket's fd to its address, and the address to the processes holding its other end", () => {
    const out = ['p100', 'f7', 'd0xaaa', 'n/tmp/s.sock', 'f8', 'd0xbbb', 'n/tmp/s.sock', 'p200', 'f3', 'd0xccc', 'n->0xaaa', 'p300', 'f4', 'd0xddd', 'n->0xbbb', 'f5', 'd0xeee', 'n->0xbbb'].join('\n')
    const l = parseLsof(out, 100)
    expect(l.ownAddress.get('7')).toBe('0xaaa')
    expect(l.holders.get('0xaaa')).toEqual([200])
    expect(l.holders.get('0xbbb')).toEqual([300])
    // Another process's sockets aren't ours.
    expect(l.ownAddress.get('3')).toBeUndefined()
  })

  it('runs one listing for every lookup in its window', async () => {
    let runs = 0
    const r = new PeerResolver(async () => (runs++, ['p1', 'f9', 'd0x1', 'p2', 'f1', 'n->0x1'].join('\n')), 1, 20)
    const [a, b] = await Promise.all([r.peersOf(9), r.peersOf(10)])
    expect([a, b, runs]).toEqual([[2], [], 1])
  })

  it('runs one listing at a time, and refuses lookups past its queue (pass 4, L-2)', async () => {
    let running = 0
    let most = 0
    let runs = 0
    const slow = async () => {
      running++, runs++
      most = Math.max(most, running)
      await new Promise(r => setTimeout(r, 60))
      running--
      return ['p1', 'f9', 'd0x1', 'p2', 'f1', 'n->0x1'].join('\n')
    }
    const r = new PeerResolver(slow, 1, 5, 3)
    const first = r.peersOf(9)
    // Arrivals while the first listing runs wait for it to finish, then share one listing.
    await new Promise(res => setTimeout(res, 20))
    const later = [r.peersOf(9), r.peersOf(9), r.peersOf(9)]
    // The queue holds 3; a fourth is refused at once.
    expect(await r.peersOf(9)).toEqual([])
    expect(await Promise.all([first, ...later])).toEqual([[2], [2], [2], [2]])
    expect([most, runs]).toEqual([1, 2])
  })

  it('keeps a few places for each channel when floods on other channels fill the queue (pass 6, L-2)', async () => {
    let release = () => {}
    const r = new PeerResolver(() => new Promise(res => (release = () => res(['p1', 'f9', 'd0x1', 'p2', 'f1', 'n->0x1'].join('\n')))), 1, 5, 4, 2)
    const flood = [r.peersOf(9, 'a'), r.peersOf(9, 'a'), r.peersOf(9, 'b'), r.peersOf(9, 'b')]
    // The queue of 4 is full; a fifth on a flooding channel is refused, a new channel's still gets in.
    expect(await r.peersOf(9, 'a')).toEqual([])
    const other = r.peersOf(9, 'c')
    await new Promise(res => setTimeout(res, 20))
    release()
    expect(await other).toEqual([2])
    await Promise.all(flood)
  })

  it("caps each channel's share of the queue, so one channel's flood doesn't refuse another's mod (pass 5, L-4)", async () => {
    let release = () => {}
    const r = new PeerResolver(() => new Promise(res => (release = () => res(['p1', 'f9', 'd0x1', 'p2', 'f1', 'n->0x1'].join('\n')))), 1, 5, 100, 2)
    const flood = [r.peersOf(9, 'a'), r.peersOf(9, 'a')]
    expect(await r.peersOf(9, 'a')).toEqual([])
    const other = r.peersOf(9, 'b')
    await new Promise(res => setTimeout(res, 20))
    release()
    expect(await other).toEqual([2])
    expect(await Promise.all(flood)).toEqual([[2], [2]])
  })
})

describe('ChannelHub peer and socket checks', () => {
  let base: string
  const logs: string[] = []
  let pid: number | null = 111
  let peer = [111]
  const fakePeers = { peersOf: async () => peer } as unknown as PeerResolver
  let hub: ChannelHub

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-')))
    logs.length = 0
    pid = 111
    peer = [111]
    hub = new ChannelHub({ modDir: '/mod', root: join(base, 'ch'), longPollMs: 300, log: l => logs.push(l), sessionPid: () => pid, peers: fakePeers, peerWaitMs: 300 })
  })
  afterEach(async () => {
    await hub.closeAll()
    rmSync(base, { recursive: true, force: true })
  })

  const launch = async () => {
    const l = await hub.prepareLaunch()
    const opts = (JSON.parse(readFileSync(l.settingsPath, 'utf8')) as { pluginConfigs: Record<string, { options: { socketPath: string; secret: string } }> }).pluginConfigs['ccc-reporter@inline']!.options
    hub.bind(l.channelId, A_ID)
    return { ch: channelFrom(opts as never)!, socketPath: opts.socketPath, opts }
  }

  it("answers the session's own process, and refuses any other, a secret-holding Bash included", async () => {
    const { ch, opts } = await launch()
    expect(await channelHello(engine, ch)).toBe(true)
    // Same secret, another process: the connection is refused before anything is read.
    peer = [222]
    expect(await channelHello(engine, channelFrom(opts as never)!)).toBe(false)
    expect(logs.some(l => l.includes('peer 222 is not the session'))).toBe(true)
    // Two processes on one connection is a failure too.
    peer = [111, 333]
    expect(await channelHello(engine, channelFrom(opts as never)!)).toBe(false)
  })

  it("refuses while the session's process isn't known", async () => {
    pid = null
    const { ch } = await launch()
    expect(await channelHello(engine, ch)).toBe(false)
    expect(logs.some(l => l.includes("process isn't known"))).toBe(true)
  })

  it('stops trusting a channel whose socket was replaced: no card answers, no relayed prompts, and it says why', async () => {
    const { ch, socketPath } = await launch()
    await channelCall(engine, ch, 'POST', CHANNEL_PATHS.report, JSON.parse(A_TEXT))
    const ask: PermissionAsk = { requestId: '6f1c2a9e-1111-4c3d-8e9f-0a1b2c3d4e5f', toolUseId: null, agentId: null, tool: 'Bash', input: { command: 'ls' }, questions: null, canRemember: false }
    const held = channelCall(engine, ch, 'POST', CHANNEL_PATHS.permission, ask)
    await new Promise(r => setTimeout(r, 50))
    expect(hub.pendingRequests().get(A_ID)).toHaveLength(1)
    // Another process removes the socket and binds its own at the path.
    unlinkSync(socketPath)
    const squatter = createServer()
    await new Promise<void>(r => squatter.listen(socketPath, () => r()))
    try {
      expect(hub.health().find(h => h.sessionId === A_ID)?.untrusted).toBe('the socket file was replaced')
      expect(hub.untrustedReason(A_ID)).toBe('the socket file was replaced')
      expect(hub.pendingRequests().get(A_ID)).toBeUndefined()
      expect(hub.answer(ask.requestId, { verdict: 'allow' })).toBe(false)
      expect(() => hub.relayPrompt(A_ID, 'go')).toThrow("can't be trusted")
      // The waiting prompt went back to the session's own dialog.
      expect((await held)?.body).toEqual({ status: 'cancel' })
    } finally {
      await new Promise<void>(r => squatter.close(() => r()))
    }
  })
})

describe('the peer check on a kept-alive connection (MIP2-1435)', () => {
  it('checks a connection once, however many requests it carries', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-')))
    let lookups = 0
    const counting = { peersOf: async () => (lookups++, [111]) } as unknown as PeerResolver
    const hub = new ChannelHub({ modDir: '/mod', root: join(base, 'ch'), longPollMs: 300, log: () => {}, sessionPid: () => 111, peers: counting })
    try {
      const l = await hub.prepareLaunch()
      hub.bind(l.channelId, A_ID)
      const opts = (JSON.parse(readFileSync(l.settingsPath, 'utf8')) as { pluginConfigs: Record<string, { options: { socketPath: string; secret: string } }> }).pluginConfigs['ccc-reporter@inline']!.options
      const agent = new Agent({ keepAlive: true, maxSockets: 1 })
      const keep = { ...engine, http: { fetch: (url: string, init: Record<string, unknown>) => (engine.http.fetch as (u: string, i: unknown) => Promise<unknown>)(url, { ...init, agent }) } } as unknown as ChannelEngine
      for (let i = 0; i < 5; i++) expect(await channelHello(keep, channelFrom(opts as never)!)).toBe(true)
      expect(hub.health()[0]!.stats).toEqual({ connections: 1, requests: 5 })
      expect(lookups).toBe(1)
      agent.destroy()
    } finally {
      await hub.closeAll()
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe.runIf(process.platform === 'darwin')('the peer check with lsof', () => {
  it("finds this process on the other end of its own connection, and refuses another pid", async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-')))
    let expected = process.pid
    const hub = new ChannelHub({ modDir: '/mod', root: join(base, 'ch'), longPollMs: 300, log: () => {}, sessionPid: () => expected, peerWaitMs: 300 })
    try {
      const l = await hub.prepareLaunch()
      hub.bind(l.channelId, A_ID)
      const opts = (JSON.parse(readFileSync(l.settingsPath, 'utf8')) as { pluginConfigs: Record<string, { options: { socketPath: string; secret: string } }> }).pluginConfigs['ccc-reporter@inline']!.options
      expect(await channelHello(engine, channelFrom(opts as never)!)).toBe(true)
      expected = process.pid + 1
      expect(await channelHello(engine, channelFrom(opts as never)!)).toBe(false)
    } finally {
      await hub.closeAll()
      rmSync(base, { recursive: true, force: true })
    }
  })
})

describe('swap and squat detection (gate run 2, M-1)', () => {
  let base: string
  const untrusted: { id: string | null; why: string }[] = []
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-')))
    untrusted.length = 0
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))
  const hubAt = (root: string) => new ChannelHub({ modDir: '/mod', root, longPollMs: 300, log: () => {}, onUntrusted: (id, why) => untrusted.push({ id, why }) })
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  const socketOf = (settingsPath: string) =>
    (JSON.parse(readFileSync(settingsPath, 'utf8')) as { pluginConfigs: Record<string, { options: { socketPath: string } }> }).pluginConfigs['ccc-reporter@inline']!.options.socketPath

  it("doesn't flag a channel for its own bind", async () => {
    const hub = hubAt(join(base, 'ch'))
    const l = await hub.prepareLaunch()
    hub.bind(l.channelId, A_ID)
    await sleep(1200)
    expect(hub.untrustedReason(A_ID)).toBeNull()
    expect(untrusted).toEqual([])
    await hub.closeAll()
  })

  it('catches a rename-and-restore swap made between polls, and asks main to stop the session', async () => {
    const hub = hubAt(join(base, 'ch'))
    const l = await hub.prepareLaunch()
    hub.bind(l.channelId, A_ID)
    const sock = socketOf(l.settingsPath)
    await sleep(700)
    // Rename aside, bind an impostor, answer, then put everything back: no poll runs in between.
    renameSync(sock, `${sock}.aside`)
    const impostor = createServer()
    await new Promise<void>(r => impostor.listen(sock, () => r()))
    await new Promise<void>(r => impostor.close(() => r()))
    renameSync(`${sock}.aside`, sock)
    await sleep(600)
    expect(hub.untrustedReason(A_ID)).not.toBeNull()
    expect(untrusted).toEqual([{ id: A_ID, why: expect.any(String) }])
    await hub.closeAll()
  })

  it('flags a channel whose socket something else answered while the app was closed', async () => {
    const root = join(base, 'ch')
    const first = hubAt(root)
    const l = await first.prepareLaunch()
    first.bind(l.channelId, A_ID)
    const sock = socketOf(l.settingsPath)
    // The app quits; its server goes, and a squatter binds the path.
    await first.closeAll()
    const squatter = createServer()
    await new Promise<void>(r => squatter.listen(sock, () => r()))
    try {
      const second = hubAt(root)
      expect(await second.recover()).toEqual([l.channelId])
      expect(second.untrustedReason(A_ID)).toBe('another process was answering its channel while the app was closed')
      expect(untrusted.map(u => u.id)).toEqual([A_ID])
      await second.closeAll()
    } finally {
      await new Promise<void>(r => squatter.close(() => r()))
    }
  })

  it("caps connections waiting for the session's pid, and refuses the rest at once (gate run 2 and 3, L-5)", async () => {
    const logs: string[] = []
    const never = { peersOf: () => new Promise<number[]>(() => {}) } as unknown as PeerResolver
    const hub = new ChannelHub({ modDir: '/mod', root: join(base, 'ch'), longPollMs: 300, log: l => logs.push(l), sessionPid: () => null, peers: never, peerWaitMs: 10_000 })
    const l = await hub.prepareLaunch()
    hub.bind(l.channelId, A_ID)
    const sock = socketOf(l.settingsPath)
    const open = Array.from({ length: PEER_CHECKS_MAX + 1 }, () => request({ socketPath: sock, path: '/v1/hello', method: 'POST', agent: false }))
    const statuses: number[] = []
    const ninth = new Promise<void>(resolve => open.at(-1)!.on('response', res => (statuses.push(res.statusCode ?? 0), resolve())))
    for (const r of open) (r.on('error', () => {}), r.end())
    await ninth
    expect(statuses).toEqual([401])
    expect(logs.some(m => m.includes('too many connections waiting'))).toBe(true)
    for (const r of open) r.destroy()
    await hub.closeAll()
  })

  it("lets the session's own mod through a flood once its pid is known (gate run 3, L-5)", async () => {
    let peer = [222]
    const peers = { peersOf: async () => peer } as unknown as PeerResolver
    const hub = new ChannelHub({ modDir: '/mod', root: join(base, 'ch'), longPollMs: 300, log: () => {}, sessionPid: () => 111, peers })
    const l = await hub.prepareLaunch()
    hub.bind(l.channelId, A_ID)
    const opts = (JSON.parse(readFileSync(l.settingsPath, 'utf8')) as { pluginConfigs: Record<string, { options: { socketPath: string; secret: string } }> }).pluginConfigs['ccc-reporter@inline']!.options
    // Twenty connections from the wrong process, each refused on its own.
    const flood = await Promise.all(Array.from({ length: 20 }, () => channelHello(engine, channelFrom(opts as never)!)))
    expect(flood.every(ok => !ok)).toBe(true)
    peer = [111]
    expect(await channelHello(engine, channelFrom(opts as never)!)).toBe(true)
    await hub.closeAll()
  })
})

describe('retiring and re-keying a channel (gate run 3, M-1 to M-3)', () => {
  let base: string
  const untrusted: { id: string | null; why: string }[] = []
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-')))
    untrusted.length = 0
  })
  afterEach(() => rmSync(base, { recursive: true, force: true }))
  const hubAt = (root: string) => new ChannelHub({ modDir: '/mod', root, longPollMs: 300, log: () => {}, onUntrusted: (id, why) => untrusted.push({ id, why }) })
  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
  const optsOf = (settingsPath: string) =>
    (JSON.parse(readFileSync(settingsPath, 'utf8')) as { pluginConfigs: Record<string, { options: { socketPath: string; secret: string; channelRoot: string } }> }).pluginConfigs['ccc-reporter@inline']!.options

  it('stops the session of a channel swapped before it was bound, once it is (M-2)', async () => {
    const hub = hubAt(join(base, 'ch'))
    const l = await hub.prepareLaunch()
    const sock = optsOf(l.settingsPath).socketPath
    await sleep(700)
    renameSync(sock, `${sock}.aside`)
    renameSync(`${sock}.aside`, sock)
    await sleep(600)
    expect(untrusted).toEqual([{ id: null, why: expect.any(String) }])
    hub.bind(l.channelId, A_ID)
    expect(untrusted.at(-1)).toEqual({ id: A_ID, why: expect.any(String) })
    await hub.closeAll()
  })

  it('keeps the untrusted mark across an app restart (M-1)', async () => {
    const root = join(base, 'ch')
    const first = hubAt(root)
    const l = await first.prepareLaunch()
    first.bind(l.channelId, A_ID)
    const sock = optsOf(l.settingsPath).socketPath
    await sleep(700)
    unlinkSync(sock)
    await sleep(600)
    const why = first.untrustedReason(A_ID)
    expect(why).not.toBeNull()
    await first.closeAll()
    untrusted.length = 0
    const second = hubAt(root)
    await second.recover()
    expect(second.untrustedReason(A_ID)).toBe(why)
    expect(untrusted.map(u => u.id)).toEqual([A_ID])
    await second.closeAll()
  })

  it('re-keys a channel: the old secret no longer works, the new one does, and the mark is gone (M-1)', async () => {
    const hub = hubAt(join(base, 'ch'))
    const l = await hub.prepareLaunch()
    hub.bind(l.channelId, A_ID)
    const before = optsOf(l.settingsPath)
    await sleep(700)
    unlinkSync(before.socketPath)
    await sleep(600)
    expect(hub.untrustedReason(A_ID)).not.toBeNull()
    await hub.rekey(A_ID)
    const after = optsOf(l.settingsPath)
    expect(after.secret).not.toBe(before.secret)
    expect(after.socketPath).toBe(before.socketPath)
    expect(hub.untrustedReason(A_ID)).toBeNull()
    expect(await channelHello(engine, channelFrom(before as never)!)).toBe(false)
    expect(await channelHello(engine, channelFrom(after as never)!)).toBe(true)
    await hub.closeAll()
  })

  it("catches a swap of the channel's whole folder made between polls (M-3)", async () => {
    const hub = hubAt(join(base, 'ch'))
    const l = await hub.prepareLaunch()
    hub.bind(l.channelId, A_ID)
    const dir = join(base, 'ch', l.channelId)
    await sleep(700)
    renameSync(dir, `${dir}-aside`)
    renameSync(`${dir}-aside`, dir)
    await sleep(600)
    expect(hub.untrustedReason(A_ID)).toBe('its channel folder was moved or replaced')
    await hub.closeAll()
  })

  // Pass 4: the re-key writes the settings file from the app's own record, and a failed one leaves the session untrusted.
  const swapped = async (hub: ChannelHub) => {
    const l = await hub.prepareLaunch({ ultracode: true })
    hub.bind(l.channelId, A_ID)
    const before = optsOf(l.settingsPath)
    await sleep(700)
    unlinkSync(before.socketPath)
    await sleep(600)
    expect(hub.untrustedReason(A_ID)).not.toBeNull()
    return { l, before, original: readFileSync(l.settingsPath, 'utf8') }
  }

  it("re-key restores a tampered socketPath and permissions, and drops anything added (pass 4, H-1)", async () => {
    const hub = hubAt(join(base, 'ch'))
    const { l, before, original } = await swapped(hub)
    const data = JSON.parse(original)
    data.pluginConfigs['ccc-reporter@inline'].options.socketPath = join(base, 'evil.sock')
    data.permissions = { deny: [], allow: ['Bash(*)'], defaultMode: 'bypassPermissions' }
    data.hooks = { PreToolUse: [] }
    writeFileSync(l.settingsPath, JSON.stringify(data), { mode: 0o600 })
    await hub.rekey(A_ID)
    const after = JSON.parse(readFileSync(l.settingsPath, 'utf8'))
    const opts = after.pluginConfigs['ccc-reporter@inline'].options
    expect(opts.socketPath).toBe(before.socketPath)
    expect(opts.secret).not.toBe(before.secret)
    // Everything but the secret is as the launch wrote it, ultracode included.
    const wrote = JSON.parse(original)
    wrote.pluginConfigs['ccc-reporter@inline'].options.secret = opts.secret
    expect(after).toEqual(wrote)
    expect(await channelHello(engine, channelFrom(opts)!)).toBe(true)
    await hub.closeAll()
  })

  it('takes the launch options from the app\'s record over the file (pass 4, H-1)', async () => {
    const hub = new ChannelHub({ modDir: '/mod', root: join(base, 'ch'), longPollMs: 300, log: () => {}, launchOf: () => ({ isolation: 'worktree' }) })
    const { l } = await swapped(hub)
    await hub.rekey(A_ID)
    const after = JSON.parse(readFileSync(l.settingsPath, 'utf8'))
    expect(after.ultracode).toBeUndefined()
    expect(after.worktree).toBeUndefined()
    await hub.closeAll()
  })

  it('a failed re-key keeps the session untrusted and its channel in place (pass 4, M-1)', async () => {
    const hub = hubAt(join(base, 'ch'))
    const { l } = await swapped(hub)
    const why = hub.untrustedReason(A_ID)
    // The channel folder can't be written, so the new file can't be.
    const dir = join(base, 'ch', l.channelId)
    chmodSync(dir, 0o500)
    try {
      await expect(hub.rekey(A_ID)).rejects.toThrow()
    } finally {
      chmodSync(dir, 0o700)
    }
    expect(hub.untrustedReason(A_ID)).toBe(why)
    expect(hub.channelOf(A_ID)).toBe(l.channelId)
    expect(hub.health()[0]?.untrusted).toBe(why)
    await hub.closeAll()
  })

  it('re-key replaces a settings file made 0644 instead of failing on it (pass 4, M-1)', async () => {
    const hub = hubAt(join(base, 'ch'))
    const { l } = await swapped(hub)
    chmodSync(l.settingsPath, 0o644)
    await hub.rekey(A_ID)
    expect(lstatSync(l.settingsPath).mode & 0o777).toBe(0o600)
    expect(hub.untrustedReason(A_ID)).toBeNull()
    await hub.closeAll()
  })

  it('a re-key with keepMark rotates the secret but leaves the session untrusted (pass 4, M-2)', async () => {
    const hub = hubAt(join(base, 'ch'))
    const { l, before } = await swapped(hub)
    const why = hub.untrustedReason(A_ID)
    await hub.rekey(A_ID, { keepMark: true })
    const after = optsOf(l.settingsPath)
    expect(after.secret).not.toBe(before.secret)
    expect(hub.untrustedReason(A_ID)).toBe(why)
    expect(existsSync(join(base, 'ch', l.channelId, 'untrusted'))).toBe(true)
    expect(await channelHello(engine, channelFrom(before as never)!)).toBe(false)
    await hub.rekey(A_ID)
    expect(hub.untrustedReason(A_ID)).toBeNull()
    await hub.closeAll()
  })

  it("marks a channel whose settings file changes while the app runs, or stops being private (pass 4, H-1)", async () => {
    const hub = hubAt(join(base, 'ch'))
    const l = await hub.prepareLaunch()
    hub.bind(l.channelId, A_ID)
    await sleep(700)
    hub.checkSockets()
    expect(hub.untrustedReason(A_ID)).toBeNull()
    const data = JSON.parse(readFileSync(l.settingsPath, 'utf8'))
    data.pluginConfigs['ccc-reporter@inline'].options.socketPath = join(base, 'evil.sock')
    writeFileSync(l.settingsPath, JSON.stringify(data), { mode: 0o600 })
    await sleep(300)
    hub.checkSockets()
    expect(hub.untrustedReason(A_ID)).toBe('its settings file was changed')
    await hub.closeAll()

    const other = hubAt(join(base, 'ch2'))
    const l2 = await other.prepareLaunch()
    other.bind(l2.channelId, A_ID)
    chmodSync(l2.settingsPath, 0o644)
    other.checkSockets()
    expect(other.untrustedReason(A_ID)).toBe('its settings file is no longer private')
    await other.closeAll()
  })

  it('marks a recovered channel whose settings file was changed while the app was closed (pass 4, H-1)', async () => {
    const root = join(base, 'ch')
    const first = hubAt(root)
    const l = await first.prepareLaunch()
    first.bind(l.channelId, A_ID)
    await first.closeAll()
    // A file the app wrote recovers trusted.
    const clean = hubAt(root)
    await clean.recover()
    expect(clean.untrustedReason(A_ID)).toBeNull()
    await clean.closeAll()
    const data = JSON.parse(readFileSync(l.settingsPath, 'utf8'))
    data.pluginConfigs['ccc-reporter@inline'].options.socketPath = join(base, 'evil.sock')
    writeFileSync(l.settingsPath, JSON.stringify(data), { mode: 0o600 })
    const second = hubAt(root)
    await second.recover()
    expect(second.untrustedReason(A_ID)).toMatch(/settings file was changed while the app was closed \(socket path\)/)
    await second.closeAll()
  })

  it("keeps the app's copy of the mark when the folder's is deleted (pass 4, M-2)", async () => {
    const root = join(base, 'ch')
    const first = hubAt(root)
    const l = await first.prepareLaunch()
    first.bind(l.channelId, A_ID)
    await first.closeAll()
    rmSync(join(root, l.channelId, 'untrusted'), { force: true })
    const second = hubAt(root)
    await second.recover()
    expect(second.untrustedReason(A_ID)).toBeNull()
    second.restoreMarks([[A_ID, 'the socket file was moved or replaced']])
    expect(second.untrustedReason(A_ID)).toBe('the socket file was moved or replaced')
    expect(untrusted.at(-1)).toEqual({ id: A_ID, why: 'the socket file was moved or replaced' })
    await second.closeAll()
  })

  // Pass 5.
  const tamperAndRecover = async (root: string, edit: (data: Record<string, any>) => void, opts: { denyAlso?: string[] } = {}) => {
    const first = new ChannelHub({ modDir: '/mod', root, longPollMs: 300, log: () => {}, ...opts })
    const l = await first.prepareLaunch()
    first.bind(l.channelId, A_ID)
    await first.closeAll()
    const data = JSON.parse(readFileSync(l.settingsPath, 'utf8'))
    edit(data)
    writeFileSync(l.settingsPath, JSON.stringify(data), { mode: 0o600 })
    const second = new ChannelHub({ modDir: '/mod', root, longPollMs: 300, log: () => {}, onUntrusted: (id, why) => untrusted.push({ id, why }), ...opts })
    await second.recover()
    const why = second.untrustedReason(A_ID)
    await second.closeAll()
    return why
  }

  it('marks a recovered file missing any current deny rule, and accepts extra ones (pass 5, M-1, M-3)', async () => {
    const modless = await tamperAndRecover(join(base, 'a'), d => (d.permissions.deny = d.permissions.deny.filter((r: string) => !r.includes('//mod/'))))
    expect(modless).toMatch(/\(permissions\)/)
    const data = join(base, 'data')
    mkdirSync(data)
    const dataless = await tamperAndRecover(join(base, 'b'), d => (d.permissions.deny = d.permissions.deny.filter((r: string) => !r.includes(data.slice(1)))), { denyAlso: [data] })
    expect(dataless).toMatch(/\(permissions\)/)
    const extra = await tamperAndRecover(join(base, 'c'), d => d.permissions.deny.push('Read(//etc/**)'))
    expect(extra).toBeNull()
  })

  it('denies sessions the folders in denyAlso, the app data folder (pass 5, M-3)', async () => {
    const data = join(base, 'data')
    mkdirSync(data)
    const hub = new ChannelHub({ modDir: '/mod', root: join(base, 'ch'), longPollMs: 300, log: () => {}, denyAlso: [data] })
    const l = await hub.prepareLaunch()
    const deny = JSON.parse(readFileSync(l.settingsPath, 'utf8')).permissions.deny
    expect(deny).toEqual(expect.arrayContaining([`Read(/${data}/**)`, `Edit(/${data}/**)`]))
    await hub.closeAll()
  })

  it("migrates a file the store recorded at an older version, keeping its secret, and marks anything else (MIP2-1444; pass 6, M-2; pass 7, M-1)", async () => {
    const data = join(base, 'data')
    mkdirSync(data)
    const dropData = (d: Record<string, any>) => (d.permissions.deny = d.permissions.deny.filter((r: string) => !r.includes(data.slice(1))))
    // A version-1 file: no data-folder rule and no env (versions 2 and 3 added them).
    const asV1 = (d: Record<string, any>) => (dropData(d), delete d.env)
    /** A channel written at the current version, then edited, then recovered with the store saying `stored`. */
    const recoverAs = async (name: string, edit: (d: Record<string, any>) => void, stored: number | undefined) => {
      const root = join(base, name)
      const versions = memoryVersions()
      const first = new ChannelHub({ modDir: '/mod', root, longPollMs: 300, log: () => {}, denyAlso: [data], versions })
      const l = await first.prepareLaunch()
      first.bind(l.channelId, A_ID)
      await first.closeAll()
      const before = JSON.parse(readFileSync(l.settingsPath, 'utf8'))
      edit(before)
      writeFileSync(l.settingsPath, JSON.stringify(before), { mode: 0o600 })
      if (stored === undefined) versions.delete(l.channelId)
      else versions.set(l.channelId, stored)
      const logs: string[] = []
      const migrated: string[] = []
      const second = new ChannelHub({ modDir: '/mod', root, longPollMs: 300, log: x => logs.push(x), denyAlso: [data], versions, onMigrated: (id, from, to) => migrated.push(`${id} ${from}->${to}`) })
      await second.recover()
      const why = second.untrustedReason(A_ID)
      await second.closeAll()
      return { why, before, after: JSON.parse(readFileSync(l.settingsPath, 'utf8')), migrated, version: versions.get(l.channelId) }
    }
    // The store recorded version 1, and the file is exactly version 1's: migrated, secret kept, noted.
    const ok = await recoverAs('v1', asV1, 1)
    expect(ok.why).toBeNull()
    expect(ok.after.pluginConfigs['ccc-reporter@inline'].options.secret).toBe(ok.before.pluginConfigs['ccc-reporter@inline'].options.secret)
    expect(ok.after.permissions.deny).toEqual(expect.arrayContaining([`Edit(/${data}/**)`]))
    expect(ok.version).toBe(3)
    expect(ok.after.env).toEqual({ CLAUDE_CODE_PLUGIN_DIR_WATCH: '0' })
    expect(ok.migrated).toHaveLength(1)
    // Version 1 in the store, anything else changed: marked.
    const tampered = await recoverAs('v1t', d => (asV1(d), (d.pluginConfigs['ccc-reporter@inline'].options.socketPath = join(base, 'evil.sock'))), 1)
    expect(tampered.why).toMatch(/changed while the app was closed/)
    // The store says 3 and the rule is gone: marked. Nothing in the channel folder can make it a migration.
    expect((await recoverAs('v3', dropData, 3)).why).toMatch(/\(permissions\)/)
    // A version-2 file (rules, no env) migrates to 3; one whose env says otherwise at version 3 is marked.
    expect((await recoverAs('v2', d => delete d.env, 2)).why).toBeNull()
    expect((await recoverAs('v3e', d => (d.env.CLAUDE_CODE_PLUGIN_DIR_WATCH = '1'), 3)).why).toMatch(/\(env\)/)
    // The store has no version for it and the file is version 1's: marked, not migrated.
    const unknown = await recoverAs('none', asV1, undefined)
    expect(unknown.why).toMatch(/changed while the app was closed/)
    expect(unknown.migrated).toEqual([])
    // A 1d3208c channel: an exact v2 file (no env) and an empty store. (Its settings-version file is never read now.)
    // Migrated, secret kept; nothing marked (pass 8, M-1).
    const v2 = await recoverAs('d3208c', d => delete d.env, undefined)
    expect(v2.why).toBeNull()
    expect(v2.migrated).toHaveLength(1)
    expect(v2.after.env).toEqual({ CLAUDE_CODE_PLUGIN_DIR_WATCH: '0' })
    expect(v2.after.pluginConfigs['ccc-reporter@inline'].options.secret).toBe(v2.before.pluginConfigs['ccc-reporter@inline'].options.secret)
    // The same with a data-folder rule removed: marked.
    expect((await recoverAs('d3208c-weak', d => (delete d.env, dropData(d)), undefined)).why).toMatch(/changed while the app was closed/)
  })

  it('marks a recovered file with another key beside options in its plugin config (pass 5, L-3)', async () => {
    const why = await tamperAndRecover(join(base, 'ch'), d => (d.pluginConfigs['ccc-reporter@inline'].enabled = true))
    expect(why).toMatch(/\(plugin config\)/)
  })

  it('marks a settings file written and then restored to the same bytes (pass 5, M-2)', async () => {
    const hub = hubAt(join(base, 'ch'))
    const l = await hub.prepareLaunch()
    hub.bind(l.channelId, A_ID)
    await sleep(700)
    const original = readFileSync(l.settingsPath)
    const data = JSON.parse(original.toString('utf8'))
    data.pluginConfigs['ccc-reporter@inline'].options.socketPath = join(base, 'evil.sock')
    writeFileSync(l.settingsPath, JSON.stringify(data), { mode: 0o600 })
    writeFileSync(l.settingsPath, original, { mode: 0o600 })
    expect(readFileSync(l.settingsPath).equals(original)).toBe(true)
    await sleep(300)
    hub.checkSockets()
    expect(hub.untrustedReason(A_ID)).toMatch(/settings file was (changed|replaced)/)
    await hub.closeAll()
  })

  it('runs two re-keys of one session one after the other, and ends with the file and the server agreeing (pass 5, M-4)', async () => {
    const hub = hubAt(join(base, 'ch'))
    const { l } = await swapped(hub)
    await Promise.all([hub.rekey(A_ID, { keepMark: true }), hub.rekey(A_ID)])
    expect(hub.health()).toHaveLength(1)
    expect(hub.untrustedReason(A_ID)).toBeNull()
    expect(await channelHello(engine, channelFrom(optsOf(l.settingsPath) as never)!)).toBe(true)
    // No temporary file left behind.
    expect(readdirSync(join(base, 'ch', l.channelId)).filter(n => n.includes('.rekey-'))).toEqual([])
    await hub.closeAll()
  })

  it('clears a kept mark only when asked, after the resume (pass 5, L-2)', async () => {
    const hub = hubAt(join(base, 'ch'))
    const { l } = await swapped(hub)
    await hub.rekey(A_ID, { keepMark: true })
    expect(hub.untrustedReason(A_ID)).not.toBeNull()
    await hub.clearMark(A_ID)
    expect(hub.untrustedReason(A_ID)).toBeNull()
    expect(existsSync(join(base, 'ch', l.channelId, 'untrusted'))).toBe(false)
    expect(hub.health()[0]?.untrusted).toBeNull()
    await hub.closeAll()
  })

  it("can't write the folder mark while the folder is aside, and the store's copy covers a restart (QA, MIP2-1443)", async () => {
    const logs: string[] = []
    const root = join(base, 'ch')
    const hub = new ChannelHub({ modDir: '/mod', root, longPollMs: 300, log: l => logs.push(l), onUntrusted: (id, why) => untrusted.push({ id, why }) })
    const l = await hub.prepareLaunch()
    hub.bind(l.channelId, A_ID)
    const dir = join(root, l.channelId)
    await sleep(700)
    renameSync(dir, `${dir}-aside`)
    await sleep(600)
    const why = hub.untrustedReason(A_ID)
    expect(why).not.toBeNull()
    // The mark goes to a folder that isn't there: ENOENT, logged. Accepted, since the store keeps its own copy.
    expect(logs.some(x => x.includes("couldn't record the untrusted mark"))).toBe(true)
    await hub.closeAll()
    renameSync(`${dir}-aside`, dir)
    const second = hubAt(root)
    await second.recover()
    second.restoreMarks([[A_ID, why!]])
    expect(second.untrustedReason(A_ID)).toBe(why)
    await second.closeAll()
  })

  it('keeps watching the new channel through a resume, and keeps the mark if its settings change meanwhile (pass 6, M-1)', async () => {
    const hub = hubAt(join(base, 'ch'))
    const { l } = await swapped(hub)
    const why = hub.untrustedReason(A_ID)
    await hub.rekey(A_ID, { keepMark: true })
    // Still refused from the card while the resume runs.
    expect(hub.health()[0]?.untrusted).toBe(why)
    await sleep(700)
    const data = JSON.parse(readFileSync(l.settingsPath, 'utf8'))
    data.pluginConfigs['ccc-reporter@inline'].options.socketPath = join(base, 'evil.sock')
    const tmp = `${l.settingsPath}.x`
    writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 })
    renameSync(tmp, l.settingsPath)
    expect(await hub.clearMark(A_ID)).toBe(false)
    expect(hub.untrustedReason(A_ID)).toMatch(/settings file was (changed|replaced)/)
    await hub.closeAll()
  })

  it('keeps both marks when the session has no channel to clear them on (pass 7, L-2)', async () => {
    const hub = hubAt(join(base, 'ch'))
    hub.restoreMarks([[A_ID, 'the socket file was moved or replaced']])
    expect(await hub.clearMark(A_ID)).toBe(false)
    expect(hub.untrustedReason(A_ID)).toBe('the socket file was moved or replaced')
    await hub.closeAll()
  })

  it('clears the kept mark after a clean resume (pass 6, M-1)', async () => {
    const hub = hubAt(join(base, 'ch'))
    await swapped(hub)
    await hub.rekey(A_ID, { keepMark: true })
    expect(await hub.clearMark(A_ID)).toBe(true)
    expect(hub.untrustedReason(A_ID)).toBeNull()
    await hub.closeAll()
  })

  it('refuses launches while blocked, and uses a new mod folder once set (pass 5, H-1)', async () => {
    const hub = hubAt(join(base, 'ch'))
    hub.blockLaunches("the reporter mod's copy is changed and couldn't be replaced (EPERM)")
    await expect(hub.prepareLaunch()).rejects.toThrow('Launching is paused')
    hub.blockLaunches(null)
    hub.setModDir('/mod-r2')
    const l = await hub.prepareLaunch()
    expect(l.args.slice(0, 2)).toEqual(['--plugin-dir', '/mod-r2'])
    await hub.closeAll()
  })

  it('writes the mark over a link left at its name, not through it (pass 4, L-1)', async () => {
    const hub = hubAt(join(base, 'ch'))
    const l = await hub.prepareLaunch()
    hub.bind(l.channelId, A_ID)
    const target = join(base, 'victim.txt')
    writeFileSync(target, 'keep me')
    symlinkSync(target, join(base, 'ch', l.channelId, 'untrusted'))
    const sock = optsOf(l.settingsPath).socketPath
    await sleep(700)
    unlinkSync(sock)
    await sleep(600)
    expect(hub.untrustedReason(A_ID)).not.toBeNull()
    expect(readFileSync(target, 'utf8')).toBe('keep me')
    expect(lstatSync(join(base, 'ch', l.channelId, 'untrusted')).isSymbolicLink()).toBe(false)
    await hub.closeAll()
  })
})

describe.runIf(process.platform === 'darwin')('channel descriptors are close-on-exec (MIP2-1440, QA)', () => {
  it('a process started while a channel connection is open inherits no Unix socket from it', async () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-')))
    const hub = new ChannelHub({ modDir: '/mod', root: join(base, 'ch'), longPollMs: 300, log: () => {} })
    try {
      const l = await hub.prepareLaunch()
      const opts = (JSON.parse(readFileSync(l.settingsPath, 'utf8')) as { pluginConfigs: Record<string, { options: { socketPath: string; secret: string } }> }).pluginConfigs['ccc-reporter@inline']!.options
      const agent = new Agent({ keepAlive: true, maxSockets: 1 })
      const keep = { ...engine, http: { fetch: (url: string, init: Record<string, unknown>) => (engine.http.fetch as (u: string, i: unknown) => Promise<unknown>)(url, { ...init, agent }) } } as unknown as ChannelEngine
      expect(await channelHello(keep, channelFrom(opts as never)!)).toBe(true)
      // A tool's subprocess, started while the connection is held open.
      const child = spawn('/bin/sleep', ['2'], { stdio: 'ignore' })
      await new Promise(r => setTimeout(r, 200))
      const listed = spawnSync('/usr/sbin/lsof', ['-a', '-U', '-p', String(child.pid), '-F', 'n'], { encoding: 'utf8' }).stdout
      expect(listed.split('\n').filter(line => line.startsWith('n'))).toEqual([])
      child.kill()
      agent.destroy()
    } finally {
      await hub.closeAll()
      rmSync(base, { recursive: true, force: true })
    }
  })
})
