// The New Session sheet (spec MIP2-1387 §2). Ultracode and extra flags are
// not in this build: they need settings-file and flag vetting of their own
// (MIP2-1407). Folder and launch defaults come from the app's store, where
// the 0.24 import puts Alex's (§2.4).

import { useEffect, useRef, useState } from 'react'
import type { LaunchRequest } from '../../shared/ipc.ts'
import { splitFlags } from '../../shared/flags.ts'
import { tildify } from '../model/format.ts'
import type { Entry } from '../model/fleet.ts'
import { useStore } from './Categories.tsx'
import { TrustTerminal } from './TrustTerminal.tsx'

const MODELS = [
  ['Default', ''],
  ['Opus', 'opus'],
  ['Sonnet', 'sonnet'],
  ['Haiku', 'haiku'],
  ['Fable', 'fable'],
  // `best`: Fable where available to Alex, otherwise Opus (model-config.md, model aliases).
  ['Best', 'best'],
  ['Custom…', 'custom'],
] as const
const EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'] as const
const MODES = [
  ['Manual', 'default'],
  ['Accept edits', 'acceptEdits'],
  ['Plan', 'plan'],
  ['Auto', 'auto'],
  ["Don't ask", 'dontAsk'],
  ['Bypass permissions', 'bypassPermissions'],
] as const

/** A recent folder as a short chip: the home folder as ~, and a long path cut in the middle so both ends show. */
function shortFolder(path: string, max = 36): string {
  const t = tildify(path)
  return t.length <= max ? t : `${t.slice(0, 10)}…${t.slice(-(max - 11))}`
}

/** The command the app runs, for `More options` (spec §2.1). */
export function commandPreview(r: LaunchRequest): string {
  const q = (v: string) => (/^[\w./:@-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`)
  const parts = ['claude', '--bg']
  if (r.name) parts.push('--name', q(r.name))
  if (r.model) parts.push('--model', q(r.model))
  if (r.effort) parts.push('--effort', r.effort)
  if (r.permissionMode) parts.push('--permission-mode', r.permissionMode)
  parts.push('--plugin-dir', '<reporter>', '--settings', r.ultracode ? '<session settings, with "ultracode": true>' : '<session settings>')
  for (const a of r.extraArgs ?? []) parts.push(q(a))
  if (r.prompt) parts.push('--', q(r.prompt))
  return `cd ${q(r.cwd)} && ${parts.join(' ')}`
}

const EFFORT_SET = new Set<string>(EFFORTS)
const MODE_SET = new Set<string>(MODES.map(([, v]) => v))
const MODEL_SET = new Set<string>(MODELS.map(([, v]) => v))

/**
 * The same sheet, three more ways (spec MIP2-1387 §2.3):
 * - `settings`: Launch settings… for a session, starting a copy;
 * - `resume`: a closed session resumed with different settings, also a copy;
 * - `from`: a new session started from this one (D-014).
 */
export interface SheetSource {
  kind: 'settings' | 'resume' | 'from'
  entry: Entry
  /** Text selected in the session's view becomes the instructions (`from`). */
  selection?: string
}

export function NewSession({
  preset,
  source,
  onClose,
  onStarted,
}: {
  /** A category id or null (Uncategorized) from a sidebar `＋`; undefined leaves it to auto-assign. */
  preset?: string | null
  source?: SheetSource
  onClose: () => void
  onStarted: (sessionId: string) => void
}) {
  const { store } = useStore()
  const settings = store?.settings
  const categories = [...(store?.categories ?? [])].sort((a, b) => a.sort - b.sort)
  const recent = settings?.recentFolders ?? []
  const copy = source?.kind === 'settings' || source?.kind === 'resume'
  const srcMeta = source ? store?.sessions[source.entry.session.sessionId] : undefined
  // A source session's own settings: as launched here, else what its snapshot shows.
  const srcLaunch = srcMeta?.launch ?? (source ? { model: source.entry.session.model?.value, effort: source.entry.session.effort?.value } : undefined)
  const [cwd, setCwd] = useState(source ? source.entry.session.cwd.value : (settings?.lastFolder ?? recent[0] ?? ''))
  const [name, setName] = useState('')
  // Imported values the sheet doesn't offer fall back to Default.
  const last = source ? (srcLaunch?.model ?? '') : (settings?.lastModel ?? '')
  // A model name the menu doesn't list is a Custom… one.
  const [choice, setChoice] = useState(MODEL_SET.has(last) && last !== 'custom' ? last : last ? 'custom' : '')
  const [customModel, setCustomModel] = useState(MODEL_SET.has(last) ? '' : last.replace(/\[1m\]$/, ''))
  const [oneM, setOneM] = useState(/\[1m\]$/.test(last))
  const model = choice === 'custom' ? (customModel.trim() ? `${customModel.trim()}${oneM ? '[1m]' : ''}` : '') : choice
  const lastEffort = source ? (srcLaunch?.effort ?? '') : (settings?.lastEffort ?? '')
  const lastMode = source ? (srcMeta?.launch?.mode ?? 'default') : (settings?.lastMode ?? '')
  const [effort, setEffort] = useState(EFFORT_SET.has(lastEffort) ? lastEffort : '')
  const [mode, setMode] = useState(MODE_SET.has(lastMode) ? lastMode : 'default')
  /** `auto`, a category id, or `none` for Uncategorized. Choosing one is a placement by hand. */
  const [category, setCategory] = useState<string>(
    source ? (source.entry.cat.id ?? 'none') : preset === undefined ? 'auto' : (preset ?? 'none'),
  )
  const [guess, setGuess] = useState<{ categoryId: string | null; folderKey: string } | null>(null)
  /** Set by `Change for this session`; otherwise the category's setting. */
  const [isolationOverride, setIsolationOverride] = useState<'none' | 'worktree' | null>(null)
  const [prompt, setPrompt] = useState(source?.kind === 'from' ? (source.selection ?? '') : '')
  const [more, setMore] = useState(false)
  const [ultracode, setUltracode] = useState(srcMeta?.launch?.ultracode === true)
  const [flagsText, setFlagsText] = useState((srcMeta?.launch?.extraArgs ?? []).map(a => (/^[\w./:=@-]+$/.test(a) ? a : `'${a.replace(/'/g, `'"'"'`)}'`)).join(' '))
  const flags = splitFlags(flagsText)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<{ text: string; variant: 'trust' | 'home' | 'missing' | null } | null>(null)
  /** The trust step's terminal is open for this request. */
  const [trusting, setTrusting] = useState<LaunchRequest | null>(null)
  const first = useRef<HTMLInputElement>(null)

  useEffect(() => first.current?.focus(), [])

  useEffect(() => {
    const folder = cwd.trim()
    if (!folder.startsWith('/')) return setGuess(null)
    let live = true
    const t = setTimeout(() => void window.ccc.guessCategory(folder).then(g => live && setGuess(g)), 150)
    return () => ((live = false), clearTimeout(t))
  }, [cwd, store?.categories])

  const chosenId = category === 'auto' ? (guess?.categoryId ?? null) : category === 'none' ? null : category
  const chosen = categories.find(c => c.id === chosenId)
  const guessed = categories.find(c => c.id === guess?.categoryId)
  const isolation = isolationOverride ?? chosen?.isolation ?? 'none'

  const request: LaunchRequest = {
    cwd: cwd.trim(),
    ...(name.trim() ? { name: name.trim() } : {}),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    permissionMode: mode,
    ...(prompt.trim() ? { prompt } : {}),
    isolation,
    ...(ultracode ? { ultracode: true } : {}),
    ...(flags.ok && flags.args.length ? { extraArgs: flags.args } : {}),
    ...(source?.kind === 'from' ? { fromSession: source.entry.session.sessionId } : {}),
  }
  // Launch settings…: only while the session isn't mid-turn (§2.3).
  const busyNow = source?.kind === 'settings' && ['working', 'agents'].includes(source.entry.view.state)
  const srcName = source?.entry.name ?? ''
  const title =
    source?.kind === 'settings' ? `Launch settings · ${srcName}` : source?.kind === 'resume' ? `Resume ${srcName} with different settings` : source?.kind === 'from' ? `Start a session from ${srcName}` : 'New session'

  const start = async () => {
    if (!request.cwd.startsWith('/')) return setError({ text: 'Choose a folder.', variant: null })
    if (!flags.ok) return setError({ text: flags.error, variant: null })
    if (choice === 'custom' && !customModel.trim()) return setError({ text: 'Enter a model name, or choose one from the menu.', variant: null })
    setBusy(true)
    setError(null)
    const r = copy ? await window.ccc.startCopy(source!.entry.session.sessionId, request) : await window.ccc.launch(request)
    setBusy(false)
    if (!r.ok) return setError({ text: r.error, variant: r.kind === 'untrusted' ? (r.variant ?? 'trust') : null })
    started(r.sessionId)
  }

  const started = (sessionId: string) => {
    window.ccc.rememberLaunch(request.cwd, { model, effort, mode })
    // `Auto` leaves the session to auto-assign; anything else is Alex's choice.
    if (category !== 'auto') void window.ccc.place(sessionId, chosenId)
    onStarted(sessionId)
  }

  return (
    <div
      className="sheet-veil"
      onKeyDown={e => {
        if (e.key === 'Escape') onClose()
        if (e.key === 'Enter' && e.metaKey) {
          e.preventDefault()
          void start()
        }
      }}
    >
      <form className="sheet" onSubmit={e => (e.preventDefault(), void start())}>
        <h2>{title}</h2>
        <label>
          Folder
          <span className="row">
            <input ref={first} value={cwd} onChange={e => setCwd(e.target.value)} placeholder="/Users/…/project" spellCheck={false} readOnly={copy} />
            {!copy && (
              <button type="button" className="fchip" onClick={async () => setCwd((await window.ccc.chooseFolder()) ?? cwd)}>
                Choose…
              </button>
            )}
          </span>
        </label>
        {recent.length > 0 && !copy && (
          <div className="recent">
            {recent.map(f => (
              <button type="button" key={f} className={`fchip${f === cwd ? ' on' : ''}`} onClick={() => setCwd(f)} title={f}>
                {shortFolder(f)}
              </button>
            ))}
          </div>
        )}
        <div className="grid2">
          <label>
            Name
            <input value={name} onChange={e => setName(e.target.value)} placeholder="The folder name when empty" />
          </label>
          {copy ? (
            <label>
              Category
              <input value={source!.entry.cat.name} readOnly />
            </label>
          ) : (
          <label>
              Category
              <select value={category} onChange={e => setCategory(e.target.value)}>
                <option value="auto">{guessed ? `Auto: ${guessed.name} (from ${tildify(guess!.folderKey)})` : 'Auto: Uncategorized'}</option>
                {categories.map(c => (
                  <option key={c.id} value={c.id}>
                    {c.emoji ? `${c.emoji} ` : ''}
                    {c.name}
                  </option>
                ))}
                <option value="none">Uncategorized</option>
              </select>
            </label>
          )}
        </div>
        <div className="grid2">
          <label>
            Model
            <select value={choice} onChange={e => setChoice(e.target.value)}>
              {MODELS.map(([l, v]) => (
                <option key={l} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
          <label>
            Permission mode
            <select value={mode} onChange={e => setMode(e.target.value)}>
              {MODES.map(([l, v]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        </div>
        {choice === 'custom' ? (
          <div className="row">
            <input value={customModel} onChange={e => setCustomModel(e.target.value)} placeholder="A full model name, e.g. claude-opus-4-6" spellCheck={false} />
            <label className="check">
              <input type="checkbox" checked={oneM} onChange={e => setOneM(e.target.checked)} />
              1M context
            </label>
          </div>
        ) : (
          choice !== '' && <p className="note">This model already uses a 1M context window.</p>
        )}
        {mode === 'bypassPermissions' && <p className="warn">Claude runs every tool without asking. Use it only in a folder you can afford to lose.</p>}
        <div className="seg" role="radiogroup" aria-label="Effort">
          <span>Effort</span>
          {EFFORTS.map(v => (
            <button type="button" key={v || 'default'} className={`fchip${effort === v ? ' on' : ''}`} onClick={() => setEffort(v)}>
              {v || 'Default'}
            </button>
          ))}
          <label className="check ultra" title="Claude plans a workflow for each substantive task, at this effort level. It uses more tokens.">
            <input type="checkbox" checked={ultracode} onChange={e => setUltracode(e.target.checked)} />
            Ultracode
          </label>
        </div>
        <p className="note">
          Edits: {isolation === 'none' ? 'in place' : 'in a worktree'}
          {isolationOverride === null && chosen ? ` (${chosen.name})` : ''}{' '}
          <button type="button" className="link" onClick={() => setIsolationOverride(isolation === 'none' ? 'worktree' : 'none')}>
            Change for this session
          </button>
        </p>
        {!copy && (
          <label>
            Initial instructions
            <textarea rows={4} value={prompt} onChange={e => setPrompt(e.target.value)} />
          </label>
        )}
        <button type="button" className="link" onClick={() => setMore(m => !m)}>
          {more ? 'Fewer options' : 'More options'}
        </button>
        {more && (
          <>
            <label>
              Extra flags
              <input value={flagsText} onChange={e => setFlagsText(e.target.value)} placeholder="--add-dir ~/other-repo" spellCheck={false} />
            </label>
            {!flags.ok && <p className="warn">{flags.error}</p>}
            <div className="lbl">Command</div>
            <code className="cmd">{commandPreview(request)}</code>
          </>
        )}
        {error && !trusting && (
          <div className="sheet-err">
            {error.variant === 'trust' && (
              <>
                This folder hasn't been trusted in Claude Code yet.{' '}
                <button type="button" className="link" onClick={() => setTrusting(request)}>
                  Open the trust check
                </button>
              </>
            )}
            {error.variant === 'home' && <>Claude Code trusts the home folder one session at a time. Choose a project folder.</>}
            {error.variant === 'missing' && <>That folder doesn't exist.</>}
            {error.variant === null && error.text}
          </div>
        )}
        {trusting && (
          <TrustTerminal
            request={trusting}
            onCancel={() => setTrusting(null)}
            onDone={(sessionId, err) => {
              setTrusting(null)
              if (sessionId) started(sessionId)
              else setError({ text: err ?? 'No session started. The folder is still untrusted.', variant: null })
            }}
          />
        )}
        {copy && <p className="note">Claude Code keeps a session's settings. New settings start a copy of the conversation under a new id.</p>}
        {busyNow && <p className="note">Available when {srcName} is idle.</p>}
        <div className="sheet-acts">
          <button type="button" className="fchip" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="fchip on" disabled={busy || busyNow}>
            {busy ? 'Starting…' : source?.kind === 'settings' ? 'Start a copy with these settings ⌘↩' : source?.kind === 'resume' ? 'Start a copy ⌘↩' : 'Start session ⌘↩'}
          </button>
        </div>
      </form>
    </div>
  )
}
