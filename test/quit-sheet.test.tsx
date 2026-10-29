// The quit modal's copy and list (MIP2-1528, spec MIP2-1462 §4, §5, §8).

import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { QuitSheet } from '../src/renderer/components/QuitSheet.tsx'
import type { CatRef, Entry } from '../src/renderer/model/fleet.ts'
import { busyWarning, headerState, listButton, modalBody, quitGroups, stateWord, stoppingLine } from '../src/renderer/model/quit.ts'

const id = (n: number) => `c0ffee0${n}-0000-4000-8000-00000000000${n}`
const cat = (cid: string | null, sort: number): CatRef => ({ id: cid, name: cid ?? 'Uncategorized', color: '#888', label: '', emoji: '', sort: cid === null ? Infinity : sort, auto: false })
const entry = (n: number, c: CatRef, label = 'YOUR TURN'): Entry => ({ session: { sessionId: id(n) }, cat: c, name: `S${n}`, view: { state: 'turn', glyph: 'turn', label }, since: null }) as unknown as Entry

describe('quit copy (§8)', () => {
  it('counts sessions and the busy ones, singular and plural', () => {
    expect(modalBody(5)).toMatch(/^5 sessions started in this app are running\. Closing stops them/)
    expect(modalBody(1)).toMatch(/^1 session started in this app is running\./)
    expect(busyWarning(0)).toBeNull()
    expect(busyWarning(1)).toBe('1 is working or waiting on you. It keeps running unless you pick it below.')
    expect(busyWarning(2)).toBe('2 are working or waiting on you. They keep running unless you pick them below.')
    expect(stoppingLine(3)).toBe('Stopping 3 sessions…')
  })

  it("the list's button counts what closes, and reads Quit when everything is kept (§5)", () => {
    expect(listButton(3, 0)).toBe('Close 3 and quit')
    expect(listButton(3, 1)).toBe('Close 2 and quit')
    expect(listButton(3, 3)).toBe('Quit')
  })
})

describe('the list (§5)', () => {
  it('groups by category in sidebar order, Uncategorized last, with header states and state words', () => {
    const a = cat('a', 2)
    const b = cat('b', 1)
    const none = cat(null, 0)
    const entries = [entry(1, a), entry(2, b, 'WORKING'), entry(3, none), entry(4, a, 'IDLE')]
    const rows = [
      { sessionId: id(3), busy: null },
      { sessionId: id(1), busy: null },
      { sessionId: id(2), busy: 'working' as const },
      { sessionId: id(4), busy: null },
    ]
    const g = quitGroups(rows, entries)
    expect(g.map(x => x.cat.id)).toEqual(['b', 'a', null])
    expect(g[1]!.rows.map(r => r.name)).toEqual(['S1', 'S4'])
    expect(stateWord(g[0]!.rows[0]!)).toBe('working')
    expect(stateWord(g[1]!.rows[1]!)).toBe('idle')
    expect(headerState(g[1]!.rows, new Set([id(1)]))).toBe('some')
    expect(headerState(g[1]!.rows, new Set([id(1), id(4)]))).toBe('all')
    expect(headerState(g[1]!.rows, new Set())).toBe('none')
  })

  it('names a session it has no entry for by its id', () => {
    expect(quitGroups([{ sessionId: id(9), busy: null }], [])[0]!.rows[0]!.name).toBe('Session c0ffee09')
  })
})

describe('QuitSheet (§4)', () => {
  it('shows the modal: title, counts, the warning, the three buttons with Yes as primary, and the Esc hint', () => {
    const html = renderToStaticMarkup(
      <QuitSheet rows={[{ sessionId: id(1), busy: null }, { sessionId: id(2), busy: 'waiting' }, { sessionId: id(3), busy: null }]} entries={[]} now={0} onClose={() => {}} onError={() => {}} />,
    )
    expect(html).toContain('Close sessions when the app quits?')
    expect(html).toContain('3 sessions started in this app are running.')
    expect(html).toContain('1 is working or waiting on you.')
    expect(html).toContain('Remember my choice')
    expect(html).toMatch(/Select which to preserve…<\/button>.*No, keep them running<\/button>.*class="primary"[^>]*>Yes, close them<\/button>/)
    expect(html).toContain('Esc cancels quitting.')
  })

  it('shows no warning when nothing is busy', () => {
    const html = renderToStaticMarkup(<QuitSheet rows={[{ sessionId: id(1), busy: null }]} entries={[]} now={0} onClose={() => {}} onError={() => {}} />)
    expect(html).not.toContain('quit-warn')
    expect(html).toContain('1 session started in this app is running.')
  })
})
