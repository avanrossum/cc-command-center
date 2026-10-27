// Bulk select's click gestures (MIP2-1407; D-014 parity item 8): ⌘-click
// toggles a session into the selection, ⇧-click adds the range from the
// last ⌘-clicked one, in the order the clicked surface shows them. Pure.

export interface Selection {
  /** Null when not selecting. */
  picked: Set<string> | null
  /** Where a ⇧-click range starts. */
  anchor: string | null
}

export const NO_SELECTION: Selection = { picked: null, anchor: null }

/** The selection after a click, or null when the click isn't a selection gesture (open the session instead). */
export function selectClick(sel: Selection, id: string, order: readonly string[], mods: { meta: boolean; shift: boolean }): Selection | null {
  if (mods.shift) {
    const from = sel.anchor ? order.indexOf(sel.anchor) : -1
    const to = order.indexOf(id)
    const picked = new Set(sel.picked)
    if (from < 0 || to < 0) return { picked: picked.add(id), anchor: id }
    for (const x of order.slice(Math.min(from, to), Math.max(from, to) + 1)) picked.add(x)
    return { picked, anchor: sel.anchor }
  }
  if (mods.meta) {
    const picked = new Set(sel.picked)
    if (picked.has(id)) picked.delete(id)
    else picked.add(id)
    return { picked, anchor: id }
  }
  return null
}
