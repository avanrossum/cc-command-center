// The app's half of the channel's signing (mod/hooks/channel-wire.ts has the
// shared rules). Node's own HMAC; the mod builds the same from digest.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
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
