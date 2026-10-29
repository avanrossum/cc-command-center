// The quit modal (MIP2-1528, spec MIP2-1462 §4, §5, §7). Main opens it on
// the app's own Quit with the sessions it may close, decides what stops from
// the answer, and reports each stop. Esc cancels quitting; in the list, Esc
// goes back to the modal.

import { useEffect, useRef, useState } from 'react'
import type { QuitProgress, QuitRow } from '../../shared/quit.ts'
import type { Entry } from '../model/fleet.ts'
import { age } from '../model/format.ts'
import { BUSY_NOTE, busyWarning, headerState, listButton, modalBody, quitGroups, stateWord, stoppingLine } from '../model/quit.ts'
import { Glyph, STATE_COLOR } from './bits.tsx'

export function QuitSheet({ rows, entries, now, onClose, onError }: { rows: QuitRow[]; entries: Entry[]; now: number; onClose: () => void; onError: (text: string) => void }) {
  const [mode, setMode] = useState<'ask' | 'list' | 'stopping'>('ask')
  const [remember, setRemember] = useState(false)
  const busy = rows.filter(r => r.busy !== null)
  const [kept, setKept] = useState<Set<string>>(() => new Set(busy.map(r => r.sessionId)))
  const [progress, setProgress] = useState<QuitProgress | null>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const yesRef = useRef<HTMLButtonElement>(null)

  useEffect(() => window.ccc.onQuitProgress(p => (setProgress(p), setMode('stopping'))), [])
  useEffect(() => {
    if (mode === 'ask') yesRef.current?.focus()
    if (mode === 'list') listRef.current?.querySelector<HTMLInputElement>('input.keep')?.focus()
  }, [mode])

  const send = async (answer: Parameters<typeof window.ccc.quitAnswer>[0]) => {
    const r = await window.ccc.quitAnswer(answer)
    if (!r.ok) {
      onError(`Not quitting: ${r.error}`)
      onClose()
    } else if (answer.action === 'cancel') onClose()
  }
  const cancel = () => void send({ action: 'cancel' })
  const yes = () => void send({ action: 'close', keep: busy.map(r => r.sessionId), remember })
  const no = () => void send({ action: 'keep', remember })
  const closeListed = () => void send({ action: 'close', keep: [...kept], remember: false })

  const toggle = (ids: string[], on: boolean) =>
    setKept(k => {
      const next = new Set(k)
      for (const id of ids) on ? next.add(id) : next.delete(id)
      return next
    })

  const onKey = (ev: React.KeyboardEvent) => {
    if (mode === 'stopping') return
    if (ev.key === 'Escape' || (ev.metaKey && ev.key === '.')) {
      ev.preventDefault()
      if (mode === 'list') setMode('ask')
      else cancel()
    } else if (mode === 'list' && ev.metaKey && ev.key === 'Enter') {
      ev.preventDefault()
      closeListed()
    } else if (mode === 'list' && (ev.key === 'ArrowDown' || ev.key === 'ArrowUp')) {
      const boxes = [...(listRef.current?.querySelectorAll<HTMLInputElement>('input.keep') ?? [])]
      const i = boxes.indexOf(document.activeElement as HTMLInputElement)
      const next = boxes[Math.max(0, Math.min(boxes.length - 1, i + (ev.key === 'ArrowDown' ? 1 : -1)))]
      if (next) (ev.preventDefault(), next.focus())
    }
  }

  return (
    <div className="sheet-veil" onKeyDown={onKey}>
      <div className={`sheet quit-sheet${mode === 'list' ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={mode === 'list' ? 'Choose sessions to keep running' : 'Close sessions when the app quits?'}>
        {mode === 'ask' && (
          <>
            <h2>Close sessions when the app quits?</h2>
            <p>{modalBody(rows.length)}</p>
            {busyWarning(busy.length) && (
              <p className="quit-warn">
                <span className="quit-warn-g" aria-hidden="true">
                  ⚠
                </span>{' '}
                {busyWarning(busy.length)}
              </p>
            )}
            <label className="quit-remember">
              <input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)} /> Remember my choice
            </label>
            <div className="sheet-acts">
              <button type="button" className="link" onClick={() => setMode('list')}>
                Select which to preserve…
              </button>
              <span className="grow" />
              <button type="button" onClick={no}>
                No, keep them running
              </button>
              <button type="button" className="primary" ref={yesRef} onClick={yes}>
                Yes, close them
              </button>
            </div>
            <p className="note">Esc cancels quitting.</p>
          </>
        )}

        {mode === 'list' && (
          <>
            <h2>Choose sessions to keep running</h2>
            <p>Checked sessions keep running. The rest stop, and stay resumable.</p>
            <div className="quit-list" ref={listRef}>
              {quitGroups(rows, entries).map(g => {
                const state = headerState(g.rows, kept)
                const ids = g.rows.map(r => r.sessionId)
                return (
                  <section key={g.cat.id ?? 'none'} className="catblk" style={{ '--cat': g.cat.color } as React.CSSProperties}>
                    <label className="cat-h">
                      <input
                        type="checkbox"
                        aria-label={`Keep running: all of ${g.cat.name}`}
                        checked={state === 'all'}
                        ref={el => void (el && (el.indeterminate = state === 'some'))}
                        onChange={() => toggle(ids, state !== 'all')}
                      />
                      <span className="nm">
                        {g.cat.emoji && <span className="emoji">{g.cat.emoji}</span>}
                        {g.cat.name}
                      </span>
                    </label>
                    {g.rows.map(r => {
                      const view = r.entry?.view
                      const color = r.busy && view ? STATE_COLOR[view.state] : undefined
                      return (
                        <label key={r.sessionId} className="quit-row">
                          <input className="keep" type="checkbox" aria-label={`Keep running: ${r.name}`} checked={kept.has(r.sessionId)} onChange={e => toggle([r.sessionId], e.target.checked)} />
                          {view && <Glyph kind={view.glyph} />}
                          <span className="quit-name">
                            {r.name}
                            {r.busy && <span className="quit-note">{BUSY_NOTE[r.busy]}</span>}
                          </span>
                          <span className="quit-state" style={color ? { color } : undefined}>
                            {stateWord(r)}
                          </span>
                          <span className="quit-age">{r.entry?.since ? age(now - r.entry.since) : ''}</span>
                        </label>
                      )
                    })}
                  </section>
                )
              })}
            </div>
            <div className="sheet-acts">
              <button type="button" onClick={() => setMode('ask')}>
                Back
              </button>
              <span className="grow" />
              <button type="button" className="primary" onClick={closeListed}>
                {listButton(rows.length, rows.filter(r => kept.has(r.sessionId)).length)}
              </button>
            </div>
          </>
        )}

        {mode === 'stopping' && progress && (
          <>
            <h2>{stoppingLine(progress.stopping.length)}</h2>
            <ul className="quit-progress">
              {progress.stopping.map(id => {
                const name = quitGroups([{ sessionId: id, busy: null }], entries)[0]?.rows[0]?.name ?? id.slice(0, 8)
                const mark = progress.done.includes(id) ? '✓' : progress.failed.includes(id) ? '✕' : '…'
                return (
                  <li key={id}>
                    <span className="quit-mark" aria-hidden="true">
                      {mark}
                    </span>{' '}
                    {name}
                  </li>
                )
              })}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
