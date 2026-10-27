// Keeps the self-check's results per Claude Code version in the app's data
// folder, so a version that passed isn't judged from scratch after a restart.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { SelfCheckStore } from '@ccc/coupling'
import { checkSelfCheckFile } from './store-schema.ts'

export function fileStore(path: string): SelfCheckStore {
  let cache: ReturnType<SelfCheckStore['load']> | null = null
  return {
    load() {
      if (cache) return cache
      try {
        // Checked on load, like the store (gate L-3).
        cache = checkSelfCheckFile(JSON.parse(readFileSync(path, 'utf8'))) as ReturnType<SelfCheckStore['load']>
      } catch {
        cache = {}
      }
      return cache!
    },
    save(data) {
      const text = JSON.stringify(data)
      if (cache && JSON.stringify(cache) === text) return
      cache = data
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      writeFileSync(`${path}.tmp`, text, { mode: 0o600 })
      renameSync(`${path}.tmp`, path)
    },
  }
}
