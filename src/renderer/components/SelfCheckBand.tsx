// The band that says what a Claude Code update broke (DECISION item 4, D-014:
// a dismissible band plus field marks). It shows only when a check failed on
// the installed version; dismissing it hides it for that version.

import { useState } from 'react'
import type { SelfCheckReport } from '@ccc/contract'
import { age } from '../model/format.ts'
import { useStore } from './Categories.tsx'

const KEY = 'ccc.selfCheckDismissed'

function dismissedVersion(): string | null {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

/**
 * The security alerts, every failing one at once, by consequence: a
 * replaced channel, a changed mod, then a session that would reload one
 * (gate run 3, M-4). None can be dismissed. A changed mod can't hide its
 * own alert behind a reload alert it reports.
 */
const SECURITY: { id: string; title: string; body: string }[] = [
  {
    id: 'channel-sockets',
    title: "A session's channel to the app was moved or replaced by another process.",
    body: "The app stopped these sessions and won't answer them from cards. Resuming one from the app gives its channel a new secret first.",
  },
  {
    id: 'mod-integrity',
    title: "The reporter mod's files were changed outside the app.",
    body: "Sessions started on it may still run it, and it can answer their permission prompts. Where the app set the copy aside and put the shipped files back, stop those sessions and resume them. Where it couldn't move the copy, new sessions start from a fresh one, and a resume would restart on the changed copy, so the app refuses it: stop those sessions and start a copy of each.",
  },
  {
    id: 'stray-sessions',
    title: "Claude Code started a session the app can't account for.",
    body: "It may run without the app's settings and deny rules. Find it in the session list and stop it unless you started it. This clears once it's gone from the list.",
  },
  {
    id: 'supervisor-path',
    title: "Some running sessions can't find claude or your tools.",
    body: "They were started without your PATH. Resume restarts one with your PATH once it isn't working or waiting on you.",
  },
  {
    id: 'mod-reload',
    title: 'Some sessions may reload the reporter mod while they run.',
    body: "Either a session's mod reports that reload is on, or the app couldn't confirm Claude Code's supervisor was running when it started a session, so that session's switch is only in its settings file. A change to the mod's folder would then load while it runs. Resuming the session from the app restarts it with the switch. This comes from what each session's mod reports, so it's advisory.",
  },
]

/** The failing security items, in SECURITY order, for Fleet's bands and Focus's strip alike (spec MIP2-1379 §7.3). */
export function failingSecurity(report: SelfCheckReport | null): { id: string; title: string; body: string; detail: string | null }[] {
  return SECURITY.flatMap(a => {
    const c = report?.checks.find(x => x.id === a.id && x.state === 'fail')
    return c ? [{ ...a, detail: c.detail }] : []
  })
}

/**
 * The alerts, each naming its sessions where the report says which
 * (MIP2-1518): a marked channel's session by name, category and folder, with
 * Open and Resume, or Start a copy once a resume is refused, or Clear when
 * the session no longer exists; a session without your PATH with Resume,
 * held while it works or waits on you. Other items keep their detail line.
 */
export function SecurityBands({ report, rows = new Map(), onOpen = () => {} }: { report: SelfCheckReport | null; rows?: ReadonlyMap<string, ChannelRow>; onOpen?: (sessionId: string) => void }) {
  const failing = failingSecurity(report)
  return (
    <>
      {failing.map(a => (
        <div key={a.id} className="band sec" role="alert">
          <div className="band-t">
            <b>{a.id === 'supervisor-path' && report?.pathMissing?.length ? <PathTitle n={report.pathMissing.length} /> : a.title}</b> {a.body}
            {a.id === 'channel-sockets' && report?.untrusted ? (
              <ul className="band-d">
                {report.untrusted.map((u, i) => (
                  <MarkedRow key={u.sessionId ?? `none-${i}`} sessionId={u.sessionId} why={u.why} row={u.sessionId ? rows.get(u.sessionId) : undefined} onOpen={onOpen} />
                ))}
              </ul>
            ) : a.id === 'supervisor-path' && report?.pathMissing ? (
              <ul className="band-d">
                {report.pathMissing.map(id => (
                  <PathRow key={id} sessionId={id} row={rows.get(id)} />
                ))}
                {report.supervisorPathLacking && <li className="band-note">Sessions Claude Code restarts by itself will also lack your PATH until the supervisor restarts.</li>}
              </ul>
            ) : (
              a.detail && (
                <ul className="band-d">
                  <li>{a.detail}</li>
                </ul>
              )
            )}
          </div>
        </div>
      ))}
      {/* No running session affected: a plain line, not a warning (MIP2-1518, UX review). */}
      {report?.supervisorPathLacking && !report.pathMissing?.length && (
        <div className="band info" role="status">
          <div className="band-t">
            Claude Code's background supervisor doesn't have your PATH. No running session is affected; sessions it restarts by itself will be until the supervisor restarts.
          </div>
        </div>
      )}
    </>
  )
}

/** The PATH alert's title, counting the sessions, with the command in mono (UX review on MIP2-1518). */
function PathTitle({ n }: { n: number }) {
  return (
    <>
      {n === 1 ? 'A running session' : `${n} running sessions`} can't find <code>claude</code> or your tools.
    </>
  )
}

/** A session by name, category and folder; by its short id only when the app doesn't list it (MIP2-1518). */
function Who({ sessionId, row }: { sessionId: string | null; row: ChannelRow | undefined }) {
  if (!row) return <span title={sessionId ?? undefined}>{sessionId ? `Session ${sessionId.slice(0, 8)}` : 'A session the app launched'}</span>
  return (
    <span title={sessionId ?? undefined}>
      <b>{row.name}</b>
      {row.category && (
        <>
          {' '}
          <i className="sq" style={{ '--cat': row.category.color } as React.CSSProperties} /> {row.category.label}
        </>
      )}
      {row.cwd && <span className="mono"> · {row.cwd}</span>}
    </span>
  )
}

function MarkedRow({ sessionId, why, row, onOpen }: { sessionId: string | null; why: string; row: ChannelRow | undefined; onOpen: (id: string) => void }) {
  const api = useStore()
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  if (!row) {
    // The name the app still has for it, archived and removed sessions keep theirs (UX review on MIP2-1518).
    const meta = sessionId ? api.store?.sessions[sessionId] : undefined
    const status = meta?.removedAt ? 'removed' : meta?.archivedAt || meta?.rolledOffAt ? 'archived' : 'gone from Claude Code'
    return (
      <li title={why}>
        {meta?.name ? <b>{meta.name}</b> : <Who sessionId={sessionId} row={row} />} · no longer exists ({status}){' '}
        {sessionId && (
          <button
            className="fchip"
            title="Removes it from this alert. It can't run, so it's no longer a risk."
            disabled={busy}
            onClick={async () => {
              setBusy(true)
              const r = await window.ccc.clearGoneMark(sessionId)
              setBusy(false)
              if (!r.ok) api.notice(`Not cleared: ${r.error}`)
            }}
          >
            Clear
          </button>
        )}
      </li>
    )
  }
  const id = sessionId!
  return (
    <li>
      <Who sessionId={id} row={row} /> · {why}{' '}
      {/* Open on a stopped session resumes it the same way, so a stopped one shows Resume only (UX review). */}
      {row.running && (
        <>
          <button className="fchip" onClick={() => onOpen(id)}>
            Open
          </button>{' '}
        </>
      )}
      {refused ? (
        <>
          <button className="fchip" title={refused} onClick={() => api.openSheet('resume', id)}>
            Start a copy
          </button>
        </>
      ) : (
        <button
          className="fchip"
          disabled={busy}
          title="Gives its channel a new secret and resumes it."
          onClick={async () => {
            setBusy(true)
            const r = await window.ccc.resume(id)
            setBusy(false)
            if (!r.ok) setRefused(r.error)
          }}
        >
          {busy ? 'Resuming…' : 'Resume'}
        </button>
      )}
    </li>
  )
}

function PathRow({ sessionId, row }: { sessionId: string; row: ChannelRow | undefined }) {
  const [busy, setBusy] = useState(false)
  const held = row?.busy === true
  return (
    <li>
      <Who sessionId={sessionId} row={row} />{' '}
      <button
        className="fchip"
        disabled={held || busy}
        title={held ? "Resuming now would interrupt it. Available once it's done working and isn't waiting on you." : 'Restarts it with your PATH.'}
        onClick={async () => {
          setBusy(true)
          await window.ccc.resume(sessionId)
          setBusy(false)
        }}
      >
        {busy ? 'Resuming…' : 'Resume'}
      </button>
    </li>
  )
}

/**
 * Focus's security strip (spec MIP2-1379 §7.3): one line per failing item,
 * between the session header and the panes, in every pane state and across
 * session switches. Nothing dismisses it. Details expands in place, then
 * hands focus back to the terminal so typing still reaches the session.
 */
export function SecurityStrip({ report, onFocusBack }: { report: SelfCheckReport | null; onFocusBack: () => void }) {
  const [open, setOpen] = useState(false)
  const failing = failingSecurity(report)
  if (!failing.length) return null
  const toggle = () => {
    setOpen(o => !o)
    onFocusBack()
  }
  return (
    <div className={`sec-strip${open ? ' open' : ''}`}>
      {failing.map((a, i) => (
        <div key={a.id} className="sec-line" role="alert">
          <span className="sec-k">Security</span>
          <span className="sec-t" title={a.title}>
            {a.title}
          </span>
          {i === 0 && (
            <button className="fchip" onClick={toggle} onMouseDown={e => e.preventDefault()} aria-expanded={open}>
              {open ? 'Hide details' : 'Details'}
            </button>
          )}
        </div>
      ))}
      {open && (
        <div className="sec-more">
          {failing.map(a => (
            <p key={a.id}>
              <b>{a.title}</b> {a.body}
              {a.detail && <span className="sec-d"> {a.detail}</span>}
            </p>
          ))}
        </div>
      )}
    </div>
  )
}

/** What the channel band needs to know about a listed session (MIP2-1488). */
export interface ChannelRow {
  name: string
  /** For the security alerts' rows (MIP2-1518). */
  category?: { label: string; color: string }
  cwd?: string
  /** Working, or waiting on you: a resume would interrupt it, so PATH's Resume is held. */
  busy?: boolean
  /** It has a process: Restart stops it and resumes it through the app. Otherwise Resume. */
  running: boolean
  /** Waiting on a permission: a restart would end the wait, so it isn't offered (Research, MIP2-1488). */
  waiting: boolean
}

export function SelfCheckBand({
  report,
  rows = new Map(),
  now = Date.now(),
  onOpen = () => {},
}: {
  report: SelfCheckReport | null
  /** Listed sessions by id, for the channel band. */
  rows?: ReadonlyMap<string, ChannelRow>
  now?: number
  onOpen?: (sessionId: string) => void
}) {
  return (
    <>
      <SecurityBands report={report} rows={rows} onOpen={onOpen} />
      <ChannelBand report={report} rows={rows} now={now} />
      <UpdateBand report={report} />
    </>
  )
}

const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })

/**
 * What may have cut the sessions off: a Claude Code install or a supervisor
 * start after the oldest of them reached the app's channel list. The app
 * infers it from timing, so it reads as likely; null when it saw neither
 * (MIP2-1488).
 */
export function channelCause(report: SelfCheckReport): string | null {
  const since = Math.min(...(report.unconnected ?? []).map(u => u.since))
  const { claudeInstalledAt, supervisorStartedAt } = report.causes ?? { claudeInstalledAt: null, supervisorStartedAt: null }
  const installed = claudeInstalledAt !== null && claudeInstalledAt > since
  const restarted = supervisorStartedAt !== null && supervisorStartedAt > since
  const claude = report.claudeVersion ? `Claude Code ${report.claudeVersion}` : 'Claude Code'
  if (installed && restarted) return `Likely cause: ${claude} was installed at ${time(claudeInstalledAt)}, and its background supervisor restarted at ${time(supervisorStartedAt)}.`
  if (installed) return `Likely cause: ${claude} was installed at ${time(claudeInstalledAt)}.`
  if (restarted) return `Likely cause: Claude Code's background supervisor restarted at ${time(supervisorStartedAt)}.`
  return null
}

/**
 * Sessions whose mod hasn't reached the app (MIP2-1488), by name and how
 * long. A running session's mod comes back by itself within a minute once
 * the app can hear it, so Check again starts the deadline over. One that
 * doesn't needs a new process: Restart stops it and resumes it through the
 * app (resume.ts), and an ended one gets Resume. Opening only attaches,
 * which doesn't reload the mod. Copy: UX review on MIP2-1488.
 */
export function ChannelBand({ report, rows, now }: { report: SelfCheckReport | null; rows: ReadonlyMap<string, ChannelRow>; now: number }) {
  const [busy, setBusy] = useState(false)
  const [restarting, setRestarting] = useState<ReadonlySet<string>>(new Set())
  const failed = report?.checks.some(c => c.id === 'channel' && c.state === 'fail')
  const list = report?.unconnected ?? []
  if (!report || !failed || !list.length) return null
  const cause = channelCause(report)
  const again = async () => {
    setBusy(true)
    try {
      await window.ccc.channelCheckAgain()
    } finally {
      setBusy(false)
    }
  }
  const restart = async (id: string) => {
    setRestarting(r => new Set([...r, id]))
    try {
      await window.ccc.resume(id)
    } finally {
      setRestarting(r => new Set([...r].filter(x => x !== id)))
    }
  }
  return (
    <div className="band" role="status">
      <div className="band-t">
        <b>{list.length === 1 ? "A session isn't connected to the app." : `${list.length} sessions aren't connected to the app.`}</b> Answering from cards and sending prompts are
        off for {list.length === 1 ? 'it until it connects' : 'these sessions until they connect'}; other sessions aren't affected. {list.length === 1 ? 'It shows' : 'They show'} their own permission dialogs meanwhile. {cause ? `${cause} ` : ''}Running
        sessions usually reconnect by themselves within a minute. If one stays listed, press Check again, then restart it from its row.
        <ul className="band-d">
          {list.map((u, i) => {
            if (!u.sessionId) return <li key={`new-${i}`}>A session the app launched at {time(u.since)}</li>
            const id = u.sessionId
            const row = rows.get(id)
            return (
              <li key={id}>
                {row?.name ?? `Session ${id.slice(0, 8)}`} · {age(now - u.since)}{' '}
                {row?.running ? (
                  <button
                    className="fchip"
                    disabled={row.waiting || restarting.has(id)}
                    title={row.waiting ? 'Waiting on a permission: answer it in the session first. A restart would end the wait.' : 'Stops this session and resumes it in the app. The conversation is kept.'}
                    onClick={() => void restart(id)}
                  >
                    {restarting.has(id) ? 'Restarting…' : 'Restart'}
                  </button>
                ) : (
                  <button className="fchip" disabled={restarting.has(id)} onClick={() => void restart(id)}>
                    {restarting.has(id) ? 'Resuming…' : 'Resume'}
                  </button>
                )}
              </li>
            )
          })}
        </ul>
      </div>
      <button className="fchip" onClick={() => void again()} disabled={busy}>
        {busy ? 'Checking…' : 'Check again'}
      </button>
    </div>
  )
}

/** What a Claude Code update broke, dismissible per version. */
function UpdateBand({ report }: { report: SelfCheckReport | null }) {
  const [dismissed, setDismissed] = useState(dismissedVersion)
  const [details, setDetails] = useState(false)
  if (!report || dismissed === report.claudeVersion) return null
  if (report.state === 'too-old') {
    return (
      <div className="band" role="status">
        <div className="band-t">
          <b>Claude Code {report.claudeVersion} is older than this app supports. Update Claude Code.</b> Until then the app only shows sessions: starting,
          opening and answering them are off.
        </div>
      </div>
    )
  }
  if (report.state !== 'degraded') return null
  const failed = report.checks.filter(c => c.state === 'fail')
  // A channel-only failure isn't an update's doing; the channel band says it (MIP2-1488).
  if (report.unconnected?.length && failed.every(c => c.id === 'channel' || SECURITY.some(a => a.id === c.id))) return null
  const off = report.controlOff.map(c => (c === 'card-answers' ? 'answering from cards' : 'sending prompts')).join(' and ')
  const dismiss = () => {
    try {
      localStorage.setItem(KEY, report.claudeVersion ?? '')
    } catch {
      // Hidden for this run only.
    }
    setDismissed(report.claudeVersion)
  }
  return (
    <div className="band" role="status">
      {/* The plain effect first; the checks that failed only under Details (UX, MIP2-1410 review). */}
      <div className="band-t">
        <b>Some session details may be out of date after the Claude Code {report.claudeVersion} update.</b>{' '}
        {off ? `${off[0]!.toUpperCase()}${off.slice(1)} ${report.controlOff.length > 1 ? 'are' : 'is'} off; sessions use their own dialogs.` : 'Details that may be wrong are marked.'}
        {details && (
          <ul className="band-d">
            {failed.map(c => (
              <li key={c.id}>
                {c.label}
                {c.detail ? `: ${c.detail}` : ''}
              </li>
            ))}
          </ul>
        )}
      </div>
      <button className="fchip" onClick={() => setDetails(d => !d)} aria-expanded={details}>
        {details ? 'Hide details' : 'Details'}
      </button>
      <button className="fchip" onClick={dismiss}>
        Dismiss
      </button>
    </div>
  )
}
