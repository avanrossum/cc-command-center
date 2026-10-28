// The session switcher (spec MIP2-1494 §5): a strip of chips for pinned and
// recent sessions at the top of Focus. Chips aren't tabs: none closes a
// session, none drags out, none has a ×. The order lives in model/switcher.ts.

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Entry } from '../model/fleet.ts'
import { categoryLabel } from '../model/fleet.ts'
import { tildify } from '../model/format.ts'
import { chipName, fitStrip } from '../model/switcher.ts'
import { URGENCY } from '../model/card-state.ts'
import { catStyle } from './Categories.tsx'
import { Glyph } from './bits.tsx'

/** Whether ⌘ is held, for the chips' numbers (§5.2). */
function useMetaHeld(): boolean {
  const [held, setHeld] = useState(false)
  useEffect(() => {
    const on = (e: KeyboardEvent) => setHeld(e.metaKey)
    const off = () => setHeld(false)
    window.addEventListener('keydown', on, true)
    window.addEventListener('keyup', on, true)
    window.addEventListener('blur', off)
    return () => (window.removeEventListener('keydown', on, true), window.removeEventListener('keyup', on, true), window.removeEventListener('blur', off))
  }, [])
  return held
}

export interface SwitcherActions {
  open: (id: string) => void
  togglePin: (id: string) => void
  move: (id: string, by: -1 | 1) => void
  /** Drag a pinned chip before another pin, or to the end of the pins (null). */
  movePin: (id: string, before: string | null) => void
  removeRecent: (id: string) => void
}

export function Switcher({ chips, pins, byId, current, act }: { chips: readonly string[]; pins: readonly string[]; byId: ReadonlyMap<string, Entry>; current: string; act: SwitcherActions }) {
  const meta = useMetaHeld()
  const strip = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(10_000)
  const [menu, setMenu] = useState<{ id: string } | 'more' | null>(null)
  const [drag, setDrag] = useState<string | null>(null)
  /** Chips' drawn widths, by `id:name length`, so the fit uses real widths (UX review, MIP2-1496). */
  const [measured, setMeasured] = useState<ReadonlyMap<string, number>>(new Map())
  const chipEls = useRef(new Map<string, HTMLElement>())
  useEffect(() => {
    const el = strip.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => e && setWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  useEffect(() => {
    if (!menu) return
    const close = (ev: MouseEvent) => (ev.target as HTMLElement).closest('.sw-menu') || setMenu(null)
    const esc = (ev: KeyboardEvent) => ev.key === 'Escape' && setMenu(null)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    // An open menu takes focus, so it works from the keyboard (UX review, MIP2-1496).
    strip.current?.querySelector<HTMLButtonElement>('.sw-menu button:not(:disabled)')?.focus()
    return () => (document.removeEventListener('mousedown', close), document.removeEventListener('keydown', esc))
  }, [menu])

  const names = new Map(chips.map(id => [id, byId.get(id)?.name ?? '']))
  const fit = fitStrip(chips, pins, names, width, measured)
  const max = fit.short ? 10 : 18
  useLayoutEffect(() => {
    let changed = false
    const next = new Map(measured)
    for (const id of fit.shown) {
      const w = chipEls.current.get(id)?.offsetWidth
      if (w && next.get(`${id}:${max}`) !== w) (next.set(`${id}:${max}`, w), (changed = true))
    }
    if (changed) setMeasured(next)
  })
  const numberOf = (id: string) => {
    const n = chips.indexOf(id) + 1
    return n >= 1 && n <= 9 ? n : null
  }
  const pinCount = fit.shown.filter(id => pins.includes(id)).length
  // A needs-you session hidden in +n still shows its glyph there.
  const rank = (id: string) => {
    const i = URGENCY.indexOf(byId.get(id)?.view.state ?? 'ended')
    return i < 0 ? URGENCY.length : i
  }
  const mostUrgent = fit.overflow.length ? byId.get([...fit.overflow].sort((a, b) => rank(a) - rank(b))[0]!) : undefined

  const chip = (id: string) => {
    const e = byId.get(id)
    if (!e) return null
    const pinned = pins.includes(id)
    const n = numberOf(id)
    return (
      <span
        key={id}
        ref={el => void (el ? chipEls.current.set(id, el) : chipEls.current.delete(id))}
        className={`sw-chip${id === current ? ' cur' : ''}${drag === id ? ' drag' : ''}`}
        style={catStyle(e.cat)}
        draggable={pinned}
        onDragStart={ev => (setDrag(id), ev.dataTransfer.setData('text/x-ccc-pin', id))}
        onDragEnd={() => setDrag(null)}
        onDragOver={ev => pinned && drag && ev.preventDefault()}
        onDrop={ev => (ev.preventDefault(), drag && act.movePin(drag, id), setDrag(null))}
        onContextMenu={ev => (ev.preventDefault(), setMenu({ id }))}
      >
        <button
          type="button"
          className="sw-open"
          // The context-menu key or ⇧F10 opens the chip's menu (UX review, MIP2-1496).
          onKeyDown={ev => (ev.key === 'ContextMenu' || (ev.key === 'F10' && ev.shiftKey)) && (ev.preventDefault(), setMenu({ id }))}
          title={`${e.name} · ${categoryLabel(e.cat)} · ${tildify(e.session.cwd.value)}`}
          // Focus stays with the attached view, so typing after a switch reaches the new session (§5.6).
          onMouseDown={ev => ev.preventDefault()}
          onClick={() => act.open(id)}
        >
          {pinned && (
            <svg className="sw-pin" viewBox="0 0 10 10" width="9" height="9" aria-label="Pinned" role="img">
              <path d="M3 1h4l-.6 3.2L8 6H5.5L5 9.5 4.5 6H2l1.6-1.8z" fill="currentColor" />
            </svg>
          )}
          <Glyph kind={e.view.glyph} />
          <span className="sw-name">{chipName(e.name, max)}</span>
          <span className="sw-cat" />
        </button>
        {/* An overlay, so holding ⌘ never changes a chip's width or the fit (UX review, MIP2-1496). */}
        {meta && n !== null && (
          <span className="sw-badge" aria-hidden="true">
            ⌘{n}
          </span>
        )}
        <button type="button" className="sw-pinbtn" tabIndex={-1} aria-label={pinned ? 'Unpin from switcher' : 'Pin to switcher'} title={pinned ? 'Unpin from switcher (⌘⇧P)' : 'Pin to switcher (⌘⇧P)'} onMouseDown={ev => ev.preventDefault()} onClick={() => act.togglePin(id)}>
          <svg viewBox="0 0 10 10" width="9" height="9" aria-hidden="true">
            <path d="M3 1h4l-.6 3.2L8 6H5.5L5 9.5 4.5 6H2l1.6-1.8z" fill={pinned ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth=".8" />
          </svg>
        </button>
      </span>
    )
  }

  const menuFor = (id: string) => {
    const pinned = pins.includes(id)
    const group = pinned ? pins.filter(x => chips.includes(x)) : chips.filter(x => !pins.includes(x))
    const i = group.indexOf(id)
    const pick = (f: () => void) => () => (setMenu(null), f())
    return (
      <div className="menu sw-menu" role="menu">
        <button role="menuitem" onClick={pick(() => act.togglePin(id))}>
          {pinned ? 'Unpin' : 'Pin'}
        </button>
        <button role="menuitem" disabled={i <= 0} onClick={pick(() => act.move(id, -1))}>
          Move left
        </button>
        <button role="menuitem" disabled={i < 0 || i >= group.length - 1} onClick={pick(() => act.move(id, 1))}>
          Move right
        </button>
        {!pinned && (
          <button role="menuitem" disabled={id === current} title={id === current ? 'The current session always has a chip.' : undefined} onClick={pick(() => act.removeRecent(id))}>
            Remove from recent
          </button>
        )}
      </div>
    )
  }

  return (
    <div className="switcher" ref={strip} role="toolbar" aria-label="Session switcher">
      {/* Chips are clipped to their row, so none can spill over the rail before the fit catches up. */}
      <div className="sw-row">
      {fit.shown.map((id, i) => (
        <span key={id} className="sw-slot">
          {i === pinCount && pinCount > 0 && <span className="sw-div" />}
          {chip(id)}
          {menu && menu !== 'more' && menu.id === id && menuFor(id)}
        </span>
      ))}
      </div>
      {drag && (
        <span className="sw-drop-end" onDragOver={ev => ev.preventDefault()} onDrop={ev => (ev.preventDefault(), act.movePin(drag, null), setDrag(null))} />
      )}
      {fit.overflow.length > 0 && (
        <span className="sw-slot sw-more-wrap">
          <button type="button" className="sw-more" tabIndex={-1} onMouseDown={ev => ev.preventDefault()} onClick={() => setMenu(m => (m === 'more' ? null : 'more'))} aria-haspopup="menu">
            {mostUrgent && <Glyph kind={mostUrgent.view.glyph} />}+{fit.overflow.length} ▾
          </button>
          {menu === 'more' && (
            <div className="menu right sw-menu" role="menu">
              {fit.overflow.map(id => {
                const e = byId.get(id)
                return (
                  e && (
                    <button key={id} role="menuitem" onClick={() => (setMenu(null), act.open(id))}>
                      <Glyph kind={e.view.glyph} /> {e.name}
                      {numberOf(id) !== null && <span className="sw-num"> ⌘{numberOf(id)}</span>}
                    </button>
                  )
                )
              })}
            </div>
          )}
        </span>
      )}
    </div>
  )
}
