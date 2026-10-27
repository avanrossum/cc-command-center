// Shift+Enter in the session view is a newline, sent once (MIP2-1458).

import { describe, expect, it } from 'vitest'
import { shiftEnterKey } from '../src/renderer/components/FocusPane.tsx'

const key = (type: string, over: Partial<KeyboardEvent> = {}) => ({ type, key: 'Enter', shiftKey: true, ctrlKey: false, altKey: false, metaKey: false, ...over })

describe('shiftEnterKey', () => {
  it('sends LF on keydown and swallows the keypress and keyup, so xterm never sends CR for it', () => {
    expect(shiftEnterKey(key('keydown'))).toBe('send')
    expect(shiftEnterKey(key('keypress'))).toBe('swallow')
    expect(shiftEnterKey(key('keyup'))).toBe('swallow')
  })

  it('leaves Enter, Option+Enter, Ctrl+Enter, ⌘+Enter and other keys to xterm', () => {
    expect(shiftEnterKey(key('keydown', { shiftKey: false }))).toBe('pass')
    expect(shiftEnterKey(key('keypress', { shiftKey: false }))).toBe('pass')
    expect(shiftEnterKey(key('keydown', { altKey: true }))).toBe('pass')
    expect(shiftEnterKey(key('keydown', { ctrlKey: true }))).toBe('pass')
    expect(shiftEnterKey(key('keydown', { metaKey: true }))).toBe('pass')
    expect(shiftEnterKey(key('keydown', { key: 'j', ctrlKey: true, shiftKey: false }))).toBe('pass')
  })
})
