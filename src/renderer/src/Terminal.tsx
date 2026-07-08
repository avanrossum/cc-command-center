import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
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
    term.open(host)
    try {
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch (e) {
      console.error('webgl addon failed to load', e)
    }
    fit.fit()

    const offData = window.cc.onTermData((p) => {
      if (p.key === termKey) term.write(p.data)
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
