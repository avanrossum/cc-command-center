// electron-builder's afterPack hook for a release build (gate pass 20, L-5): runs on the packed app before anything is
// signed or notarized. The packaged reporter mod must hash to the hash built into the packaged main.cjs, which the app
// checks at start, or the app would refuse to start (MIP2-1560). A build that fails it stops here, before the
// notarization round trip. release.mjs checks the finished app the same way.

const { readFileSync } = require('node:fs')
const { join } = require('node:path')

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return
  const { embeddedModHash, modPackRefusal } = await import('./release-lib.mjs')
  const { modHashOf } = await import('./mod-hash.mjs')
  const resources = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
  const why = modPackRefusal(embeddedModHash(readFileSync(join(resources, 'app.asar'), 'latin1')), modHashOf(join(resources, 'app.asar.unpacked', 'dist', 'mod')))
  if (why) throw new Error(`release: ${why}`)
}
