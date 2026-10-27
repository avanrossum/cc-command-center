// The mod's side of the channel to the app (D-011 item 7, MIP2-1390). One
// signed call at a time over the session's Unix socket. A reply whose MAC
// fails, a transport error, or anything unexpected reads as no answer, and
// every caller falls back to the session's own behavior: the dialog stays,
// the telemetry waits for the next send.
//
// Plain functions taking `$` first: the engine's scanner follows `$` into a
// module's functions, not into class methods (`claude plugin validate`).

import { CHANNEL_PATHS, HEADER, MAC_HEX, MAX_BODY_BYTES, SECRET_HEX, bytesEqual, fromHex, replyText, requestText, toHex } from './channel-wire.ts'
import { hmacSha256 } from './hmac.ts'

/**
 * The two engine calls the client makes. The mod passes its `$`; the tests
 * pass a stand-in. Typed here rather than from 'claude-code', so the app's
 * tests read this file without the engine's declarations.
 */
export interface ChannelEngine {
  clock: { now(): Promise<number> }
  http: {
    fetch(
      url: string,
      init: { method: string; headers: Record<string, string>; body?: string; socketPath: string },
    ): Promise<{ status: number; text: string; headers: Record<string, string | undefined> }>
  }
}

export interface Channel {
  readonly key: Uint8Array
  readonly socketPath: string
  /** The folder holding every session's channel; "remember" never grants it. */
  readonly channelRoot: string
  /** True while the last call verified. Any failure clears it, and channelSend says hello again first. */
  trusted: boolean
}

export interface Reply {
  status: number
  /** The parsed body of a verified 200; undefined for 204. */
  body: unknown
}

/** Null unless every option is well formed; the mod then runs without a channel. */
export function channelFrom(options: Readonly<Record<string, unknown>>): Channel | null {
  const socketPath = typeof options.socketPath === 'string' ? options.socketPath : ''
  const channelRoot = typeof options.channelRoot === 'string' ? options.channelRoot.replace(/\/+$/, '') : ''
  const key = typeof options.secret === 'string' ? fromHex(options.secret, SECRET_HEX) : null
  if (!key || !channelRoot.startsWith('/') || !socketPath.startsWith(`${channelRoot}/`)) return null
  return { key, socketPath, channelRoot, trusted: false }
}

/** One signed call. Undefined for any failure; the caller falls back. */
export async function channelCall(
  $: ChannelEngine,
  ch: Channel,
  method: 'GET' | 'POST',
  path: string,
  payload?: unknown,
): Promise<Reply | undefined> {
  const body = payload === undefined ? '' : JSON.stringify(payload)
  if (body.length > MAX_BODY_BYTES) return undefined
  const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)))
  const ts = String(await $.clock.now())
  const mac = toHex(await hmacSha256(ch.key, requestText(method, path, nonce, ts, body)))
  try {
    const r = await $.http.fetch(`http://ccc${path}`, {
      method,
      headers: { 'content-type': 'application/json', [HEADER.nonce]: nonce, [HEADER.ts]: ts, [HEADER.mac]: mac },
      body: body || undefined,
      socketPath: ch.socketPath,
    })
    const got = fromHex(r.headers[HEADER.mac] ?? '', MAC_HEX)
    const want = await hmacSha256(ch.key, replyText(nonce, r.status, r.text))
    if (!got || !bytesEqual(got, want)) return distrust(ch)
    if (r.status === 204) return trust(ch, { status: 204, body: undefined })
    if (r.status !== 200) return distrust(ch)
    return trust(ch, { status: 200, body: JSON.parse(r.text) })
  } catch {
    return distrust(ch)
  }
}

function trust(ch: Channel, reply: Reply): Reply {
  ch.trusted = true
  return reply
}

function distrust(ch: Channel): undefined {
  ch.trusted = false
  return undefined
}

/**
 * A call that carries session content (telemetry, a command to approve).
 * After any failure the app must prove the secret again before the content
 * is sent, so a process that took the socket while the app was down sees
 * only hellos (MIP2-1376 §3).
 */
export async function channelSend($: ChannelEngine, ch: Channel, path: string, payload: unknown): Promise<Reply | undefined> {
  if (!ch.trusted && !(await channelHello($, ch))) return undefined
  return channelCall($, ch, 'POST', path, payload)
}

/**
 * True when the app proves it holds the secret. Called before a request
 * that carries a command or input, so a process squatting the socket while
 * the app is down never sees it (MIP2-1376 §3).
 */
export async function channelHello($: ChannelEngine, ch: Channel): Promise<boolean> {
  const r = await channelCall($, ch, 'POST', CHANNEL_PATHS.hello)
  return r?.status === 200 && (r.body as { ok?: unknown } | undefined)?.ok === true
}
