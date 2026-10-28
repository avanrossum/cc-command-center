// Focus: one session, attached (spec MIP2-1379 §2, §8; MIP2-1398). The four
// most recently focused panes stay mounted and attached, so switching back is
// instant (§2.3). The composer sends to the named session only, and a kept
// draft keeps its own target (MIP2-1398 §6).

import { useEffect, useRef, useState } from 'react'
import { categoryLabel, type Entry } from '../model/fleet.ts'
import { ArtifactDrawer } from './ArtifactDrawer.tsx'
import { CatChip, catStyle } from './Categories.tsx'
import { ContractorTag, NeverMark, SessionMenu } from './SessionMenu.tsx'
import { modelName, tildify, tokens } from '../model/format.ts'
import { Glyph } from './bits.tsx'
import { FocusPane, type PaneState } from './FocusPane.tsx'
import { SecurityStrip } from './SelfCheckBand.tsx'
import type { SelfCheckReport } from '@ccc/contract'

const KEPT = 4
const DRAFTS_KEY = 'ccc.drafts'

function loadDrafts(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(DRAFTS_KEY) ?? '{}') as Record<string, string>
  } catch {
    return {}
  }
}

function saveDrafts(d: Record<string, string>): void {
  try {
    localStorage.setItem(DRAFTS_KEY, JSON.stringify(d))
  } catch {
    // Drafts then live for this run only.
  }
}

/** Middle-truncated, so both ends of a long name stay visible (MIP2-1398 §6). */
function middle(name: string, max = 28): string {
  return name.length <= max ? name : `${name.slice(0, Math.ceil(max / 2) - 1)}…${name.slice(-Math.floor(max / 2))}`
}

export function Focus({
  focused,
  entries,
  onBackToFleet,
  onTitle,
  onTyping,
  selfCheck = null,
  strip = null,
}: {
  focused: string
  /** The session switcher, above the session header (MIP2-1494 §5.1). */
  strip?: React.ReactNode
  entries: Entry[]
  /** The self-check, for the security strip (spec MIP2-1379 §7.3). */
  selfCheck?: SelfCheckReport | null
  onBackToFleet: () => void
  onTitle: (t: string) => void
  /** The session typing reaches: the focused one while its view is attached, else null. */
  onTyping: (sessionId: string | null) => void
}) {
  const [mounted, setMounted] = useState<string[]>([focused])
  const panesRef = useRef<HTMLDivElement>(null)
  const [states, setStates] = useState<Record<string, PaneState>>({})
  const [drawer, setDrawer] = useState(false)
  /** The composer's target while it's open: the focused session, or the session a kept draft belongs to. */
  const [composerFor, setComposerFor] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, string>>(loadDrafts)
  const [sending, setSending] = useState<string | null>(null)
  const [sendError, setSendError] = useState<string | null>(null)
  const box = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    setMounted(m => [focused, ...m.filter(x => x !== focused)].slice(0, KEPT))
  }, [focused])

  const byId = new Map(entries.map(e => [e.session.sessionId, e]))
  const current = byId.get(focused)
  const state = states[focused]?.kind ?? 'attaching'

  useEffect(() => onTyping(state === 'attached' ? focused : null), [state, focused])
  useEffect(() => () => onTyping(null), [])

  // Draft guard: with no draft for this session, a kept draft for another listed session opens with its own target.
  const draftsRef = useRef(drafts)
  draftsRef.current = drafts
  const openComposer = () => {
    const d = draftsRef.current
    const other = Object.keys(d).filter(id => id !== focused && d[id]?.trim() && byIdRef.current.has(id)).at(-1)
    setComposerFor(d[focused]?.trim() || !other ? focused : other)
  }
  const byIdRef = useRef(byId)
  byIdRef.current = byId

  useEffect(() => {
    if (current) onTitle(`${current.name} · ${current.view.label.toLowerCase()} — CC Command Center`)
  }, [current?.view.label, focused])

  // ⌘E opens the composer; ⌘W and ⌘0 go back to Fleet (spec §2.4).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.metaKey || e.altKey) return
      if (e.code === 'KeyE') {
        e.preventDefault()
        openComposer()
      } else if (e.code === 'KeyW') {
        e.preventDefault()
        onBackToFleet()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onBackToFleet, focused])

  useEffect(() => {
    if (composerFor) box.current?.focus()
  }, [composerFor])

  // The composer belongs to the session it opened on; switching sessions closes it.
  useEffect(() => setComposerFor(null), [focused])

  if (!current) {
    return (
      <main className="main focus">
        <div className="empty">This session is no longer listed.</div>
      </main>
    )
  }

  const s = current.session
  const name = current.name
  const target = composerFor ? (byId.get(composerFor) ?? current) : current
  const targetId = target.session.sessionId
  const targetName = target.name
  const isOther = targetId !== focused
  // Pasting into the attached view reaches any session; the relay needs the app's mod, so not one started outside the app.
  const viaView = !isOther && state === 'attached'
  const blocked = !viaView && target.view.outside
  const draft = drafts[targetId] ?? ''
  const setDraft = (text: string) => {
    const next = { ...drafts, [targetId]: text }
    if (!text) delete next[targetId]
    setDrafts(next)
    saveDrafts(next)
  }

  const send = async () => {
    const text = draft
    if (!text.trim()) return
    if (blocked) return
    if (viaView) {
      // In Focus: as if typed, so a draft already in the session's prompt goes with it (spec §8.2).
      window.ccc.focusPaste(focused, text, true)
    } else {
      // Not attached: relay through the mod, respawning a stopped session first (spec §8.2).
      setSending(targetId)
      setSendError(null)
      const r = await window.ccc.sendPrompt(targetId, text)
      setSending(null)
      if (!r.ok) return setSendError(r.error)
    }
    setDraft('')
    setComposerFor(null)
  }

  const pct = s.context?.value.percent ?? null
  const total = s.tokens ? s.tokens.value.input + s.tokens.value.output + s.tokens.value.cacheRead + s.tokens.value.cacheWrite : 0

  return (
    <main className="main focus">
      {strip}
      <header className="sess-h">
        <Glyph kind={current.view.glyph} />
        <b>{name}</b>
        <NeverMark e={current} />
        {current.contractor ? <ContractorTag e={current} /> : <CatChip e={current} />}
        <span className="mono path" title={s.cwd.value}>
          <span>{tildify(s.cwd.value)}</span>
        </span>
        <span className="spacer" />
        {s.model && <span className="mono">{modelName(s.model.value)}</span>}
        {s.effort && <span className="mono">{s.effort.value}</span>}
        {pct !== null && <span className="mono">ctx {pct}%</span>}
        {s.tokens && total > 0 && <span className="mono">{tokens(total)}</span>}
        <button
          className="tb"
          title="Stop this session. It can be resumed (⌘⇧T)."
          onClick={() => void window.ccc.stop(focused).then(r => r.ok && onBackToFleet())}
        >
          Stop
        </button>
        <SessionMenu e={current} />
        <button className="tb" onClick={() => setDrawer(d => !d)} title="Files Claude wrote and artifacts it published" aria-expanded={drawer}>
          Artifacts {s.filesWritten?.value.length ?? 0}
        </button>
        <button className="tb" onClick={onBackToFleet} title="Back to Fleet (⌘0)">
          Fleet ⌘0
        </button>
      </header>
      {/* The view's, not a pane's: it stays across session switches and in every pane state. */}
      <SecurityStrip report={selfCheck} onFocusBack={() => panesRef.current?.querySelector<HTMLTextAreaElement>('.pane:not(.hidden) .xterm-helper-textarea')?.focus()} />
      <div className="panes" ref={panesRef}>
        {drawer && <ArtifactDrawer session={s} now={Date.now()} onClose={() => setDrawer(false)} />}
        {mounted.map(id => {
          const e = byId.get(id)
          if (!e) return null
          return (
            <FocusPane
              key={id}
              session={e.session}
              view={e.view}
              name={e.name}
              cat={e.cat}
              visible={id === focused}
              onState={st => setStates(prev => ({ ...prev, [id]: st }))}
              onBackToFleet={onBackToFleet}
              onOpenComposer={openComposer}
            />
          )
        })}
      </div>
      {composerFor && (
        <div className={`composer${isOther ? ' other' : ''}`} style={catStyle(target.cat)}>
          <div className="composer-h">
            To <span className="cat-block">{categoryLabel(target.cat)}</span> <b>{targetName}</b>
            {isOther && <span className="draft-mark"> (draft)</span>} <span className="mono">{tildify(target.session.cwd.value)}</span>
          </div>
          <textarea
            ref={box}
            rows={4}
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && e.metaKey) {
                e.preventDefault()
                void send()
              } else if (e.key === 'Escape') {
                e.preventDefault()
                setComposerFor(null)
              }
            }}
          />
          {blocked && (
            <div className="composer-err">
              {targetName} started outside the app, so the app can send to it only through its attached view.{' '}
              {isOther ? `Open ${targetName} to send.` : 'Reattach to send.'}
            </div>
          )}
          {sendError && <div className="composer-err">Not sent: {sendError}</div>}
          <div className="composer-acts">
            <button className="fchip on" disabled={blocked || !draft.trim() || sending === targetId} onClick={() => void send()}>
              {sending === targetId ? 'Sending…' : `Send to ${middle(targetName)} ⌘↩`}
            </button>
            {isOther && (
              <button className="fchip" onClick={() => setComposerFor(focused)} title={`Write to ${name} instead; the draft stays with ${targetName}`}>
                Write to {middle(name)}
              </button>
            )}
            <button className="fchip" onClick={() => setComposerFor(null)}>
              Close Esc
            </button>
          </div>
        </div>
      )}
    </main>
  )
}
