// The Arbiter key store (MIP2-1412): encrypted at rest, shape-checked.

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ArbiterKey, isApiKey } from '../src/main/arbiter-key.ts'

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
    const locked = new ArbiterKey(join(dir, 'k.bin'), { ...crypto, isEncryptionAvailable: () => false })
    expect(() => locked.set(KEY)).toThrow('Keychain')
    expect(locked.has()).toBe(false)
  })
})
