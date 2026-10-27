// ⌘K Jump to session (spec MIP2-1370 §15, MIP2-1379 §4a): by name or folder,
// grouped Running and Closed. Return opens a running session in Focus and
// resumes a closed one.

import { useEffect, useRef, useState } from 'react'
import type { Entry } from '../model/fleet.ts'
import { tildify } from '../model/format.ts'
import { Glyph } from './bits.tsx'

export function Jump({
  entries,
  onClose,
  onPick,
  onResumeWith,
}: {
  entries: Entry[]
  onClose: () => void
  onPick: (e: Entry) => void
  /** ⌥↩ on a closed session: Resume with different settings (MIP2-1387 §2.3). */
  onResumeWith: (e: Entry) => void
}) {
  const [q, setQ] = useState('')
  const [sel, setSel] = useState(0)
  const box = useRef<HTMLInputElement>(null)
  useEffect(() => box.current?.focus(), [])

  const words = q.toLowerCase().split(/\s+/).filter(Boolean)
  const hits = entries.filter(e => {
    const hay = `${e.name} ${e.cat.id ? e.cat.name : ''} ${e.session.cwd.value}`.toLowerCase()
    return words.every(w => hay.includes(w))
  })
  // Contractors are never offered for resume, and running ones list last, only when the query names them (MIP2-1393 §4.3).
  const running = hits.filter(e => e.view.state !== 'ended' && !e.contractor)
  const closed = hits.filter(e => e.view.state === 'ended' && !e.contractor)
  const contractors = words.length ? hits.filter(e => e.contractor && e.view.state !== 'ended' && words.every(w => e.name.toLowerCase().includes(w))) : []
  const list = [...running, ...closed, ...contractors]

  const row = (e: Entry, i: number) => (
    <div key={e.session.sessionId} className={`jrow${i === sel ? ' on' : ''}`} onMouseEnter={() => setSel(i)} onClick={() => onPick(e)}>
      <Glyph kind={e.view.glyph} />
      <b>{e.name}</b>
      <span className="mono">{tildify(e.session.cwd.value)}</span>
      {e.view.state === 'ended' && <span className="jresume">Resume ↩ · ⌥↩ with different settings</span>}
    </div>
  )

  return (
    <div className="sheet-veil" onClick={onClose}>
      <div className="jump-box" onClick={e => e.stopPropagation()}>
        <input
          ref={box}
          value={q}
          placeholder="Jump to session…"
          onChange={e => (setQ(e.target.value), setSel(0))}
          onKeyDown={e => {
            if (e.key === 'Escape') onClose()
            else if (e.key === 'ArrowDown') setSel(s => Math.min(s + 1, list.length - 1))
            else if (e.key === 'ArrowUp') setSel(s => Math.max(s - 1, 0))
            else if (e.key === 'Enter' && e.altKey && list[sel]?.view.state === 'ended') onResumeWith(list[sel])
            else if (e.key === 'Enter' && list[sel]) onPick(list[sel])
            else return
            e.preventDefault()
          }}
        />
        {running.length > 0 && <div className="jgrp">Running</div>}
        {running.map((e, i) => row(e, i))}
        {closed.length > 0 && <div className="jgrp">Closed</div>}
        {closed.map((e, i) => row(e, running.length + i))}
        {contractors.length > 0 && <div className="jgrp">Contractors</div>}
        {contractors.map((e, i) => row(e, running.length + closed.length + i))}
        {list.length === 0 && <div className="quiet">No session matches.</div>}
      </div>
    </div>
  )
}
