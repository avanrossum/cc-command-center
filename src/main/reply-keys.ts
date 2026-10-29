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
// No key goes in a log, an error message or over IPC: errors here name the
// channel and the step, never the bytes.

import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { memoryReplyKeys, type ReplyKeys } from '@ccc/coupling'
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
  return {
    get(id) {
      const path = pathOf(id)
      let fd: number
      try {
        fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      } catch {
        return null
      }
      try {
        const st = fstatSync(fd)
        if (!st.isFile() || st.size > MAX_BYTES || st.uid !== process.getuid?.() || (st.mode & 0o077) !== 0) return null
        const der = Buffer.from(crypto.decryptString(readFileSync(fd)), 'base64')
        return der.length ? der : null
      } catch {
        // Can't be decrypted: the channel is treated as having no kept key.
        return null
      } finally {
        closeSync(fd)
      }
    },
    set(id, der) {
      const path = pathOf(id)
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const st = lstatSync(dir)
      if (!st.isDirectory() || st.uid !== process.getuid?.()) throw new Error('reply keys: the key folder is not a folder of this user')
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
