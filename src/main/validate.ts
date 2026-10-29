// Checks for what the renderer sends to main (src/main/control.ts). Pure, so
// they're tested without Electron. The renderer is treated as able to send
// anything.

import type { AnswerRequest, LaunchRequest } from '../shared/ipc.ts'
import { checkFlags } from '../shared/flags.ts'
import { SIDEBAR_WIDTH, type Category } from '../shared/store.ts'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** The largest single input, paste or prompt accepted from the renderer. */
const MAX_TEXT = 1024 * 1024
const NAME = /^[\w .,:()'#@+-]{1,120}$/
const MODEL = /^[a-z0-9][a-z0-9.\-[\]]{0,63}$/
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max'])
const MODES = new Set(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions', 'dontAsk'])

export function isSessionId(v: unknown): v is string {
  return typeof v === 'string' && UUID.test(v)
}

export function isText(v: unknown): v is string {
  return typeof v === 'string' && v.length <= MAX_TEXT
}

export function isSize(v: unknown): v is number {
  return Number.isInteger(v) && (v as number) > 0 && (v as number) <= 2000
}

/** A launch request with only known fields and values; null if anything is off. */
export function checkLaunch(v: unknown): LaunchRequest | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  if (typeof r.cwd !== 'string' || !r.cwd.startsWith('/') || r.cwd.length > 4096 || r.cwd.includes('\0')) return null
  const out: LaunchRequest = { cwd: r.cwd }
  if (r.name !== undefined) {
    if (typeof r.name !== 'string' || !NAME.test(r.name)) return null
    out.name = r.name
  }
  if (r.model !== undefined) {
    if (typeof r.model !== 'string' || !MODEL.test(r.model)) return null
    out.model = r.model
  }
  if (r.effort !== undefined) {
    if (typeof r.effort !== 'string' || !EFFORTS.has(r.effort)) return null
    out.effort = r.effort
  }
  if (r.permissionMode !== undefined) {
    if (typeof r.permissionMode !== 'string' || !MODES.has(r.permissionMode)) return null
    out.permissionMode = r.permissionMode
  }
  if (r.prompt !== undefined) {
    if (!isText(r.prompt)) return null
    out.prompt = r.prompt
  }
  if (r.isolation !== undefined) {
    if (r.isolation !== 'none' && r.isolation !== 'worktree') return null
    out.isolation = r.isolation
  }
  if (r.resume !== undefined) {
    if (!isSessionId(r.resume)) return null
    out.resume = r.resume
  }
  if (r.fromSession !== undefined) {
    if (!isSessionId(r.fromSession)) return null
    out.fromSession = r.fromSession
  }
  if (r.ultracode !== undefined) {
    if (typeof r.ultracode !== 'boolean') return null
    out.ultracode = r.ultracode
  }
  if (r.extraArgs !== undefined) {
    // The app's own flags are refused here too, whatever the window sent.
    const f = Array.isArray(r.extraArgs) ? checkFlags(r.extraArgs) : null
    if (!f?.ok) return null
    out.extraArgs = f.args
  }
  return out
}

export function checkAnswer(v: unknown): AnswerRequest | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  if (r.verdict === 'deny') return { verdict: 'deny' }
  if (r.verdict !== 'allow') return null
  if (r.answers === undefined) return { verdict: 'allow' }
  if (typeof r.answers !== 'object' || r.answers === null || Array.isArray(r.answers)) return null
  const answers: Record<string, string> = {}
  for (const [k, val] of Object.entries(r.answers)) {
    if (typeof val !== 'string' || k.length > 4096 || val.length > 4096) return null
    answers[k] = val
  }
  return { verdict: 'allow', answers }
}

/** The settings sheet's fields (MIP2-1407): known keys with sane values only; null if anything is off. */
/** A font family name for the terminal: letters, digits, spaces and `-_.`, so it can't break out of the CSS font list. */
export const FONT_NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/
export const FONT_SIZE = { min: 9, max: 32 } as const

export function checkSettings(v: unknown): Record<string, boolean | number | string> | null {
  if (typeof v !== 'object' || v === null) return null
  const out: Record<string, boolean | number | string> = {}
  for (const [k, val] of Object.entries(v)) {
    if (k === 'terminalFont') {
      // Empty clears it: the system monospace.
      if (typeof val !== 'string' || (val.trim() !== '' && !FONT_NAME.test(val.trim()))) return null
      out[k] = val.trim()
    } else if (k === 'terminalFontSize') {
      if (typeof val !== 'number' || !Number.isInteger(val) || val < FONT_SIZE.min || val > FONT_SIZE.max) return null
      out[k] = val
    } else if (['notifyEnabled', 'notifyNeedsYou', 'notifyTurn', 'arbiterEnabled', 'showOutside', 'hideOutsideAsked', 'showParked', 'betaUpdates'].includes(k)) {
      if (typeof val !== 'boolean') return null
      out[k] = val
    } else if (k === 'quitSessions') {
      if (val !== 'ask' && val !== 'close' && val !== 'keep') return null
      out[k] = val
    } else if (k === 'sidebarWidth') {
      if (typeof val !== 'number' || !Number.isInteger(val) || val < SIDEBAR_WIDTH.min || val > SIDEBAR_WIDTH.max) return null
      out[k] = val
    } else if (k === 'rollOffDays') {
      if (typeof val !== 'number' || !Number.isInteger(val) || val < 7 || val > 14) return null
      out[k] = val
    } else if (k === 'arbiterCapUsd') {
      if (typeof val !== 'number' || !Number.isFinite(val) || val < 0 || val > 100) return null
      out[k] = val
    } else return null
  }
  return out
}

const CATEGORY_ID = /^[a-z][a-z0-9]{0,15}$/
const COLOR = /^#[0-9a-f]{6}$/i
const MAX_FOLDERS = 64

export function isCategoryId(v: unknown): v is string {
  return typeof v === 'string' && CATEGORY_ID.test(v)
}

const isFolder = (f: unknown): f is string => typeof f === 'string' && f.startsWith('/') && f.length <= 4096 && !f.includes('\0')

/** The category editor's fields, each checked; null if anything is off. */
export function checkCategory(v: unknown): Partial<Category> | null {
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  const out: Partial<Category> = {}
  if (r.id !== undefined) {
    if (!isCategoryId(r.id)) return null
    out.id = r.id
  }
  for (const [key, max] of [['name', 60], ['label', 8], ['emoji', 8]] as const) {
    if (r[key] === undefined) continue
    if (typeof r[key] !== 'string' || [...(r[key] as string)].length > max) return null
    out[key] = r[key] as string
  }
  if (r.color !== undefined) {
    if (typeof r.color !== 'string' || !COLOR.test(r.color)) return null
    out.color = r.color
  }
  for (const key of ['folders', 'notFolders'] as const) {
    if (r[key] === undefined) continue
    const list = r[key]
    if (!Array.isArray(list) || list.length > MAX_FOLDERS || !list.every(isFolder)) return null
    out[key] = list
  }
  if (r.isolation !== undefined) {
    if (r.isolation !== 'none' && r.isolation !== 'worktree') return null
    out.isolation = r.isolation
  }
  for (const key of ['notifyNeeds', 'notifyTurn'] as const) {
    if (r[key] === undefined) continue
    if (r[key] !== 'auto' && r[key] !== 'on' && r[key] !== 'off') return null
    out[key] = r[key] as 'auto' | 'on' | 'off'
  }
  for (const key of ['arbiterReadsText', 'collapsed'] as const) {
    if (r[key] === undefined) continue
    if (typeof r[key] !== 'boolean') return null
    out[key] = r[key] as boolean
  }
  return out
}

/**
 * 0.24's settings from its registry, run through the same checks as values
 * typed here (gate L-2, MIP2-1431). A value that fails is dropped, and the
 * app's default stands. The font name reaches xterm.js's generated style.
 */
export function checkImportedSettings<T extends { lastFolder?: string; lastModel?: string; lastEffort?: string; lastMode?: string; terminalFont?: string; terminalFontSize?: number }>(v: T): T {
  const out = { ...v }
  if (out.lastFolder !== undefined && !(out.lastFolder.startsWith('/') && out.lastFolder.length <= 4096 && !out.lastFolder.includes('\0'))) delete out.lastFolder
  if (out.lastModel !== undefined && !MODEL.test(out.lastModel)) delete out.lastModel
  if (out.lastEffort !== undefined && !EFFORTS.has(out.lastEffort)) delete out.lastEffort
  if (out.lastMode !== undefined && !MODES.has(out.lastMode)) delete out.lastMode
  if (out.terminalFont !== undefined && !FONT_NAME.test(out.terminalFont)) delete out.terminalFont
  if (out.terminalFontSize !== undefined && !(Number.isInteger(out.terminalFontSize) && out.terminalFontSize >= FONT_SIZE.min && out.terminalFontSize <= FONT_SIZE.max)) delete out.terminalFontSize
  return out
}

/** Dropped files' paths to insert: absolute, bounded, and with no control characters, as with typed flags (gate L-5). */
export function droppedPaths(paths: readonly unknown[]): string[] {
  return paths.filter((p): p is string => typeof p === 'string' && p.startsWith('/') && p.length < 4096 && !/[\u0000-\u001f\u007f]/.test(p))
}
