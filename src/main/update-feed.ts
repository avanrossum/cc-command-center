// Which release the app updates to (MIP2-1469; release plan §3). Stock
// electron-updater reads GitHub's "latest" release, and that stays on 0.24's
// tombstone, since every release of this app is published with
// --latest=false. So the app reads the public releases.atom itself and takes
// the newest semver tag above its own version whose release carries
// ccc-mac.yml. Kept free of Electron so it's tested against recorded feeds.

/** The public repository the app updates from. */
export const UPDATE_REPO = 'https://github.com/avanrossum/cc-command-center'
/** The update file a `ccc` channel build publishes; 0.24 reads latest-mac.yml. */
export const CHANNEL_FILE = 'ccc-mac.yml'

/** GitHub's own hosts: the site, and the CDN its release downloads redirect to. */
const GITHUB_HOSTS = new Set(['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])

/** The most the feed and the update file may be; a larger response is cut off and refused. */
export const FEED_MAX_BYTES = 1024 * 1024
export const YML_MAX_BYTES = 64 * 1024
/** The most an update's zip may be. */
export const DOWNLOAD_MAX_BYTES = 600 * 1024 * 1024
/** How many tags above the running version are tried for a ccc-mac.yml before giving up. */
export const MAX_CANDIDATES = 5

type Version = [number, number, number, string | null]

function parse(v: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? null] : null
}

/** Semver order, prereleases below their release; null when either isn't semver. */
export function compareVersions(a: string, b: string): number | null {
  const x = parse(a)
  const y = parse(b)
  if (!x || !y) return null
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] as number) - (y[i] as number)
  if (x[3] === y[3]) return 0
  if (x[3] === null) return 1
  if (y[3] === null) return -1
  return x[3] < y[3] ? -1 : 1
}

/** The release tags in a releases.atom feed, in feed order. */
export function feedTags(xml: string): string[] {
  const tags: string[] = []
  for (const m of xml.matchAll(/<link[^>]*href="https:\/\/github\.com\/[^"/]+\/[^"/]+\/releases\/tag\/([^"]+)"/g)) {
    const tag = decodeURIComponent(m[1] as string)
    if (!tags.includes(tag)) tags.push(tag)
  }
  return tags
}

/**
 * The tags worth trying, newest first: semver, above the running version
 * (never a downgrade), and no prereleases unless `allowPrerelease`.
 */
export function candidates(tags: string[], current: string, allowPrerelease: boolean): string[] {
  return tags
    .filter(t => parse(t) !== null && (allowPrerelease || parse(t)?.[3] === null) && (compareVersions(t, current) ?? 0) > 0)
    .sort((a, b) => compareVersions(b, a) ?? 0)
    .slice(0, MAX_CANDIDATES)
}

/** The feed's URL, and where a tag's assets are. `base` is the repository, or the dry run's local stand-in. */
export const feedUrl = (base: string) => `${base}/releases.atom`
export const assetBase = (base: string, tag: string) => `${base}/releases/download/${encodeURIComponent(tag)}/`

/**
 * Whether the updater may request this URL: HTTPS to GitHub's hosts, or the
 * dry run's local origin when a test build names one. Applied to every
 * request and every redirect hop.
 */
export function allowedUrl(url: string, testOrigin: string | null = null): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (testOrigin !== null && u.origin === testOrigin) return true
  return u.protocol === 'https:' && u.port === '' && u.username === '' && u.password === '' && GITHUB_HOSTS.has(u.hostname)
}

/** One request's outcome: a redirect to follow, or a response to read. */
export type Hop =
  | { kind: 'redirect'; status: number; location: string }
  | { kind: 'response'; status: number; length: number | null; body: AsyncIterable<Uint8Array>; cancel: () => void }

/** The most redirects followed for one request. */
const MAX_HOPS = 5

/**
 * A GET of the feed or the update file, following redirects by hand so
 * every hop is checked against `allowedUrl`, and reading at most `cap`
 * bytes. Resolves to null on 404, the "no such file" answer a release
 * without ccc-mac.yml gives.
 */
export async function boundedGet(url: string, cap: number, open: (url: string) => Promise<Hop>, testOrigin: string | null = null): Promise<string | null> {
  let at = url
  for (let hops = 0; ; hops++) {
    if (!allowedUrl(at, testOrigin)) throw new Error(`refused a request to ${new URL(at).origin}: only GitHub's hosts over HTTPS`)
    const hop = await open(at)
    if (hop.kind === 'redirect') {
      if (hops >= MAX_HOPS) throw new Error(`too many redirects from ${url}`)
      at = new URL(hop.location, at).toString()
      continue
    }
    if (hop.status === 404) {
      hop.cancel()
      return null
    }
    if (hop.status !== 200) {
      hop.cancel()
      throw new Error(`${url} answered ${hop.status}`)
    }
    if (hop.length !== null && hop.length > cap) {
      hop.cancel()
      throw new Error(`${url} is ${hop.length} bytes, over the ${cap}-byte cap`)
    }
    const chunks: Uint8Array[] = []
    let size = 0
    for await (const chunk of hop.body) {
      size += chunk.byteLength
      if (size > cap) {
        hop.cancel()
        throw new Error(`${url} is over the ${cap}-byte cap`)
      }
      chunks.push(chunk)
    }
    return Buffer.concat(chunks).toString('utf8')
  }
}
