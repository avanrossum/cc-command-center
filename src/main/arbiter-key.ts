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

/** An Admin API key: organization-admin rights (gate pass 15, M-3). */
export const isAdminKey = (v: string) => /^sk-ant-admin/.test(v.trim())

/**
 * Why a key can't be saved for this use, or null (gate pass 15, M-3). The
 * Arbiter refuses an Admin key, which would otherwise go out on every
 * Arbiter call. A prefix can't recognize a personal key with an admin's
 * role, so Settings asks for a workspace-scoped key rather than claiming to
 * catch one (gate pass 16, M-2). The spend key takes an Admin key or a
 * personal or service-account key; the cost report itself decides, before
 * it's saved (MIP2-1503).
 */
export function keyRefusal(kind: 'arbiter' | 'spend', key: string): string | null {
  if (!isApiKey(key)) return "That doesn't look like an Anthropic API key (sk-ant-…)."
  if (kind === 'arbiter' && isAdminKey(key)) return "That's an Admin API key, which has organization-admin rights. The Arbiter needs a workspace-scoped API key."
  return null
}

export class ArbiterKey {
  constructor(
    private readonly path: string,
    private readonly crypto: Crypto,
    private readonly kind: 'arbiter' | 'spend' = 'arbiter',
  ) {}

  /** A usable key is saved. An Admin key in the Arbiter's slot doesn't count (gate pass 16, M-2). */
  has(): boolean {
    return this.kind === 'arbiter' ? this.get() !== null : existsSync(this.path)
  }

  /**
   * The key's state from one decryption (gate pass 17, L-2): none, usable
   * (with its last four characters), an Admin key in the Arbiter's slot, or
   * a file that can't be decrypted, which stays visible so it can be removed.
   */
  status(): { kind: 'none' } | { kind: 'ok'; end: string } | { kind: 'admin' } | { kind: 'unreadable' } {
    if (!existsSync(this.path)) return { kind: 'none' }
    const k = this.read()
    if (k === null) return { kind: 'unreadable' }
    if (this.kind === 'arbiter' && isAdminKey(k)) return { kind: 'admin' }
    return { kind: 'ok', end: k.slice(-4) }
  }

  /**
   * The Arbiter's slot holds an Admin key, saved before 1.0.1 refused one.
   * It's never used; Settings asks for it to be replaced (gate pass 16, M-2).
   */
  holdsAdminKey(): boolean {
    const k = this.read()
    return this.kind === 'arbiter' && k !== null && isAdminKey(k)
  }

  set(key: string): void {
    const refused = keyRefusal(this.kind, key)
    if (refused) throw new Error(refused)
    if (!this.crypto.isEncryptionAvailable()) throw new Error('The Keychain is not available, so the key was not saved.')
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    writeFileSync(`${this.path}.tmp`, this.crypto.encryptString(key.trim()), { mode: 0o600 })
    renameSync(`${this.path}.tmp`, this.path)
  }

  private read(): string | null {
    try {
      return this.crypto.decryptString(readFileSync(this.path))
    } catch {
      return null
    }
  }

  /** For main's calls (MIP2-1411); null when none is set, it can't be read, or it's an Admin key in the Arbiter's slot. */
  get(): string | null {
    const k = this.read()
    return k !== null && this.kind === 'arbiter' && isAdminKey(k) ? null : k
  }

  clear(): void {
    rmSync(this.path, { force: true })
  }
}

/**
 * An Admin key in the Arbiter's slot, saved before 1.0.1 refused one, is
 * never used, so it's deleted once at start (gate pass 17, M-3). Returns the
 * notice to show, or null when there was none. A delete that fails doesn't
 * stop the app: the notice says so, and Settings shows Remove (pass 18, L-2).
 */
export function removeAdminKeyAtStart(key: Pick<ArbiterKey, 'holdsAdminKey' | 'clear'>): string | null {
  if (!key.holdsAdminKey()) return null
  try {
    key.clear()
    return 'Removed the Admin API key saved for the Arbiter: it has organization-admin rights. Save a workspace-scoped API key in Settings › Arbiter to turn the Arbiter on.'
  } catch (err) {
    return `The Admin API key saved for the Arbiter couldn't be removed (${err instanceof Error ? err.message : String(err)}). The Arbiter doesn't use it; remove it in Settings › Arbiter.`
  }
}
