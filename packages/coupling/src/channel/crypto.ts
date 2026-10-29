// The app's half of the channel's signing (mod/hooks/channel-wire.ts has the
// shared rules). Node's own HMAC; the mod builds the same from digest.

import { createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, randomBytes, sign as edSign, timingSafeEqual, type KeyObject } from 'node:crypto'
import { MAC_HEX, SECRET_HEX } from '../../../../mod/hooks/channel-wire.ts'

/** A new 32-byte secret, as 64 hex characters. One per launch (D-017). */
export function newSecret(): string {
  return randomBytes(32).toString('hex')
}

export function sign(secretHex: string, text: string): string {
  if (!SECRET_HEX.test(secretHex)) throw new Error('secret is not 64 hex characters')
  return createHmac('sha256', Buffer.from(secretHex, 'hex')).update(text, 'utf8').digest('hex')
}

/** Constant-time check of a MAC given as hex. A malformed MAC never matches. */
export function verify(secretHex: string, text: string, macHex: string): boolean {
  if (!MAC_HEX.test(macHex)) return false
  return timingSafeEqual(Buffer.from(sign(secretHex, text), 'hex'), Buffer.from(macHex, 'hex'))
}

/**
 * A channel's Ed25519 reply key (MIP2-1436 item 1). The private half signs
 * every reply and never goes in a file a session can read; the public half,
 * raw 32 bytes as hex, goes in the session's settings for the mod to verify.
 */
export interface ReplyKey {
  readonly privateKey: KeyObject
  readonly publicHex: string
}

export function newReplyKey(): ReplyKey {
  return replyKeyOf(generateKeyPairSync('ed25519').privateKey)
}

function replyKeyOf(privateKey: KeyObject): ReplyKey {
  // The raw key is the last 32 bytes of its SPKI DER encoding.
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  return { privateKey, publicHex: spki.subarray(spki.length - 32).toString('hex') }
}

/** The private key as PKCS#8 DER, for the app's encrypted key store. */
export function exportReplyKey(key: ReplyKey): Buffer {
  return key.privateKey.export({ format: 'der', type: 'pkcs8' })
}

/** A key from the app's store; null if it isn't an Ed25519 private key. */
export function importReplyKey(der: Buffer): ReplyKey | null {
  try {
    const k = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })
    return k.asymmetricKeyType === 'ed25519' ? replyKeyOf(k) : null
  } catch {
    return null
  }
}

/** The reply text's signature, 64 bytes as hex. */
export function signReply(key: ReplyKey, text: string): string {
  return edSign(null, Buffer.from(text, 'utf8'), key.privateKey).toString('hex')
}
