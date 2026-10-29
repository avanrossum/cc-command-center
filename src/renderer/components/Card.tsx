// The session card and its one-line row (spec MIP2-1370 §5.3, §5.4). Read
// only in N1: no answer buttons and no Focus yet.

import { useEffect, useRef, useState } from 'react'
import { CARD_APPROVE_LINES, type SessionSnapshot } from '@ccc/contract'
import { NEEDS_YOU } from '../model/card-state.ts'
import { frameColor, type Entry } from '../model/fleet.ts'
import { blockedOnAlex } from '../../shared/summaries.ts'
import { age, modelName, tildify, tokens } from '../model/format.ts'
import { FieldText, Glyph, STATE_COLOR } from './bits.tsx'
import { CatChip, SESSION_DRAG } from './Categories.tsx'
import { ContractorTag, NeverMark, SessionMenu } from './SessionMenu.tsx'

/** Right-click opens the card's ⋯ menu (MIP2-1407). */
function openMenu(ev: React.MouseEvent<HTMLElement>): void {
  ev.preventDefault()
  ev.currentTarget.querySelector<HTMLButtonElement>('button.more')?.click()
}

/** Cards and rows drag onto a sidebar category: a placement by hand (spec MIP2-1370 §7). */
function dragProps(sessionId: string) {
  return {
    draggable: true,
    onDragStart: (ev: React.DragEvent) => {
      ev.dataTransfer.setData(SESSION_DRAG, sessionId)
      ev.dataTransfer.effectAllowed = 'move'
    },
  }
}

function stateAge(e: Entry, now: number): string {
  const start = e.view.knownSince ?? e.since
  return start === null ? '' : age(now - start)
}

/** One flash in the new state's color each time the state changes (spec §8). */
function useFlash(state: string): number {
  const prev = useRef(state)
  const [n, setN] = useState(0)
  useEffect(() => {
    if (prev.current !== state) setN(x => x + 1)
    prev.current = state
  }, [state])
  return n
}

function MetaLine({ s, now }: { s: SessionSnapshot; now: number }) {
  const pct = s.context?.value.percent ?? null
  const heat = pct === null ? '' : pct >= 85 ? 'hot' : pct >= 65 ? 'warm' : ''
  const total = s.tokens ? s.tokens.value.input + s.tokens.value.output + s.tokens.value.cacheRead + s.tokens.value.cacheWrite : 0
  return (
    <div className="c-meta">
      <FieldText f={s.model} label="model" now={now}>
        {s.model && modelName(s.model.value)}
      </FieldText>
      <FieldText f={s.effort} label="effort" now={now}>
        {s.effort?.value}
      </FieldText>
      <FieldText f={s.context} label="ctx" now={now}>
        <span className={`ctx ${heat}`}>
          <i>
            <b style={{ width: `${Math.min(100, pct ?? 0)}%` }} />
          </i>
          {pct === null ? 'ctx —' : `${pct}%`}
        </span>
      </FieldText>
      {/* A zero total before the first completed turn means "not reported yet" (UX item 6). */}
      <FieldText f={total === 0 && !s.turn?.value.endedAt ? undefined : s.tokens} label="tok" now={now}>
        {tokens(total)}
      </FieldText>
    </div>
  )
}

export function NowLine({ e }: { e: Entry }) {
  const s = e.session
  // Blocked with nothing saying why (MIP2-1426): the Arbiter's line where the category allows it (MIP2-1485),
  // as plain text; otherwise the session's own view shows it.
  if (e.view.state === 'request' && blockedOnAlex(s)) {
    return <p className="c-now">{e.waitingOn ? (e.waitingLastLine ? `Last line: "${e.waitingOn}"` : e.waitingOn) : 'Open the session to see what it needs.'}</p>
  }
  const tool = s.toolCalls?.value.filter(c => c.agentId === null).at(-1)
  if (e.view.state === 'working' && tool) {
    return (
      <p className="c-now">
        <em>⚙ {tool.tool}</em>
        {tool.detail ? ` ${tool.detail}` : ''}
      </p>
    )
  }
  // Until the Arbiter summarizes (N3), the last answer itself, prefixed on your-turn cards (spec §5.3 item 6, §13).
  // The model's summary of this turn when the category allows it, else the answer's first line (MIP2-1422).
  const answer = e.summary ?? s.turn?.value.lastAnswer
  if (answer && e.view.state !== 'working' && e.view.state !== 'asked') {
    return (
      <p className="c-now">
        {e.view.state === 'turn' || e.view.state === 'idle' ? <em>Last turn: </em> : null}
        {answer}
      </p>
    )
  }
  if (e.view.state === 'asked') {
    const sent = s.peerMessages?.value.filter(m => m.direction === 'sent').at(-1)
    if (sent) return <p className="c-now">{sent.preview}</p>
  }
  return null
}

/**
 * Whether the card may approve right now (gate run 2, M-2): main's refusal
 * first, then the box's measured height, then the whole ask on screen.
 * `too-tall` and a refusal hide Allow; `off-screen` shows it disabled.
 */
export function approveState(refusal: string | null | 'none', fits: boolean, visible: boolean): 'refused' | 'too-tall' | 'off-screen' | 'ready' {
  if (refusal !== null) return 'refused'
  if (!fits) return 'too-tall'
  return visible ? 'ready' : 'off-screen'
}


/** Whether the fields fit the card's line limit; a long line that wraps counts once. */
export function withinLines(fields: readonly { value: string }[]): boolean {
  return fields.reduce((n, f) => n + f.value.split('\n').length, 0) <= CARD_APPROVE_LINES
}

/** Whether the ask on the card is the one last seen whole (pass 4, L-3). */
export function seenWhole(visibleFor: string | null, requestId: string | undefined): boolean {
  return requestId !== undefined && visibleFor === requestId
}

/** The request seen whole after an observer reading for `id`: it, once fully in view; nothing, once it leaves. */
export function nextSeen(prev: string | null, id: string, ratio: number): string | null {
  return ratio >= 1 ? id : prev === id ? null : prev
}

/**
 * What the session waits on Alex for, and the card's answer (spec §6, D-010):
 * a tool permission (Allow, Deny) or a single-choice question (its options).
 * Anything else, or a prompt the mod didn't offer, shows Open ↗ only.
 */
export function AskBlock({ e, onOpen, armed }: { e: Entry; onOpen: (sessionId: string) => void; armed: boolean }) {
  const ask = e.session.pendingRequests?.value[0]
  // Approving needs all of the request on screen (gate run 2, M-2): at most 8 lines by newline, and the
  // whole ask block inside the viewport, which covers wrapping (MIP2-1442). Main counts the same lines.
  const boxRef = useRef<HTMLDivElement>(null)
  // Visibility belongs to the request it was seen for, so a new ask starts unseen in its first render: the
  // last one's visibility can't approve it (gate run 3, L-2; pass 4, L-3).
  const [visibleFor, setVisibleFor] = useState<string | null>(null)
  const visible = seenWhole(visibleFor, ask?.requestId)
  const fits = ask ? withinLines(ask.fields) : true
  useEffect(() => {
    const el = boxRef.current
    const id = ask?.requestId
    if (!el || !id || typeof IntersectionObserver === 'undefined') return
    const io = new IntersectionObserver(([en]) => setVisibleFor(v => nextSeen(v, id, en?.intersectionRatio ?? 0)), { threshold: [0, 1] })
    io.observe(el)
    return () => io.disconnect()
  }, [ask?.requestId])
  const approve = approveState(ask ? ask.refusal : 'none', fits, visible)
  const [sent, setSent] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const open = (
    <button className="ab ghost" onClick={() => onOpen(e.session.sessionId)}>
      Open ↗
    </button>
  )
  const answer = async (a: Parameters<typeof window.ccc.answer>[1]) => {
    if (!ask) return
    setError(null)
    const r = await window.ccc.answer(ask.requestId, a)
    if (r.ok) {
      // Answering is activity (MIP2-1370 §4.1).
      void window.ccc.markSeen(e.session.sessionId)
      setSent(ask.requestId)
      setTimeout(() => setSent(null), 1500)
    } else setError(r.error)
  }

  // Y, N and 1–4 work only on the card armed with Space (spec §6, MIP2-1398 §7).
  useEffect(() => {
    if (!armed || !ask) return
    const onKey = (ev: KeyboardEvent) => {
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return
      const q = ask.questions?.[0]
      // Y approves only what the card shows in full and on screen (gate H-1, run 2 M-2).
      if (!ask.questions && (ev.key === 'y' || ev.key === 'Y') && approve === 'ready') void answer({ verdict: 'allow' })
      else if (!ask.questions && (ev.key === 'n' || ev.key === 'N')) void answer({ verdict: 'deny' })
      else if (q && ask.questions?.length === 1 && /^[1-4]$/.test(ev.key)) {
        const label = q.options[Number(ev.key) - 1]
        if (label) void answer({ verdict: 'allow', answers: { [q.question]: label } })
      } else return
      ev.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  if (sent && sent === ask?.requestId) {
    return (
      <div className="ask">
        <span className="k">Sent</span>
      </div>
    )
  }
  if (ask?.questions) {
    // One question answers from the card; several open the session (each needs an answer).
    const single = ask.questions.length === 1 ? ask.questions[0]! : null
    return (
      <div className="ask" ref={boxRef}>
        <span className="k">Asks</span>
        {ask.questions.map(q => (
          <div key={q.question}>{q.question}</div>
        ))}
        <div className="acts">
          {single?.options.map((o, i) => (
            <button key={o} className={`ab${i === 0 ? ' pri' : ''}`} onClick={() => void answer({ verdict: 'allow', answers: { [single.question]: o } })}>
              {i + 1}. {o}
            </button>
          ))}
          {open}
        </div>
        {error && <span className="ask-err">{error}</span>}
      </div>
    )
  }
  if (ask) {
    // Every field in full, so Allow approves exactly what's shown; when the card can't show it all, only Open and Deny (gate H-1).
    return (
      <div className="ask" ref={boxRef}>
        <span className="k">Wants to run · {ask.tool}</span>
        {/* Approvable means all of it is on view: that box doesn't scroll (ruling on MIP2-1428). */}
        <dl className={`ask-input${ask.refusal === null ? ' whole' : ''}`} tabIndex={0} aria-label="What it will run">
          {ask.fields.map(f => (
            <div key={f.name}>
              <dt>{f.name}</dt>
              <dd>{f.value}</dd>
            </div>
          ))}
        </dl>
        {ask.refusal && <span className="ask-why">{ask.refusal}</span>}
        {approve === 'too-tall' && <span className="ask-why">Too long to approve from the card; answer it in the session.</span>}
        <div className="acts">
          {(approve === 'ready' || approve === 'off-screen') && (
            <button
              className="ab pri"
              disabled={approve !== 'ready'}
              title={approve === 'off-screen' ? 'Scroll the whole request into view to approve it.' : undefined}
              onClick={() => approve === 'ready' && void answer({ verdict: 'allow' })}
            >
              Allow
            </button>
          )}
          <button className="ab" onClick={() => void answer({ verdict: 'deny' })}>
            Deny
          </button>
          {open}
        </div>
        {error && <span className="ask-err">{error}</span>}
      </div>
    )
  }
  // A job with no process waiting on something in the session (MIP2-1558): Claude Code's words, or a plain line until
  // it gives some. Opened, never answered here.
  const job = e.session.jobNeeds
  if (job && e.session.pid.value === null) {
    const said = job.value ? job.value.charAt(0).toUpperCase() + job.value.slice(1) : null
    return (
      <div className="ask">
        <span className="k">WAITING IN THE SESSION</span>
        <span>{said ?? 'Something in the session needs you. Open it to see what.'}</span>
        <div className="acts">{open}</div>
      </div>
    )
  }
  const detail = e.session.needsYou.value?.detail
  return (
    <div className="ask">
      <span className="k">{detail ?? 'Waiting on you'}</span>
      <span>Answer in the session.</span>
      <div className="acts">{open}</div>
    </div>
  )
}

/** `⚒ <n> contractors` and its tray (MIP2-1393 §4.1): one row per live contractor. */
function ContractorTray({ e, now, onOpen }: { e: Entry; now: number; onOpen: (sessionId: string) => void }) {
  return (
    <div className="tray" onClick={ev => ev.stopPropagation()}>
      {e.children.map(c => (
        <div key={c.session.sessionId} className="tray-row" role="button" onClick={() => onOpen(c.session.sessionId)}>
          <Glyph kind={c.view.glyph} />
          <b>{c.name}</b>
          <span className="lbl">{c.view.label.toLowerCase()}</span>
          <span className="age">{c.since === null ? '' : age(now - c.since)}</span>
          <SessionMenu e={c} />
        </div>
      ))}
    </div>
  )
}

/** Trays stay open per card until the app restarts (§4.1). */
const openTrays = new Set<string>()

function LinksLine({ e, now, onOpen }: { e: Entry; now: number; onOpen: (sessionId: string) => void }) {
  const [tray, setTray] = useState(() => openTrays.has(e.session.sessionId))
  const toggle = () => {
    const next = !tray
    if (next) openTrays.add(e.session.sessionId)
    else openTrays.delete(e.session.sessionId)
    setTray(next)
  }
  const s = e.session
  const peers = [...new Set((s.peerMessages?.value ?? []).map(m => m.peer))]
  const calls = s.toolCalls?.value ?? []
  const local = calls.filter(c => !c.tool.startsWith('mcp__'))
  const outsideCalls = calls.filter(c => c.tool.startsWith('mcp__'))
  const files = s.filesWritten?.value.length ?? 0
  const items: React.ReactNode[] = []
  if (peers.length) items.push(<span key="peers">↔ {peers.join(', ')}</span>)
  if (e.view.askedPeer && e.view.askedAt !== null) {
    items.push(
      <span key="wait" className="wait">
        ⧗ asked {e.view.askedPeer} {age(now - e.view.askedAt)} ago, no reply since
      </span>,
    )
  }
  if (e.view.runningAgents) {
    items.push(
      <span key="agents">
        ⑂ {e.view.runningAgents} {e.view.runningAgents === 1 ? 'agent' : 'agents'}
      </span>,
    )
  }
  const oldest = local[0]
  if (oldest) items.push(<span key="tool">⚙ {oldest.tool} {age(now - oldest.startedAt)}</span>)
  if (outsideCalls.length) {
    const server = outsideCalls[0]!.tool.split('__')[1] ?? 'mcp'
    items.push(<span key="mcp">↗ {server} {outsideCalls.length}</span>)
  }
  if (files) {
    items.push(
      <span key="files" title={`${files} files written by Claude`}>
        ◫ {files} files
      </span>,
    )
  }
  if (e.children.length) {
    items.unshift(
      <button key="kids" type="button" className="link kids" aria-expanded={tray} onClick={ev => (ev.stopPropagation(), toggle())}>
        ⚒ {e.children.length} {e.children.length === 1 ? 'contractor' : 'contractors'}
      </button>,
    )
  }
  if (!items.length) return null
  return (
    <>
      <div className="c-links">{items}</div>
      {tray && e.children.length > 0 && <ContractorTray e={e} now={now} onOpen={onOpen} />}
    </>
  )
}

/** `compact`: the queue form in Focus's rail (spec L11): state line, name and ask block only. */
/** Bulk select (MIP2-1407): a checkbox on the card or row while Fleet is selecting, and ⌘- or ⇧-click at any time. */
export interface Selecting {
  /** Fleet is selecting: show the checkbox. */
  active: boolean
  on: boolean
  toggle: () => void
  /** True when the click was a selection gesture, so it doesn't open the session. */
  click: (ev: React.MouseEvent) => boolean
}

function SelectBox({ select }: { select?: Selecting }) {
  if (!select?.active) return null
  return <input type="checkbox" className="pick" checked={select.on} onChange={select.toggle} onClick={ev => ev.stopPropagation()} aria-label="Select" />
}

export function Card({ e, now, onOpen, compact = false, select }: { e: Entry; now: number; onOpen: (sessionId: string) => void; compact?: boolean; select?: Selecting }) {
  const { view, session: s } = e
  const flash = useFlash(view.state)
  /** Space on a focused needs-you card arms its answer keys; Esc or blur disarms (spec §6). */
  const [armed, setArmed] = useState(false)
  const lastState = view.label
  return (
    <article
      className={`card st-${view.state}${view.unreported ? ' unreported' : ''}${armed ? ' armed' : ''}${select?.on ? ' picked' : ''}`}
      style={{ '--frame': frameColor(e.cat) } as React.CSSProperties}
      {...dragProps(s.sessionId)}
      onContextMenu={openMenu}
      tabIndex={0}
      onKeyDown={ev => {
        if (ev.target !== ev.currentTarget) return
        if (ev.key === ' ' && NEEDS_YOU.has(view.state)) {
          ev.preventDefault()
          setArmed(true)
        } else if (ev.key === 'Escape') setArmed(false)
        else if (ev.key === 'Enter') onOpen(s.sessionId)
      }}
      onBlur={() => setArmed(false)}
      onClick={ev => {
        // A click on a control inside the card is that control's, not Open.
        if ((ev.target as HTMLElement).closest('button, .menu, input')) return
        if (!select?.click(ev)) onOpen(s.sessionId)
      }}
    >
      {flash > 0 && <span key={flash} className="flash-ring" style={{ '--flash': STATE_COLOR[view.state] } as React.CSSProperties} />}
      <div className="c-state">
        <Glyph kind={view.glyph} />
        <span className="lbl">{view.unreported ? `NO REPORT FOR ${age(now - s.activity.observedAt)} · LAST: ${lastState}` : lastState}</span>
        <span className="age">{stateAge(e, now)}</span>
      </div>
      <div className="c-name">
        <SelectBox select={select} />
        <b>{e.name}</b>
        <NeverMark e={e} />
        {e.contractor ? <ContractorTag e={e} /> : <CatChip e={e} />}
        {e.inElectron ? <span className="outside" title="Running in CC Command Center 0.24. Move it in from its menu.">in CCC 0.24</span> : view.outside && !e.contractor && <span className="outside">outside the app</span>}
        {e.origin && <span className="ctag">{e.origin}</span>}
        <span className="spacer" />
        <SessionMenu e={e} />
      </div>
      {!compact && (
        <>
          <div className="c-path" title={s.cwd.value}>
            <span>{tildify(s.cwd.value)}</span>
          </div>
          {view.outside ? (
            <div className="c-outside">Started outside the app, so only its state and folder are shown.</div>
          ) : (
            <MetaLine s={s} now={now} />
          )}
          <NowLine e={e} />
        </>
      )}
      {/* The Arbiter's first pick only, named from the app's evidence (UX, MIP2-1411 review). */}
      {NEEDS_YOU.has(view.state) && e.arbiterStart && <div className="arb-reason">★ Start here · unblocks {e.arbiterStart.join(', ')}</div>}
      {NEEDS_YOU.has(view.state) && <AskBlock e={e} onOpen={onOpen} armed={armed} />}
      {!compact && <LinksLine e={e} now={now} onOpen={onOpen} />}
    </article>
  )
}

export function SessionRow({ e, now, onOpen, select }: { e: Entry; now: number; onOpen: (sessionId: string) => void; select?: Selecting }) {
  const { view, session: s } = e
  const when = s.turn?.value.endedAt ?? e.since
  return (
    <article
      className={`card row st-${view.state}${view.unreported ? ' unreported' : ''}${select?.on ? ' picked' : ''}`}
      {...dragProps(s.sessionId)}
      onContextMenu={openMenu}
      onClick={ev => (ev.target as HTMLElement).closest('button, .menu, input') || select?.click(ev) || onOpen(s.sessionId)}
    >
      <SelectBox select={select} />
      <Glyph kind={view.glyph} />
      <b>{e.name}</b>
      <NeverMark e={e} />
      {e.contractor ? <ContractorTag e={e} /> : <CatChip e={e} />}
      {e.inElectron ? <span className="outside" title="Running in CC Command Center 0.24. Move it in from its menu.">in CCC 0.24</span> : view.outside && !e.contractor && <span className="outside">outside the app</span>}
      <span className="c-path" title={s.cwd.value}>
        <span>{tildify(s.cwd.value)}</span>
      </span>
      <span className="age">
        {/* An assumed-dead row counts down to roll-off (MIP2-1370 §4.1). */}
        {e.life.stage === 'dead' ? `rolls off in ${Math.max(1, Math.ceil((e.life.rollsOffAt - now) / 86_400_000))}d` : when === null ? view.label.toLowerCase() : age(now - when)}
      </span>
      <SessionMenu e={e} />
    </article>
  )
}
