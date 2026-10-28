// The sidebar's resize handle (MIP2-1495): drag its edge, or use the arrow
// keys while it has focus. Double-click restores the default. The width is
// saved when a drag ends, so it comes back at the next launch.

import { useRef } from 'react'
import { clampSidebarWidth, SIDEBAR_WIDTH } from '../../shared/store.ts'

/** Arrow keys move the edge by this much, px. */
const STEP = 16

export function SidebarGrip({ width, onWidth, onSave }: { width: number; onWidth: (px: number) => void; onSave: (px: number) => void }) {
  const start = useRef<{ x: number; w: number } | null>(null)
  const last = useRef(width)
  last.current = width
  const set = (px: number) => onWidth(clampSidebarWidth(px))
  return (
    <div
      className="side-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label="Sidebar width"
      aria-valuemin={SIDEBAR_WIDTH.min}
      aria-valuemax={SIDEBAR_WIDTH.max}
      aria-valuenow={width}
      tabIndex={0}
      title="Drag to resize. Double-click to restore."
      onPointerDown={ev => {
        ev.preventDefault()
        ev.currentTarget.setPointerCapture(ev.pointerId)
        start.current = { x: ev.clientX, w: width }
      }}
      onPointerMove={ev => start.current && set(start.current.w + ev.clientX - start.current.x)}
      onPointerUp={ev => {
        if (!start.current) return
        ev.currentTarget.releasePointerCapture(ev.pointerId)
        start.current = null
        onSave(last.current)
      }}
      onDoubleClick={() => (set(SIDEBAR_WIDTH.default), onSave(SIDEBAR_WIDTH.default))}
      onKeyDown={ev => {
        if (ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') return
        ev.preventDefault()
        const next = clampSidebarWidth(width + (ev.key === 'ArrowLeft' ? -STEP : STEP))
        onWidth(next)
        onSave(next)
      }}
    />
  )
}
