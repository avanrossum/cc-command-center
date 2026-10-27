// The release check for gate H-2 (MIP2-1429): reads the fuse wire from a
// built app and fails on any fuse not as scripts/fuses.mjs requires.
//
//   node scripts/check-fuses.mjs "release/mac-arm64/CC Command Center App.app"

import { getCurrentFuseWire } from '@electron/fuses'
import { wrongFuses } from './fuses.mjs'

const app = process.argv[2]
if (!app) throw new Error('usage: node scripts/check-fuses.mjs <path to .app>')
const wire = await getCurrentFuseWire(app)
const wrong = wrongFuses(wire)
if (wrong.length) {
  console.error(`Fuse check failed for ${app}:\n  ${wrong.join('\n  ')}`)
  process.exit(1)
}
console.log(`Fuse check passed for ${app}.`)
