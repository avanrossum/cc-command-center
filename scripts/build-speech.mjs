// Compile the ccc-speech helper (native/ccc-speech) into native/ccc-speech/ccc-speech.
//
// Runs before packaging so electron-builder can copy it into Contents/Resources,
// where @electron/osx-sign signs it along with every other Mach-O in the bundle.
//
// Non-fatal by design. A machine without Xcode can still build and run the app —
// the Apple speech engine simply reports itself unavailable and the Whisper engine
// (or system dictation) carries the feature. Failing the whole build over an
// optional engine would be the wrong trade.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const dir = join(root, 'native', 'ccc-speech')
const src = join(dir, 'main.swift')
const out = join(dir, 'ccc-speech')

// Pinned, NOT inherited from the build machine. A plain swiftc run on a macOS 26
// host stamps minos 26.x; the app declares LSMinimumSystemVersion 12.0, so an
// unpinned binary would be refused by dyld on every older Mac. The Speech API here
// is 26+ regardless, and the app gates on that at runtime — this pin exists so the
// binary LOADS everywhere and reports "unavailable" rather than failing to launch.
const TARGET = 'arm64-apple-macos26.0'

if (!existsSync(src)) {
  console.warn('[speech] no main.swift; skipping')
  process.exit(0)
}
try {
  execFileSync('xcrun', ['--find', 'swiftc'], { stdio: 'ignore' })
} catch {
  console.warn('[speech] no Swift toolchain on this machine; skipping (engine will report unavailable)')
  process.exit(0)
}
try {
  mkdirSync(dir, { recursive: true })
  execFileSync(
    'xcrun',
    ['swiftc', '-O', '-parse-as-library', '-target', TARGET, '-o', out, src],
    { stdio: 'inherit' },
  )
  const info = execFileSync('vtool', ['-show-build-version', out], { encoding: 'utf8' })
  const minos = /minos (\S+)/.exec(info)?.[1]
  console.log(`[speech] built ccc-speech (minos ${minos ?? '?'})`)
} catch (e) {
  console.warn('[speech] build failed; continuing without the Apple engine:', e.message)
}
