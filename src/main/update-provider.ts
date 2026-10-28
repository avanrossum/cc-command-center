// electron-updater's provider for this app (MIP2-1469): the release comes
// from src/main/update-feed.ts, not GitHub's "latest" flag, which stays on
// 0.24's tombstone. Every request the updater makes, the zip and each of its
// redirects included, is limited to GitHub's hosts over HTTPS and capped in
// size. The update's code signature is checked by Squirrel.Mac, which
// electron-updater hands the zip to: SQRLUpdater's -verifyUpdate:fromBundle:
// checks the bundle against the running app's designated requirement
// (SQRLCodeSignature +currentApplicationSignature, SecStaticCodeCheckValidity
// with kSecCSCheckNestedCode | kSecCSStrictValidate) before installing it.

import type { IncomingMessage } from 'electron'
import type { RequestOptions } from 'node:http'
import type { UpdateInfo } from 'builder-util-runtime'
import { Provider, type AppUpdater, type ResolvedUpdateFileInfo } from 'electron-updater'
import type { ProviderRuntimeOptions } from 'electron-updater/out/providers/Provider'
import { parseUpdateInfo, resolveFiles } from 'electron-updater/out/providers/Provider'
import {
  allowedUrl,
  assetBase,
  boundedGet,
  candidates,
  CHANNEL_FILE,
  compareVersions,
  DOWNLOAD_MAX_BYTES,
  FEED_MAX_BYTES,
  feedTags,
  feedUrl,
  type Hop,
  YML_MAX_BYTES,
} from './update-feed.ts'

/** What setFeedURL passes the provider, beside `provider: 'custom'`. */
export interface CccFeedOptions {
  /** The repository, or the dry run's local stand-in. */
  base: string
  /** The dry run's local origin, allowed beside GitHub's hosts; null in a release build. */
  testOrigin: string | null
  /** One request, without following redirects (Electron's net in the app; a fake in tests). */
  open: (url: string) => Promise<Hop>
}

type Executor = { createRequest(options: RequestOptions & { redirect?: string }, callback: (response: IncomingMessage) => void): { abort(): void } }

function urlOf(o: RequestOptions): string {
  return `${o.protocol ?? 'https:'}//${o.hostname ?? o.host ?? ''}${o.port ? `:${o.port}` : ''}${o.path ?? '/'}`
}

/**
 * Puts the host check and the size cap on every request electron-updater's
 * executor makes. Each redirect hop is a new request (its
 * addRedirectHandlers aborts and starts another), so each is checked.
 */
export function guardExecutor(executor: Executor, testOrigin: string | null): void {
  const create = executor.createRequest.bind(executor)
  executor.createRequest = (options, callback) => {
    const url = urlOf(options)
    if (!allowedUrl(url, testOrigin)) throw new Error(`refused a request to ${url.split('/').slice(0, 3).join('/')}: only GitHub's hosts over HTTPS`)
    const request = create({ ...options, redirect: 'manual' }, response => {
      const length = Number(response.headers['content-length'])
      let size = 0
      const over = () => request.abort()
      if (Number.isFinite(length) && length > DOWNLOAD_MAX_BYTES) over()
      else
        response.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > DOWNLOAD_MAX_BYTES) over()
        })
      callback(response)
    })
    return request
  }
}

export class CccProvider extends Provider<UpdateInfo> {
  private tagBase: string | null = null

  constructor(
    private readonly options: CccFeedOptions,
    private readonly updater: AppUpdater,
    runtimeOptions: ProviderRuntimeOptions,
  ) {
    super(runtimeOptions)
    guardExecutor(this.executor as unknown as Executor, options.testOrigin)
  }

  async getLatestVersion(): Promise<UpdateInfo> {
    const { base, open, testOrigin } = this.options
    const current = this.updater.currentVersion.version
    const xml = await boundedGet(feedUrl(base), FEED_MAX_BYTES, open, testOrigin)
    if (xml === null) throw new Error(`no releases feed at ${feedUrl(base)}`)
    for (const tag of candidates(feedTags(xml), current, this.updater.allowPrerelease)) {
      const url = `${assetBase(base, tag)}${CHANNEL_FILE}`
      const yml = await boundedGet(url, YML_MAX_BYTES, open, testOrigin)
      if (yml === null) continue // a release without ccc-mac.yml, such as 0.24's
      const info = parseUpdateInfo(yml, CHANNEL_FILE, new URL(url))
      if (compareVersions(info.version, tag) !== 0) throw new Error(`${tag}'s ${CHANNEL_FILE} names version ${info.version}`)
      this.tagBase = assetBase(base, tag)
      return info
    }
    // Nothing newer: electron-updater compares versions and reports none available.
    this.tagBase = null
    return { version: current, files: [], path: '', sha512: '', releaseDate: new Date(0).toISOString() }
  }

  resolveFiles(info: UpdateInfo): ResolvedUpdateFileInfo[] {
    if (this.tagBase === null) throw new Error('no release was found to download')
    const base = new URL(this.tagBase)
    const files = resolveFiles(info, base)
    for (const f of files) {
      if (f.url.origin !== base.origin || !f.url.pathname.startsWith(base.pathname)) throw new Error(`${CHANNEL_FILE} points outside its release: ${f.url.origin}${f.url.pathname}`)
    }
    return files
  }
}
