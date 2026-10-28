// The release script's checks (docs/release-plan.md §2–§5), kept pure so they're tested.

/** The public repository: releases, the update feed, and the snapshots (pass 11, L-5). */
export const PUBLIC_REPO = 'avanrossum/cc-command-center'

/** Semver as [major, minor, patch, prerelease], or null. A prerelease sorts below its release. */
export function parseVersion(tag) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(tag)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3]), m[4] ?? null] : null
}

/** a > b, by semver. */
export function newerThan(a, b) {
  const x = parseVersion(a)
  const y = parseVersion(b)
  if (!x || !y) return false
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]
  if (x[3] === y[3]) return false
  if (x[3] === null) return true
  if (y[3] === null) return false
  return comparePrerelease(x[3], y[3]) > 0
}

/** Prerelease order (semver §11): numeric identifiers as numbers, below alphanumeric ones; beta.2 < beta.10 (MIP2-1497). */
export function comparePrerelease(a, b) {
  const x = a.split('.')
  const y = b.split('.')
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] === y[i]) continue
    const xn = /^\d+$/.test(x[i])
    const yn = /^\d+$/.test(y[i])
    if (xn && yn) return Number(x[i]) - Number(y[i])
    if (xn) return -1
    if (yn) return 1
    return x[i] < y[i] ? -1 : 1
  }
  return x.length - y.length
}

/**
 * Why `tag` can't go to the public repository yet, or null (§3). Beta 0.24
 * builds take the newest semver tag in releases.atom, drafts and bare tags
 * included, so until the farewell release (the tombstone) has reached them
 * no newer tag of any kind may exist. The window is closed by hand, in
 * scripts/release-window.json.
 */
export function windowRefusal(tag, window) {
  if (!window?.tombstone) return 'scripts/release-window.json names no tombstone tag yet'
  if (window.closed) return null
  if (tag === window.tombstone) return null
  return newerThan(tag, window.tombstone) || !parseVersion(tag)
    ? `${tag} would be newer than the tombstone ${window.tombstone}, and the beta window is still open; close it by hand in scripts/release-window.json once the close users have the tombstone`
    : null
}

/** The first version of this app; every 0.24 tag, the tombstone included, is below it. */
export const FIRST_VERSION = '1.0.0'

/**
 * Why `tag` can't be a release of this app, or null (MIP2-1469 ruling): it
 * must be semver, at least 1.0.0, and above the tombstone once one is named,
 * so the updater never mistakes a 0.24 tag for a newer release.
 */
export function versionRefusal(tag, tombstone) {
  if (!parseVersion(tag)) return `${tag} is not a semver tag`
  if (newerThan(`v${FIRST_VERSION}`, tag)) return `${tag} is below ${FIRST_VERSION}, among 0.24's versions`
  if (tombstone && !newerThan(tag, tombstone)) return `${tag} is not above the tombstone ${tombstone}`
  return null
}

/**
 * The `gh release create` arguments. Every release is made with
 * `--latest=false`, so GitHub's "latest", which stable 0.24 builds follow,
 * stays on the tombstone (§3). A dry run is always a draft.
 */
export function releaseArgs({ tag, repo, title, notesFile, files, draft, target = null, prerelease = false }) {
  const args = ['release', 'create', tag, '--repo', repo, '--title', title, '--notes-file', notesFile, '--latest=false']
  // A beta is a GitHub prerelease, and like every release never "latest" (MIP2-1497).
  if (prerelease) args.push('--prerelease')
  // The tag is made on the public snapshot commit that holds this source, not on the remote's default branch (pass 9, M-2).
  if (target) args.push('--target', target)
  if (draft) args.push('--draft')
  return [...args, ...files]
}

/** Refuses release arguments without `--latest=false` (§3). */
export function latestFalseRefusal(args) {
  return args.includes('--latest=false') && !args.some(a => a === '--latest' || a === '--latest=true') ? null : 'every release must be created with --latest=false'
}

/** The update file a `ccc` channel build must carry, and refuses 0.24's (§3). */
export function updateFileRefusal(files) {
  if (files.includes('latest-mac.yml')) return 'the build wrote latest-mac.yml, which 0.24 reads; only ccc-mac.yml may be published'
  if (!files.includes('ccc-mac.yml')) return 'the build wrote no ccc-mac.yml'
  return null
}

/** The TeamIdentifier from `codesign -dv` output, or null (ad hoc or unsigned). */
export function teamOf(codesignOutput) {
  const t = /^TeamIdentifier=(.+)$/m.exec(codesignOutput)?.[1]?.trim()
  return t && t !== 'not set' ? t : null
}

/**
 * Why the signed binaries don't match, or null (§2, gate run 2, M-3): the
 * app and every native binary loaded into it carry the same Team ID, so
 * library validation refuses a replaced pty.node. Ad hoc builds have none.
 */
export function teamRefusal(appTeam, binaries, adhoc) {
  if (adhoc) return null
  if (!appTeam) return 'the app has no Team ID: it was not signed with a Developer ID'
  // No pty.node found means the walk missed it, not that it's safe (pass 9, L-4).
  if (!binaries.some(b => b.path.endsWith('pty.node'))) return 'no pty.node among the native binaries: the Team ID check found nothing to check'
  const off = binaries.filter(b => b.team !== appTeam).map(b => `${b.path} (${b.team ?? 'none'})`)
  return off.length ? `not signed with the app's Team ID ${appTeam}: ${off.join(', ')}` : null
}

/**
 * Why the app's app-update.yml won't do, or null (MIP2-1469): electron-updater
 * reads its updaterCacheDirName when Download is pressed, and fails with
 * ENOENT without the file, which a `--mac dir` build doesn't write.
 */
export function updateConfigRefusal(text) {
  if (text === null) return 'the app has no Contents/Resources/app-update.yml, so Download would fail'
  if (!/^updaterCacheDirName: \S+$/m.test(text)) return 'app-update.yml names no updaterCacheDirName'
  if (!/^channel: ccc$/m.test(text)) return 'app-update.yml is not on the ccc channel'
  return null
}

/** Why the assets to upload aren't this version's alone, or null: every dmg, zip and blockmap names the version. */
export function assetRefusal(names, version) {
  const other = names.filter(n => n !== 'ccc-mac.yml' && !n.includes(`-${version}-`))
  if (other.length) return `not from this ${version} build: ${other.join(', ')}`
  if (!names.some(n => n.endsWith('.dmg')) || !names.some(n => n.endsWith('.zip'))) return 'the build made no dmg or no zip'
  return null
}

/** The certificate-type prefixes electron-builder 26 refuses in an identity name (app-builder-lib, macCodeSign.js, appleCertificatePrefixes). */
const CERT_PREFIXES = ['Developer ID Application:', 'Developer ID Installer:', '3rd Party Mac Developer Application:', '3rd Party Mac Developer Installer:']

/**
 * Why CSC_NAME won't sign, or null. electron-builder throws "Please remove
 * prefix" for a name starting with a certificate type, after the whole
 * build has run, so the script refuses it first and prints the name to use.
 */
export function identityRefusal(name) {
  const trimmed = name.trim()
  const prefix = CERT_PREFIXES.find(p => trimmed.startsWith(p))
  if (!prefix) return null
  return `CSC_NAME must not start with "${prefix}"; electron-builder refuses it. Use CSC_NAME="${trimmed.slice(prefix.length).trim()}"`
}

/** The production app's bundle identifier; dry-run test builds use their own (pass 9, M-1). */
export const APP_ID = 'com.mipyip.cc-command-center-app'

/** Why the built app isn't the production app, or null: its bundle identifier must be APP_ID. */
export function bundleIdRefusal(id) {
  return id === APP_ID ? null : `the app's bundle identifier is ${id}, not ${APP_ID}`
}

/**
 * Why the built app.asar is a dry-run test build, or null (pass 9, M-1): a
 * test build carries its local feed, `"http://127.0.0.1:<port>"`, as a
 * string. A release build has none.
 */
export function testFeedRefusal(asarText) {
  const m = /"http:\/\/127\.0\.0\.1:\d+"/.exec(asarText)
  return m ? `the app carries the test feed ${m[0]}: it's a dry-run test build` : null
}

/**
 * Ignored files a build may leave or read without them being source: build
 * output, installed dependencies (reinstalled with npm ci first), Finder's
 * .DS_Store and Claude Code's edit records.
 */
const IGNORED_OK = [/^node_modules\//, /^dist\//, /^out\//, /^release\//, /^scratch\//, /^mod\/\.claude-plugin\/types\//, /(^|\/)\.DS_Store$/, /(^|\/)\.claude\/\.cc-writes\//, /(^|\/)__pycache__\//, /^\.claude\/settings\.local\.json$/]

/**
 * Why the checkout holds files the commit doesn't, or null (pass 9, M-2;
 * pass 10, L-1): any untracked file, and any ignored file outside
 * IGNORED_OK. Input: `git status --porcelain --untracked-files=all --ignored=matching`.
 */
export function untrackedRefusal(porcelain) {
  const lines = porcelain.split('\n')
  const untracked = lines.filter(l => l.startsWith('?? ')).map(l => l.slice(3))
  const ignored = lines.filter(l => l.startsWith('!! ')).map(l => l.slice(3)).filter(f => !IGNORED_OK.some(re => re.test(f)))
  const found = [...untracked, ...ignored]
  return found.length ? `files in the checkout that aren't in the commit: ${found.join(', ')}` : null
}

/** A real release is made from main only (pass 9, M-2). */
export function branchRefusal(branch) {
  return branch === 'main' ? null : `a real release is made from main, not ${branch}`
}

/**
 * Why `target` can't carry the tag, or null (pass 9, M-2; MIP2-1472). It must be the public repository's main, already pushed, and
 * its tree must be this commit's snapshot tree (HEAD minus
 * scripts/snapshot-exclude.txt), so the tag names exactly the source that
 * was built.
 */
export function targetRefusal({ target, mainSha, targetTree, expectedTree }) {
  if (!/^[0-9a-f]{40}$/.test(target ?? '')) return 'a real release needs --target <the public snapshot commit, 40 hex characters>'
  if (target !== mainSha) return `--target ${target.slice(0, 7)} is not the public main (${(mainSha ?? 'none').slice(0, 7)}); push the snapshot first`
  if (targetTree !== expectedTree) return `the public commit's tree ${(targetTree ?? 'none').slice(0, 7)} isn't this commit's snapshot tree ${expectedTree.slice(0, 7)}; make the snapshot from this commit`
  return null
}

/**
 * Why the tag can't be made, or null: refs are GitHub's
 * `git/matching-refs/tags/<tag>` answer. A tag already there must point at
 * `target`; gh would otherwise release from wherever it points (pass 9, M-2).
 */
export function remoteTagRefusal(refs, tag, target) {
  const ref = refs.find(r => r.ref === `refs/tags/${tag}`)
  if (!ref) return null
  if (ref.object?.type === 'commit' && ref.object.sha === target) return null
  return `${tag} already exists on the remote at ${String(ref.object?.sha).slice(0, 7)} (${ref.object?.type}), not ${target.slice(0, 7)}`
}

/**
 * electron-builder's overrides for a release build. app-update.yml's owner
 * and repository aren't read by the app (it always updates from the public
 * repository), so a --build-only run, which has no --repo, takes the public
 * one, the right value for a distributable image (pass 10, M-3).
 */
export function builderConfig({ identity, adhoc, repo }) {
  const [owner, name] = (repo ?? PUBLIC_REPO).split('/')
  return [
    `-c.mac.identity=${adhoc ? '-' : identity}`,
    `-c.mac.hardenedRuntime=${adhoc ? 'false' : 'true'}`,
    '-c.mac.entitlements=build/entitlements.mac.plist',
    '-c.mac.entitlementsInherit=build/entitlements.mac.plist',
    `-c.mac.notarize=${adhoc ? 'false' : 'true'}`,
    '-c.publish.provider=github',
    `-c.publish.owner=${owner}`,
    `-c.publish.repo=${name}`,
    '-c.publish.channel=ccc',
    // npm run setup already rebuilt node-pty under the allowlisted environment; electron-builder's own
    // rebuild would run node-gyp with the signing credentials if its skip marker ever missed (pass 13, M-1).
    '-c.npmRebuild=false',
  ]
}

/**
 * The environment for the steps that run dependency code before signing:
 * npm ci, npm run setup and npm run build (pass 11, L-2; pass 12, M-2). An
 * allowlist: the shell basics, the locale, npm's and Node's own settings,
 * Electron's download settings, the proxy and certificate setup, and the
 * Xcode selection the native rebuild uses. Signing, notarization and
 * GitHub credentials, and anything else, are left out. This is the
 * environment only: credentials in the login keychain, such as a `gh` login
 * or a notarytool profile, stay reachable to the same user, as does
 * ~/.npmrc (release plan §2).
 *
 * npm's settings are named one by one, not by prefix, so a new credential
 * setting such as `npm_config_key` (a TLS client key) isn't admitted by
 * default (pass 14, L-1). A URL value loses any user and password in it, so
 * proxy and registry credentials don't reach install scripts; a release
 * can't use a proxy that needs them.
 */
const INSTALL_ENV = new Set([
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'TERM', 'LANG',
  'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'DEVELOPER_DIR', 'SDKROOT',
  // npm and node-gyp: the cache, the registry and proxy, certificates, and the native build's target.
  'npm_config_cache', 'npm_config_registry', 'npm_config_proxy', 'npm_config_https_proxy', 'npm_config_noproxy', 'npm_config_cafile', 'npm_config_strict_ssl',
  'npm_config_loglevel', 'npm_config_arch', 'npm_config_target_arch', 'npm_config_target', 'npm_config_runtime', 'npm_config_disturl', 'npm_config_build_from_source',
])
const INSTALL_ENV_PREFIXES = ['LC_', 'NODE_', 'ELECTRON_']

/** Token-shaped names the prefixes would otherwise admit: NODE_AUTH_TOKEN (pass 13, L-1), and any *_KEY. */
const TOKEN_SHAPED = /(_AUTH|_TOKEN|_PASSWORD|_SECRET|authToken|_auth|_KEY$)/i

/** `value` without a user or password, when it's a URL that has one. */
function withoutUserinfo(value) {
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return value
  try {
    const u = new URL(value)
    if (!u.username && !u.password) return value
    u.username = ''
    u.password = ''
    return u.toString()
  } catch {
    // Not a URL after all; it can't be checked for credentials, so it's left out.
    return null
  }
}

export function installEnv(env) {
  return Object.fromEntries(
    Object.entries(env)
      .filter(([k]) => (INSTALL_ENV.has(k) || INSTALL_ENV_PREFIXES.some(p => k.startsWith(p))) && !TOKEN_SHAPED.test(k))
      .map(([k, v]) => [k, typeof v === 'string' ? withoutUserinfo(v) : v])
      .filter(([, v]) => v !== null),
  )
}

/**
 * Why the version and the mode don't agree, or null (MIP2-1497): --prerelease
 * publishes only an `X.Y.Z-beta.N` version, and a release only a plain one.
 */
export function prereleaseRefusal(version, prerelease) {
  const beta = /^\d+\.\d+\.\d+-beta\.\d+$/.test(version)
  if (prerelease && !beta) return `--prerelease publishes a beta version (X.Y.Z-beta.N), not ${version}`
  if (!prerelease && /-/.test(version)) return `${version} is a prerelease; publish it with --prerelease`
  return null
}
