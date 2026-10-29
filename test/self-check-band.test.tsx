// Every failing security alert shows at once, by consequence (gate run 3, M-4).

import type { SelfCheckReport } from '@ccc/contract'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { ChannelBand, channelCause, failingSecurity, SecurityBands, SecurityStrip, SelfCheckBand } from '../src/renderer/components/SelfCheckBand.tsx'

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

describe('the channel band (MIP2-1488)', () => {
  const ID = 'c0ffee05-0000-4000-8000-000000000005'
  const late = (over: Partial<SelfCheckReport> = {}): SelfCheckReport => ({
    claudeVersion: '2.1.312',
    state: 'degraded',
    controlOff: ['card-answers', 'prompt-relay'],
    checkedAt: 1,
    checks: [{ id: 'channel', label: 'channel', state: 'fail', detail: "a hosted session's mod hasn't reached the app in 90 s" }],
    unconnected: [{ sessionId: ID, since: 1_000 }, { sessionId: null, since: 2_000 }],
    causes: { claudeInstalledAt: null, supervisorStartedAt: null },
    ...over,
  })

  it('names each session, offers Open and Check again, and leaves the update band out', () => {
    const html = renderToStaticMarkup(<SelfCheckBand report={late()} now={241_000} rows={new Map([[ID, { name: 'site-build', running: true, waiting: false }]])} />)
    expect(html).toContain("2 sessions aren&#x27;t connected to the app.")
    expect(html).toContain('off for these sessions until they connect; other sessions aren&#x27;t affected')
    expect(html).toContain('site-build · 4m')
    expect(html).toContain('>Restart<')
    expect(html).toContain('A session the app launched at')
    expect(html).toContain('Check again')
    expect(html).not.toContain('after the Claude Code')
  })

  it('offers Resume for an ended session, holds Restart while one waits on a permission, and names an unlisted one by id', () => {
    const band = (rows: Map<string, { name: string; running: boolean; waiting: boolean }>) => renderToStaticMarkup(<ChannelBand report={late()} now={2_000} rows={rows} />)
    expect(band(new Map([[ID, { name: 'a', running: false, waiting: false }]]))).toContain('>Resume<')
    expect(band(new Map([[ID, { name: 'a', running: true, waiting: true }]]))).toMatch(/disabled=""[^>]*title="Waiting on a permission/)
    expect(band(new Map())).toContain('Session c0ffee05')
  })

  it('names a cause only when it came after the sessions reached the list', () => {
    expect(channelCause(late())).toBeNull()
    expect(channelCause(late({ causes: { claudeInstalledAt: 500, supervisorStartedAt: 1_500 } }))).toMatch(/^Likely cause: Claude Code's background supervisor restarted at .+\.$/)
    expect(channelCause(late({ causes: { claudeInstalledAt: 1_500, supervisorStartedAt: null } }))).toMatch(/^Likely cause: Claude Code 2\.1\.312 was installed at [^,]+\.$/)
    expect(channelCause(late({ causes: { claudeInstalledAt: 1_500, supervisorStartedAt: 1_600 } }))).toMatch(/installed at .+, and its background supervisor restarted at /)
  })

  it('shows nothing while the channel passes', () => {
    const ok = late({ state: 'passed', checks: [{ id: 'channel', label: 'channel', state: 'pass', detail: null }], unconnected: [] })
    expect(renderToStaticMarkup(<ChannelBand report={ok} rows={new Map()} now={0} />)).toBe('')
  })
})
