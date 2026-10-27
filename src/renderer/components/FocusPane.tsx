// One attached session view: xterm.js over `claude attach` (spec MIP2-1379
// §2, MIP2-1398 §3–§5). The app takes only ⌘ chords; everything else goes
// to the session. Leaving ends the attach process and shows the Left bar.

import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { SessionSnapshot } from '@ccc/contract'
import { categoryLabel, frameColor, type CatRef } from '../model/fleet.ts'
import { terminalFont, tildify } from '../model/format.ts'
import type { CardView } from '../model/card-state.ts'
import { Glyph } from './bits.tsx'
import { useStore } from './Categories.tsx'

export type PaneState =
  | { kind: 'attaching' }
  | { kind: 'attached' }
  | { kind: 'left'; reason: 'left' | 'stopped' | 'error' }
  | { kind: 'failed'; error: string; terminal?: boolean }

/**
 * The title Claude Code sets while the pane shows agent view, not a session:
 * `claude agents`, or `<n> awaiting input · claude agents` (Research MIP2-1403).
 */
export function isAgentViewTitle(title: string): boolean {
  return /(^|·\s*)claude agents\s*$/.test(title.trim())
}

const THEME = { background: '#0b0d12', foreground: '#c9ced8', cursor: '#c9ced8' }

/** Each mounted view's current selection, for Start a session from this one (D-014). */
const selections = new Map<string, () => string>()

export function viewSelection(sessionId: string): string {
  return selections.get(sessionId)?.() ?? ''
}

/**
 * Shift+Enter in the session view (MIP2-1458): a newline, sent once as LF,
 * the byte Ctrl+J sends, which Claude Code takes as a newline. xterm calls
 * the key handler for keydown, keypress and keyup; keydown sends it and
 * the others are swallowed, or the keypress would reach xterm and send CR,
 * which submits. 0.24 got the same result from xterm 6.1's kitty keyboard
 * protocol; this app is on xterm 6.0.
 */
export function shiftEnterKey(e: Pick<KeyboardEvent, 'type' | 'key' | 'shiftKey' | 'ctrlKey' | 'altKey' | 'metaKey'>): 'send' | 'swallow' | 'pass' {
  if (e.key !== 'Enter' || !e.shiftKey || e.ctrlKey || e.altKey || e.metaKey) return 'pass'
  return e.type === 'keydown' ? 'send' : 'swallow'
}

export function FocusPane({
  session,
  view,
  name,
  cat,
  visible,
  onState,
  onBackToFleet,
  onOpenComposer,
}: {
  session: SessionSnapshot
  view: CardView
  name: string
  cat: CatRef
  visible: boolean
  onState: (s: PaneState) => void
  onBackToFleet: () => void
  onOpenComposer: () => void
}) {
  const id = session.sessionId
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const store = useStore()
  const settings = store.store?.settings
  /** The font at the terminal's creation; later changes go through the effect below. */
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  const [state, setState] = useState<PaneState>({ kind: 'attaching' })
  const [nameCard, setNameCard] = useState(0)
  const reattachBtn = useRef<HTMLButtonElement>(null)
  const attached = state.kind === 'attached'

  const set = (s: PaneState) => {
    setState(s)
    onState(s)
  }

  const attach = async () => {
    const t = term.current
    if (!t || !fit.current) return
    set({ kind: 'attaching' })
    t.reset()
    fit.current.fit()
    const r = await window.ccc.focusOpen(id, Math.max(t.cols, 20), Math.max(t.rows, 5))
    set(r.ok ? { kind: 'attached' } : { kind: 'failed', error: r.error, ...(r.kind === 'terminal' ? { terminal: true } : {}) })
  }

  // The terminal, once per pane.
  useEffect(() => {
    const t = new Terminal({
      macOptionIsMeta: true,
      // Option-drag (and Shift-drag) select in the view itself while Claude Code has the mouse (MIP2-1385, Focus spec §2.4).
      macOptionClickForcesSelection: true,
      ...terminalFont(settingsRef.current),
      theme: THEME,
      allowProposedApi: false,
      scrollback: 0,
    })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host.current!)
    term.current = t
    selections.set(id, () => (t.hasSelection() ? t.getSelection() : ''))
    fit.current = f
    // ⌘ chords belong to the app; Shift+Enter is a newline, not a submit (spec §2.4).
    t.attachCustomKeyEventHandler(e => {
      // ⌘C copies the view's own selection, else asks Claude Code to copy its selection with
      // Ctrl+Shift+C in kitty CSI u form (MIP2-1414: inert with no selection). Never 0x03, which cancels.
      if (e.metaKey && e.type === 'keydown' && e.code === 'KeyC' && !e.shiftKey && !e.altKey) {
        if (t.hasSelection()) window.ccc.copyText(t.getSelection())
        else window.ccc.focusInput(id, '\x1b[99;6u')
        return false
      }
      if (e.metaKey) return false
      const shiftEnter = shiftEnterKey(e)
      if (shiftEnter !== 'pass') {
        if (shiftEnter === 'send') {
          e.preventDefault()
          window.ccc.focusInput(id, '\n')
        }
        return false
      }
      return true
    })
    t.onData(d => window.ccc.focusInput(id, d))
    t.onResize(({ cols, rows }) => window.ccc.focusResize(id, cols, rows))
    t.onTitleChange(title => {
      host.current?.parentElement?.setAttribute('data-title', title)
      // The pane left the session for agent view: end the attach, show Left (MIP2-1403).
      if (isAgentViewTitle(title)) {
        window.ccc.focusLeave(id)
        set({ kind: 'left', reason: 'left' })
      }
    })
    const offData = window.ccc.onFocusData((sid, data) => sid === id && t.write(data))
    const offExit = window.ccc.onFocusExit((sid, code) => {
      if (sid !== id) return
      host.current?.parentElement?.setAttribute('data-exit', String(code))
      setState(prev => {
        const next: PaneState = prev.kind === 'left' ? prev : { kind: 'left', reason: code === 0 ? 'left' : 'error' }
        onState(next)
        return next
      })
    })
    const ro = new ResizeObserver(() => f.fit())
    ro.observe(host.current!)
    void attach()
    return () => {
      ro.disconnect()
      offData()
      offExit()
      window.ccc.focusLeave(id)
      selections.delete(id)
      t.dispose()
    }
    // One terminal per session for the pane's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  // The font from settings, applied live (MIP2-1424); the view refits and tells the session its new size.
  useEffect(() => {
    const t = term.current
    if (!t) return
    const next = terminalFont(settings)
    if (t.options.fontFamily === next.fontFamily && t.options.fontSize === next.fontSize) return
    t.options.fontFamily = next.fontFamily
    t.options.fontSize = next.fontSize
    fit.current?.fit()
    window.ccc.focusResize(id, Math.max(t.cols, 20), Math.max(t.rows, 5))
  }, [settings?.terminalFont, settings?.terminalFontSize])

  // On every switch to this pane: focus, the name card (MIP2-1398 §5).
  useEffect(() => {
    if (!visible) return
    fit.current?.fit()
    setNameCard(n => n + 1)
    if (state.kind === 'left') reattachBtn.current?.focus()
    else term.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible])

  useEffect(() => {
    if (state.kind === 'left' && visible) reattachBtn.current?.focus()
  }, [state.kind, visible])

  // ⌘O inserts paths, ⌘⇧R redraws (spec §8.1, §8.3), on the visible pane only.
  useEffect(() => {
    if (!visible) return
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey) return
      if (e.code === 'KeyO' && !e.shiftKey && attached) {
        e.preventDefault()
        void window.ccc.focusPickPaths(id)
      } else if (e.code === 'KeyR' && e.shiftKey && attached) {
        e.preventDefault()
        redraw()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })

  const redraw = () => {
    const t = term.current
    if (!t) return
    const { cols, rows } = t
    t.resize(cols - 1, rows)
    setTimeout(() => t.resize(cols, rows), 150)
  }

  const catColor = cat.color
  const frame = frameColor(cat)
  const leftText =
    state.kind === 'left' && state.reason === 'error'
      ? `The view for ${name} closed unexpectedly. The session is still running.`
      : `You left ${name}. The session is still running.`

  return (
    <section
      className={`pane${visible ? '' : ' hidden'}${attached && visible ? ' framed' : ''}`}
      style={{ '--cat': catColor, '--frame': frame } as React.CSSProperties}
    >
      <div
        className="term-host"
        ref={host}
        onDragOver={e => e.preventDefault()}
        onDrop={e => {
          e.preventDefault()
          if (attached) window.ccc.focusDropFiles(id, [...e.dataTransfer.files])
        }}
      />
      {state.kind === 'attaching' && <div className="pane-msg">{session.pid.value === null ? `Resuming ${name}…` : `Attaching to ${name}…`}</div>}
      {state.kind === 'failed' && (
        <div className="pane-msg">
          {/* An interactive session in a terminal: where it runs, and the move (MIP2-1466). */}
          <div>{state.terminal ? state.error : <>Can't open {name}: {state.error}</>}</div>
          <div className="pane-acts">
            {state.terminal && (
              <button className="fchip on" onClick={() => store.openMove(id)}>
                Move into the app…
              </button>
            )}
            <button className="fchip" onClick={() => void attach()}>
              Try again
            </button>
          </div>
        </div>
      )}
      {state.kind === 'left' && (
        <div className="leftbar" role="status">
          <span>{leftText}</span>
          <button ref={reattachBtn} className="fchip on" onClick={() => void attach()}>
            Reattach ↩
          </button>
          <button className="fchip" onClick={onBackToFleet}>
            Back to Fleet ⌘0
          </button>
        </div>
      )}
      {visible && nameCard > 0 && (
        <div key={nameCard} className="namecard" aria-hidden="true">
          <span className="cat-block">{categoryLabel(cat)}</span>
          <b>{name}</b>
          <span className="mono">{tildify(session.cwd.value)}</span>
        </div>
      )}
      <footer className={`strip${attached ? '' : ' neutral'}`}>
        <span className="cat-block">{categoryLabel(cat)}</span>
        <Glyph kind={view.glyph} />
        <span className="target">
          {attached ? (
            <>
              <b>{name}</b> <span className="mono">{tildify(session.cwd.value)}</span>
            </>
          ) : (
            <>Not attached: typing goes nowhere · {name}</>
          )}
        </span>
        <button className="tb" disabled={!attached} title={attached ? 'Insert a path (⌘O)' : 'Reattach to insert a path'} onClick={() => void window.ccc.focusPickPaths(id)}>
          ＋ File or folder
        </button>
        <button className="tb" onClick={onOpenComposer} title="Composer (⌘E)">
          Composer
        </button>
        <button className="tb" disabled={!attached} onClick={redraw} title="Redraw (⌘⇧R)">
          Redraw
        </button>
      </footer>
    </section>
  )
}
