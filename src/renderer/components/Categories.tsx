// Categories in the window (MIP2-1409): the store the renderer reads, the
// category chip and its menu (spec MIP2-1370 §7), the category editor
// (MIP2-1387 §3) and the import from 0.24 (MIP2-1370 §14 step 2).

import { createContext, useContext, useEffect, useRef, useState } from 'react'
import { PICKABLE_COLORS, type AppStore, type Category } from '../../shared/store.ts'
import { categoryLabel, type CatRef, type Entry } from '../model/fleet.ts'
import { tildify } from '../model/format.ts'

export interface StoreApi {
  store: AppStore | null
  /** The fleet as drawn, for menus that list other sessions. */
  entries: Entry[]
  /** Opens the category editor: an id edits, null starts a new one; `folders` scrolls to Folders. */
  editCategory: (id: string | null, folders?: boolean) => void
  /** A toast; with an action it offers a button and goes after 10 s. */
  notice: (text: string, action?: NoticeAction) => void
  /** The New Session sheet in one of its other forms (MIP2-1387 §2.3). */
  openSheet: (kind: 'settings' | 'resume' | 'from', sessionId: string) => void
  /** The move sheet for 0.24's sessions, with one session picked or the idle ones (MIP2-1425). */
  openMove: (sessionId: string | null) => void
}

export interface NoticeAction {
  label: string
  run: () => void
}

export const StoreContext = createContext<StoreApi>({ store: null, entries: [], editCategory: () => {}, notice: () => {}, openSheet: () => {}, openMove: () => {} })

export const useStore = () => useContext(StoreContext)

/** The drag type a card or sidebar row carries, holding its session id. */
export const SESSION_DRAG = 'application/x-ccc-session'

export function catStyle(cat: CatRef): React.CSSProperties {
  return { '--cat': cat.color } as React.CSSProperties
}

const ok = (api: StoreApi, r: { ok: boolean; error?: string }) => r.ok || api.notice(`Not saved: ${r.error}`)

/** The category chip: its label, `· auto` while unseen, and a click for the category menu. */
export function CatChip({ e }: { e: Entry }) {
  const api = useStore()
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (ev: MouseEvent) => ref.current?.contains(ev.target as Node) || setOpen(false)
    const esc = (ev: KeyboardEvent) => ev.key === 'Escape' && setOpen(false)
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => (document.removeEventListener('mousedown', close), document.removeEventListener('keydown', esc))
  }, [open])
  const id = e.session.sessionId
  const move = async (categoryId: string | null) => {
    setOpen(false)
    ok(api, await window.ccc.place(id, categoryId))
  }
  // Two categories matched equally: offer both instead of guessing (spec §7).
  const tie = e.cat.id === null ? (api.store?.sessions[e.session.sessionId]?.tie ?? []).map(id => api.store?.categories.find(c => c.id === id)).filter(Boolean) : []
  if (tie.length > 1) {
    return (
      <span className="tie">
        Category?{' '}
        {tie.map((c, i) => (
          <span key={c!.id}>
            {i > 0 && ' · '}
            <button type="button" className="chip" style={{ '--cat': c!.color } as React.CSSProperties} onClick={ev => (ev.stopPropagation(), void move(c!.id))}>
              {c!.label || c!.name.split(/\s+/)[0]}
            </button>
          </span>
        ))}
      </span>
    )
  }
  return (
    <span className="chip-wrap" ref={ref}>
      <button
        type="button"
        className="chip"
        style={catStyle(e.cat)}
        title={`${e.cat.name}. Click for the category menu.`}
        onClick={ev => (ev.stopPropagation(), setOpen(o => !o))}
      >
        {categoryLabel(e.cat)}
        {e.cat.auto && <span className="auto"> · auto</span>}
      </button>
      {open && (
        <div className="menu" role="menu" onClick={ev => ev.stopPropagation()}>
          <div className="menu-h">Move to</div>
          {(api.store?.categories ?? []).map(c => (
            <button key={c.id} role="menuitem" disabled={c.id === e.cat.id} onClick={() => void move(c.id)}>
              <i className="sq" style={{ '--cat': c.color } as React.CSSProperties} />
              {c.emoji && <span>{c.emoji}</span>} {c.name}
            </button>
          ))}
          <button role="menuitem" disabled={e.cat.id === null} onClick={() => void move(null)}>
            <i className="sq" style={{ '--cat': 'var(--cc-cat-none)' } as React.CSSProperties} /> Uncategorized
          </button>
          {e.cat.id !== null && (
            <>
              <hr />
              <button
                role="menuitem"
                title="Moves it to Uncategorized, and this folder stops matching the category."
                onClick={async () => (setOpen(false), ok(api, await window.ccc.notCategory(id)))}
              >
                Not {e.cat.name}
              </button>
              <button role="menuitem" onClick={() => (setOpen(false), api.editCategory(e.cat.id, true))}>
                Edit {e.cat.name} folders…
              </button>
            </>
          )}
        </div>
      )}
    </span>
  )
}

/** The 0.24 emoji grid, unchanged. */
const EMOJI = [
  '💼', '🏢', '📊', '💰', '📁', '🗂️', '📈', '🧾', '💻', '⚙️', '🔧', '🚀', '🧪', '🐛', '🖥️', '🤖', '☁️', '🔌', '🗄️', '📦',
  '🧠', '💡', '🔬', '🧩', '🤝', '🎯', '👥', '🏠', '🌊', '🌱', '🎨', '📚', '⭐', '🔥', '⚡', '🔔', '🗓️', '📝', '✈️', '🎛️',
]

/**
 * The category editor (MIP2-1387 §3). Changes save as they're made. Notify
 * settings arrive with notifications (MIP2-1412).
 */
export function CategoryEditor({ id, folders: toFolders, entries, onClose }: { id: string | null; folders: boolean; entries: Entry[]; onClose: () => void }) {
  const api = useStore()
  const [catId, setCatId] = useState(id)
  const cat = api.store?.categories.find(c => c.id === catId) ?? null
  const [name, setName] = useState(cat?.name ?? '')
  const [confirm, setConfirm] = useState(false)
  const foldersRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (toFolders) foldersRef.current?.scrollIntoView({ block: 'center' })
    else nameRef.current?.focus()
  }, [toFolders])

  // Saves run one after another, each with the id the last one got: a name's
  // blur and a swatch click on a new category made two categories (MIP2-1433).
  const idRef = useRef(catId)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const save = (patch: Partial<Category>): Promise<void> =>
    (queue.current = queue.current.then(async () => {
      const r = await window.ccc.saveCategory({ ...(idRef.current ? { id: idRef.current } : {}), ...patch })
      if (!r.ok) return api.notice(`Not saved: ${r.error}`)
      idRef.current = r.category.id
      setCatId(r.category.id)
    }))
  // A new category exists once it has a name.
  const commitName = () => {
    const n = name.trim()
    if (n && n !== cat?.name) void save({ name: n })
  }

  const members = entries.filter(e => e.cat.id === catId)
  const learned = [
    ...new Set(
      Object.values(api.store?.sessions ?? {})
        // By repository root (the folder key, spec §7), so one repository is one entry.
        .filter(m => m.categoryId === catId && (m.placedBy === 'hand' || m.placedBy === 'import') && (m.folderKey ?? m.cwd))
        .map(m => (m.folderKey ?? m.cwd)!),
    ),
  ].filter(f => !cat?.folders.some(x => f === x || f.startsWith(x + '/')) && !cat?.notFolders.includes(f))

  const addFolder = async () => {
    const f = await window.ccc.chooseFolder()
    if (f && cat && !cat.folders.includes(f)) void save({ folders: [...cat.folders, f] })
  }

  return (
    <div className="sheet-veil" onMouseDown={ev => ev.target === ev.currentTarget && onClose()} onKeyDown={ev => ev.key === 'Escape' && onClose()}>
      <div className="sheet cat-editor" role="dialog" aria-label={cat ? `Edit ${cat.name}` : 'New category'}>
        <h2>{cat ? cat.name : 'New category'}</h2>
        <label>
          Name
          <input
            ref={nameRef}
            value={name}
            maxLength={60}
            onChange={ev => setName(ev.target.value)}
            onBlur={commitName}
            onKeyDown={ev => ev.key === 'Enter' && commitName()}
            placeholder="Required"
          />
        </label>
        <fieldset disabled={!cat}>
          <div className="row">
            <label className="grow">
              Short label
              <input
                defaultValue={cat?.label ?? ''}
                key={`label-${catId}`}
                maxLength={8}
                placeholder={cat ? categoryLabel({ id: cat.id, name: cat.name, label: '', color: '', emoji: '', sort: 0, auto: false }) : ''}
                onBlur={ev => ev.target.value !== cat?.label && void save({ label: ev.target.value })}
              />
            </label>
            <span className="emoji-now" title="Emoji">{cat?.emoji || '⊘'}</span>
          </div>
          <div className="emoji-grid">
            <button type="button" className={!cat?.emoji ? 'on' : ''} onClick={() => void save({ emoji: '' })} title="No emoji">
              ⊘
            </button>
            {EMOJI.map(e => (
              <button type="button" key={e} className={cat?.emoji === e ? 'on' : ''} onClick={() => void save({ emoji: e })}>
                {e}
              </button>
            ))}
          </div>
          <div className="swatches" role="radiogroup" aria-label="Color">
            {PICKABLE_COLORS.map(c => (
              <button
                type="button"
                key={c}
                role="radio"
                aria-checked={cat?.color === c}
                className={cat?.color === c ? 'on' : ''}
                style={{ '--cat': c } as React.CSSProperties}
                onClick={() => void save({ color: c })}
              />
            ))}
          </div>
          <div ref={foldersRef} className="folders">
            <div className="lbl">Folders</div>
            {cat?.folders.map(f => (
              <div key={f} className="folder">
                <span className="mono" title={f}>{tildify(f)}</span>
                <button type="button" className="x" title="Remove" onClick={() => void save({ folders: cat.folders.filter(x => x !== f) })}>
                  ×
                </button>
              </div>
            ))}
            {learned.map(f => (
              <div key={f} className="folder">
                <span className="mono" title={f}>{tildify(f)}</span>
                <span className="learned">learned</span>
                <button type="button" className="x" title="Stop matching this folder" onClick={() => cat && void save({ notFolders: [...cat.notFolders, f] })}>
                  ×
                </button>
              </div>
            ))}
            <button type="button" className="link" onClick={() => void addFolder()}>
              ＋ Add folder…
            </button>
          </div>
          <div className="lbl">Where sessions edit</div>
          <div className="seg">
            {(
              [
                ['none', 'In place'],
                ['worktree', 'In a separate worktree'],
              ] as const
            ).map(([v, l]) => (
              <button type="button" key={v} className={`fchip${(cat?.isolation ?? 'none') === v ? ' on' : ''}`} onClick={() => void save({ isolation: v })}>
                {l}
              </button>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={cat?.arbiterReadsText ?? false} onChange={ev => void save({ arbiterReadsText: ev.target.checked })} />
            Arbiter may read this category
          </label>
          <p className="note">Sends commands and questions to the Arbiter without redaction. Session and category names go to it either way.</p>
          <div className="lbl">Notify me</div>
          {(
            [
              ['notifyNeeds', 'Needs you'],
              ['notifyTurn', 'Your turn'],
            ] as const
          ).map(([key, label]) => (
            <div key={key} className="seg">
              <span className="seg-l">{label}</span>
              {(['auto', 'on', 'off'] as const).map(v => (
                <button type="button" key={v} className={`fchip${(cat?.[key] ?? 'auto') === v ? ' on' : ''}`} onClick={() => void save({ [key]: v })}>
                  {v}
                </button>
              ))}
            </div>
          ))}
          <p className="note">auto follows Settings → Notifications.</p>
        </fieldset>
        <div className="sheet-acts">
          {cat &&
            (confirm ? (
              <span className="confirm">
                Delete {cat.name}? Its {members.length} session{members.length === 1 ? '' : 's'} move to Uncategorized.{' '}
                <button
                  type="button"
                  className="fchip danger"
                  onClick={async () => {
                    const r = await window.ccc.deleteCategory(cat.id)
                    onClose()
                    if (!r.ok) return api.notice(`Not deleted: ${r.error}`)
                    api.notice(`${cat.name} deleted.`, {
                      label: 'Undo',
                      run: async () => {
                        const u = await window.ccc.undoDeleteCategory(cat.id)
                        api.notice(u.ok ? `${cat.name} restored.` : `Can't undo: ${u.error}`)
                      },
                    })
                  }}
                >
                  Delete
                </button>{' '}
                <button type="button" className="fchip" onClick={() => setConfirm(false)}>
                  Cancel
                </button>
              </span>
            ) : (
              <button type="button" className="link del" onClick={() => setConfirm(true)}>
                Delete category
              </button>
            ))}
          <span className="spacer" />
          <button type="button" className="fchip on" onClick={() => (commitName(), onClose())}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * The import offer until settings are imported: a band at the top of the
 * sidebar. First run (MIP2-1412) takes this over as its step 2.
 */
export function ImportBand() {
  const api = useStore()
  const [available, setAvailable] = useState(false)
  const [busy, setBusy] = useState(false)
  useEffect(() => void window.ccc.importAvailable().then(setAvailable), [])
  if (!available || api.store?.importedAt) return null
  const run = async () => {
    setBusy(true)
    const r = await window.ccc.importSettings()
    setBusy(false)
    if (!r.ok) return api.notice(`Import failed: ${r.error}`)
    const s = r.summary
    api.notice(
      `Imported ${s.categories} categories and ${s.named} session names. Assigned ${s.assigned} of ${s.uncategorized} uncategorized sessions by folder.`,
    )
  }
  return (
    <div className="import-band">
      <p>Bring over categories, session names and launch defaults from CC Command Center 0.24, read-only. Electron can stay open.</p>
      <button type="button" className="fchip on" disabled={busy} onClick={() => void run()}>
        {busy ? 'Importing…' : 'Import'}
      </button>
    </div>
  )
}
