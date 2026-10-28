// The Arbiter key store (MIP2-1412): encrypted at rest, shape-checked.

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArbiterKey, isApiKey, keyRefusal } from '../src/main/arbiter-key.ts'

const KEY = 'sk-ant-api03-' + 'a'.repeat(40)
// A stand-in for safeStorage: reversible, and never the plain text.
const crypto = { isEncryptionAvailable: () => true, encryptString: (t: string) => Buffer.from([...t].reverse().join('') + '#'), decryptString: (b: Buffer) => [...b.toString().slice(0, -1)].reverse().join('') }

let dir = ''
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

describe('ArbiterKey', () => {
  it('stores the key encrypted, 0600, and reads it back', () => {
    dir = mkdtempSync(join(tmpdir(), 'ccc-key-'))
    const k = new ArbiterKey(join(dir, 'arbiter-key.bin'), crypto)
    expect(k.has()).toBe(false)
    k.set(` ${KEY} `)
    expect(readFileSync(join(dir, 'arbiter-key.bin'), 'utf8')).not.toContain(KEY)
    expect(statSync(join(dir, 'arbiter-key.bin')).mode & 0o777).toBe(0o600)
    expect(k.get()).toBe(KEY)
    k.clear()
    expect(k.has()).toBe(false)
  })

  it('refuses a malformed key, and saves nothing without the Keychain', () => {
    dir = mkdtempSync(join(tmpdir(), 'ccc-key-'))
    const k = new ArbiterKey(join(dir, 'k.bin'), crypto)
    expect(() => k.set('hello')).toThrow('sk-ant')
    expect([isApiKey(KEY), isApiKey('sk-ant-short'), isApiKey(42)]).toEqual([true, false, false])
    // The Console admin key for real spend is stored the same way (MIP2-1498 §5.3).
    const ADMIN = 'sk-ant-admin01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'
    expect(isApiKey(ADMIN)).toBe(true)
    // But the Arbiter refuses one, and the spend key takes it or a regular key (gate pass 15, M-3).
    expect(keyRefusal('arbiter', ADMIN)).toMatch(/organization-admin rights/)
    expect(() => k.set(ADMIN)).toThrow('Admin API key')
    expect(keyRefusal('spend', ADMIN)).toBeNull()
    expect(keyRefusal('spend', KEY)).toBeNull()
    expect(keyRefusal('spend', 'nope')).toMatch(/sk-ant/)
    expect(() => new ArbiterKey(join(dir, 'admin.bin'), crypto, 'spend').set(ADMIN)).not.toThrow()
    const locked = new ArbiterKey(join(dir, 'k.bin'), { ...crypto, isEncryptionAvailable: () => false })
    expect(() => locked.set(KEY)).toThrow('Keychain')
    expect(locked.has()).toBe(false)
  })

  it('treats an Admin key saved in the Arbiter slot before 1.0.1 as absent, and says so (gate pass 16, M-2)', () => {
    dir = mkdtempSync(join(tmpdir(), 'ccc-key-'))
    const path = join(dir, 'arbiter-key.bin')
    // Written as 1.0.0 would have, before the Arbiter refused Admin keys.
    writeFileSync(path, crypto.encryptString('sk-ant-admin01-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'))
    const k = new ArbiterKey(path, crypto)
    expect([k.get(), k.has(), k.holdsAdminKey()]).toEqual([null, false, true])
    // The spend slot uses the same key as it is.
    const spend = new ArbiterKey(path, crypto, 'spend')
    expect([spend.has(), spend.holdsAdminKey(), spend.get()?.startsWith('sk-ant-admin')]).toEqual([true, false, true])
  })
})
