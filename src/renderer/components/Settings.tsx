// The settings sheet (⌘,; spec MIP2-1387 §4): sections on the left, as in
// macOS settings. General, Terminal, Notifications, Arbiter, Claude Code and
// About (MIP2-1407, MIP2-1424). Changes save as they're made.

import { useEffect, useState } from 'react'
import type { SelfCheckReport } from '@ccc/contract'
import type { AppStatus } from '../../shared/ipc.ts'
import { ARBITER_MODEL, type ArbiterState } from '../../shared/arbiter-state.ts'
import { TERMINAL_FONT_SIZE, terminalFont } from '../model/format.ts'
import { useStore } from './Categories.tsx'
import { checkLine, useUpdate } from './UpdateBand.tsx'
import { betaUpdatesOn } from '../../shared/update-state.ts'

const SECTIONS = ['General', 'Terminal', 'Notifications', 'Arbiter', 'Spend', 'Claude Code', 'About'] as const
export type Section = (typeof SECTIONS)[number]

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
  initialSection = 'General',
}: {
  /** The section to open at, such as Spend from the spend panel's Set up… (MIP2-1498 §5.4). */
  initialSection?: Section
  onClose: () => void
  /** The move sheet for 0.24's sessions (MIP2-1425). */
  onMove: () => void
  onArbiterLog: () => void
  arbiter: ArbiterState | null
  selfCheck: SelfCheckReport | null
}) {
  const api = useStore()
  const s = api.store?.settings
  const [section, setSection] = useState<Section>(initialSection)
  const [cap, setCap] = useState((s?.arbiterCapUsd ?? 1).toFixed(2))
  const [key, setKey] = useState('')
  const [replacing, setReplacing] = useState(false)
  const [font, setFont] = useState(s?.terminalFont ?? '')
  const [status, setStatus] = useState<AppStatus | null>(null)
  const update = useUpdate()
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
              {status?.arbiterKeyIsAdmin && (
                <p className="note warn">
                  The saved key is an Admin API key, which has organization-admin rights, so the Arbiter doesn't use it. Remove it and save a workspace-scoped API key.
                </p>
              )}
              <p className="note">
                Use a workspace-scoped API key. The app refuses an Admin key, but it can't tell whether a personal key's account has admin rights. The key is encrypted on this Mac with a key kept in
                your Keychain.
              </p>
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

          {section === 'Spend' && <SpendSettings />}

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
              <p>{checkLine(update, Date.now())}</p>
              {update?.testOrigin && <p className="note">Test build: updates come from {update.testOrigin}, not GitHub.</p>}
              {update && update.phase !== 'off' && (
                <button
                  type="button"
                  className="fchip"
                  disabled={update.phase === 'checking' || update.phase === 'downloading' || update.phase === 'downloaded'}
                  onClick={() => void window.ccc.checkForUpdate()}
                >
                  Check for updates
                </button>
              )}
              {update && update.phase !== 'off' && (
                <>
                  {toggle('Get beta updates', betaUpdatesOn(s.betaUpdates, status.version), v => ({ betaUpdates: v }))}
                  <p className="note">Betas come before a release, to try new features early. A beta install keeps getting betas, then the release. You can turn this off at any time.</p>
                </>
              )}
              {update?.phase === 'available' && (
                <button type="button" className="fchip on" onClick={() => void window.ccc.downloadUpdate()}>
                  Download
                </button>
              )}
              {update?.phase === 'downloaded' && (
                <button type="button" className="fchip on" onClick={() => void window.ccc.restartToUpdate()}>
                  Restart to update
                </button>
              )}
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

/** Settings → Spend (MIP2-1498 §5.3): the Console key, with Test and Remove. Stored like the Arbiter's key. */
function SpendSettings() {
  const api = useStore()
  const [status, setStatus] = useState<{ end: string | null } | null | undefined>(undefined)
  const [key, setKey] = useState('')
  const [result, setResult] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const refresh = () => void window.ccc.adminKeyStatus().then(setStatus)
  useEffect(refresh, [])
  const run = async (what: 'test' | 'save' | 'remove') => {
    setBusy(true)
    setResult(null)
    try {
      const r = what === 'test' ? await window.ccc.testAdminKey(key.trim() || undefined) : what === 'save' ? await window.ccc.saveAdminKey(key) : await window.ccc.removeAdminKey()
      // A failed test shows the API's own message.
      if (!r.ok) return setResult(r.error)
      if (what === 'test') setResult('The key works.')
      if (what === 'save') (setKey(''), api.notice('Console key saved.'))
      if (what === 'remove') api.notice('Console key removed.')
      refresh()
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <div className="lbl">Console key (Admin, personal or service account)</div>
      {status ? (
        <div className="row">
          <span className="mono grow">Stored · …{status.end ?? '????'}</span>
          <button type="button" className="fchip" disabled={busy} onClick={() => void run('test')}>
            Test
          </button>
          <button type="button" className="fchip" disabled={busy} onClick={() => void run('remove')}>
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
            placeholder="sk-ant-… (paste; tested, then stored in the Keychain)"
            onChange={e => setKey(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && key.trim() && void run('save')}
          />
          <button type="button" className="fchip" disabled={busy || !key.trim()} onClick={() => void run('test')}>
            Test
          </button>
          <button type="button" className="fchip on" disabled={busy || !key.trim()} onClick={() => void run('save')}>
            Save
          </button>
        </div>
      )}
      {result && <p className="note">{result}</p>}
      <p className="note">Needs an Anthropic Console organization. Individual accounts don't have one. Check platform.claude.com/settings/organization.</p>
      <p className="note">
        An Admin API key has full organization-admin rights: it can manage members, workspaces and API keys. A personal or service-account key carries its account's role. For an owner or
        admin it's just as broad, and it can also spend on inference. The narrower choice is a service account with the lowest role that can read cost. The key is tested with one cost-report
        call before it's saved.
      </p>
      <p className="note">The key is encrypted on this Mac with a key kept in your Keychain. It's used only to read your organization's cost, every 15 minutes.</p>
    </>
  )
}
