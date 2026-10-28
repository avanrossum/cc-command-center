// The session switcher's order (spec MIP2-1494 §5.3): pins first, in Alex's
// order, then up to five recent sessions opened in Focus. Switching between
// chips already in the strip never reorders them, so a chip keeps its number.

import { SWITCHER_RECENT_MAX } from '../../shared/store.ts'

export interface SwitcherLists {
  pins: string[]
  recent: string[]
}

/**
 * The lists after `id` is opened in Focus. A session already in the strip
 * changes nothing. A new one joins on the right; when that makes six, the
 * least recently focused recent leaves (`focusedAt`, this run's times; one
 * never focused this run counts as oldest, leftmost first).
 */
export function noteOpened(l: SwitcherLists, id: string, focusedAt: ReadonlyMap<string, number>): SwitcherLists {
  if (l.pins.includes(id) || l.recent.includes(id)) return l
  const recent = [...l.recent, id]
  while (recent.length > SWITCHER_RECENT_MAX) {
    const others = recent.filter(x => x !== id)
    const oldest = others.reduce((a, b) => ((focusedAt.get(b) ?? -1) < (focusedAt.get(a) ?? -1) ? b : a))
    recent.splice(recent.indexOf(oldest), 1)
  }
  return { pins: l.pins, recent }
}

/** The chips, in order: listed pins, then listed recents. */
export function chipIds(l: SwitcherLists, listed: ReadonlySet<string>): string[] {
  return [...l.pins.filter(id => listed.has(id)), ...l.recent.filter(id => listed.has(id) && !l.pins.includes(id))]
}

/** Drops ids that are no longer listed (at startup, §5.5). */
export function pruned(l: SwitcherLists, listed: ReadonlySet<string>): SwitcherLists {
  return { pins: l.pins.filter(id => listed.has(id)), recent: l.recent.filter(id => listed.has(id)) }
}

/**
 * Pins or unpins `id`. A pin joins the end of the pins and leaves the
 * recents. An unpinned session becomes a recent when it's the current one,
 * since the current session always has a chip; otherwise it leaves.
 */
export function togglePin(l: SwitcherLists, id: string, current: string | null, focusedAt: ReadonlyMap<string, number>): SwitcherLists {
  if (!l.pins.includes(id)) return { pins: [...l.pins, id], recent: l.recent.filter(x => x !== id) }
  const unpinned = { pins: l.pins.filter(x => x !== id), recent: l.recent }
  return id === current ? noteOpened(unpinned, id, focusedAt) : unpinned
}

/** Moves `id` one place left (-1) or right (+1) within its group. */
export function moveChip(l: SwitcherLists, id: string, by: -1 | 1): SwitcherLists {
  const shift = (list: string[]) => {
    const i = list.indexOf(id)
    const j = i + by
    if (i < 0 || j < 0 || j >= list.length) return list
    const out = [...list]
    ;[out[i], out[j]] = [out[j]!, out[i]!]
    return out
  }
  return { pins: shift(l.pins), recent: shift(l.recent) }
}

/** Moves a pinned `id` to just before `before` (drag to reorder), or to the end when `before` is null. */
export function movePin(l: SwitcherLists, id: string, before: string | null): SwitcherLists {
  if (!l.pins.includes(id) || id === before) return l
  const rest = l.pins.filter(x => x !== id)
  const at = before === null ? rest.length : rest.indexOf(before)
  if (at < 0) return l
  return { pins: [...rest.slice(0, at), id, ...rest.slice(at)], recent: l.recent }
}

export function removeRecent(l: SwitcherLists, id: string): SwitcherLists {
  return { pins: l.pins, recent: l.recent.filter(x => x !== id) }
}

/** The chip `by` places from `current`, wrapping (⌘⇧[ and ⌘⇧], §5.4); the first or last chip when none is current. */
export function cycle(chips: readonly string[], current: string | null, by: -1 | 1): string | null {
  if (!chips.length) return null
  const i = current === null ? -1 : chips.indexOf(current)
  if (i < 0) return by > 0 ? chips[0]! : chips.at(-1)!
  return chips[(i + by + chips.length) % chips.length]!
}

/**
 * How the strip fits `width` px (§5.3): full names (up to 18 characters),
 * then names cut to 10, then chips into the `+n` menu, recents oldest first
 * and pins after. `measured` holds chips' rendered widths by id and name
 * length; a chip not yet drawn at that length is estimated from its name.
 */
export function fitStrip(
  chips: readonly string[],
  pins: readonly string[],
  names: ReadonlyMap<string, string>,
  width: number,
  measured: ReadonlyMap<string, number> = new Map(),
): { shown: string[]; overflow: string[]; short: boolean } {
  const chipWidth = (id: string, max: number) => measured.get(`${id}:${max}`) ?? 60 + Math.min(max, (names.get(id) ?? '').length) * 7
  const total = (ids: readonly string[], max: number) => ids.reduce((w, id) => w + chipWidth(id, max) + 6, 0)
  if (total(chips, 18) <= width) return { shown: [...chips], overflow: [], short: false }
  const MORE = 48
  const shown = [...chips]
  const overflow: string[] = []
  // Recents leave first, leftmost (oldest to join) first; then pins, from the right.
  const order = [...chips.filter(id => !pins.includes(id)), ...chips.filter(id => pins.includes(id)).reverse()]
  for (const id of order) {
    if (total(shown, 10) + (overflow.length ? MORE : 0) <= width) break
    shown.splice(shown.indexOf(id), 1)
    overflow.push(id)
  }
  return { shown, overflow, short: true }
}

/** A chip's name: cut to `max` characters with an ellipsis. */
export function chipName(name: string, max: number): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name
}
