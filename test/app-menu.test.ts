// Settings… in the app menu (MIP2-1459).

import { describe, expect, it } from 'vitest'
import { appMenuTemplate } from '../src/main/app-menu.ts'

describe('appMenuTemplate', () => {
  it('puts Settings… (⌘,) in the app menu, and keeps the standard menus by role', () => {
    let opened = 0
    const t = appMenuTemplate('CC Command Center App', () => opened++)
    const app = t[0]!
    expect(app.label).toBe('CC Command Center App')
    const items = app.submenu as { label?: string; accelerator?: string; role?: string; click?: () => void }[]
    const settings = items.find(i => i.label === 'Settings…')!
    expect(settings.accelerator).toBe('CmdOrCtrl+,')
    settings.click!()
    expect(opened).toBe(1)
    expect(items.map(i => i.role).filter(Boolean)).toEqual(['about', 'services', 'hide', 'hideOthers', 'unhide', 'quit'])
    expect(t.slice(1).map(m => m.role)).toEqual(['fileMenu', 'editMenu', 'viewMenu', 'windowMenu'])
  })
})
