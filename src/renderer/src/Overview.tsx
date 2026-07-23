// The "50,000-foot" overview: a grid of every ACTIVE session across the fleet, so
// you can see what all your Claudes are doing at once. Tiles are periodically
// refreshed SNAPSHOTS (not live-streaming terminals) — the app streams only the
// one attached terminal, and even that is near its repaint budget on the DOM
// renderer, so N live terminals would jank. The parts that must feel live — the
// state-color outline and the critical-order reordering — ride the app's 1.5s
// snapshot and are genuinely real-time; the terminal thumbnail being ~2s stale is
// irrelevant to a "who needs me" glance. Click a tile to drop into the real
// live session.
import { useEffect, useLayoutEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { themeByName } from './themes'
import { DEFAULT_TERMINAL_FONT, DEFAULT_TERMINAL_FONT_SIZE } from './fonts'
import '@xterm/xterm/css/xterm.css'

export interface OverviewSession {
  sessionId: string
  name: string
  dstate: string // display-state key, drives the outline color class + label
  stateLabel: string
  stateColor: string
  categoryColor?: string
  categoryEmoji?: string | null
  categoryLabel?: string
}

const REFRESH_MS = 1800 // thumbnails refresh a touch slower than the 1.5s scan — plenty for a glance

// One tile's terminal thumbnail. A static xterm that is written the peeked tail
// once per refresh, never streamed — so the DOM renderer only repaints on the
// tick, and many tiles stay cheap.
function TileTerm({
  sessionId,
  themeName,
  fontFamily,
  fontSize,
}: {
  sessionId: string
  themeName?: string | null
  fontFamily?: string | null
  fontSize?: number | null
}): React.ReactElement {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  const lastTail = useRef<string>('')
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const term = new XTerm({
      allowProposedApi: true,
      disableStdin: true,
      cursorBlink: false,
      cursorStyle: 'bar',
      fontFamily: fontFamily || DEFAULT_TERMINAL_FONT,
      fontSize: Math.max(8, (fontSize || DEFAULT_TERMINAL_FONT_SIZE) - 3.5), // smaller: it's a thumbnail
      theme: themeByName(themeName).theme,
      scrollback: 0, // a thumbnail shows the tail only; no scroll history needed
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)
    try {
      fit.fit()
    } catch {
      /* host not measured yet */
    }
    let disposed = false
    const paint = (tail: string): void => {
      if (disposed || tail === lastTail.current) return
      lastTail.current = tail
      // Repaint from scratch each tick: clear, home the cursor, write the tail.
      // The tail is raw ANSI from a full-screen TUI, so it can begin mid-sequence
      // and look briefly imperfect — acceptable for a thumbnail.
      term.reset()
      term.write(tail)
    }
    const tick = async (): Promise<void> => {
      try {
        const rows = await window.cc.termPeek([sessionId])
        paint(rows[0]?.tail ?? '')
      } catch {
        /* peek failed this tick — keep the last frame */
      }
    }
    void tick()
    const iv = setInterval(() => void tick(), REFRESH_MS)
    // Re-fit if the tile is resized (grid reflow / window resize).
    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        /* ignore */
      }
    })
    ro.observe(host)
    return () => {
      disposed = true
      clearInterval(iv)
      ro.disconnect()
      term.dispose()
    }
  }, [sessionId]) // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="ov-tile-term" ref={hostRef} />
}

export function OverviewGrid({
  sessions,
  overflow,
  themeName,
  fontFamily,
  fontSize,
  onPick,
  onClose,
}: {
  sessions: OverviewSession[]
  overflow: number
  themeName?: string | null
  fontFamily?: string | null
  fontSize?: number | null
  onPick: (sessionId: string) => void
  onClose: () => void
}): React.ReactElement {
  // FLIP: the sort order (and thus DOM order) changes as sessions shift state, and
  // CSS alone can't animate a reflow. Record each tile's position before the
  // reorder, then invert-and-release after the DOM updates so tiles slide.
  const gridRef = useRef<HTMLDivElement>(null)
  const prevRects = useRef<Map<string, DOMRect>>(new Map())
  useLayoutEffect(() => {
    const grid = gridRef.current
    if (!grid) return
    const tiles = grid.querySelectorAll<HTMLElement>('[data-sid]')
    tiles.forEach((el) => {
      const sid = el.dataset.sid as string
      const prev = prevRects.current.get(sid)
      const next = el.getBoundingClientRect()
      if (prev) {
        const dx = prev.left - next.left
        const dy = prev.top - next.top
        if (dx || dy) {
          el.style.transition = 'none'
          el.style.transform = `translate(${dx}px, ${dy}px)`
          // next frame: release to the real position, animating the delta
          requestAnimationFrame(() => {
            el.style.transition = 'transform 260ms cubic-bezier(0.22, 0.61, 0.36, 1)'
            el.style.transform = ''
          })
        }
      }
    })
    // Record for the next reorder.
    const m = new Map<string, DOMRect>()
    tiles.forEach((el) => m.set(el.dataset.sid as string, el.getBoundingClientRect()))
    prevRects.current = m
  }, [sessions])

  return (
    <div className="ov" onClick={onClose}>
      <div className="ov-head">
        <span className="ov-title">Fleet overview</span>
        <span className="ov-count">
          {sessions.length} active{overflow > 0 ? ` · +${overflow} more` : ''}
        </span>
        <button className="ov-close" onClick={onClose} title="Close (Esc)">
          Close ✕
        </button>
      </div>
      {sessions.length === 0 ? (
        <div className="ov-empty">Nothing active right now — every session is idle or waiting to resume.</div>
      ) : (
        <div className="ov-grid" ref={gridRef} onClick={(e) => e.stopPropagation()}>
          {sessions.map((s) => (
            // A div, not a button: xterm injects a helper <textarea>, and interactive
            // descendants inside a <button> are invalid and can swallow the click.
            <div
              key={s.sessionId}
              data-sid={s.sessionId}
              role="button"
              tabIndex={0}
              className={`ov-tile state-${s.dstate}`}
              style={{ ['--tile-color' as string]: s.stateColor }}
              onClick={() => onPick(s.sessionId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onPick(s.sessionId)
                }
              }}
              title={`${s.name} — ${s.stateLabel}`}
            >
              <div className="ov-tile-head">
                {s.categoryColor && (
                  <span className="ov-tile-cat" style={{ background: s.categoryColor }}>
                    {s.categoryEmoji || ''}
                  </span>
                )}
                <span className="ov-tile-name">{s.name}</span>
                <span className="ov-tile-state" style={{ color: s.stateColor }}>
                  {s.stateLabel}
                </span>
              </div>
              <TileTerm
                sessionId={s.sessionId}
                themeName={themeName}
                fontFamily={fontFamily}
                fontSize={fontSize}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
