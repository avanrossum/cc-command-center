// The main window remembers its size, position, and maximized or full-screen
// state (MIP2-1519). The decisions are pure: checking a saved state, and
// placing it against the current displays. Saved in userData/window-state.json,
// the app's own file, written whole through a temporary name.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const WINDOW_MIN = { width: 1100, height: 640 } as const
export const WINDOW_MAX = { width: 10_000, height: 10_000 } as const
export const WINDOW_DEFAULT = { width: 1400, height: 900 } as const

export interface Bounds {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState {
  bounds: Bounds
  maximized: boolean
  fullScreen: boolean
}

const num = (v: unknown, lo: number, hi: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi

/** A saved state, checked: finite numbers in range and booleans; null if anything is off, so the default is used. */
export function checkWindowState(v: unknown): WindowState | null {
  if (typeof v !== 'object' || v === null) return null
  const s = v as { bounds?: unknown; maximized?: unknown; fullScreen?: unknown }
  const b = s.bounds as Partial<Record<keyof Bounds, unknown>> | undefined
  if (typeof b !== 'object' || b === null) return null
  if (!num(b.x, -100_000, 100_000) || !num(b.y, -100_000, 100_000)) return null
  if (!num(b.width, WINDOW_MIN.width, WINDOW_MAX.width) || !num(b.height, WINDOW_MIN.height, WINDOW_MAX.height)) return null
  if (typeof s.maximized !== 'boolean' || typeof s.fullScreen !== 'boolean') return null
  return { bounds: { x: Math.round(b.x), y: Math.round(b.y), width: Math.round(b.width), height: Math.round(b.height) }, maximized: s.maximized, fullScreen: s.fullScreen }
}

/** How much of `a` lies inside `b`, in square pixels. */
function overlap(a: Bounds, b: Bounds): number {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * Where to open the window. The saved bounds when enough of the window's
 * title area is on a current display to grab it; otherwise centered on the
 * primary display at the saved size, clamped to that display's work area.
 * No saved state: the default size, centered by the window itself.
 */
export function placeWindow(saved: WindowState | null, displays: readonly Bounds[], primary: Bounds): { bounds: Partial<Bounds> & { width: number; height: number }; maximized: boolean; fullScreen: boolean } {
  if (!saved) return { bounds: { ...WINDOW_DEFAULT }, maximized: false, fullScreen: false }
  const b = saved.bounds
  // The top strip, where the window is dragged from: at least 100 × 30 of it must be on a display.
  const titleStrip = { x: b.x, y: b.y, width: b.width, height: 30 }
  if (displays.some(d => overlap(titleStrip, d) >= 100 * 30)) return { bounds: b, maximized: saved.maximized, fullScreen: saved.fullScreen }
  const width = Math.max(WINDOW_MIN.width, Math.min(b.width, primary.width))
  const height = Math.max(WINDOW_MIN.height, Math.min(b.height, primary.height))
  return {
    bounds: { x: Math.round(primary.x + (primary.width - width) / 2), y: Math.round(primary.y + (primary.height - height) / 2), width, height },
    maximized: saved.maximized,
    fullScreen: saved.fullScreen,
  }
}

export function loadWindowState(path: string): WindowState | null {
  try {
    return checkWindowState(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return null
  }
}

export function saveWindowState(path: string, s: WindowState): void {
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(`${path}.tmp`, JSON.stringify(s), { mode: 0o600 })
    renameSync(`${path}.tmp`, path)
  } catch (err) {
    console.warn(`window state: ${String(err)}`)
  }
}
