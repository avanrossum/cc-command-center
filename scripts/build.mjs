// Builds the app: main.cjs and preload.cjs for Electron's main and preload
// contexts, renderer/ with the page, its script and styles, and mod/ with the
// reporter mod the app passes to `--plugin-dir`. The workspace packages are
// bundled from their TypeScript source.
//
//   npm run build                     into dist/
//   npm run build -- --outdir <path>  into <path>, runnable with
//                                     node_modules/electron/dist/Electron.app/Contents/MacOS/Electron <path>
//                                     (MIP2-1408: QA builds without writing this repo)

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'
import { build } from 'esbuild'
import { modHashOf } from './mod-hash.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const flag = process.argv.indexOf('--outdir')
const out = flag > 0 ? resolve(process.argv[flag + 1] ?? '') : resolve(ROOT, 'dist')
const outsideRepo = relative(ROOT, out).startsWith('..') || isAbsolute(relative(ROOT, out))
if (flag > 0 && !process.argv[flag + 1]) throw new Error('--outdir needs a path')
if (out === ROOT || ROOT.startsWith(out + '/')) throw new Error('--outdir must not contain the repo')

rmSync(out, { recursive: true, force: true })
mkdirSync(`${out}/renderer`, { recursive: true })

const common = { bundle: true, sourcemap: true, logLevel: 'warning', absWorkingDir: ROOT }

// The build identity for the settings window's About (MIP2-1424): the short
// commit, marked -dirty when the tree had uncommitted changes, and the date.
function gitCommit() {
  try {
    const sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: ROOT, encoding: 'utf8' }).trim() !== ''
    return dirty ? `${sha}-dirty` : sha
  } catch {
    return 'unknown'
  }
}
const BUILD = { commit: gitCommit(), builtAt: new Date().toISOString() }

// A dry-run build's local stand-in for the release repository (MIP2-1469).
// The release script refuses to build with it set.
const UPDATE_TEST_FEED = process.env.CCC_UPDATE_TEST_FEED || null
if (UPDATE_TEST_FEED && !/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(UPDATE_TEST_FEED)) throw new Error('CCC_UPDATE_TEST_FEED must be http://127.0.0.1:<port>')

// The reporter mod beside the build: its manifest and hooks, not the types
// the engine lays down on load.
mkdirSync(`${out}/mod/.claude-plugin`, { recursive: true })
cpSync(`${ROOT}/mod/.claude-plugin/plugin.json`, `${out}/mod/.claude-plugin/plugin.json`)
cpSync(`${ROOT}/mod/hooks`, `${out}/mod/hooks`, { recursive: true })

// The mod's hash, embedded in main.cjs inside the integrity-checked asar: the
// packaged app refuses an unpacked mod that doesn't match it (gate run 2, M-3).
const MOD_HASH = modHashOf(`${out}/mod`)
if (!/^[0-9a-f]{16}$/.test(MOD_HASH)) throw new Error(`the reporter mod can't be hashed: ${MOD_HASH}`)

await Promise.all([
  build({
    ...common,
    entryPoints: ['src/main/index.ts'],
    outfile: `${out}/main.cjs`,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    // node-pty is a native module; it stays in node_modules.
    external: ['electron', 'node-pty'],
    define: { __CCC_BUILD__: JSON.stringify(BUILD), __CCC_MOD_HASH__: JSON.stringify(MOD_HASH), __CCC_UPDATE_TEST_FEED__: JSON.stringify(UPDATE_TEST_FEED) },
  }),
  build({
    ...common,
    entryPoints: ['src/preload/index.ts'],
    outfile: `${out}/preload.cjs`,
    platform: 'node',
    // A sandboxed preload is CommonJS and may require only `electron`.
    format: 'cjs',
    target: 'node22',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: ['src/renderer/main.tsx'],
    outfile: `${out}/renderer/renderer.js`,
    platform: 'browser',
    format: 'iife',
    target: 'chrome130',
    jsx: 'automatic',
    define: { 'process.env.NODE_ENV': '"production"' },
  }),
])

cpSync(`${ROOT}/src/renderer/index.html`, `${out}/renderer/index.html`)
cpSync(`${ROOT}/src/renderer/styles/tokens.css`, `${out}/renderer/tokens.css`)
cpSync(`${ROOT}/src/renderer/styles/app.css`, `${out}/renderer/app.css`)
cpSync(`${ROOT}/node_modules/@xterm/xterm/css/xterm.css`, `${out}/renderer/xterm.css`)


if (outsideRepo) {
  // Electron needs a package.json to start from the folder, and main.cjs
  // finds node-pty (native, not bundled) through node_modules.
  // The app's version, so About and app.getVersion() don't fall back to Electron's (MIP2-1433, QA). No
  // productName: the build keeps its own name, and with it its own Keychain item (MIP2-1404).
  const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, 'utf8'))
  writeFileSync(`${out}/package.json`, JSON.stringify({ name: 'cc-command-center-build', version: pkg.version, private: true, main: 'main.cjs' }, null, 2))
  if (!existsSync(`${out}/node_modules`)) symlinkSync(`${ROOT}/node_modules`, `${out}/node_modules`)
}
