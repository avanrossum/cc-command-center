// The artifact drawer in Focus (MIP2-1412; spec MIP2-1370 §10.2): files the
// session wrote and artifacts it published, newest first, with a preview.
// The preview is an iframe with `sandbox=""` on main's preview scheme: no
// script, an opaque origin, no preload, no IPC (DECISION item 8, D-019).

import { useEffect, useState } from 'react'
import type { FileWrite, SessionSnapshot } from '@ccc/contract'
import { age, tildify } from '../model/format.ts'

const base = (p: string) => p.split('/').at(-1) ?? p
const ext = (p: string) => (/\.([a-z0-9]{1,6})$/i.exec(base(p))?.[1] ?? '').toLowerCase()
const isMarkdown = (p: string) => ['md', 'markdown'].includes(ext(p))

/** Raw or rendered, remembered per file (spec §10.2). */
const RAW_KEY = 'ccc.artifactRaw'
function rawSet(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(RAW_KEY) ?? '[]') as string[])
  } catch {
    return new Set()
  }
}

export function ArtifactDrawer({ session, now, onClose }: { session: SessionSnapshot; now: number; onClose: () => void }) {
  const files = [...(session.filesWritten?.value ?? [])].reverse()
  const [sel, setSel] = useState<FileWrite | null>(files[0] ?? null)
  const [view, setView] = useState<{ url: string; open: string | null } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [raw, setRaw] = useState(rawSet)
  const id = session.sessionId
  const showRaw = Boolean(sel && raw.has(sel.path))
  const toggleRaw = () => {
    if (!sel) return
    const next = new Set(raw)
    if (next.has(sel.path)) next.delete(sel.path)
    else next.add(sel.path)
    setRaw(next)
    try {
      localStorage.setItem(RAW_KEY, JSON.stringify([...next].slice(-200)))
    } catch {
      // Remembered for this run only.
    }
  }

  useEffect(() => {
    setView(null)
    setError(null)
    if (!sel || sel.url) return
    let live = true
    void window.ccc.artifactPreview(id, sel.path, showRaw).then(r => live && (r.ok ? setView({ url: r.url, open: r.open }) : setError(r.error)))
    return () => void (live = false)
  }, [id, sel?.path, sel?.at, showRaw])

  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', esc)
    return () => window.removeEventListener('keydown', esc)
  }, [onClose])

  /** An unknown file type waiting for "Open anyway" (gate M-3). */
  const [confirm, setConfirm] = useState<{ target: string; question: string } | null>(null)
  const open = async (target: string, confirmed = false) => {
    setConfirm(null)
    const r = await window.ccc.artifactOpen(id, target, confirmed)
    if (r.ok) return
    if ('confirm' in r) setConfirm({ target, question: r.error })
    else setError(r.error)
  }

  return (
    <div className="drawer" role="dialog" aria-label="Artifacts">
      <div className="drawer-preview">
        {!sel && <div className="quiet">Nothing written or published yet.</div>}
        {sel?.url && (
          <div className="drawer-card">
            <p>Published artifact</p>
            <p className="mono">{sel.url}</p>
            <button type="button" className="fchip on" onClick={() => void open(sel.url!)}>
              Open link ↗
            </button>
          </div>
        )}
        {sel && !sel.url && view && <iframe title={`Preview of ${base(sel.path)}`} src={view.url} sandbox="" referrerPolicy="no-referrer" />}
        {sel && !sel.url && (
          <div className="drawer-acts">
            <span className="mono" title={sel.path}>
              {tildify(sel.path)}
            </span>
            {isMarkdown(sel.path) && (
              <button type="button" className="fchip" onClick={toggleRaw} aria-pressed={showRaw}>
                {showRaw ? 'rendered' : 'raw'}
              </button>
            )}
            <button type="button" className="fchip" onClick={() => void window.ccc.artifactReveal(id, sel.path)} title="Show in Finder">
              ⤴
            </button>
            <button type="button" className="fchip" onClick={() => void open(sel.path)}>
              {view?.open ? 'Open' : 'Open in its app'} ↗
            </button>
          </div>
        )}
        {confirm && (
          <div className="drawer-confirm">
            <span>{confirm.question}</span>
            <button type="button" className="fchip" onClick={() => void open(confirm.target, true)}>
              Open anyway
            </button>
            <button type="button" className="fchip" onClick={() => setConfirm(null)}>
              Cancel
            </button>
          </div>
        )}
        {error && <div className="sheet-err">{error}</div>}
      </div>
      <div className="drawer-list">
        <div className="rail-h">
          Artifacts <span>{files.length}</span>
          <button type="button" className="fchip" onClick={onClose} title="Close (Esc)">
            Close
          </button>
        </div>
        {files.map(f => (
          <button
            type="button"
            key={`${f.path}${f.at}`}
            className={`drawer-row${sel === f ? ' on' : ''}`}
            onClick={() => setSel(f)}
            title={f.url ?? f.path}
          >
            <b>
              {!f.url && ext(f.path) && <span className="ext">{ext(f.path)}</span>}
              {f.url ? base(f.url) : base(f.path)}
            </b>
            <span>
              {f.url ? 'published' : f.tool} · {age(now - f.at)}
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
