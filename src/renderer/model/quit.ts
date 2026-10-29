// The quit modal's copy and list (MIP2-1528, spec MIP2-1462 §4, §5, §8).
// Pure: the sheet renders from these.

import type { QuitBusy, QuitRow } from '../../shared/quit.ts'
import { UNCAT_REF, type CatRef, type Entry } from './fleet.ts'

const sessions = (n: number) => `${n} ${n === 1 ? 'session' : 'sessions'}`

export function modalBody(n: number): string {
  return `${sessions(n)} started in this app ${n === 1 ? 'is' : 'are'} running. Closing stops them; you can resume any of them from the app later. Sessions started outside the app and contractors keep running either way.`
}

/** The ⚠ line, or null when nothing closable is working or waiting on Alex. */
export function busyWarning(n: number): string | null {
  if (n === 0) return null
  return n === 1 ? '1 is working or waiting on you. It keeps running unless you pick it below.' : `${n} are working or waiting on you. They keep running unless you pick them below.`
}

export const BUSY_NOTE: Record<QuitBusy, string> = {
  working: 'Working: stopping it ends the turn.',
  waiting: 'Waiting on you: stopping it ends the wait.',
}

/** The list's primary button: the unchecked rows are closed (§5). */
export function listButton(rows: number, kept: number): string {
  const close = rows - kept
  return close > 0 ? `Close ${close} and quit` : 'Quit'
}

export function stoppingLine(n: number): string {
  return `Stopping ${sessions(n)}…`
}

export interface QuitListRow extends QuitRow {
  name: string
  entry: Entry | null
}

/** Rows grouped by category in sidebar order, Uncategorized last (§5). */
export function quitGroups(rows: readonly QuitRow[], entries: readonly Entry[]): { cat: CatRef; rows: QuitListRow[] }[] {
  const byId = new Map(entries.map(e => [e.session.sessionId, e]))
  const groups = new Map<string, { cat: CatRef; rows: QuitListRow[] }>()
  for (const r of rows) {
    const e = byId.get(r.sessionId) ?? null
    const cat = e?.cat ?? UNCAT_REF
    const key = cat.id ?? ''
    const g = groups.get(key) ?? { cat, rows: [] }
    g.rows.push({ ...r, name: e?.name ?? `Session ${r.sessionId.slice(0, 8)}`, entry: e })
    groups.set(key, g)
  }
  return [...groups.values()].sort((a, b) => (a.cat.id === null ? 1 : b.cat.id === null ? -1 : a.cat.sort - b.cat.sort))
}

/** A row's state word: the card's label up to its detail, lower case. */
export function stateWord(r: QuitListRow): string {
  if (r.busy === 'waiting') return 'needs you'
  if (r.busy === 'working') return 'working'
  return (r.entry?.view.label.split(' · ')[0] ?? 'running').toLowerCase()
}

/** A header's checkbox: every row kept, none, or some (a dash). */
export function headerState(rows: readonly QuitRow[], kept: ReadonlySet<string>): 'all' | 'none' | 'some' {
  const n = rows.filter(r => kept.has(r.sessionId)).length
  return n === 0 ? 'none' : n === rows.length ? 'all' : 'some'
}
