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
    expect(items.some(i => i.label === 'Check for Updates…')).toBe(false)
  })

  it('puts Check for Updates… after About when the build can update (MIP2-1517)', () => {
    let checked = 0
    const items = appMenuTemplate('App', () => {}, () => checked++)[0]!.submenu as { label?: string; role?: string; click?: () => void }[]
    expect(items[0]!.role).toBe('about')
    expect(items[1]!.label).toBe('Check for Updates…')
    items[1]!.click!()
    expect(checked).toBe(1)
  })
})
