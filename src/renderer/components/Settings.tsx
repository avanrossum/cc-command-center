// The settings sheet (⌘,; spec MIP2-1387 §4): sections on the left, as in
// macOS settings. General, Terminal, Notifications, Arbiter, Claude Code and
// About (MIP2-1407, MIP2-1424). Changes save as they're made.

import { useEffect, useState } from 'react'
import type { SelfCheckReport } from '@ccc/contract'
import type { AppStatus } from '../../shared/ipc.ts'
import { ARBITER_MODEL, type ArbiterState } from '../../shared/arbiter-state.ts'
import { TERMINAL_FONT_SIZE, terminalFont } from '../model/format.ts'
import { useStore } from './Categories.tsx'

const SECTIONS = ['General', 'Terminal', 'Notifications', 'Arbiter', 'Claude Code', 'About'] as const
type Section = (typeof SECTIONS)[number]

/** What `Copy build info` copies, for bug reports (§4.6). */
export function buildInfo(s: AppStatus, claudeVersion: string | null): string {
  return [
    `CC Command Center ${s.version} (build ${s.commit}${s.builtAt ? ` · ${s.builtAt.slice(0, 10)}` : ''})`,
    `Electron ${s.electron} · Chromium ${s.chrome} · Node ${s.node}`,
    `Claude Code ${claudeVersion ?? 'not found'} (supports ${s.floor} or later)`,
  ].join('\n')
}

const SUPERVISOR: Record<string, string> = {
  up: 'Running',
  idle: 'Not running. It starts with the next session.',
  restarting: 'Down. The app is restarting it.',
  unknown: "Unknown: the app couldn't read its status.",
}

export function SettingsSheet({
  onClose,
  onMove,
  onArbiterLog,
  arbiter,
  selfCheck,
}: {
  onClose: () => void
  /** The move sheet for 0.24's sessions (MIP2-1425). */
  onMove: () => void
  onArbiterLog: () => void
  arbiter: ArbiterState | null
  selfCheck: SelfCheckReport | null
}) {
  const api = useStore()
  const s = api.store?.settings
  const [section, setSection] = useState<Section>('General')
  const [cap, setCap] = useState((s?.arbiterCapUsd ?? 1).toFixed(2))
  const [key, setKey] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [font, setFont] = useState(s?.terminalFont ?? '')
  const [status, setStatus] = useState<AppStatus | null>(null)
  const refresh = () => void window.ccc.appStatus().then(setStatus)
  useEffect(refresh, [])
  if (!s) return null
  const save = async (patch: Parameters<typeof window.ccc.updateSettings>[0]) => {
    const r = await window.ccc.updateSettings(patch)
    if (!r.ok) api.notice(`Not saved: ${r.error}`)
  }
  const toggle = (label: string, on: boolean, patch: (v: boolean) => Parameters<typeof window.ccc.updateSettings>[0], disabled = false) => (
    <label className="check">
      <input type="checkbox" checked={on} disabled={disabled} onChange={e => void save(patch(e.target.checked))} />
      {label}
    </label>
  )
  const saveKey = async () => {
    if (!key.trim()) return
    const r = await window.ccc.setArbiterKey(key)
    if (!r.ok) return api.notice(r.error)
    setKey('')
    setReplacing(false)
    refresh()
    api.notice('Key saved.')
  }
  const days = s.rollOffDays ?? 7
  const size = s.terminalFontSize ?? TERMINAL_FONT_SIZE
  const cats = api.store?.categories ?? []
  const reading = cats.filter(c => c.arbiterReadsText).length
  const claudeVersion = selfCheck?.claudeVersion ?? null

  return (
    <div className="sheet-veil" onMouseDown={ev => ev.target === ev.currentTarget && onClose()} onKeyDown={ev => ev.key === 'Escape' && onClose()}>
      <div className="sheet settings" role="dialog" aria-label="Settings" tabIndex={-1}>
        <nav className="set-nav" aria-label="Settings sections">
          {SECTIONS.map(name => (
            <button key={name} type="button" className={section === name ? 'on' : ''} aria-current={section === name} onClick={() => setSection(name)}>
              {name}
            </button>
          ))}
        </nav>
        <div className="set-body">
          <h2>{section}</h2>

          {section === 'General' && (
            <>
              <div className="lbl">Sessions started outside the app</div>
              {toggle('Show them', s.showOutside !== false, v => ({ showOutside: v }))}
              <p className="note">Hidden ones still count in the top line when they need you.</p>
              <div className="lbl">Sessions parked in CC Command Center 0.24</div>
              {toggle('Show them in the sidebar', s.showParked !== false, v => ({ showParked: v }))}
              <button
                type="button"
                className="fchip"
                onClick={() =>
                  void window.ccc.setParkedHidden('all', false).then(r => (r.ok ? api.notice(r.count ? `Showing ${r.count} hidden parked session${r.count === 1 ? '' : 's'} again.` : 'No parked sessions are hidden.') : api.notice(`Not saved: ${r.error}`)))
                }
              >
                Show hidden parked sessions
              </button>
              <p className="note">Hidden or not, every parked session stays in the move sheet.</p>
              <div className="lbl">Roll-off</div>
              <label>
                Archive assumed-dead sessions after {days} days
                <input type="range" min={7} max={14} step={1} value={days} onChange={e => void save({ rollOffDays: Number(e.target.value) })} />
              </label>
              <p className="note">The archive keeps every session; nothing is deleted.</p>
              <div className="lbl">CC Command Center 0.24</div>
              <button type="button" className="link" onClick={onMove}>
                Move sessions from CC Command Center 0.24…
              </button>
            </>
          )}

          {section === 'Terminal' && (
            <>
              <div className="row">
                <label className="grow">
                  Font
                  <input
                    value={font}
                    placeholder="System monospace"
                    spellCheck={false}
                    onChange={e => setFont(e.target.value)}
                    onBlur={() => {
                      const v = font.trim()
                      // Empty goes back to the system monospace.
                      if (v !== (s.terminalFont ?? '')) void save({ terminalFont: v })
                    }}
                  />
                </label>
                <label>
                  Size {size}
                  <input type="range" min={9} max={32} step={1} value={size} onChange={e => void save({ terminalFontSize: Number(e.target.value) })} />
                </label>
              </div>
              <p className="note">A font installed on this Mac, by name. If it isn't installed, the system monospace is used.</p>
              <div className="set-preview" style={terminalFont({ terminalFont: font.trim() || undefined, terminalFontSize: size })}>
                ❯ claude --bg · Reading src/main/index.ts · 0O1lI
              </div>
            </>
          )}

          {section === 'Notifications' && (
            <>
              {toggle('Notifications', s.notifyEnabled, v => ({ notifyEnabled: v }))}
              {toggle('Needs you: approvals, questions and requests', s.notifyNeedsYou !== false, v => ({ notifyNeedsYou: v }), !s.notifyEnabled)}
              {toggle('Your turn: a turn finished', s.notifyTurn === true, v => ({ notifyTurn: v }), !s.notifyEnabled)}
              <p className="note">Never shown while CC Command Center is in front. At most one every 10 seconds per session.</p>
              <p className="note">Per-category overrides are in each category's editor.</p>
            </>
          )}

          {section === 'Arbiter' && (
            <>
              {toggle('Arbiter', s.arbiterEnabled !== false, v => ({ arbiterEnabled: v }))}
              <div className="lbl">API key</div>
              {status?.arbiterKey && !replacing ? (
                <div className="row">
                  <span className="mono grow">Stored · …{status.arbiterKey.end ?? '????'}</span>
                  <button type="button" className="fchip" onClick={() => setReplacing(true)}>
                    Replace
                  </button>
                  <button
                    type="button"
                    className="fchip"
                    onClick={async () => {
                      const r = await window.ccc.removeArbiterKey()
                      if (!r.ok) return api.notice(r.error)
                      refresh()
                      api.notice('Key removed. The Arbiter is off until a key is saved.')
                    }}
                  >
                    Remove
                  </button>
                </div>
              ) : (
                <div className="row">
                  <input
                    className="grow"
                    type="password"
                    value={key}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="sk-ant-… (paste; stored in the Keychain)"
                    onChange={e => setKey(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && void saveKey()}
                  />
                  <button type="button" className="fchip on" disabled={!key.trim()} onClick={() => void saveKey()}>
                    Save
                  </button>
                </div>
              )}
              <p className="note">The key is encrypted on this Mac with a key kept in your Keychain.</p>
              <div className="lbl">Model</div>
              <p className="mono">{ARBITER_MODEL}</p>
              <label>
                Daily cap, US dollars
                <input
                  value={cap}
                  inputMode="decimal"
                  onChange={e => setCap(e.target.value)}
                  onBlur={() => {
                    const v = Number(cap)
                    if (Number.isFinite(v) && v >= 0 && v <= 100) void save({ arbiterCapUsd: v })
                    else (setCap((s.arbiterCapUsd ?? 1).toFixed(2)), api.notice('The cap is a dollar amount from 0 to 100.'))
                  }}
                />
              </label>
              <p className="note">Spent today ${(arbiter?.spentTodayUsd ?? 0).toFixed(2)} · resets at midnight local time</p>
              <div className="lbl">Redaction</div>
              <p className="note">Commands and questions are redacted unless a category allows the Arbiter to read them. Session and category names are sent for every category.</p>
              <p className="note">
                {reading} of {cats.length} categories allow it.
              </p>
              <button type="button" className="link" onClick={() => (onClose(), onArbiterLog())}>
                View log…
              </button>
            </>
          )}

          {section === 'Claude Code' && (
            <>
              <p>
                Installed: <span className="mono">{claudeVersion ?? 'not found'}</span>
                {selfCheck?.checkedAt != null && <span className="note"> · checked {new Date(selfCheck.checkedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</span>}
                {status && <span className="note"> · supports {status.floor} or later</span>}
              </p>
              <ul className="set-checks">
                {(selfCheck?.checks ?? []).map(c => (
                  <li key={c.id} className={`ck-${c.state}`}>
                    <b>{c.state === 'pass' ? 'passed' : c.state === 'fail' ? 'failed' : 'not seen yet'}</b> {c.label}
                    {c.detail && <span className="note"> · {c.detail}</span>}
                  </li>
                ))}
              </ul>
              {selfCheck && selfCheck.controlOff.length > 0 && (
                <p className="note">
                  Off for this version: {selfCheck.controlOff.map(c => (c === 'card-answers' ? 'answering from cards' : 'sending prompts')).join(' and ')}. Sessions use their
                  own dialogs.
                </p>
              )}
              <button
                type="button"
                className="fchip"
                onClick={async () => {
                  const r = await window.ccc.selfCheckAgain()
                  api.notice(r.ok ? 'Checking again as sessions report.' : r.error)
                }}
              >
                Check again
              </button>
              <div className="lbl">Supervisor</div>
              <p>
                {status ? SUPERVISOR[status.supervisor] ?? status.supervisor : '…'}
                {status && status.restartsToday > 0 && ` · Restarted ${status.restartsToday} time${status.restartsToday === 1 ? '' : 's'} today`}
              </p>
              <p className="note">Claude Code updates itself; the app doesn't change that.</p>
            </>
          )}

          {section === 'About' && status && (
            <>
              <p>
                <b>CC Command Center {status.version}</b> <span className="mono">(build {status.commit}{status.builtAt ? ` · ${status.builtAt.slice(0, 10)}` : ''})</span>
              </p>
              <p className="mono">
                Electron {status.electron} · Chromium {status.chrome}
              </p>
              <p className="mono">Claude Code {claudeVersion ?? 'not found'}</p>
              <button type="button" className="fchip" onClick={() => (window.ccc.copyText(buildInfo(status, claudeVersion)), api.notice('Build info copied.'))}>
                Copy build info
              </button>
            </>
          )}

          <div className="sheet-acts">
            <span className="spacer" />
            <button type="button" className="fchip on" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
