// Every failing security alert shows at once, by consequence (gate run 3, M-4).

import type { SelfCheckReport } from '@ccc/contract'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { failingSecurity, SecurityBands, SecurityStrip } from '../src/renderer/components/SelfCheckBand.tsx'

const report = (failing: string[]): SelfCheckReport => ({
  claudeVersion: '2.1.311',
  state: 'passed',
  controlOff: [],
  checkedAt: 1,
  checks: ['channel-sockets', 'mod-integrity', 'mod-reload'].map(id => ({ id, label: id, state: failing.includes(id) ? 'fail' : 'pass', detail: failing.includes(id) ? `detail of ${id}` : null })),
})

describe('SecurityBands', () => {
  it("shows a changed mod's alert even when a session also reports reloading, and the changed mod first", () => {
    const html = renderToStaticMarkup(<SecurityBands report={report(['mod-reload', 'mod-integrity'])} />)
    expect(html).toContain('detail of mod-integrity')
    expect(html).toContain('detail of mod-reload')
    expect(html.indexOf('mod-integrity')).toBeLessThan(html.indexOf('mod-reload'))
  })

  it('says resuming re-keys, not that it gives a fresh channel', () => {
    const html = renderToStaticMarkup(<SecurityBands report={report(['channel-sockets'])} />)
    expect(html).toContain('gives its channel a new secret first')
    expect(html).not.toContain('fresh channel')
  })

  it('shows nothing when every check passes', () => {
    expect(renderToStaticMarkup(<SecurityBands report={report([])} />)).toBe('')
  })
})

describe("Focus's security strip (spec MIP2-1379 §7.3)", () => {
  const strip = (failing: string[]) => renderToStaticMarkup(<SecurityStrip report={report(failing)} onFocusBack={() => {}} />)

  it('shows one alert line per failing item, in the same order and with the same titles as Fleet', () => {
    const html = strip(['mod-reload', 'mod-integrity', 'channel-sockets'])
    expect(html.match(/role="alert"/g)).toHaveLength(3)
    const titles = failingSecurity(report(['mod-reload', 'mod-integrity', 'channel-sockets'])).map(a => a.title)
    let at = -1
    for (const t of titles) {
      const i = html.indexOf(t.replace(/'/g, '&#x27;'))
      expect(i, t).toBeGreaterThan(at)
      at = i
    }
    // Details on the first line only, and nothing that dismisses it.
    expect(html.match(/>Details</g)).toHaveLength(1)
    expect(html).not.toMatch(/Dismiss|Close|×/)
  })

  it('shows nothing when every check passes', () => {
    expect(strip([])).toBe('')
  })

  it('sits between the session header and the panes, outside any one pane', () => {
    const focus = readFileSync(new URL('../src/renderer/components/Focus.tsx', import.meta.url), 'utf8')
    const header = focus.indexOf('<header className="sess-h">')
    const strip = focus.indexOf('<SecurityStrip')
    const panes = focus.indexOf('<div className="panes"')
    expect(header).toBeGreaterThan(0)
    expect(strip).toBeGreaterThan(header)
    expect(strip).toBeLessThan(panes)
  })

  it('uses the alert color in both views, not the update band\'s violet', () => {
    const css = readFileSync(new URL('../src/renderer/styles/app.css', import.meta.url), 'utf8')
    const tokens = readFileSync(new URL('../src/renderer/styles/tokens.css', import.meta.url), 'utf8')
    expect(tokens).toMatch(/--cc-alert:\s*#ff7a6b/)
    expect(css).toMatch(/\.band\.sec \{[^}]*--cc-alert/)
    expect(css).toMatch(/\.sec-strip \{[^}]*--cc-alert/)
    expect(renderToStaticMarkup(<SecurityBands report={report(['mod-integrity'])} />)).toContain('class="band sec"')
  })
})
