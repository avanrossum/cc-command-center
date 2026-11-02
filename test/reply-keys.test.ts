// The reply-key store (MIP2-1436 item 1, D-027): safeStorage-encrypted 0600 files, memory only without it.

import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { exportReplyKey, importReplyKey, newReplyKey } from '../packages/coupling/src/channel/crypto.ts'
import { replyKeyStore } from '../src/main/reply-keys.ts'

/** A stand-in for safeStorage: reversible, and never the plain text. */
const fakeCrypto = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (t: string) => Buffer.from(`enc:${Buffer.from(t).toString('hex')}`),
  decryptString: (b: Buffer) => {
    const t = b.toString()
    if (!t.startsWith('enc:')) throw new Error('not ours')
    return Buffer.from(t.slice(4), 'hex').toString()
  },
})

let base: string
beforeEach(() => (base = realpathSync(mkdtempSync(join(tmpdir(), 'ccc-rk-')))))
afterEach(() => rmSync(base, { recursive: true, force: true }))

describe('replyKeyStore', () => {
  it('keeps a key encrypted in a 0600 file and reads it back', () => {
    const keys = replyKeyStore(join(base, 'rk'), fakeCrypto(), () => {})
    const key = newReplyKey()
    const der = exportReplyKey(key)
    keys.set('0a1b2c3d', der)
    const path = join(base, 'rk', '0a1b2c3d.bin')
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
    expect(lstatSync(join(base, 'rk')).mode & 0o777).toBe(0o700)
    // The file holds no plain key bytes.
    expect(readFileSync(path).includes(der)).toBe(false)
    expect(importReplyKey(keys.get('0a1b2c3d')!)?.publicHex).toBe(key.publicHex)
    keys.delete('0a1b2c3d')
    expect(keys.get('0a1b2c3d')).toBeNull()
  })

  it("reads nothing from a link, a file others can read, or one it can't decrypt", () => {
    const keys = replyKeyStore(join(base, 'rk'), fakeCrypto(), () => {})
    keys.set('0a1b2c3d', exportReplyKey(newReplyKey()))
    const path = join(base, 'rk', '0a1b2c3d.bin')
    symlinkSync(path, join(base, 'rk', '11111111.bin'))
    expect(keys.get('11111111')).toBeNull()
    writeFileSync(join(base, 'rk', '22222222.bin'), readFileSync(path), { mode: 0o644 })
    expect(keys.get('22222222')).toBeNull()
    writeFileSync(join(base, 'rk', '33333333.bin'), 'garbage', { mode: 0o600 })
    expect(keys.get('33333333')).toBeNull()
  })

  it('tells a missing key from one that is there but fails a check or will not decrypt (gate pass 20, M-2)', () => {
    const keys = replyKeyStore(join(base, 'rk'), fakeCrypto(), () => {})
    keys.set('0a1b2c3d', exportReplyKey(newReplyKey()))
    const path = join(base, 'rk', '0a1b2c3d.bin')
    expect(keys.read!('0a1b2c3d').state).toBe('ok')
    expect(keys.persistent).toBe(true)
    expect(keys.read!('44444444')).toEqual({ state: 'missing' })
    symlinkSync(path, join(base, 'rk', '11111111.bin'))
    expect(keys.read!('11111111')).toEqual({ state: 'unreadable', why: 'its key file is a link' })
    writeFileSync(join(base, 'rk', '22222222.bin'), readFileSync(path), { mode: 0o644 })
    expect(keys.read!('22222222')).toEqual({ state: 'unreadable', why: 'its key file is open to other users' })
    writeFileSync(join(base, 'rk', '33333333.bin'), 'garbage', { mode: 0o600 })
    expect(keys.read!('33333333')).toEqual({ state: 'unreadable', why: "its key file won't decrypt; the Keychain may be locked or have refused the app" })
    const locked = replyKeyStore(join(base, 'rk'), { ...fakeCrypto(), decryptString: () => { throw new Error('user canceled') } }, () => {})
    expect(locked.read!('0a1b2c3d').state).toBe('unreadable')
  })

  it('sets an existing key folder back to 0700 (gate pass 20, L-2)', () => {
    mkdirSync(join(base, 'rk'), { mode: 0o755 })
    chmodSync(join(base, 'rk'), 0o755)
    const keys = replyKeyStore(join(base, 'rk'), fakeCrypto(), () => {})
    keys.set('0a1b2c3d', exportReplyKey(newReplyKey()))
    expect(lstatSync(join(base, 'rk')).mode & 0o777).toBe(0o700)
  })

  it('refuses anything but a channel id as a name, without the key in the error', () => {
    const keys = replyKeyStore(join(base, 'rk'), fakeCrypto(), () => {})
    const der = exportReplyKey(newReplyKey())
    let message = ''
    try {
      keys.set('../evil', der)
    } catch (err) {
      message = String(err)
    }
    expect(message).toMatch(/not a channel id/)
    expect(message).not.toContain(der.toString('base64'))
    expect(message).not.toContain(der.toString('hex'))
  })

  it('keeps keys in memory only, and says so once, without safeStorage', () => {
    const lines: string[] = []
    const keys = replyKeyStore(join(base, 'rk'), fakeCrypto(false), l => lines.push(l))
    keys.set('0a1b2c3d', exportReplyKey(newReplyKey()))
    expect(keys.get('0a1b2c3d')).not.toBeNull()
    expect(() => lstatSync(join(base, 'rk'))).toThrow()
    expect(lines).toEqual([expect.stringMatching(/memory only/)])
  })
})
