// Right-click on a sidebar row opens the card's session menu (MIP2-1460).

import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import { describe, expect, it } from 'vitest'
import { NeverMark } from '../src/renderer/components/SessionMenu.tsx'
import type { Entry } from '../src/renderer/model/fleet.ts'

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

describe('the never-roll-off mark in the sidebar (MIP2-1513)', () => {
  it("shows the card's ∞ on a row between the name and the age, only for a never-roll-off session", () => {
    expect(src('Sidebar.tsx')).toMatch(/\{e\.name\}<\/b>\s*\{\/\*[^*]*\*\/\}\s*<NeverMark e=\{e\} \/>\s*<span className="age">/)
    const mark = (neverRollOff: boolean) => renderToStaticMarkup(createElement(NeverMark, { e: { neverRollOff } as Entry }))
    expect(mark(true)).toBe('<span class="never" title="Never rolls off">∞</span>')
    expect(mark(false)).toBe('')
  })
})

describe('a category name opens Fleet filtered to it, from Fleet or Focus (MIP2-1514)', () => {
  it('filters on a click and on ⌥⌘1–9, and no longer opens the latest session from Focus', () => {
    expect(src('Sidebar.tsx')).toContain('onClick={() => onFilter(catFilter(cat))}')
    expect(src('Sidebar.tsx')).not.toMatch(/const latest = focused/)
    const app = src('App.tsx')
    expect(app).toMatch(/categoryKeyRef\.current = n => \{[\s\S]*?setFocused\(null\)\s*setFilter\(catFilter\(cat\)\)\s*\}/)
    // The sidebar's onFilter leaves Focus first.
    expect(app).toContain('onFilter={f => (setFocused(null), setFilter(f))}')
  })
})
