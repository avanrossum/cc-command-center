import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SerializeAddon } from '@xterm/addon-serialize'
import { themeByName } from './themes'
import '@xterm/xterm/css/xterm.css'

interface Props {
  termKey: string
  sessionId?: string
  pid?: number
  cwd: string
  resume: boolean
  themeName?: string | null
  // Spawn a child seeded with the current terminal selection. instant=true →
  // spawn immediately (Cmd+K tangent / Cmd+Shift+K blocking); instant=false → open
  // the composer pre-filled with the given type as default (right-click).
  onSpawnFromSelection?: (text: string, instant: boolean, type: 'blocking' | 'tangential') => void
}

// Hosts one live terminal. The PTY lives in the main process and keeps running
// when this component unmounts (switching sessions) — main replays its buffered
// scrollback on reattach, so we just create a fresh xterm and let main feed it.
export function TerminalView({
  termKey,
  sessionId,
  pid,
  cwd,
  resume,
  themeName,
  onSpawnFromSelection,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)
  // Held in a ref so the terminal setup effect (which captures it) doesn't need to
  // re-run — and always calls the latest callback.
  const spawnCbRef = useRef(onSpawnFromSelection)
  useEffect(() => {
    spawnCbRef.current = onSpawnFromSelection
  }, [onSpawnFromSelection])

  useEffect(() => {
    const host = hostRef.current!
    const term = new XTerm({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 12.5,
      // Initial theme; live changes are applied via the effect below without
      // remounting. themeName is intentionally NOT a dep of this setup effect.
      theme: themeByName(themeName).theme,
      scrollback: 8000,
      // Kitty keyboard protocol (xterm 6.1+): xterm answers Claude's protocol
      // negotiation and reports Shift+Enter as CSI-u (\x1b[13;2u), which Claude
      // inserts as a newline — the correct, native path (no key-injection hack).
      vtExtensions: { kittyKeyboard: true },
    })
    termRef.current = term
    const fit = new FitAddon()
    term.loadAddon(fit)
    const serialize = new SerializeAddon()
    term.loadAddon(serialize)
    term.open(host)
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch (e) {
      console.error('webgl addon failed to load', e)
    }
    fit.fit()

    // Persist a scrollback snapshot (debounced) so a restart can repaint this
    // pane before the resumed session redraws. Only scanned sessions have a
    // stable id to key on; brand-new (unadopted) terminals are skipped.
    let saveTimer: ReturnType<typeof setTimeout> | null = null
    const saveSnapshot = () => {
      if (!sessionId) return
      try {
        window.cc.snapshotSave(sessionId, serialize.serialize({ scrollback: 1000 }))
      } catch {
        /* serialize can throw on a disposed terminal — ignore */
      }
    }
    const scheduleSave = () => {
      if (!sessionId) return
      if (saveTimer) clearTimeout(saveTimer)
      saveTimer = setTimeout(saveSnapshot, 4000)
    }

    const offData = window.cc.onTermData((p) => {
      if (p.key === termKey) {
        term.write(p.data)
        scheduleSave()
      }
    })
    const offExit = window.cc.onTermExit((p) => {
      if (p.key === termKey) term.write(`\r\n\x1b[90m[session exited: ${p.code}]\x1b[0m\r\n`)
    })
    const onData = term.onData((d) => window.cc.termInput(termKey, d))

    // Shift+Enter → newline is handled natively by the kitty keyboard protocol
    // (vtExtensions.kittyKeyboard above), so no custom key handler is needed.

    // On macOS the Cmd (meta) key is never terminal input — every Cmd shortcut
    // belongs to the app menu / OS (paste, copy, quit, close, …). Return FALSE for
    // any Cmd combo so xterm ignores the key at the top of _keyDown: no PTY write,
    // no preventDefault, so the menu accelerator fires normally. (Returning true
    // let xterm consume Cmd+V/Cmd+Q under the kitty protocol — it sent a CSI-u
    // sequence and called preventDefault, typing a literal 'v' and blocking Cmd+Q.)
    // The Edit-menu Paste role then handles Cmd+V for BOTH text and images: it
    // fires webContents.paste → xterm sends a bracketed paste, and Claude Code
    // pastes the clipboard image on it. So no extra image handling belongs here —
    // an explicit Ctrl+V injection here just double-pasted the image. Non-Cmd keys
    // fall through (return true) so kitty Shift+Enter and Ctrl+V still work.
    // Special case: Cmd+K with a selection spawns a tangent seeded with that text
    // (instant). Cmd+K isn't a menu/terminal shortcut here, so it's free to claim.
    term.attachCustomKeyEventHandler((e) => {
      if (e.metaKey) {
        if (e.type === 'keydown' && !e.ctrlKey && !e.altKey && (e.key === 'k' || e.key === 'K')) {
          const sel = term.getSelection().trim()
          if (sel) {
            // Cmd+K → tangent; Cmd+Shift+K → blocking child.
            spawnCbRef.current?.(sel, true, e.shiftKey ? 'blocking' : 'tangential')
            return false
          }
        }
        return false
      }
      return true
    })

    // Right-click with a selection → spawn a tangent, but via the composer so you
    // can adjust folder/name/type first. No selection → leave the default alone.
    const onCtx = (ev: MouseEvent): void => {
      const sel = term.getSelection().trim()
      if (sel) {
        ev.preventDefault()
        spawnCbRef.current?.(sel, false, 'tangential') // composer default; toggle in it
      }
    }
    host.addEventListener('contextmenu', onCtx)

    window.cc
      .termOpen(termKey, { sessionId, pid, cwd, resume, cols: term.cols, rows: term.rows })
      .then(() => {
        window.cc.termResize(termKey, term.cols, term.rows)
      })

    const ro = new ResizeObserver(() => {
      fit.fit()
      window.cc.termResize(termKey, term.cols, term.rows)
    })
    ro.observe(host)
    term.focus()

    return () => {
      if (saveTimer) clearTimeout(saveTimer)
      saveSnapshot() // flush a final snapshot before tearing down the xterm
      ro.disconnect()
      host.removeEventListener('contextmenu', onCtx)
      offData()
      offExit()
      onData.dispose()
      term.dispose()
      termRef.current = null
      // Intentionally NOT closing the PTY: it keeps running in the background.
    }
  }, [termKey, sessionId, cwd, resume])

  // Apply theme changes live without tearing down the terminal.
  useEffect(() => {
    if (termRef.current) termRef.current.options.theme = themeByName(themeName).theme
  }, [themeName])

  return <div className="termhost" ref={hostRef} />
}
