// electron-updater set up for this app (MIP2-1469): the custom provider, no
// download until Download is pressed, prereleases only with Get beta updates
// (MIP2-1497), never a downgrade. A
// dry-run build (CCC_UPDATE_TEST_FEED at build time, refused by the release
// script) reads a local stand-in for the repository instead.

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { net, session } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { UpdateState } from '../shared/update-state.ts'
import { UPDATE_REPO, type Hop } from './update-feed.ts'
import { CccProvider } from './update-provider.ts'
import { Updates } from './updater.ts'
import { UPDATE_TEST_FEED } from './test-isolation.ts'


/** One GET without following redirects, so update-feed.ts checks each hop. */
function open(url: string): Promise<Hop> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: 'manual', session: session.fromPartition('ccc-updates'), useSessionCookies: false })
    request.on('redirect', (status, _method, location) => {
      request.abort()
      resolve({ kind: 'redirect', status, location })
    })
    request.on('response', response => {
      const raw = response.headers['content-length']
      const length = Number(Array.isArray(raw) ? raw[0] : raw)
      async function* body(): AsyncIterable<Uint8Array> {
        const queue: Buffer[] = []
        let done = false
        let failed: Error | null = null
        let wake: (() => void) | null = null
        const poke = () => (wake?.(), (wake = null))
        response.on('data', (chunk: Buffer) => (queue.push(chunk), poke()))
        response.on('end', () => ((done = true), poke()))
        response.on('error', (err: Error) => ((failed = err), poke()))
        for (;;) {
          if (queue.length) yield queue.shift() as Buffer
          else if (failed) throw failed
          else if (done) return
          else await new Promise<void>(r => (wake = r))
        }
      }
      resolve({ kind: 'response', status: response.statusCode, length: Number.isFinite(length) ? length : null, body: body(), cancel: () => request.abort() })
    })
    request.on('error', reject)
    request.end()
  })
}

/**
 * Whether this build can install an update: a packaged build with
 * electron-builder's app-update.yml, which Download reads for its cache
 * folder. A `--mac dir` build has none, so it never checks, rather than
 * offering an update it can't install.
 */
export function canUpdate(packaged: boolean, resourcesPath: string): boolean {
  return packaged && existsSync(join(resourcesPath, 'app-update.yml'))
}

export function setUpUpdates(packaged: boolean, onChange: (s: UpdateState) => void, betas: () => boolean = () => false): Updates {
  autoUpdater.autoDownload = false
  autoUpdater.allowPrerelease = false
  autoUpdater.allowDowngrade = false
  autoUpdater.setFeedURL({
    provider: 'custom',
    updateProvider: CccProvider,
    base: UPDATE_TEST_FEED ?? UPDATE_REPO,
    testOrigin: UPDATE_TEST_FEED,
    open,
  } as Parameters<typeof autoUpdater.setFeedURL>[0])
  return new Updates(autoUpdater, { active: canUpdate(packaged, process.resourcesPath), testOrigin: UPDATE_TEST_FEED, onChange, betas })
}
