import { useEffect, useRef } from 'react'
import { Terminal as XTerm } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'

interface Props {
  pid: number
  sessionId?: string
  cwd: string
  resume: boolean
}

// Hosts one live terminal. The PTY lives in the main process and keeps running
// when this component unmounts (switching sessions) — main replays its buffered
// scrollback on reattach, so we just create a fresh xterm and let main feed it.
export function TerminalView({ pid, sessionId, cwd, resume }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current!
    const term = new XTerm({
      allowProposedApi: true,
      cursorBlink: true,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      fontSize: 12.5,
      theme: { background: '#0b0d12' },
      scrollback: 8000,
    })
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
      if (p.pid === pid) term.write(p.data)
    })
    const offExit = window.cc.onTermExit((p) => {
      if (p.pid === pid) term.write(`\r\n\x1b[90m[session exited: ${p.code}]\x1b[0m\r\n`)
    })
    const onData = term.onData((d) => window.cc.termInput(pid, d))

    window.cc.termOpen(pid, { sessionId, cwd, resume, cols: term.cols, rows: term.rows }).then(() => {
      window.cc.termResize(pid, term.cols, term.rows)
    })

    const ro = new ResizeObserver(() => {
      fit.fit()
      window.cc.termResize(pid, term.cols, term.rows)
    })
    ro.observe(host)
    term.focus()

    return () => {
      ro.disconnect()
      offData()
      offExit()
      onData.dispose()
      term.dispose()
      // Intentionally NOT closing the PTY: it keeps running in the background.
    }
  }, [pid, sessionId, cwd, resume])

  return <div className="termhost" ref={hostRef} />
}
