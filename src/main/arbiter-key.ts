// The Arbiter's Anthropic API key (first run step 4, MIP2-1412; spec
// MIP2-1370 §14). Encrypted with Electron's safeStorage, whose key is in
// the macOS Keychain, and kept in the app's data folder. It never goes
// back to the renderer: the window can only ask whether one is set.
// Electron CCCC's key isn't read; Alex enters it again (MIP2-1409).

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface Crypto {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(data: Buffer): string
}

const KEY_SHAPE = /^sk-ant-[A-Za-z0-9_-]{20,200}$/

export function isApiKey(v: unknown): v is string {
  return typeof v === 'string' && KEY_SHAPE.test(v.trim())
}

export class ArbiterKey {
  constructor(
    private readonly path: string,
    private readonly crypto: Crypto,
  ) {}

  has(): boolean {
    return existsSync(this.path)
  }

  set(key: string): void {
    if (!isApiKey(key)) throw new Error("That doesn't look like an Anthropic API key (sk-ant-…).")
    if (!this.crypto.isEncryptionAvailable()) throw new Error('The Keychain is not available, so the key was not saved.')
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    writeFileSync(`${this.path}.tmp`, this.crypto.encryptString(key.trim()), { mode: 0o600 })
    renameSync(`${this.path}.tmp`, this.path)
  }

  /** For the Arbiter in main (MIP2-1411); null when none is set or it can't be read. */
  get(): string | null {
    try {
      return this.crypto.decryptString(readFileSync(this.path))
    } catch {
      return null
    }
  }

  clear(): void {
    rmSync(this.path, { force: true })
  }
}
