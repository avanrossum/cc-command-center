// The security and PATH alerts name their sessions, with an action per session (MIP2-1518).

import type { SelfCheckReport } from '@ccc/contract'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { SecurityBands, type ChannelRow } from '../src/renderer/components/SelfCheckBand.tsx'

const A = 'c0ffee01-0000-4000-8000-000000000001'
const B = 'c0ffee02-0000-4000-8000-000000000002'
const report = (over: Partial<SelfCheckReport>): SelfCheckReport => ({
  claudeVersion: '2.1.312',
  state: 'passed',
  controlOff: [],
  checkedAt: 1,
  checks: [
    { id: 'channel-sockets', label: '', state: over.untrusted?.length ? 'fail' : 'pass', detail: 'c0ffee01: old detail' },
    { id: 'supervisor-path', label: '', state: over.pathMissing?.length ? 'fail' : 'pass', detail: null },
  ],
  ...over,
})
const row = (over: Partial<ChannelRow> = {}): ChannelRow => ({ name: 'Pagination tests', running: true, waiting: false, category: { label: 'ACME', color: '#4ac0e2' }, cwd: '~/acme/app', busy: false, ...over })

describe('security rows (MIP2-1518)', () => {
  it('names a marked session by name, category and folder, with Open and Resume, and offers Clear for one that is gone', () => {
    const html = renderToStaticMarkup(
      <SecurityBands report={report({ untrusted: [{ sessionId: A, why: 'its settings file was changed while the app was closed' }, { sessionId: B, why: 'socket replaced' }] })} rows={new Map([[A, row()]])} />,
    )
    expect(html).toContain('<b>Pagination tests</b>')
    expect(html).toContain('ACME')
    expect(html).toContain('~/acme/app')
    expect(html).toMatch(/>Open<\/button>/) // running: Open and Resume
    expect(html).toMatch(/>Resume<\/button>/)
    expect(html).toMatch(/Session c0ffee02<\/span> · no longer exists \(gone from Claude Code\)/)
    expect(html).toMatch(/>Clear<\/button>/)
    expect(html).not.toContain('old detail')
  })

  it('lists the sessions without your PATH, holds Resume while one works or waits, and says the supervisor line plainly', () => {
    const html = renderToStaticMarkup(
      <SecurityBands report={report({ pathMissing: [A, B], supervisorPathLacking: true })} rows={new Map([[A, row()], [B, row({ name: 'Docs sync', busy: true })]])} />,
    )
    expect(html).toContain('2 running sessions can&#x27;t find <code>claude</code> or your tools.')
    expect(html).toContain('<b>Pagination tests</b>')
    expect(html).toMatch(/<b>Docs sync<\/b>[\s\S]*?<button class="fchip" disabled=""[^>]*title="Resuming now would interrupt it/)
    expect(html).toContain('Sessions Claude Code restarts by itself will also lack your PATH until the supervisor restarts.')
    expect(html).not.toMatch(/restart the supervisor/i)
  })

  it('shows a plain line, not a warning, when no running session is affected', () => {
    const html = renderToStaticMarkup(<SecurityBands report={report({ pathMissing: [], supervisorPathLacking: true })} />)
    expect(html).toContain('class="band info"')
    expect(html).not.toContain('band sec')
    expect(html).toContain('No running session is affected')
  })

  it('shows Resume only on a stopped marked session, since Open would resume it the same way', () => {
    const html = renderToStaticMarkup(<SecurityBands report={report({ untrusted: [{ sessionId: A, why: 'x' }] })} rows={new Map([[A, row({ running: false })]])} />)
    expect(html).not.toMatch(/>Open<\/button>/)
    expect(html).toMatch(/>Resume<\/button>/)
  })

  it("lists sessions whose mod can't say as may be missing your PATH, in a plain band with Resume (MIP2-1539)", () => {
    const html = renderToStaticMarkup(<SecurityBands report={report({ pathUnknown: [A] })} rows={new Map([[A, row()]])} />)
    expect(html).toContain('class="band info"')
    expect(html).toContain('A running session</b>'.replace('</b>', '') )
    expect(html).toContain('may be missing your PATH.')
    expect(html).toMatch(/>Resume<\/button>/)
    expect(html).toContain('started before the app was updated')
    expect(html).toContain('<code>claude</code>')
    expect(html).not.toContain('reporter mod')
  })

  it('lists sessions that check replies by their secret alone, with Start a copy (MIP2-1543)', () => {
    const html = renderToStaticMarkup(<SecurityBands report={report({ hmacOnly: [A] })} rows={new Map([[A, row()]])} />)
    expect(html).toContain('check that replies come from this app.')
    expect(html).toContain('Resuming keeps the older check.')
    expect(html).toContain('this one keeps running until you stop it.')
    expect(html).toMatch(/>Start a copy<\/button>/)
  })
})
