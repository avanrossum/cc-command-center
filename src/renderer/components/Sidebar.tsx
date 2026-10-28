// The left sidebar (spec MIP2-1370 §11): one tree of categories and their
// sessions, in the order Alex sets. Drag a session onto a category to place
// it; drag a category header (or ⌥⌘↑/↓) to reorder (MIP2-1387 §3).

import { useState } from 'react'
import type { Category } from '../../shared/store.ts'
import { NEEDS_YOU, URGENCY } from '../model/card-state.ts'
import { catFilter, UNCAT_REF, type CatRef, type Entry, type FilterId } from '../model/fleet.ts'
import { age } from '../model/format.ts'
import { selectClick, type Selection } from '../model/selection.ts'
import { Glyph } from './bits.tsx'
import { ImportBand, SESSION_DRAG, useStore } from './Categories.tsx'
import { SessionMenu } from './SessionMenu.tsx'
import { parkedSessions, type Parked } from '../model/move.ts'

/** Order inside a category: needs you, working, asked/waiting, your turn; quiet sessions fold. */
const ORDER = URGENCY
const CAT_DRAG = 'application/x-ccc-category'

const refOf = (c: Category): CatRef => ({ id: c.id, name: c.name, color: c.color, label: c.label, emoji: c.emoji, sort: c.sort, auto: false })

/** The empty categories show and hide in place, so the control names its action and has no arrow (MIP2-1495). */
export function emptyCategoriesLabel(showing: boolean): string {
  return showing ? 'Hide empty categories' : 'Show empty categories'
}

/** The full name on hover, only while the name is cut short (MIP2-1495). */
const titleIfCut = (ev: React.MouseEvent<HTMLElement>) => {
  const el = ev.currentTarget
  el.title = el.scrollWidth > el.clientWidth ? (el.textContent ?? '') : ''
}

export function Sidebar({
  entries,
  now,
  onFilter,
  focused,
  typing,
  onOpen,
  onNew,
  selection,
  onSelection,
}: {
  entries: Entry[]
  now: number
  onFilter: (f: FilterId) => void
  focused: string | null
  typing: string | null
  onOpen: (sessionId: string) => void
  /** `＋` on a category: the New Session sheet with that category preset. */
  onNew: (categoryId: string | null) => void
  /** Bulk select, shared with Fleet: ⌘- and ⇧-click a row (MIP2-1407). */
  selection: Selection
  onSelection: (s: Selection) => void
}) {
  /** Row ids in the order shown, filled as they render, for ⇧-click ranges. */
  const order: string[] = []
  const api = useStore()
  const [showEmpty, setShowEmpty] = useState(false)
  const [dropOn, setDropOn] = useState<string | null>(null)
  // The row whose session menu a right-click opened, and a count so a second right-click opens it again (MIP2-1460).
  const [menuFor, setMenuFor] = useState<{ id: string; n: number } | null>(null)
  /** The parked row whose right-click menu is open (MIP2-1465). */
  const [parkedMenu, setParkedMenu] = useState<string | null>(null)
  const hideParked = async (ids: string[]) => {
    setParkedMenu(null)
    const r = await window.ccc.setParkedHidden(ids, true)
    if (!r.ok) return api.notice(`Not saved: ${r.error}`)
    api.notice(`Hid ${ids.length === 1 ? 'a parked session' : `${ids.length} parked sessions`}. Settings shows them again.`, {
      label: 'Undo',
      run: () => void window.ccc.setParkedHidden(ids, false),
    })
  }
  const cats = [...(api.store?.categories ?? [])].sort((a, b) => a.sort - b.sort)

  const byCat = new Map<string, Entry[]>()
  // Contractors never show in the sidebar (MIP2-1393 §4.3).
  for (const e of entries) {
    if (e.contractor) continue
    const key = e.cat.id ?? 'none'
    byCat.set(key, [...(byCat.get(key) ?? []), e])
  }
  // Sessions 0.24 had parked, which Claude Code doesn't list, on their category as parked rows (MIP2-1461).
  const parkedByCat = new Map<string, Parked[]>()
  // Off in Settings, or hidden one by one: not in the sidebar, still in the move sheet (MIP2-1465).
  const showParked = api.store?.settings.showParked !== false
  for (const p of showParked ? parkedSessions(api.store, new Set(api.entries.map(e => e.session.sessionId))) : []) {
    const key = p.cat.id ?? 'none'
    parkedByCat.set(key, [...(parkedByCat.get(key) ?? []), p])
  }
  const filled = cats.filter(c => byCat.has(c.id) || parkedByCat.has(c.id))
  const empty = cats.filter(c => !byCat.has(c.id) && !parkedByCat.has(c.id))

  const reorder = async (id: string, beforeId: string | null) => {
    const ids = cats.map(c => c.id).filter(x => x !== id)
    ids.splice(beforeId ? ids.indexOf(beforeId) : ids.length, 0, id)
    const r = await window.ccc.reorderCategories(ids)
    if (!r.ok) api.notice(`Not saved: ${r.error}`)
  }
  const move = (id: string, by: -1 | 1) => {
    const i = cats.findIndex(c => c.id === id)
    const j = i + by
    if (j < 0 || j >= cats.length) return
    void reorder(id, by < 0 ? cats[j]!.id : (cats[j + 1]?.id ?? null))
  }

  const dropProps = (cat: CatRef) => ({
    onDragOver: (ev: React.DragEvent) => {
      const types = ev.dataTransfer.types
      if (types.includes(SESSION_DRAG) || (cat.id && types.includes(CAT_DRAG))) {
        ev.preventDefault()
        setDropOn(cat.id ?? 'none')
      }
    },
    onDragLeave: () => setDropOn(null),
    onDrop: async (ev: React.DragEvent) => {
      setDropOn(null)
      const sessionId = ev.dataTransfer.getData(SESSION_DRAG)
      const catId = ev.dataTransfer.getData(CAT_DRAG)
      if (sessionId) {
        const r = await window.ccc.place(sessionId, cat.id)
        if (!r.ok) api.notice(`Not moved: ${r.error}`)
      } else if (catId && cat.id && catId !== cat.id) void reorder(catId, cat.id)
    },
  })

  const section = (cat: CatRef, list: Entry[], source: Category | null) => {
    const collapsed = source?.collapsed ?? false
    const sorted = list.filter(e => ORDER.includes(e.view.state)).sort((a, b) => ORDER.indexOf(a.view.state) - ORDER.indexOf(b.view.state))
    // A needs-you session stays visible under a collapsed header until answered.
    const shown = collapsed ? sorted.filter(e => NEEDS_YOU.has(e.view.state)) : sorted
    const idle = list.filter(e => e.view.state === 'idle').length
    const ended = list.filter(e => e.view.state === 'ended').length
    const dead = list.filter(e => e.view.state === 'dead').length
    const folded = [idle && `${idle} idle`, ended && `${ended} ended`, dead && `${dead} assumed dead`].filter(Boolean).join(' · ')
    const urgent = sorted[0]
    const key = cat.id ?? 'none'
    return (
      // A tinted header and a category rule down the block (MIP2-1494 §4, option D).
      <section key={key} className={`catblk${dropOn === key ? ' drop' : ''}`} style={{ '--cat': cat.color } as React.CSSProperties} {...dropProps(cat)}>
        <div
          className="cat-h"
          tabIndex={0}
          draggable={!!source}
          onDragStart={ev => source && (ev.dataTransfer.setData(CAT_DRAG, source.id), (ev.dataTransfer.effectAllowed = 'move'))}
          onContextMenu={ev => source && (ev.preventDefault(), api.editCategory(source.id))}
          onKeyDown={ev => {
            if (source && ev.metaKey && ev.altKey && (ev.key === 'ArrowUp' || ev.key === 'ArrowDown')) {
              ev.preventDefault()
              move(source.id, ev.key === 'ArrowUp' ? -1 : 1)
            } else if (ev.key === 'Enter') onFilter(catFilter(cat))
          }}
          title={source ? 'Right-click to edit. Drag to reorder.' : undefined}
        >
          {source ? (
            <button
              type="button"
              className="chev"
              aria-label={collapsed ? `Expand ${cat.name}` : `Collapse ${cat.name}`}
              onClick={() => void window.ccc.saveCategory({ id: source.id, collapsed: !collapsed })}
            >
              {collapsed ? '▸' : '▾'}
            </button>
          ) : (
            <span className="chev" />
          )}
          <span
            className="nm"
            role="button"
            onClick={() => {
              // In Focus a header opens the category's latest session; in Fleet it filters (spec §11).
              const latest = focused ? [...list].filter(e => e.session.sessionId !== focused).sort((a, b) => (b.since ?? b.session.startedAt.value) - (a.since ?? a.session.startedAt.value))[0] : undefined
              if (latest) onOpen(latest.session.sessionId)
              else onFilter(catFilter(cat))
            }}
          >
            {cat.emoji && <span className="emoji">{cat.emoji}</span>}
            {cat.name}
          </span>
          {collapsed && urgent && <Glyph kind={urgent.view.glyph} />}
          <span className="cnt">{list.length}</span>
          <button type="button" className="plus" title={`New session in ${cat.name}`} onClick={() => onNew(cat.id)}>
            ＋
          </button>
        </div>
        {shown.map(e => {
          const since = e.view.knownSince ?? e.since
          const bar = NEEDS_YOU.has(e.view.state) ? (e.view.state === 'question' ? ' question' : ' needs') : ''
          order.push(e.session.sessionId)
          return (
            <div
              key={e.session.sessionId}
              className={`srow${bar}${focused === e.session.sessionId ? ' sel' : ''}${selection.picked?.has(e.session.sessionId) ? ' picked' : ''}`}
              role="button"
              draggable
              onDragStart={ev => (ev.dataTransfer.setData(SESSION_DRAG, e.session.sessionId), (ev.dataTransfer.effectAllowed = 'move'))}
              onClick={ev => {
                const next = selectClick(selection, e.session.sessionId, order, { meta: ev.metaKey, shift: ev.shiftKey })
                if (next) onSelection(next)
                else onOpen(e.session.sessionId)
              }}
              // The card's session menu, Rename… included, from the sidebar (MIP2-1460).
              onContextMenu={ev => (ev.preventDefault(), setMenuFor(m => ({ id: e.session.sessionId, n: (m?.n ?? 0) + 1 })))}
            >
              <Glyph kind={e.view.glyph} />
              <b onMouseEnter={titleIfCut}>{e.name}</b>
              <span className="age">{since === null ? '' : age(now - since)}</span>
              {/* The one row receiving input (MIP2-1398 §5). */}
              {typing === e.session.sessionId && (
                <span className="kbd-mark" title="Typing goes here">
                  <svg width="14" height="10" viewBox="0 0 14 10" aria-hidden="true">
                    <rect x="0.5" y="0.5" width="13" height="9" rx="1.5" fill="none" stroke="currentColor" />
                    <path d="M3 3h1M6 3h1M9 3h1M3 5.5h1M6 5.5h1M9 5.5h1M4 7.5h6" stroke="currentColor" />
                  </svg>
                </span>
              )}
              {menuFor?.id === e.session.sessionId && <SessionMenu e={e} openSignal={menuFor.n} buttonless />}
            </div>
          )
        })}
        {!collapsed && folded && <div className="folded">▸ {folded}</div>}
        {!collapsed &&
          (parkedByCat.get(cat.id ?? 'none') ?? []).map(p => (
            <div
              key={p.id}
              className="srow parked"
              role="button"
              title={`Parked in CC Command Center 0.24. Resume it here: ${p.cwd}`}
              onClick={() => api.openMove(p.id)}
              onContextMenu={ev => (ev.preventDefault(), setParkedMenu(p.id))}
            >
              <span className="glyph-gap" />
              <b onMouseEnter={titleIfCut}>{p.name}</b>
              <span className="age">parked</span>
              {parkedMenu === p.id && (
                <span className="chip-wrap">
                  <div className="menu right" role="menu" onClick={ev => ev.stopPropagation()} onMouseLeave={() => setParkedMenu(null)}>
                    <button role="menuitem" onClick={() => (setParkedMenu(null), api.openMove(p.id))}>
                      <span className="check" /> Move into the app…
                    </button>
                    <button role="menuitem" onClick={() => void hideParked([p.id])}>
                      <span className="check" /> Hide
                    </button>
                  </div>
                </span>
              )}
            </div>
          ))}
        {!collapsed && (parkedByCat.get(cat.id ?? 'none')?.length ?? 0) > 1 && (
          // Every parked session in the category at once (MIP2-1465).
          <div className="folded">
            <button type="button" className="link" onClick={() => void hideParked(parkedByCat.get(cat.id ?? 'none')!.map(p => p.id))}>
              Hide these {parkedByCat.get(cat.id ?? 'none')!.length} parked
            </button>
          </div>
        )}
      </section>
    )
  }

  return (
    <nav className="side">
      <div className="jump" title="Jump to session (⌘K)">
        <span>Jump to session…</span>
        <span className="mono">⌘K</span>
      </div>
      <ImportBand />
      {filled.map(c => section(refOf(c), byCat.get(c.id) ?? [], c))}
      {showEmpty && empty.map(c => section(refOf(c), [], c))}
      {/* Uncategorized is always last. */}
      {(byCat.has('none') || parkedByCat.has('none')) && section(UNCAT_REF, byCat.get('none') ?? [], null)}
      <div className="side-foot">
        {empty.length > 0 && (
          <button type="button" className="link" onClick={() => setShowEmpty(s => !s)}>
            {emptyCategoriesLabel(showEmpty)}
          </button>
        )}
        <button type="button" className="link" onClick={() => api.editCategory(null)}>
          ＋ Category
        </button>
      </div>
    </nav>
  )
}
