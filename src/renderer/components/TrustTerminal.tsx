// The trust step's terminal (Research MIP2-1388): Claude Code's own trust
// dialog for the folder, answered by Alex at the keyboard. Every key goes to
// the dialog; the app adds nothing of its own.

import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { LaunchRequest } from '../../shared/ipc.ts'
import { terminalFont } from '../model/format.ts'
import { useStore } from './Categories.tsx'

export function TrustTerminal({
  request,
  onDone,
  onCancel,
}: {
  request: LaunchRequest
  /** The run ended: the new session's id, or null when no session started. */
  onDone: (sessionId: string | null, error: string | null) => void
  onCancel: () => void
}) {
  const host = useRef<HTMLDivElement>(null)
  const runId = useRef<string | null>(null)
  const settings = useStore().store?.settings

  useEffect(() => {
    const t = new Terminal({ ...terminalFont(settings), theme: { background: '#0b0d12', foreground: '#c9ced8' } })
    const f = new FitAddon()
    t.loadAddon(f)
    t.open(host.current!)
    // The dialog is below the sheet's fields; bring it into view.
    host.current!.scrollIntoView({ block: 'center' })
    f.fit()
    t.focus()
    const offData = window.ccc.onTrustData((id, d) => id === runId.current && t.write(d))
    const offDone = window.ccc.onTrustDone((id, sid, err) => id === runId.current && onDone(sid, err))
    t.onData(d => runId.current && window.ccc.trustInput(runId.current, d))
    void window.ccc.trustStart(request, t.cols, t.rows).then(r => {
      if (r.ok) runId.current = r.runId
      else onDone(null, r.error)
    })
    return () => {
      offData()
      offDone()
      if (runId.current) window.ccc.trustCancel(runId.current)
      t.dispose()
    }
    // One run per mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="trust">
      <div className="trust-h">
        Claude Code's trust check for <span className="mono">{request.cwd}</span>. Answer it below; the session starts if you trust the folder.
      </div>
      <div className="trust-term" ref={host} />
      <div className="sheet-acts">
        <button type="button" className="fchip" onClick={onCancel}>
          Close
        </button>
      </div>
    </div>
  )
}
