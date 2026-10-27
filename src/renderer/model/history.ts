// What the app has seen each session do, kept in memory: when it entered its
// current state, and the right rail's "Who's been active" strip (spec §11):
// one cell per 100 s over the last 25 minutes, colored by state.

import type { CardState } from './card-state.ts'

export const CELL_MS = 100_000
export const CELLS = 15

interface Track {
  state: CardState
  since: number
  /** False until the app sees the session change state: the first sighting's time isn't when the state began. */
  seenEnter: boolean
  /** State per cell index (Math.floor(time / CELL_MS)); the most urgent seen in that cell wins. */
  cells: Map<number, CardState>
}

const URGENCY: CardState[] = ['approval', 'sandbox', 'request', 'question', 'working', 'asked', 'agents', 'turn', 'idle', 'ended', 'dead']

export class History {
  private readonly tracks = new Map<string, Track>()

  /**
   * Records one observation. Returns when the session entered this state as
   * the app saw it, or null when the app has seen it in no other state yet.
   */
  observe(sessionId: string, state: CardState, now: number): number | null {
    const cell = Math.floor(now / CELL_MS)
    let t = this.tracks.get(sessionId)
    if (!t || t.state !== state) {
      t = { state, since: now, seenEnter: t !== undefined, cells: t?.cells ?? new Map() }
      this.tracks.set(sessionId, t)
    }
    for (const k of t.cells.keys()) if (k < cell - CELLS) t.cells.delete(k)
    return t.seenEnter ? t.since : null
  }

  /** Colors the current cell with the state the card shows; the most urgent in a cell wins. */
  paint(sessionId: string, state: CardState, now: number): void {
    const t = this.tracks.get(sessionId)
    if (!t) return
    const cell = Math.floor(now / CELL_MS)
    const prev = t.cells.get(cell)
    if (prev === undefined || URGENCY.indexOf(state) < URGENCY.indexOf(prev)) t.cells.set(cell, state)
  }

  /** Cells oldest to newest; null where the app saw nothing. */
  strip(sessionId: string, now: number): (CardState | null)[] {
    const t = this.tracks.get(sessionId)
    const last = Math.floor(now / CELL_MS)
    return Array.from({ length: CELLS }, (_, i) => t?.cells.get(last - CELLS + 1 + i) ?? null)
  }

  forget(keep: ReadonlySet<string>): void {
    for (const id of this.tracks.keys()) if (!keep.has(id)) this.tracks.delete(id)
  }
}
