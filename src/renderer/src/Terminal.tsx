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
  cwd: string
  resume: boolean
  themeName?: string | null
}

// Hosts one live terminal. The PTY lives in the main process and keeps running
// when this component unmounts (switching sessions) — main replays its buffered
// scrollback on reattach, so we just create a fresh xterm and let main feed it.
export function TerminalView({ termKey, sessionId, cwd, resume, themeName }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<XTerm | null>(null)

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

    window.cc.termOpen(termKey, { sessionId, cwd, resume, cols: term.cols, rows: term.rows }).then(() => {
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
