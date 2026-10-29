// One session's channel server: Node `http` on a Unix socket, every request
// verified before it is read and every reply signed (D-011 item 7, Research
// MIP2-1376). A request that fails any check gets an unsigned 401, which the
// mod treats as no answer.

import { lstatSync } from 'node:fs'
import { dirname } from 'node:path'
import { chmod, lstat, unlink } from 'node:fs/promises'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Socket } from 'node:net'
import {
  ANSWER_CHARS,
  CHANNEL_PATHS,
  HEADER,
  MAX_BODY_BYTES,
  NONCE_HEX,
  TIMESTAMP_WINDOW_MS,
  replyText,
  requestText,
  type AnswerPost,
  type PermissionAnswer,
  type PermissionAsk,
  type PromptRelay,
  type ReportWanted,
} from '../../../../mod/hooks/channel-wire.ts'
import type { ReporterFile } from '../../../../mod/hooks/wire.ts'
import { validateReporterFile } from '../reporter-schema.ts'
import { sign, signReply, verify, type ReplyKey } from './crypto.ts'
import { parsePermissionAsk } from './messages.ts'

export interface ChannelHandlers {
  report(file: ReporterFile): void
  /** Resolves with the answer, or `pending` when the long poll should end unanswered. */
  permission(ask: PermissionAsk, signal: AbortSignal): Promise<PermissionAnswer>
  permissionDone(requestId: string): void
  /** Resolves with the next relayed prompt, a request for the full report, or null when the long poll should end empty. */
  nextPrompt(signal: AbortSignal): Promise<PromptRelay | ReportWanted | null>
  promptAck(id: string): void
  /** The main loop's whole final text for a turn (mod 0.6.0). */
  answer?(post: AnswerPost): void
  /** Any verified request: the mod is alive. */
  contact?(): void
  /** A request refused before it was read: for the log. */
  refused?(reason: string): void
}

export interface ChannelServerOptions {
  socketPath: string
  secret: string
  /** Signs every reply (MIP2-1436 item 1); without it replies carry the MAC alone. */
  replyKey?: ReplyKey | null
  handlers: ChannelHandlers
  now?: () => number
  /**
   * Checks the process on the other end of a connection, once per
   * connection, before any request on it is read (gate M-1). Resolves with
   * why it's refused, or null. `fd` is the accepted socket's descriptor.
   */
  checkPeer?: (fd: number | null) => Promise<string | null>
}

const ROUTES = new Map<string, 'GET' | 'POST'>([
  [CHANNEL_PATHS.hello, 'POST'],
  [CHANNEL_PATHS.report, 'POST'],
  [CHANNEL_PATHS.permission, 'POST'],
  [CHANNEL_PATHS.permissionDone, 'POST'],
  [CHANNEL_PATHS.prompt, 'GET'],
  [CHANNEL_PATHS.promptAck, 'POST'],
  [CHANNEL_PATHS.answer, 'POST'],
])

const decoder = new TextDecoder('utf-8', { fatal: true })

class Refused extends Error {}

export class ChannelServer {
  readonly socketPath: string
  private readonly secret: string
  private readonly replyKey: ReplyKey | null
  private readonly handlers: ChannelHandlers
  private readonly now: () => number
  /** Requests signed before this server started are refused, so nothing captured earlier replays. */
  private readonly startedAt: number
  /** Nonces seen inside the timestamp window, with their timestamps. */
  private readonly nonces = new Map<string, number>()
  private server: Server | null = null
  private readonly checkPeer: ChannelServerOptions['checkPeer']
  /** Each connection's peer verdict, so a kept-alive connection is checked once. */
  private readonly peers = new WeakMap<Socket, Promise<string | null>>()
  /** Connections accepted and requests read, for the peer check's cost (MIP2-1435). */
  readonly stats = { connections: 0, requests: 0 }
  /**
   * The socket file this server made: its inode and owner, to tell if it's
   * replaced (gate M-1), and the inodes of its folder, the channel root and
   * the folder above that, since moving any of those also changes what the
   * mod's path reaches (gate run 3, M-3).
   */
  private bound: { ino: number; uid: number; folders: { path: string; ino: number }[] } | null = null

  constructor(opts: ChannelServerOptions) {
    this.socketPath = opts.socketPath
    this.secret = opts.secret
    this.replyKey = opts.replyKey ?? null
    this.handlers = opts.handlers
    this.now = opts.now ?? Date.now
    this.startedAt = this.now()
    this.checkPeer = opts.checkPeer
  }

  /**
   * Null while the socket file is the one this server bound; otherwise what
   * changed. Another process that removed it and bound its own would get
   * the mod's requests, so a change means the channel can't be trusted.
   */
  socketChanged(): string | null {
    if (!this.bound) return null
    let st: { ino: number; uid: number; isSocket(): boolean }
    try {
      st = lstatSync(this.socketPath)
    } catch {
      return 'the socket file is gone'
    }
    if (!st.isSocket()) return 'the socket path is no longer a socket'
    if (st.ino !== this.bound.ino) return 'the socket file was replaced'
    if (st.uid !== this.bound.uid) return 'the socket file has another owner'
    for (const f of this.bound.folders) {
      try {
        if (lstatSync(f.path).ino !== f.ino) return 'a folder on its socket path was moved or replaced'
      } catch {
        return 'a folder on its socket path is gone'
      }
    }
    return null
  }

  async listen(): Promise<void> {
    await removeStaleSocket(this.socketPath)
    const server = createServer((req, res) => (this.stats.requests++, void this.handle(req, res)))
    server.on('connection', () => void this.stats.connections++)
    // Long polls hold for 25 s; keep the defaults from cutting them.
    server.requestTimeout = 0
    server.headersTimeout = 10_000
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.socketPath, () => resolve())
    })
    await chmod(this.socketPath, 0o600)
    const st = lstatSync(this.socketPath)
    const folders = [dirname(this.socketPath), dirname(dirname(this.socketPath)), dirname(dirname(dirname(this.socketPath)))]
    this.bound = { ino: st.ino, uid: st.uid, folders: folders.map(path => ({ path, ino: lstatSync(path).ino })) }
    this.server = server
  }

  async close(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    await removeStaleSocket(this.socketPath)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let nonce: string
    let path: string
    let body: string
    if (this.checkPeer) {
      const socket = req.socket
      let verdict = this.peers.get(socket)
      if (!verdict) {
        // `_handle.fd` is Node's own descriptor for the accepted socket; it has no documented accessor.
        const fd = (socket as unknown as { _handle?: { fd?: number } })._handle?.fd
        verdict = this.checkPeer(typeof fd === 'number' && fd >= 0 ? fd : null)
        this.peers.set(socket, verdict)
      }
      const why = await verdict
      if (why) {
        this.handlers.refused?.(`peer: ${why}`)
        if (!res.headersSent) res.writeHead(401).end()
        req.resume()
        return
      }
    }
    try {
      ;({ nonce, path, body } = await this.verified(req))
    } catch (err) {
      this.handlers.refused?.(err instanceof Error ? err.message : String(err))
      if (!res.headersSent) res.writeHead(401).end()
      req.resume()
      return
    }

    this.handlers.contact?.()
    const abort = new AbortController()
    res.on('close', () => abort.abort())
    const reply = (status: number, payload?: unknown) => {
      if (res.writableEnded || res.destroyed) return
      const text = payload === undefined ? '' : JSON.stringify(payload)
      const signed = replyText(nonce, status, text)
      res.writeHead(status, {
        'content-type': 'application/json',
        [HEADER.mac]: sign(this.secret, signed),
        ...(this.replyKey ? { [HEADER.sig]: signReply(this.replyKey, signed) } : {}),
      })
      res.end(text)
    }

    try {
      switch (path) {
        case CHANNEL_PATHS.hello:
          return reply(200, { ok: true })
        case CHANNEL_PATHS.report: {
          const { file } = validateReporterFile(JSON.parse(body))
          this.handlers.report(file)
          return reply(204)
        }
        case CHANNEL_PATHS.permission: {
          const ask = parsePermissionAsk(JSON.parse(body))
          if (!ask) return reply(400)
          return reply(200, await this.handlers.permission(ask, abort.signal))
        }
        case CHANNEL_PATHS.permissionDone: {
          const { requestId } = JSON.parse(body) as { requestId?: unknown }
          if (typeof requestId === 'string') this.handlers.permissionDone(requestId)
          return reply(204)
        }
        case CHANNEL_PATHS.prompt: {
          const relay = await this.handlers.nextPrompt(abort.signal)
          return relay ? reply(200, relay) : reply(204)
        }
        case CHANNEL_PATHS.promptAck: {
          const { id } = JSON.parse(body) as { id?: unknown }
          if (typeof id === 'string') this.handlers.promptAck(id)
          return reply(204)
        }
        case CHANNEL_PATHS.answer: {
          const { at, text } = JSON.parse(body) as { at?: unknown; text?: unknown }
          if (typeof at !== 'number' || !Number.isFinite(at) || typeof text !== 'string' || text.length > ANSWER_CHARS) return reply(400)
          this.handlers.answer?.({ at, text })
          return reply(204)
        }
      }
    } catch (err) {
      this.handlers.refused?.(`${path}: ${err instanceof Error ? err.message : String(err)}`)
      return reply(400)
    }
  }

  /** Reads the whole body, then checks method, path, timestamp, nonce and MAC. */
  private async verified(req: IncomingMessage): Promise<{ nonce: string; path: string; body: string }> {
    const method = req.method ?? ''
    const path = req.url ?? ''
    if (ROUTES.get(path) !== method) throw new Refused(`no route ${method} ${path}`)

    const nonce = header(req, HEADER.nonce)
    const tsText = header(req, HEADER.ts)
    const mac = header(req, HEADER.mac)
    if (!NONCE_HEX.test(nonce)) throw new Refused('bad nonce')
    if (!/^\d{1,16}$/.test(tsText)) throw new Refused('bad timestamp')
    const ts = Number(tsText)
    const now = this.now()
    if (!Number.isFinite(ts) || Math.abs(now - ts) > TIMESTAMP_WINDOW_MS) throw new Refused('timestamp outside the window')
    if (ts < this.startedAt) throw new Refused('signed before this server started')

    // Concatenate before decoding, so a multibyte character split across
    // chunks decodes whole (MIP2-1376 §6).
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of req as AsyncIterable<Buffer>) {
      size += chunk.length
      if (size > MAX_BODY_BYTES) throw new Refused('body too large')
      chunks.push(chunk)
    }
    let body: string
    try {
      body = decoder.decode(Buffer.concat(chunks))
    } catch {
      throw new Refused('body is not UTF-8')
    }

    if (!verify(this.secret, requestText(method, path, nonce, tsText, body), mac)) throw new Refused('bad mac')
    // Checked after the MAC, so an unsigned request can't fill the cache.
    this.pruneNonces(now)
    if (this.nonces.has(nonce)) throw new Refused('replayed nonce')
    this.nonces.set(nonce, ts)
    return { nonce, path, body }
  }

  private pruneNonces(now: number): void {
    for (const [nonce, ts] of this.nonces) {
      if (Math.abs(now - ts) > TIMESTAMP_WINDOW_MS) this.nonces.delete(nonce)
    }
  }
}

function header(req: IncomingMessage, name: string): string {
  const value = req.headers[name]
  return typeof value === 'string' ? value : ''
}

/** Removes a socket left at the path, and refuses anything else there. */
async function removeStaleSocket(path: string): Promise<void> {
  try {
    const st = await lstat(path)
    if (!st.isSocket() || st.uid !== process.getuid?.()) throw new Error(`${path} exists and is not this user's socket`)
    await unlink(path)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
  }
}
