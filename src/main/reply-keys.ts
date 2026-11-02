// Each channel's Ed25519 reply private key (MIP2-1436 item 1, D-027).
// Encrypted with Electron's safeStorage, whose key is in the macOS Keychain,
// one 0600 file per channel under userData/reply-keys, which sessions are
// denied. A channel recovered after an app restart then still signs with the
// key its session started with. A same-user process can read the file, but
// decrypting it needs the app's Keychain item.
//
// When safeStorage reports encryption unavailable, the keys stay in memory
// only: a channel recovered there gets a new key and shows as not connected
// until it's resumed from the app, which re-keys it (hub.ts recover()). On
// macOS it's available whenever the Keychain is, unpacked and QA builds
// included, so those keep keys too, under their own "<app name> Safe
// Storage" Keychain item, as they keep the Arbiter key.
//
// A key that's missing reads as missing; one that's there but fails a check
// or won't decrypt reads as unreadable, with why, so recovery marks its
// channel instead of replacing the file (gate pass 20, M-2). The folder is
// kept at 0700, set again when it was found looser (L-2).
//
// No key goes in a log, an error message or over IPC: errors here name the
// channel and the step, never the bytes.

import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { memoryReplyKeys, type ReplyKeyRead, type ReplyKeys } from '@ccc/coupling'
import type { Crypto } from './arbiter-key.ts'

const CHANNEL_ID = /^[0-9a-f]{8}$/
/** A PKCS#8 Ed25519 key is 48 bytes; its encrypted, base64 form stays well under this. */
const MAX_BYTES = 4096

export function replyKeyStore(dir: string, crypto: Crypto, log: (line: string) => void = l => console.warn(l)): ReplyKeys {
  if (!crypto.isEncryptionAvailable()) {
    log('reply keys: safeStorage is not available; reply keys are kept in memory only')
    return memoryReplyKeys()
  }
  const pathOf = (id: string) => {
    if (!CHANNEL_ID.test(id)) throw new Error('reply keys: not a channel id')
    return join(dir, `${id}.bin`)
  }
  /** The key folder, made 0700 or set back to it; throws if it isn't a folder of this user. */
  const keyFolder = () => {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const st = lstatSync(dir)
    if (!st.isDirectory() || st.uid !== process.getuid?.()) throw new Error('reply keys: the key folder is not a folder of this user')
    if ((st.mode & 0o077) !== 0) chmodSync(dir, 0o700)
    if ((lstatSync(dir).mode & 0o077) !== 0) throw new Error('reply keys: the key folder is open to other users')
  }
  const read = (id: string): ReplyKeyRead => {
    const path = pathOf(id)
    let fd: number
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return { state: 'missing' }
      return { state: 'unreadable', why: code === 'ELOOP' ? 'its key file is a link' : "its key file can't be opened" }
    }
    try {
      const st = fstatSync(fd)
      if (!st.isFile()) return { state: 'unreadable', why: "its key file isn't a file" }
      if (st.uid !== process.getuid?.()) return { state: 'unreadable', why: "its key file isn't this user's" }
      if ((st.mode & 0o077) !== 0) return { state: 'unreadable', why: 'its key file is open to other users' }
      if (st.size > MAX_BYTES) return { state: 'unreadable', why: 'its key file is too large' }
      let der: Buffer
      try {
        der = Buffer.from(crypto.decryptString(readFileSync(fd)), 'base64')
      } catch {
        return { state: 'unreadable', why: "its key file won't decrypt; the Keychain may be locked or have refused the app" }
      }
      return der.length ? { state: 'ok', der } : { state: 'unreadable', why: 'its key file is empty' }
    } finally {
      closeSync(fd)
    }
  }
  return {
    persistent: true,
    read,
    get(id) {
      const r = read(id)
      return r.state === 'ok' ? r.der : null
    },
    set(id, der) {
      const path = pathOf(id)
      keyFolder()
      // Written beside it with `wx` and renamed over it, so a link at the name is replaced, not written through.
      const tmp = `${path}.${process.pid}.tmp`
      rmSync(tmp, { force: true })
      writeFileSync(tmp, crypto.encryptString(der.toString('base64')), { mode: 0o600, flag: 'wx' })
      renameSync(tmp, path)
    },
    delete(id) {
      rmSync(pathOf(id), { force: true })
    },
  }
}
