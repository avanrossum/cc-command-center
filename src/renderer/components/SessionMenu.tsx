// A session's `⋯` menu, also its right-click menu (MIP2-1370 L5.5, UX
// review on MIP2-1407): Rename…, Move to category ›, the sheet's two
// forms and Copy last output; Never roll off (D-020) and Keep as my
// session or Treat as a contractor (MIP2-1393 §3, §6); Archive (§4.1) and Stop.

import { useEffect, useRef, useState } from 'react'
import type { Entry } from '../model/fleet.ts'
import { useStore } from './Categories.tsx'

/**
 * A session's menu. On a card it opens from its ⋯ button. A sidebar row
 * opens it on right-click instead (MIP2-1460): `openSignal` opens it each
 * time it changes, and `buttonless` leaves the ⋯ out of the row.
 */
export function SessionMenu({ e, openSignal = 0, buttonless = false }: { e: Entry; openSignal?: number; buttonless?: boolean }) {
  const api = useStore()
  const entries = api.entries
  const [open, setOpen] = useState<null | 'main' | 'parents' | 'move' | 'rename'>(null)
  useEffect(() => {
    if (openSignal) setOpen('main')
  }, [openSignal])
  const [draft, setDraft] = useState('')
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (ev: MouseEvent) => ref.current?.contains(ev.target as Node) || setOpen(null)
    const esc = (ev: KeyboardEvent) => ev.key === 'Escape' && setOpen(null)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => (document.removeEventListener('mousedown', close), document.removeEventListener('keydown', esc))
  }, [open])

  const id = e.session.sessionId
  const pins = api.store?.settings.switcherPins ?? []
  const recent = api.store?.settings.switcherRecent ?? []
  const pinned = pins.includes(id)
  const run = async (p: Promise<{ ok: boolean; error?: string }>, done?: string, undo?: () => Promise<unknown>) => {
    setOpen(null)
    const r = await p
    if (!r.ok) return api.notice(`Not saved: ${r.error}`)
    if (done) api.notice(done, undo ? { label: 'Undo', run: () => void undo() } : undefined)
  }
  // Parent candidates: Alex's sessions, most recent first.
  const parents = entries
    .filter(x => !x.contractor && x.session.sessionId !== id)
    .sort((a, b) => b.session.startedAt.value - a.session.startedAt.value)
    .slice(0, 12)

  return (
    <span className="chip-wrap" ref={ref}>
      {!buttonless && (
        <button type="button" className="more" title="Session menu" aria-haspopup="menu" onClick={ev => (ev.stopPropagation(), setOpen(o => (o ? null : 'main')))}>
          ⋯
        </button>
      )}
      {open === 'main' && (
        <div className="menu right" role="menu" onClick={ev => ev.stopPropagation()}>
          {e.movable && (
            <>
              <button role="menuitem" onClick={() => (setOpen(null), api.openMove(id))}>
                <span className="check" /> Move into the app…
              </button>
              <hr />
            </>
          )}
          <button role="menuitem" onClick={() => (setDraft(api.store?.sessions[id]?.name ?? e.name), setOpen('rename'))}>
            <span className="check" /> Rename…
          </button>
          <button role="menuitem" onClick={() => setOpen('move')}>
            <span className="check" /> Move to category ›
          </button>
          <button role="menuitem" onClick={() => (setOpen(null), api.openSheet('settings', id))}>
            <span className="check" /> Launch settings…
          </button>
          <button role="menuitem" onClick={() => (setOpen(null), api.openSheet('from', id))}>
            <span className="check" /> Start a session from this one…
          </button>
          <button role="menuitem" title="The last turn's whole answer, as Markdown" onClick={() => void run(window.ccc.copyLastOutput(id), 'Copied the last output.')}>
            <span className="check" /> Copy last output
          </button>
          <hr />
          <button role="menuitemcheckbox" aria-checked={e.neverRollOff} onClick={() => void run(window.ccc.setNeverRollOff(id, !e.neverRollOff))}>
            <span className="check">{e.neverRollOff ? '✓' : ''}</span> Never roll off
          </button>
          <button role="menuitem" onClick={() => (setOpen(null), api.togglePin(id))}>
            <span className="check" /> {pinned ? 'Unpin from switcher' : 'Pin to switcher'}
          </button>
          {e.contractor ? (
            <button
              role="menuitem"
              onClick={() =>
                void run(window.ccc.setSessionKind(id, 'session', null), `${e.name} is now one of your sessions.`, () =>
                  window.ccc.setSessionKind(id, 'contractor', e.contractor?.parentId ?? null),
                )
              }
            >
              <span className="check" /> Keep as my session
            </button>
          ) : (
            <button role="menuitem" onClick={() => setOpen('parents')}>
              <span className="check" /> Treat as a contractor ›
            </button>
          )}
          <hr />
          <button
            role="menuitem"
            // Archiving unpins; Undo pins it again (MIP2-1494 §5.3).
            onClick={() =>
              void run(window.ccc.archive(id), pinned ? `${e.name} archived and unpinned.` : `${e.name} archived.`, async () => {
                await window.ccc.resurrect([id])
                if (pinned || recent.includes(id)) await window.ccc.setSwitcher(pins, recent)
              })
            }
          >
            <span className="check" /> Archive
          </button>
          {e.view.state !== 'ended' && e.view.state !== 'dead' && (
            <button role="menuitem" title="Stop this session. It can be resumed (⌘⇧T)." onClick={() => void run(window.ccc.stop(id), `${e.name} stopped.`)}>
              <span className="check" /> Stop
            </button>
          )}
        </div>
      )}
      {open === 'move' && (
        <div className="menu right" role="menu" onClick={ev => ev.stopPropagation()}>
          <div className="menu-h">Move to</div>
          {(api.store?.categories ?? []).map(c => (
            <button key={c.id} role="menuitem" disabled={c.id === e.cat.id} onClick={() => void run(window.ccc.place(id, c.id))}>
              <i className="sq" style={{ '--cat': c.color } as React.CSSProperties} />
              {c.emoji && <span>{c.emoji}</span>} {c.name}
            </button>
          ))}
          <button role="menuitem" disabled={e.cat.id === null} onClick={() => void run(window.ccc.place(id, null))}>
            <i className="sq" style={{ '--cat': 'var(--cc-cat-none)' } as React.CSSProperties} /> Uncategorized
          </button>
        </div>
      )}
      {open === 'rename' && (
        <div className="menu right" role="dialog" aria-label="Rename" onClick={ev => ev.stopPropagation()}>
          <form
            className="rename"
            onSubmit={ev => (ev.preventDefault(), void run(window.ccc.setName(id, draft)))}
          >
            <input autoFocus value={draft} maxLength={80} onChange={ev => setDraft(ev.target.value)} placeholder={e.session.name.value || 'Name'} aria-label="Session name" />
            <p className="note">Empty goes back to Claude Code's name.</p>
          </form>
        </div>
      )}
      {open === 'parents' && (
        <div className="menu right" role="menu" onClick={ev => ev.stopPropagation()}>
          <div className="menu-h">Contractor of</div>
          {parents.map(p => (
            <button key={p.session.sessionId} role="menuitem" onClick={() => void run(window.ccc.setSessionKind(id, 'contractor', p.session.sessionId))}>
              {p.name}
            </button>
          ))}
          <hr />
          <button role="menuitem" onClick={() => void run(window.ccc.setSessionKind(id, 'contractor', null))}>
            Parent unknown
          </button>
        </div>
      )}
    </span>
  )
}

/** The `⚒ contractor of <parent>` tag, with why on hover (MIP2-1393 §3). */
export function ContractorTag({ e }: { e: Entry }) {
  if (!e.contractor) return null
  const why =
    e.contractor.why === 'hand'
      ? 'You marked it as a contractor.'
      : e.contractor.why === 'seen'
        ? `Started by ${e.parentName ?? 'another session'}'s Bash call.`
        : 'Started in the background outside the app, and no parent was seen starting it.'
  return (
    <span className="ctag" title={why}>
      ⚒ {e.parentName ? `contractor of ${e.parentName}` : 'contractor'}
    </span>
  )
}

/** `∞` after the name of a session set to never roll off (D-020). */
export function NeverMark({ e }: { e: Entry }) {
  return e.neverRollOff ? (
    <span className="never" title="Never rolls off">
      ∞
    </span>
  ) : null
}
