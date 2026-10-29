// The app's name (MIP2-1532, Research MIP2-1531). Two names, kept apart:
// - APP_NAME, "CC Command Center App": what Electron calls the app. It names
//   the safeStorage Keychain item ("<name> Safe Storage") and, with it, every
//   stored key (the Arbiter key, the Console key, the D-027 reply keys), and
//   the crash-dump and log folders. A different name can't decrypt them.
// - DISPLAY_NAME, "CC Command Center": what Alex sees. Finder, the Dock and
//   the switcher take it from the bundle's localized InfoPlist.strings
//   (LSHasLocalizedDisplayName); the menus and the About panel are set to it.
//
// Electron reads the name for the Keychain item after the main script's top
// level, so pinning it there holds; after `ready` it doesn't (Research,
// MIP2-1531, N1 B and C).

export const APP_NAME = 'CC Command Center App'
export const DISPLAY_NAME = 'CC Command Center'

/**
 * The name to pin, or null to leave it. A build named as the app, or one
 * whose productName was edited to the shown name, runs as APP_NAME, so it
 * never takes 0.24's "CC Command Center Safe Storage" item. A test build with
 * a name of its own (the dry run, a folder build) keeps it, and its own item
 * (MIP2-1404).
 */
export function nameToPin(current: string): string | null {
  return current === APP_NAME || current === DISPLAY_NAME ? APP_NAME : null
}
