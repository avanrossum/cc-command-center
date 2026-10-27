// The first run (MIP2-1412; spec MIP2-1370 §14, MIP2-1379 §4): four steps,
// each skippable. Nothing here changes Claude Code's settings except step
// 1, on Alex's press, after a backup.

import { useEffect, useState } from 'react'
import type { FirstRunInfo, ImportParts } from '../../shared/ipc.ts'
import { tildify } from '../model/format.ts'

const PARTS: [keyof ImportParts, string][] = [
  ['categories', 'Categories'],
  ['sessions', 'Session names, aliases and categories'],
  ['defaults', 'Launch defaults'],
  ['prefs', 'Terminal font, notifications, recent folders'],
]

export function FirstRun({ electronRunning, onDone, onReview, onMove }: { electronRunning: number; onDone: () => void; onReview: () => void; onMove: () => void }) {
  const [info, setInfo] = useState<FirstRunInfo | null>(null)
  const [step, setStep] = useState(1)
  const [busy, setBusy] = useState(false)
  const [line, setLine] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [parts, setParts] = useState<ImportParts>({ categories: true, sessions: true, defaults: true, prefs: true })
  const [key, setKey] = useState('')
  const [cap, setCap] = useState('1.00')

  useEffect(() => void window.ccc.firstRunInfo().then(setInfo), [])
  if (!info || info.done) return null

  const next = () => (setStep(s => s + 1), setLine(null), setError(null))
  const act = async (fn: () => Promise<{ ok: boolean; error?: string }>, done?: (r: never) => string, advance = true) => {
    setBusy(true)
    setError(null)
    const r = await fn()
    setBusy(false)
    if (!r.ok) return setError(r.error ?? 'Something went wrong.')
    if (done) setLine(done(r as never))
    if (advance && !done) next()
  }
  const n = info.mailboxRules.length

  return (
    <div className="sheet-veil">
      <div className="sheet first-run" role="dialog" aria-label="First run">
        <div className="fr-step">{step} of 4</div>

        {step === 1 && (
          <>
            <h2>Remove the old mailbox</h2>
            {n === 0 ? (
              <p>Your Claude Code settings don't grant the old CC Command Center mailbox. Nothing to remove.</p>
            ) : (
              <>
                <p>Claude Code now has its own peer messaging. Your global settings still grant the CC Command Center mailbox:</p>
                <ul className="mono fr-rules">
                  {info.mailboxRules.map(r => (
                    <li key={r}>{r}</li>
                  ))}
                </ul>
                <p className="note">
                  In {tildify(info.settingsFile)}. The app backs the file up first and changes nothing else in it. The status hooks and ~/.claude/ccc/usage/
                  stay for the usage governor.
                </p>
              </>
            )}
            {line && <p className="fr-done">{line}</p>}
            <div className="sheet-acts">
              <span className="spacer" />
              {n > 0 && !line ? (
                <>
                  <button type="button" className="fchip" onClick={next}>
                    Keep for now
                  </button>
                  <button
                    type="button"
                    className="fchip on"
                    disabled={busy}
                    onClick={() =>
                      void act(
                        () => window.ccc.removeMailboxRules(),
                        (r: { removed: string[]; backup: string | null }) =>
                          `Removed ${r.removed.length === 1 ? 'the rule' : `the ${r.removed.length} rules`}. The backup is ${tildify(r.backup ?? '')}.`,
                      )
                    }
                  >
                    {n === 2 ? 'Remove the two rules' : n === 1 ? 'Remove the rule' : `Remove the ${n} rules`}
                  </button>
                </>
              ) : (
                <button type="button" className="fchip on" onClick={next}>
                  Next
                </button>
              )}
            </div>
          </>
        )}

        {step === 2 && (
          <>
            <h2>Bring over your settings</h2>
            {info.importAvailable ? (
              <>
                <p>From CC Command Center 0.24, read-only. Electron can stay open.</p>
                {PARTS.map(([k, label]) => (
                  <label key={k} className="check">
                    <input type="checkbox" checked={parts[k]} disabled={!!line} onChange={e => setParts(p => ({ ...p, [k]: e.target.checked }))} />
                    {label}
                  </label>
                ))}
              </>
            ) : (
              <p>CC Command Center 0.24's settings aren't on this Mac, so there's nothing to bring over.</p>
            )}
            {line && (
              <p className="fr-done">
                {line}{' '}
                {/^Assigned [1-9]/.test(line) && (
                  <button type="button" className="link" onClick={onReview}>
                    Review
                  </button>
                )}
              </p>
            )}
            <div className="sheet-acts">
              <span className="spacer" />
              {info.importAvailable && !line ? (
                <>
                  <button type="button" className="fchip" onClick={next}>
                    Skip
                  </button>
                  <button
                    type="button"
                    className="fchip on"
                    disabled={busy || !Object.values(parts).some(Boolean)}
                    onClick={() =>
                      void act(
                        () => window.ccc.importSettings(parts),
                        (r: { summary: { assigned: number; uncategorized: number } }) =>
                          `Assigned ${r.summary.assigned} of ${r.summary.uncategorized} uncategorized sessions by folder.`,
                      )
                    }
                  >
                    {busy ? 'Importing…' : 'Import selected'}
                  </button>
                </>
              ) : (
                <button type="button" className="fchip on" onClick={next}>
                  Next
                </button>
              )}
            </div>
          </>
        )}

        {step === 3 && (
          <>
            <h2>Sessions in CC Command Center 0.24</h2>
            <p>
              {electronRunning === 0
                ? 'No sessions are running in CC Command Center 0.24.'
                : `${electronRunning} session${electronRunning === 1 ? ' is' : 's are'} running in CC Command Center 0.24. ${electronRunning === 1 ? 'It stays' : 'They stay'} there until the cutover, when you move ${electronRunning === 1 ? 'it' : 'them'} in.`}
            </p>
            <div className="sheet-acts">
              <span className="spacer" />
              {electronRunning > 0 && (
                <button type="button" className="fchip" onClick={onMove} title="Opens the move sheet; the first run picks up here next time">
                  Show them
                </button>
              )}
              <button type="button" className="fchip on" onClick={next}>
                Later
              </button>
            </div>
          </>
        )}

        {step === 4 && (
          <>
            <h2>Arbiter</h2>
            <p>The Arbiter runs in the app and decides which waiting session to answer first. It uses your Anthropic API key, encrypted on this Mac with a key kept in your Keychain.</p>
            <label>
              Anthropic API key
              <input
                type="password"
                value={key}
                onChange={e => setKey(e.target.value)}
                placeholder={info.arbiterKeySet ? 'A key is saved. Enter a new one to replace it.' : 'sk-ant-…'}
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <label>
              Daily cap, US dollars
              <input value={cap} onChange={e => setCap(e.target.value)} inputMode="decimal" />
            </label>
            <p className="note">Redaction is on: the Arbiter reads session text only in categories that allow it. Session and category names are sent for every category.</p>
            <div className="sheet-acts">
              <span className="spacer" />
              <button
                type="button"
                className="fchip on"
                disabled={busy}
                onClick={async () => {
                  const capUsd = Number(cap)
                  if (!Number.isFinite(capUsd) || capUsd < 0 || capUsd > 100) return setError('The cap is a dollar amount from 0 to 100.')
                  if (key.trim()) {
                    setBusy(true)
                    const r = await window.ccc.setArbiterKey(key)
                    setBusy(false)
                    if (!r.ok) return setError(r.error)
                    setKey('')
                  }
                  await act(() => window.ccc.finishFirstRun({ capUsd, arbiterEnabled: true }), undefined, false)
                  onDone()
                }}
              >
                Finish
              </button>
            </div>
          </>
        )}
        {error && <div className="sheet-err">{error}</div>}
      </div>
    </div>
  )
}
