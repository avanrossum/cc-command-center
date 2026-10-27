// The band that says what a Claude Code update broke (DECISION item 4, D-014:
// a dismissible band plus field marks). It shows only when a check failed on
// the installed version; dismissing it hides it for that version.

import { useState } from 'react'
import type { SelfCheckReport } from '@ccc/contract'

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
    body: 'The app stopped the session and stopped answering it from cards. Resuming it from the app gives its channel a new secret first.',
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
    title: "Some background sessions may not find claude or your tools.",
    body: "Claude Code's background supervisor was started without your PATH. A session's commands use the PATH of whatever last started or restarted it: the app always gives yours, so sessions it launches, resumes or restarts are fine. A session started or restarted from somewhere else without your PATH isn't. Resume it from the app to fix it, or restart the supervisor once no session needs it.",
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

export function SecurityBands({ report }: { report: SelfCheckReport | null }) {
  const failing = failingSecurity(report)
  return (
    <>
      {failing.map(a => (
        <div key={a.id} className="band sec" role="alert">
          <div className="band-t">
            <b>{a.title}</b> {a.body}
            {a.detail && (
              <ul className="band-d">
                <li>{a.detail}</li>
              </ul>
            )}
          </div>
        </div>
      ))}
    </>
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

export function SelfCheckBand({ report }: { report: SelfCheckReport | null }) {
  return (
    <>
      <SecurityBands report={report} />
      <UpdateBand report={report} />
    </>
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
