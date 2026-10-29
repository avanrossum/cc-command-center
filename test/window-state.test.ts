// The window remembers its size, position and maximized or full-screen state (MIP2-1519).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { checkWindowState, loadWindowState, placeWindow, saveWindowState, WINDOW_DEFAULT } from '../src/main/window-state.ts'

const primary = { x: 0, y: 25, width: 1728, height: 1092 }
const second = { x: 1728, y: 0, width: 2560, height: 1415 }
const saved = { bounds: { x: 1900, y: 100, width: 1600, height: 1000 }, maximized: false, fullScreen: false }

describe('window state (MIP2-1519)', () => {
  it('restores the saved bounds and state on a display that is still there, after a round trip to disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ccc-win-'))
    try {
      const path = join(dir, 'window-state.json')
      saveWindowState(path, { ...saved, maximized: true })
      const place = placeWindow(loadWindowState(path), [primary, second], primary)
      expect(place).toEqual({ bounds: saved.bounds, maximized: true, fullScreen: false })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('centers on the primary display at the saved size, clamped to it, when the saved spot is off every display', () => {
    const place = placeWindow(saved, [primary], primary)
    expect(place.bounds).toEqual({ x: 64, y: 71, width: 1600, height: 1000 })
    const big = placeWindow({ ...saved, bounds: { ...saved.bounds, width: 3000, height: 2000 } }, [primary], primary)
    expect(big.bounds).toMatchObject({ x: 0, y: 25, width: 1728, height: 1092 })
  })

  it('ignores a saved state that is malformed, out of range or missing, and uses the default', () => {
    for (const bad of [null, 'x', {}, { ...saved, bounds: { ...saved.bounds, width: 300 } }, { ...saved, bounds: { ...saved.bounds, x: Number.NaN } }, { ...saved, maximized: 'yes' }]) {
      expect(checkWindowState(bad)).toBeNull()
    }
    expect(placeWindow(null, [primary], primary)).toEqual({ bounds: WINDOW_DEFAULT, maximized: false, fullScreen: false })
    const dir = mkdtempSync(join(tmpdir(), 'ccc-win-'))
    try {
      writeFileSync(join(dir, 'w.json'), '{not json')
      expect(loadWindowState(join(dir, 'w.json'))).toBeNull()
      expect(loadWindowState(join(dir, 'missing.json'))).toBeNull()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
