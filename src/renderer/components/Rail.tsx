// The right rail in Fleet (spec MIP2-1370 §11): what is running across
// sessions now, the last 25 minutes of activity, and the Arbiter footer.

import type { SourceHealth } from '@ccc/contract'
import type { ArbiterState } from '../../shared/arbiter-state.ts'
import { NEEDS_YOU } from '../model/card-state.ts'
import type { Entry } from '../model/fleet.ts'
import { age, modelName } from '../model/format.ts'
import type { History } from '../model/history.ts'
import { Glyph } from './bits.tsx'
import { Card } from './Card.tsx'

function ActiveNow({ entries, now }: { entries: Entry[]; now: number }) {
  const groups = entries
    .map(e => ({
      e,
      agents: (e.session.subagents?.value ?? []).filter(a => a.status === 'running'),
      calls: e.session.toolCalls?.value ?? [],
      // Working contractors under their parent (MIP2-1393 §4.1).
      kids: e.children.filter(c => c.view.state === 'working'),
    }))
    .filter(g => !g.e.contractor && g.agents.length + g.calls.length + g.kids.length > 0)
  const running = groups.reduce((n, g) => n + g.agents.length + g.calls.length + g.kids.length, 0)
  return (
    <>
      <div className="rail-h">
        Active now <span>{running} running</span>
      </div>
      {groups.length === 0 && <div className="quiet">Nothing running in sessions that report through the app.</div>}
      {groups.map(({ e, agents, calls, kids }) => (
        <div key={e.session.sessionId} className="act">
          <div className="who">
            <Glyph kind={e.view.glyph} />
            <span>{e.name}</span>
          </div>
          {kids.map(c => (
            <div key={c.session.sessionId} className="it">
              <span className="ic">⚒</span>
              <span className="x">{c.name} · working</span>
              <span className="t">{c.since === null ? '' : age(now - c.since)}</span>
            </div>
          ))}
          {agents.map(a => (
            <div key={a.agentId} className="it">
              <span className="ic">⑂</span>
              <span className="x">
                {[a.type, a.model && modelName(a.model), a.description].filter(Boolean).join(' · ')}
              </span>
              <span className="t" />
            </div>
          ))}
          {calls.map(c => {
            const mcp = c.tool.startsWith('mcp__')
            const [, server, name] = c.tool.split('__')
            return (
              <div key={c.toolUseId} className="it">
                <span className="ic">{mcp ? '↗' : '⚙'}</span>
                <span className="x" title={c.detail ?? undefined}>
                  {mcp ? `${server} · ${name}` : c.detail ? `${c.tool}: ${c.detail}` : c.tool}
                </span>
                <span className="t">{age(now - c.startedAt)}</span>
              </div>
            )
          })}
        </div>
      ))}
    </>
  )
}

/** Cells that show a session doing something: working, or waiting on Alex. */
const BUSY = new Set(['working', 'approval', 'sandbox', 'request', 'question'])

function WhoActive({ entries, history, now }: { entries: Entry[]; history: History; now: number }) {
  // Only sessions with a working or needs-you cell in the window, most active first (UX item 10).
  const busy = (e: Entry) => history.strip(e.session.sessionId, now).filter(c => c !== null && BUSY.has(c)).length
  const rows = entries
    .map(e => ({ e, n: busy(e) }))
    .filter(r => r.n > 0)
    .sort((a, b) => b.n - a.n)
    .map(r => r.e)
  return (
    <>
      <div className="rail-h">
        Who's been active <span>last 25 min</span>
      </div>
      <div className="bars">
        {rows.length === 0 && <div className="quiet">No session has worked or waited on you in this window.</div>}
        {rows.map(e => (
          <div key={e.session.sessionId} className="bar">
            <span title={e.name}>{e.name}</span>
            <i>
              {history.strip(e.session.sessionId, now).map((c, i) => (
                <b key={i} className={c ? `s-${c}` : ''} />
              ))}
            </i>
          </div>
        ))}
      </div>
    </>
  )
}

export function Rail({
  entries,
  history,
  now,
  sources,
  arbiter,
  onArbiterLog,
}: {
  entries: Entry[]
  history: History
  now: number
  sources: SourceHealth[]
  arbiter: ArbiterState | null
  onArbiterLog: () => void
}) {
  const sorted = [...entries].sort((a, b) => Number(NEEDS_YOU.has(b.view.state)) - Number(NEEDS_YOU.has(a.view.state)))
  const failing = sources.filter(s => !s.ok && s.lastOkAt !== null)
  return (
    <aside className="rail">
      <div className="rail-scroll">
        <ActiveNow entries={sorted} now={now} />
        <WhoActive entries={sorted} history={history} now={now} />
      </div>
      {failing.map(s => (
        <div key={s.source} className="health" title={s.error ?? undefined}>
          {s.source} not answering · last ok {s.lastOkAt === null ? 'never' : `${age(now - s.lastOkAt)} ago`}
        </div>
      ))}
      {/* Spend against the cap; a click opens the log (D-014). */}
      <button type="button" className="arb" onClick={onArbiterLog} title="Arbiter log">
        <span>Arbiter · Haiku 5.5</span>
        {!arbiter || arbiter.status === 'off' ? (
          <span className="off">not set up</span>
        ) : (
          <span className={arbiter.status === 'capped' || arbiter.status === 'error' ? 'off' : ''}>
            {arbiter.status === 'error' ? 'error · ' : arbiter.status === 'capped' ? 'at cap · ' : ''}${arbiter.spentTodayUsd.toFixed(2)} / ${arbiter.capUsd.toFixed(2)} today
          </span>
        )}
      </button>
    </aside>
  )
}

/**
 * The right rail in Focus (spec L3, L11): the needs-you queue, answerable in
 * place without moving input focus (MIP2-1398 §7), then This session.
 */
export function FocusRail({ entries, focused, now, onOpen }: { entries: Entry[]; focused: string; now: number; onOpen: (sessionId: string) => void }) {
  const queue = entries
    .filter(e => NEEDS_YOU.has(e.view.state))
    .sort((a, b) => (a.view.knownSince ?? a.since ?? Infinity) - (b.view.knownSince ?? b.since ?? Infinity))
  const me = entries.find(e => e.session.sessionId === focused)
  const s = me?.session
  const agents = (s?.subagents?.value ?? []).filter(a => a.status === 'running')
  const calls = s?.toolCalls?.value ?? []
  const peers = [...(s?.peerMessages?.value ?? [])].reverse()
  const files = [...(s?.filesWritten?.value ?? [])].reverse()
  return (
    <aside className="rail">
      <div className="rail-scroll">
        <div className="rail-h">
          Needs you <span>{queue.length} · oldest first</span>
        </div>
        {queue.length === 0 && <div className="quiet">Nothing needs you.</div>}
        {queue.map(e => (
          <Card key={e.session.sessionId} e={e} now={now} onOpen={onOpen} compact />
        ))}
        {me && me.children.length > 0 && (
          <>
            {/* A contractor opens in Focus from here (MIP2-1393 §4.1). */}
            <div className="rail-h">
              Contractors <span>{me.children.length}</span>
            </div>
            <div className="act">
              {me.children.map(c => (
                <div key={c.session.sessionId} className="it link-row" role="button" onClick={() => onOpen(c.session.sessionId)}>
                  <span className="ic">⚒</span>
                  <span className="x">
                    {c.name} · {c.view.label.toLowerCase()}
                  </span>
                  <span className="t">{c.since === null ? '' : age(now - c.since)}</span>
                </div>
              ))}
            </div>
          </>
        )}
        <div className="rail-h">This session</div>
        {!s || (agents.length + calls.length + peers.length + files.length === 0) ? (
          <div className="quiet">{me?.view.outside ? 'Started outside the app: no reporter.' : 'Nothing running, no messages or files yet.'}</div>
        ) : (
          <div className="act">
            {agents.map(a => (
              <div key={a.agentId} className="it">
                <span className="ic">⑂</span>
                <span className="x">{[a.type, a.model && modelName(a.model), a.description].filter(Boolean).join(' · ')}</span>
                <span className="t" />
              </div>
            ))}
            {calls.map(c => (
              <div key={c.toolUseId} className="it">
                <span className="ic">{c.tool.startsWith('mcp__') ? '↗' : '⚙'}</span>
                <span className="x" title={c.detail ?? undefined}>
                  {c.detail ? `${c.tool}: ${c.detail}` : c.tool}
                </span>
                <span className="t">{age(now - c.startedAt)}</span>
              </div>
            ))}
            {peers.map(m => (
              <div key={`${m.at}-${m.direction}`} className="it">
                <span className="ic">↔</span>
                <span className="x" title={m.preview}>
                  {m.direction === 'sent' ? `to ${m.peer}` : `from ${m.peer}`} · {m.preview}
                </span>
                <span className="t">{age(now - m.at)}</span>
              </div>
            ))}
            {files.map(f => (
              <div key={f.path} className="it">
                <span className="ic">◫</span>
                <span className="x" title={f.path}>
                  {f.path.split('/').at(-1)}
                </span>
                <span className="t">{age(now - f.at)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  )
}
