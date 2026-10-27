// The app menu (MIP2-1459). Electron's default menu has no Settings item, so
// ⌘, was the only way in and Alex couldn't find it. This keeps the default
// menus by role and adds Settings… (⌘,) in the app menu, where macOS apps
// put it.

import type { MenuItemConstructorOptions } from 'electron'

export function appMenuTemplate(appName: string, openSettings: () => void): MenuItemConstructorOptions[] {
  return [
    {
      label: appName,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { label: 'Settings…', accelerator: 'CmdOrCtrl+,', click: openSettings },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    { role: 'fileMenu' },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ]
}
