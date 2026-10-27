// Right-click on a sidebar row opens the card's session menu (MIP2-1460).

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const src = (f: string) => readFileSync(new URL(`../src/renderer/components/${f}`, import.meta.url), 'utf8')

describe('the sidebar session menu', () => {
  it('opens the same SessionMenu on right-click, without a ⋯ in the row', () => {
    const sidebar = src('Sidebar.tsx')
    expect(sidebar).toMatch(/onContextMenu=\{ev => \(ev\.preventDefault\(\), setMenuFor\(/)
    expect(sidebar).toContain('<SessionMenu e={e} openSignal={menuFor.n} buttonless />')
    const menu = src('SessionMenu.tsx')
    expect(menu).toMatch(/if \(openSignal\) setOpen\('main'\)/)
    expect(menu).toMatch(/\{!buttonless && \(/)
  })
})
