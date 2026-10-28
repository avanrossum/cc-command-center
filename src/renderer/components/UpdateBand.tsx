// The app update notice (MIP2-1469), as in 0.24: "Version X is available"
// with Download and Later, its progress, then Restart to update. Nothing
// downloads until Download is pressed.

import { useEffect, useState } from 'react'
import type { UpdateState } from '../../shared/update-state.ts'

/** The update state, kept current from main. */
export function useUpdate(): UpdateState | null {
  const [state, setState] = useState<UpdateState | null>(null)
  useEffect(() => {
    void window.ccc.getUpdate().then(s => s && setState(s))
    return window.ccc.onUpdate(setState)
  }, [])
  return state
}

/** What the band says, or null when it doesn't show. */
export function bandText(u: UpdateState | null): { text: string; action: 'download' | 'restart' | null } | null {
  if (!u?.version) return null
  if (u.phase === 'available' && !u.dismissed) return { text: `Version ${u.version} is available.`, action: 'download' }
  if (u.phase === 'downloading') return { text: `Downloading version ${u.version}… ${u.percent ?? 0}%`, action: null }
  if (u.phase === 'downloaded') return { text: `Version ${u.version} is ready. Sessions keep running while the app restarts.`, action: 'restart' }
  return null
}

export function UpdateBand() {
  const u = useUpdate()
  const shown = bandText(u)
  if (!shown) return null
  return (
    <div className="band upd" role="status">
      <div className="band-t">
        <b>{shown.text}</b>
      </div>
      {shown.action === 'download' && (
        <>
          <button type="button" className="fchip on" onClick={() => void window.ccc.downloadUpdate()}>
            Download
          </button>
          <button type="button" className="fchip" onClick={() => void window.ccc.updateLater()}>
            Later
          </button>
        </>
      )}
      {shown.action === 'restart' && (
        <button type="button" className="fchip on" onClick={() => void window.ccc.restartToUpdate()}>
          Restart to update
        </button>
      )}
    </div>
  )
}

/** Settings → About's line for the last check. */
export function checkLine(u: UpdateState | null, now: number): string {
  if (!u) return ''
  if (u.phase === 'off') return 'Updates come with release builds.'
  if (u.phase === 'checking') return 'Checking…'
  const when = u.checkedAt !== null ? ` Checked ${ago(now - u.checkedAt)}.` : ''
  if (u.phase === 'error') return `The last check failed: ${u.error ?? 'unknown error'}.${when}`
  if (u.phase === 'none') return `This is the newest version.${when}`
  if (u.phase === 'available') return `Version ${u.version} is available.${when}`
  if (u.phase === 'downloading') return `Downloading version ${u.version}… ${u.percent ?? 0}%`
  if (u.phase === 'downloaded') return `Version ${u.version} is downloaded. Restart to update.`
  return 'Not checked yet.'
}

function ago(ms: number): string {
  const min = Math.round(ms / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min} min ago`
  const h = Math.round(min / 60)
  return `${h} hour${h === 1 ? '' : 's'} ago`
}
