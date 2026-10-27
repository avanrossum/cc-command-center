// The Electron fuses a packaged build must have (gate H-2, MIP2-1429).
// Defaults let any process running as Alex take the main process with
// --inspect, NODE_OPTIONS or ELECTRON_RUN_AS_NODE, and with it every card
// approval, relayed prompt and the Arbiter key. electron-builder flips them
// (package.json build.electronFuses) before signing; check-fuses.mjs reads
// them back from the built binary.

/** Fuse index in the V1 wire (@electron/fuses FuseV1Options) → the state required, and its electron-builder key. */
export const REQUIRED_FUSES = [
  { index: 0, name: 'RunAsNode', key: 'runAsNode', on: false },
  { index: 1, name: 'EnableCookieEncryption', key: 'enableCookieEncryption', on: true },
  { index: 2, name: 'EnableNodeOptionsEnvironmentVariable', key: 'enableNodeOptionsEnvironmentVariable', on: false },
  { index: 3, name: 'EnableNodeCliInspectArguments', key: 'enableNodeCliInspectArguments', on: false },
  { index: 4, name: 'EnableEmbeddedAsarIntegrityValidation', key: 'enableEmbeddedAsarIntegrityValidation', on: true },
  { index: 5, name: 'OnlyLoadAppFromAsar', key: 'onlyLoadAppFromAsar', on: true },
  { index: 7, name: 'GrantFileProtocolExtraPrivileges', key: 'grantFileProtocolExtraPrivileges', on: false },
]

/** The fuses that differ from what's required, given a wire read by @electron/fuses (49 on, 48 off). */
export function wrongFuses(wire) {
  return REQUIRED_FUSES.filter(f => wire[f.index] !== (f.on ? 49 : 48)).map(f => `${f.name} should be ${f.on ? 'on' : 'off'}`)
}
