// The app menu (MIP2-1459). Electron's default menu has no Settings item, so
// ⌘, was the only way in and Alex couldn't find it. This keeps the default
// menus by role and adds Settings… (⌘,) in the app menu, where macOS apps
// put it. Check for Updates… follows About when the build can update
// (MIP2-1517).

import type { MenuItemConstructorOptions } from 'electron'

export function appMenuTemplate(appName: string, openSettings: () => void, checkUpdates: (() => void) | null = null, quit: (() => void) | null = null): MenuItemConstructorOptions[] {
  return [
    {
      label: appName,
      submenu: [
        // Labeled with the shown name: Electron's defaults use app.name, which stays the internal one (MIP2-1532).
        { role: 'about', label: `About ${appName}` },
        ...(checkUpdates ? [{ label: 'Check for Updates…', click: checkUpdates }] : []),
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettings },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide', label: `Hide ${appName}` },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        // The app's own Quit asks about its sessions (MIP2-1528); only this item and ⌘Q do, never a Dock quit or a log out.
        quit ? { label: `Quit ${appName}`, accelerator: 'CmdOrCtrl+Q', click: quit } : { role: 'quit' },
      ],
    },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
}
