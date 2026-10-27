// The window (spec MIP2-1370 §3): top bar, sidebar, Fleet and the right rail.
// It reads FleetSnapshots from window.ccc and derives every card from them.

import { useEffect, useMemo, useRef, useState } from 'react'
import type { FleetSnapshot } from '@ccc/contract'
import { cardView, deadView, NEEDS_YOU, withObservedIdle } from '../model/card-state.ts'
import { classify, inArchive, lastActivityOf, lifeOf, parentsOf } from '../../shared/lifecycle.ts'
import type { ArbiterState } from '../../shared/arbiter-state.ts'
import type { TurnSummary } from '../../shared/summaries.ts'
import type { AppStore } from '../../shared/store.ts'
import { attentionLine, catFilter, categoryRef, countFleet, groupFleet, nameOf, shownEntries, summaryFor, type CatRef, type Entry, type FilterId } from '../model/fleet.ts'
import { NO_SELECTION, type Selection } from '../model/selection.ts'
import { age } from '../model/format.ts'
import { History } from '../model/history.ts'
import { Archive, RollOffNotice } from './Archive.tsx'
import { ArbiterLogSheet } from './ArbiterLog.tsx'
import { MoveSheet } from './MoveSheet.tsx'
import { SettingsSheet } from './Settings.tsx'
import { CategoryEditor, StoreContext, type NoticeAction, type StoreApi } from './Categories.tsx'
import { FirstRun } from './FirstRun.tsx'
import { Fleet } from './Fleet.tsx'
import { Focus } from './Focus.tsx'
import { Jump } from './Jump.tsx'
import { NewSession } from './NewSession.tsx'
import { viewSelection } from './FocusPane.tsx'
import { FocusRail, Rail } from './Rail.tsx'
import { Sidebar } from './Sidebar.tsx'
import { TopBar } from './TopBar.tsx'

/** Below this width the rail starts collapsed (spec §3). */
const RAIL_MIN_WIDTH = 1280

function useNow(): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [])
  return now
}

export function App() {
  const [fleet, setFleet] = useState<FleetSnapshot | null>(null)
  /** Bulk select, shared by Fleet and the sidebar (MIP2-1407). */
  const [selection, setSelection] = useState<Selection>(NO_SELECTION)
  const [store, setStore] = useState<AppStore | null>(null)
  const [arbiter, setArbiter] = useState<ArbiterState | null>(null)
  const [arbiterLogOpen, setArbiterLogOpen] = useState(false)
  const [summaries, setSummaries] = useState<Record<string, TurnSummary>>({})
  /** The move sheet for 0.24's sessions (MIP2-1425). */
  const [move, setMove] = useState<{ preselect: string | null } | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  /** Review in first run step 2 shows Fleet's auto placements; the first run comes back at the next start. */
  const [firstRunHidden, setFirstRunHidden] = useState(false)
  /** The category editor: which category (null for a new one), and whether to open at Folders. */
  const [editor, setEditor] = useState<{ id: string | null; folders: boolean } | null>(null)
  const [filter, setFilter] = useState<FilterId>('all')
  const [railOpen, setRailOpen] = useState(() => window.innerWidth >= RAIL_MIN_WIDTH)
  /** The session open in Focus; null shows Fleet. */
  const [focused, setFocused] = useState<string | null>(null)
  const [focusTitle, setFocusTitle] = useState<string | null>(null)
  /** The session typing reaches; null when no view is attached. */
  const [typing, setTyping] = useState<string | null>(null)
  const [sheet, setSheet] = useState<'new' | 'jump' | 'archive' | null>(null)
  /** The archive opened from the roll-off notice shows only the sessions it covers. */
  const [archiveOnly, setArchiveOnly] = useState<string[] | null>(null)
  /** The category `＋` on a sidebar header presets; undefined from the top bar or ⌘N. */
  const [newCat, setNewCat] = useState<string | null | undefined>(undefined)
  /** The sheet's other forms: which session, and how (MIP2-1387 §2.3). */
  const [sheetSource, setSheetSource] = useState<{ kind: 'settings' | 'resume' | 'from'; sessionId: string; selection?: string } | null>(null)
  const [toast, setToast] = useState<{ text: string; action?: NoticeAction } | null>(null)
  const setNotice = (text: string | null, action?: NoticeAction) => setToast(text === null ? null : { text, action })
  // A toast with an action (Undo) goes after 10 s (MIP2-1387 §3).
  useEffect(() => {
    if (!toast?.action) return
    const t = setTimeout(() => setToast(cur => (cur === toast ? null : cur)), 10_000)
    return () => clearTimeout(t)
  }, [toast])
  const history = useRef(new History()).current
  const now = useNow()

  useEffect(() => {
    void window.ccc.getFleet().then(f => f && setFleet(f))
    return window.ccc.onFleet(setFleet)
  }, [])

  useEffect(() => {
    void window.ccc.getStore().then(s => s && setStore(s))
    const offStore = window.ccc.onStore(setStore)
    const offNotice = window.ccc.onNotice(text => setNotice(text))
    const offOpen = window.ccc.onOpenSession(id => openRef.current(id))
    const offNeeds = window.ccc.onOpenNeeds(() => (setFocused(null), setFilter('needs')))
    const offSettings = window.ccc.onOpenSettings(() => setSettingsOpen(true))
    void window.ccc.getArbiter().then(a => a && setArbiter(a))
    const offArbiter = window.ccc.onArbiter(setArbiter)
    void window.ccc.getSummaries().then(setSummaries)
    const offSummaries = window.ccc.onSummaries(setSummaries)
    return () => (offStore(), offNotice(), offOpen(), offArbiter(), offSummaries(), offNeeds(), offSettings())
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey && e.altKey && e.code === 'Digit0') setRailOpen(o => !o)
      if (e.metaKey && !e.altKey && e.code === 'Digit0') {
        setFocused(null)
        setFilter('all')
      }
      // xterm.js would send ⌘↩ as Return; the app consumes it everywhere (spec §2.4).
      if (e.metaKey && e.key === 'Enter') e.preventDefault()
      if (e.metaKey && !e.altKey && !e.shiftKey && e.code === 'KeyN') (e.preventDefault(), setNewCat(undefined), setSheetSource(null), setSheet('new'))
      if (e.metaKey && !e.altKey && !e.shiftKey && e.code === 'KeyK') (e.preventDefault(), setSheet('jump'))
      if (e.metaKey && e.shiftKey && e.code === 'KeyT') (e.preventDefault(), reopenRef.current())
      if (e.metaKey && e.shiftKey && e.code === 'KeyA') (e.preventDefault(), setArchiveOnly(null), setSheet('archive'))
      if (e.metaKey && !e.shiftKey && !e.altKey && e.code === 'Comma') (e.preventDefault(), setSettingsOpen(true))
      // ⌘1–⌘9: category 1–9 in sidebar order (spec MIP2-1370 §15).
      const digit = /^Digit([1-9])$/.exec(e.code)?.[1]
      if (digit && e.metaKey && !e.altKey && !e.shiftKey && !e.ctrlKey) (e.preventDefault(), categoryKeyRef.current(Number(digit)))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const entries: Entry[] = useMemo(() => {
    // Archived, rolled-off and removed sessions leave the live views (MIP2-1370 §4.1, MIP2-1393 §4.5).
    const list = (fleet?.sessions ?? []).filter(s => !inArchive(store?.sessions[s.sessionId]))
    history.forget(new Set(list.map(s => s.sessionId)))
    const parents = parentsOf(fleet?.sessions ?? [])
    const rollOffDays = store?.settings.rollOffDays ?? 7
    const built = list.map((session): Entry => {
      const meta = store?.sessions[session.sessionId]
      const cls = classify(session, meta, parents)
      const contractor = cls.kind === 'contractor' ? cls : null
      const first = cardView(session, now)
      const since = history.observe(session.sessionId, first.state, now)
      const life = lifeOf({
        lastActivityAt: lastActivityOf(session, meta),
        needsYou: NEEDS_YOU.has(first.state),
        neverRollOff: meta?.neverRollOff === true,
        contractor: contractor !== null,
        parentGone: false,
        rollOffDays,
        now,
      })
      const observed = withObservedIdle(first, since, now)
      const view = life.stage === 'dead' && !NEEDS_YOU.has(observed.state) ? deadView(observed, life.since) : observed
      history.paint(session.sessionId, view.state, now)
      return {
        session,
        view,
        since,
        cat: categoryRef(store, session.sessionId),
        name: nameOf(store, session),
        contractor,
        life,
        neverRollOff: meta?.neverRollOff === true,
        children: [],
        parentName: null,
        origin: (() => {
          const src = meta?.copyOf ?? meta?.fromSession
          if (!src) return undefined
          const s = fleet?.sessions.find(x => x.sessionId === src)
          const srcName = s ? nameOf(store, s) : (store?.sessions[src]?.name ?? 'another session')
          return `${meta?.copyOf ? 'copy of' : 'from'} ${srcName}`
        })(),
        arbiterStart: arbiter?.status === 'ranked' && arbiter.start?.sessionId === session.sessionId ? arbiter.start.unblocks : undefined,
        summary: summaryFor(session, summaries[session.sessionId]),
        inElectron: meta?.origin === 'import' && !meta.movedAt && session.kind.value === 'interactive',
        movable: meta?.origin !== 'app' && !meta?.movedAt && session.kind.value === 'interactive',
      }
    })
    const byId = new Map(built.map(e => [e.session.sessionId, e]))
    for (const e of built) {
      const parent = e.contractor?.parentId ? byId.get(e.contractor.parentId) : undefined
      if (!parent) continue
      parent.children.push(e)
      e.parentName = parent.name
    }
    return built
    // `now` ticks every second so ages and the 30-minute idle line move on their own.
  }, [fleet, store, arbiter, summaries, now, history])
  const rank = arbiter && arbiter.status !== 'off' ? arbiter.order.map(o => o.sessionId) : []
  const shown = useMemo(() => shownEntries(entries, store?.settings.showOutside), [entries, store?.settings.showOutside])

  const api: StoreApi = useMemo(
    () => ({
      store,
      entries,
      editCategory: (id, folders = false) => setEditor({ id, folders }),
      notice: setNotice,
      openMove: sessionId => setMove({ preselect: sessionId }),
      openSheet: (kind, sessionId) => (setSheetSource({ kind, sessionId, ...(kind === 'from' ? { selection: viewSelection(sessionId) } : {}) }), setSheet('new')),
    }),
    [store, entries],
  )

  /** Sessions being resumed by an open: a second open waits for the first, not a second resume (MIP2-1467). */
  const resuming = useRef(new Set<string>())
  /** Opens a session in Focus; an ended one is resumed first (spec MIP2-1379 §4a). */
  const open = async (sessionId: string) => {
    const e = entries.find(x => x.session.sessionId === sessionId)
    if (e?.view.state === 'ended') {
      if (resuming.current.has(sessionId)) return
      resuming.current.add(sessionId)
      setNotice(`Resuming ${e.name}…`)
      const r = await window.ccc.resume(sessionId).finally(() => resuming.current.delete(sessionId))
      setNotice(r.ok ? null : r.kind === 'copy' ? 'Resumed as a different session. The original conversation is unchanged on disk.' : `Can't resume: ${r.error}`)
      if (!r.ok) return
    }
    setSheet(null)
    setFocused(sessionId)
    // Opening is activity (§4.1), and drops an auto placement's `· auto` (§7).
    void window.ccc.markSeen(sessionId)
  }
  const openRef = useRef((_id: string) => {})
  openRef.current = id => void open(id)
  // ⌘⇧T: the most recently ended session, then the one before it (spec §4a).
  const reopened = useRef<string[]>([])
  const reopenRef = useRef(() => {})
  reopenRef.current = () => {
    const ended = groupFleet(entries, 'all').quiet.filter(e => e.view.state === 'ended' && !reopened.current.includes(e.session.sessionId))
    const next = ended[0]
    if (!next) return
    reopened.current.push(next.session.sessionId)
    void open(next.session.sessionId)
  }

  // In Fleet a category key filters; in Focus it opens the category's most recent session, as a header click does.
  const categoryKeyRef = useRef((_n: number) => {})
  categoryKeyRef.current = n => {
    const order: CatRef[] = [...countFleet(entries).byCategory.values()].map(x => x.cat)
    const cat = order[n - 1]
    if (!cat) return
    if (!focused) return setFilter(catFilter(cat))
    const recent = entries
      .filter(e => e.cat.id === cat.id && e.session.sessionId !== focused)
      .sort((a, b) => (b.session.turn?.value.endedAt ?? b.session.startedAt.value) - (a.session.turn?.value.endedAt ?? a.session.startedAt.value))[0]
    if (recent) void open(recent.session.sessionId)
    else (setFocused(null), setFilter(catFilter(cat)))
  }

  const counts = countFleet(entries)
  const line = attentionLine(groupFleet(entries, 'all', rank), counts, now, age, arbiter)

  // The window title carries the needs-you count (spec MIP2-1379 F9).
  useEffect(() => {
    if (focused && focusTitle) {
      document.title = focusTitle
      return
    }
    document.title = counts.needs > 0 ? `CC Command Center — ${counts.needs} need${counts.needs === 1 ? 's' : ''} you` : 'CC Command Center'
  }, [counts.needs, focused, focusTitle])

  return (
    <StoreContext.Provider value={api}>
    <div className="app">
      <TopBar
        line={line}
        counts={counts}
        usage={fleet?.usage ?? null}
        now={now}
        railOpen={railOpen}
        onToggleRail={() => setRailOpen(o => !o)}
        onNew={() => (setNewCat(undefined), setSheetSource(null), setSheet('new'))}
      />
      <div className={`body${railOpen ? '' : ' rail-off'}`}>
        <Sidebar entries={shown} now={now} onFilter={f => (setFocused(null), setFilter(f))} focused={focused} typing={typing}
          onOpen={id => void open(id)}
          onNew={id => (setNewCat(id), setSheetSource(null), setSheet('new'))}
          selection={selection}
          onSelection={setSelection}
        />
        {focused ? (
          <Focus focused={focused} entries={entries} onBackToFleet={() => setFocused(null)} onTitle={setFocusTitle} onTyping={setTyping} selfCheck={fleet?.selfCheck ?? null} />
        ) : (
          <Fleet entries={shown} rank={rank} now={now} filter={filter} onFilter={setFilter} selfCheck={fleet?.selfCheck ?? null} onOpen={id => void open(id)} selection={selection} onSelection={setSelection} />
        )}
        {railOpen &&
          (focused ? (
            <FocusRail entries={entries} focused={focused} now={now} onOpen={id => void open(id)} />
          ) : (
            <Rail entries={shown} history={history} now={now} sources={fleet?.sources ?? []} arbiter={arbiter} onArbiterLog={() => setArbiterLogOpen(true)} />
          ))}
      </div>
      {sheet === 'new' && (
        <NewSession
          preset={newCat}
          source={(() => {
            const e = sheetSource && entries.find(x => x.session.sessionId === sheetSource.sessionId)
            return e && sheetSource ? { kind: sheetSource.kind, entry: e, selection: sheetSource.selection } : undefined
          })()}
          onClose={() => (setSheet(null), setSheetSource(null))}
          onStarted={id => (setSheet(null), setSheetSource(null), setFocused(id))}
        />
      )}
      {sheet === 'archive' && <Archive sessions={fleet?.sessions ?? []} only={archiveOnly} now={now} onClose={() => setSheet(null)} />}
      {arbiterLogOpen && <ArbiterLogSheet onClose={() => setArbiterLogOpen(false)} />}
      {move && <MoveSheet entries={entries} preselect={move.preselect} onClose={() => setMove(null)} onOpen={id => void open(id)} />}
      {settingsOpen && (
        <SettingsSheet onClose={() => setSettingsOpen(false)} onMove={() => (setSettingsOpen(false), setMove({ preselect: null }))} onArbiterLog={() => setArbiterLogOpen(true)} arbiter={arbiter} selfCheck={fleet?.selfCheck ?? null} />
      )}
      <RollOffNotice onReview={ids => (setArchiveOnly(ids), setSheet('archive'))} />
      {/* Until it's finished; 0.24's sessions are its interactive ones with a process (step 3). */}
      {store && store.settings.firstRunDoneAt == null && !firstRunHidden && (
        <FirstRun
          onReview={() => (setFirstRunHidden(true), setFocused(null), setFilter('auto'))}
          onMove={() => (setFirstRunHidden(true), setMove({ preselect: null }))}
          electronRunning={(fleet?.sessions ?? []).filter(s => store.sessions[s.sessionId]?.origin === 'import' && s.kind.value === 'interactive' && s.pid.value !== null).length}
          onDone={() => setNotice('All set.')}
        />
      )}
      {sheet === 'jump' && (
        <Jump
          entries={entries}
          onClose={() => setSheet(null)}
          onPick={e => void open(e.session.sessionId)}
          onResumeWith={e => (setSheetSource({ kind: 'resume', sessionId: e.session.sessionId }), setSheet('new'))}
        />
      )}
      {toast && (
        <div className="toast" role="status" onClick={() => !toast.action && setToast(null)}>
          {toast.text}
          {toast.action && (
            <>
              {' '}
              <button type="button" className="link" onClick={() => (setToast(null), toast.action!.run())}>
                {toast.action.label}
              </button>
            </>
          )}
        </div>
      )}
      {editor && <CategoryEditor key={editor.id ?? 'new'} id={editor.id} folders={editor.folders} entries={entries} onClose={() => setEditor(null)} />}
    </div>
    </StoreContext.Provider>
  )
}
