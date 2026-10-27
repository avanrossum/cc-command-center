// The move sheet (MIP2-1425; spec MIP2-1379 §6.2; DECISION item 11): moves
// CC Command Center 0.24's idle sessions into the app. Alex closes each one
// in 0.24; the app waits for its process to exit, resumes it here with
// `claude --resume <id> --bg` and its saved settings, and checks the id.
// The app never ends a 0.24 process or writes 0.24's registry.

import { useEffect, useRef, useState } from 'react'
import type { CatRef, Entry } from '../model/fleet.ts'
import { movable, nextToResume, parkedSessions, readiness, READINESS_TEXT, stopWaiting, type MovePhase } from '../model/move.ts'
import { Glyph } from './bits.tsx'
import { useStore } from './Categories.tsx'
import { TrustTerminal } from './TrustTerminal.tsx'

interface Row {
  id: string
  name: string
  cat: CatRef
  /** 0.24 had it parked: no process, and Claude Code doesn't list it (MIP2-1461). */
  parked?: boolean
  /** Hidden from the sidebar (MIP2-1465). */
  hidden?: boolean
}

export function MoveSheet({ entries, preselect, onClose, onOpen }: { entries: Entry[]; preselect: string | null; onClose: () => void; onOpen: (sessionId: string) => void }) {
  const api = useStore()
  const store = api.store
  const byId = new Map(entries.map(e => [e.session.sessionId, e]))
  // The rows are fixed when the sheet opens: a session closed in 0.24 leaves the list but stays here.
  // Then the ones 0.24 had parked, which Claude Code doesn't list: resumed the same way (MIP2-1461).
  const [rows] = useState<Row[]>(() => [
    // 0.24's interactive sessions, and ones run in a terminal (MIP2-1466).
    ...entries.filter(e => movable(e, store?.sessions[e.session.sessionId])).map(e => ({ id: e.session.sessionId, name: e.name, cat: e.cat })),
    ...parkedSessions(store, new Set(entries.map(e => e.session.sessionId)), true).map(p => ({ id: p.id, name: p.name, cat: p.cat, parked: true, hidden: p.hidden })),
  ])
  // Parked sessions Alex hid stay reachable here, behind Show hidden (MIP2-1465).
  const [showHidden, setShowHidden] = useState(() => rows.some(r => r.hidden && r.id === preselect))
  const hiddenCount = rows.filter(r => r.hidden).length
  const shownRows = rows.filter(r => showHidden || !r.hidden)
  const [picked, setPicked] = useState<Set<string>>(() => new Set(rows.filter(r => (preselect ? r.id === preselect : readiness(byId.get(r.id)) === 'ready')).map(r => r.id)))
  const [phases, setPhases] = useState<Record<string, MovePhase>>({})
  const [stopOnFail, setStopOnFail] = useState(true)
  const [asked, setAsked] = useState(false)
  /** The row whose folder the trust check is open for (MIP2-1461). */
  const [trusting, setTrusting] = useState<string | null>(null)
  const busy = useRef(false)
  const order = rows.map(r => r.id)
  const phase = (id: string): MovePhase => phases[id] ?? { kind: 'idle' }
  const running = Object.values(phases).some(p => p.kind === 'waiting' || p.kind === 'resuming')
  const resuming = Object.values(phases).some(p => p.kind === 'resuming')

  // Resume each selected session once its 0.24 process has exited, one at a time.
  useEffect(() => {
    if (busy.current) return
    const id = nextToResume(order, phases, x => byId.get(x))
    if (!id) return
    busy.current = true
    setPhases(p => ({ ...p, [id]: { kind: 'resuming' } }))
    void window.ccc.moveIn(id).then(r => {
      busy.current = false
      setPhases(p => {
        const failed: MovePhase = { kind: 'failed', error: r.ok ? '' : r.error, ...(!r.ok && r.kind === 'untrusted' ? { variant: r.variant ?? 'trust' } : {}) }
        const next: Record<string, MovePhase> = { ...p, [id]: r.ok ? (r.sameId ? { kind: 'moved' } : { kind: 'different', sessionId: r.sessionId }) : failed }
        return !r.ok && stopOnFail ? stopWaiting(next) : next
      })
    })
  })

  const start = () => setPhases(p => ({ ...p, ...Object.fromEntries([...picked].map(id => [id, { kind: 'waiting' } as MovePhase])) }))
  const moved = Object.values(phases).filter(p => p.kind === 'moved' || p.kind === 'different').length
  const settled = moved > 0 && !running
  // After the last move, 0.24's "hide sessions it didn't start" is offered once (ruling on MIP2-1424).
  const askHide = settled && store?.settings.importedHideUnmanaged === true && !store.settings.hideOutsideAsked && !asked
  const answerHide = async (hide: boolean) => {
    setAsked(true)
    const r = await window.ccc.updateSettings({ showOutside: !hide, hideOutsideAsked: true })
    if (!r.ok) api.notice(`Not saved: ${r.error}`)
  }
  const ready = rows.filter(r => picked.has(r.id) && phase(r.id).kind === 'idle').length

  return (
    <div className="sheet-veil" onMouseDown={ev => ev.target === ev.currentTarget && !running && onClose()} onKeyDown={ev => ev.key === 'Escape' && !running && onClose()}>
      <div className="sheet move" role="dialog" aria-label="Move sessions from CC Command Center 0.24" tabIndex={-1}>
        <h2>Move sessions from CC Command Center 0.24</h2>
        <ol className="move-steps">
          <li>
            Close the selected sessions where they run: each one's tab in CC Command Center 0.24 (or quit 0.24, which closes all of them), or the terminal
            running it. Their conversations stay on disk.
          </li>
          <li>The app waits for each one to close.</li>
          <li>It resumes each here with its saved model, effort and mode, and checks it's the same session.</li>
        </ol>
        {rows.length === 0 && <div className="quiet">No sessions are running or parked in CC Command Center 0.24.</div>}
        <div className="move-list">
          {shownRows.map((r, i) => {
            const e = byId.get(r.id)
            const ready0 = readiness(e)
            const ph = phase(r.id)
            const selectable = ph.kind === 'idle' && (ready0 === 'ready' || ready0 === 'closed')
            return (
              <div key={r.id} className="move-row-wrap">
              {r.parked && !shownRows[i - 1]?.parked && <div className="move-head">Parked in 0.24</div>}
              <div className={`move-row ph-${ph.kind}${r.parked ? ' parked' : ''}`}>
                <input type="checkbox" aria-label={`Move ${r.name}`} disabled={!selectable || running} checked={picked.has(r.id) && selectable} onChange={() => setPicked(p => {
                  const n = new Set(p)
                  if (n.has(r.id)) n.delete(r.id)
                  else n.add(r.id)
                  return n
                })} />
                {e ? <Glyph kind={e.view.glyph} /> : <span className="glyph-gap" />}
                <b>{r.name}</b>
                <i className="sq" style={{ '--cat': r.cat.color } as React.CSSProperties} title={r.cat.name} />
                <span className="move-state">
                  {ph.kind === 'idle' && (r.parked ? 'Parked in 0.24: resume it here' : READINESS_TEXT[ready0])}
                  {ph.kind === 'waiting' && 'Waiting for you to close it…'}
                  {ph.kind === 'resuming' && 'Resuming…'}
                  {ph.kind === 'moved' && 'Moved ✓'}
                  {ph.kind === 'different' && (
                    <>
                      Resumed as a different session. The original conversation is unchanged on disk.{' '}
                      <button type="button" className="link" onClick={() => (onClose(), onOpen(ph.sessionId))}>
                        Open the new one
                      </button>{' '}
                      <button type="button" className="link" onClick={() => void window.ccc.stop(ph.sessionId)}>
                        Stop the new one
                      </button>
                    </>
                  )}
                  {ph.kind === 'failed' && ph.variant === 'missing' && <>Its folder is gone, so it can't be resumed here. Its conversation is still on disk.</>}
                  {ph.kind === 'failed' && ph.variant === 'trust' && (
                    <>
                      Its folder hasn't been trusted in Claude Code yet.{' '}
                      <button type="button" className="link" onClick={() => setTrusting(r.id)}>
                        Open the trust check
                      </button>
                    </>
                  )}
                  {ph.kind === 'failed' && !ph.variant && (
                    <>
                      Couldn't resume {r.name}: {ph.error}.{' '}
                      <button type="button" className="link" onClick={() => setPhases(p => ({ ...p, [r.id]: { kind: 'waiting' } }))}>
                        Try again
                      </button>{' '}
                      <button type="button" className="link" onClick={() => (window.ccc.copyText(`claude --resume ${r.id} --bg`), api.notice('Resume command copied.'))}>
                        Copy resume command
                      </button>
                    </>
                  )}
                </span>
              </div>
              </div>
            )
          })}
        </div>
        {trusting && (
          // Claude Code's own trust question, answered by Alex; the app never writes trust (MIP2-1399).
          <TrustTerminal
            request={{ cwd: store?.sessions[trusting]?.cwd ?? '/', resume: trusting }}
            onCancel={() => setTrusting(null)}
            onDone={(sessionId, err) => {
              const id = trusting
              setTrusting(null)
              setPhases(p => ({ ...p, [id]: sessionId ? (sessionId === id ? { kind: 'moved' } : { kind: 'different', sessionId }) : { kind: 'failed', error: err ?? 'No session started. The folder is still untrusted' } }))
            }}
          />
        )}
        {askHide && (
          <div className="move-ask">
            <p>Hide sessions started outside the app, as in 0.24?</p>
            <button type="button" className="fchip" onClick={() => void answerHide(true)}>
              Hide them
            </button>
            <button type="button" className="fchip on" onClick={() => void answerHide(false)}>
              Keep showing them
            </button>
          </div>
        )}
        <div className="sheet-acts">
          {hiddenCount > 0 && (
            <label className="check">
              <input type="checkbox" checked={showHidden} onChange={ev => setShowHidden(ev.target.checked)} />
              Show hidden ({hiddenCount})
            </label>
          )}
          <label className="check">
            <input type="checkbox" checked={stopOnFail} disabled={running} onChange={ev => setStopOnFail(ev.target.checked)} />
            Stop at the first failure
          </label>
          <span className="spacer" />
          {running ? (
            <button type="button" className="fchip" disabled={resuming} onClick={() => setPhases(stopWaiting)} title="Stops waiting; nothing in 0.24 changes">
              Stop waiting
            </button>
          ) : (
            <button type="button" className="fchip" onClick={onClose}>
              {settled ? 'Done' : 'Cancel'}
            </button>
          )}
          <button type="button" className="fchip on" disabled={running || ready === 0} onClick={start}>
            Move {ready} session{ready === 1 ? '' : 's'}
          </button>
        </div>
      </div>
    </div>
  )
}
