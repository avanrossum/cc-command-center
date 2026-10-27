// First run, step 1 (MIP2-1412; spec MIP2-1370 §14, MIP2-1379 §4): the old
// Electron mailbox's permission rules in Claude Code's user settings.
// Claude Code now has its own peer messaging, so the rules grant edits to a
// folder nothing uses.
//
// This is the one change the app makes to `~/.claude/settings.json`, and
// only on Alex's press in the dialog (FRAGO-001 constraint 5). It backs the
// file up first, removes only the matching `permissions.allow` entries,
// keeps every other key and value, and refuses if the file changed while
// it worked.

import { constants, copyFileSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { debugPortAllowed } from './paths.ts'

/** `Edit(~/.claude/ccc/mail/**)`, `Edit(~/.claude/ccc/mail-dev/**)`, and the like. */
const MAILBOX_RULE = /^(?:Edit|Write|Read)\(~\/\.claude\/ccc\/mail(?:-[a-z]+)?\/\*\*\)$/

/**
 * Where Claude Code's user settings are. `CCC_CLAUDE_SETTINGS` points the
 * first run at a copy, for development and QA only (the same rule as the
 * debugging port, MIP2-1408).
 */
export function claudeSettingsPath(env: NodeJS.ProcessEnv, isPackaged: boolean): string {
  const override = env.CCC_CLAUDE_SETTINGS
  if (!override) return join(homedir(), '.claude', 'settings.json')
  if (!debugPortAllowed(env, isPackaged)) throw new Error('CCC_CLAUDE_SETTINGS needs CCC_QA=1 and an unpackaged build')
  if (!isAbsolute(override)) throw new Error('CCC_CLAUDE_SETTINGS must be an absolute path')
  return override
}

type Settings = { permissions?: { allow?: unknown } } & Record<string, unknown>

function parse(text: string): Settings {
  const v = JSON.parse(text) as unknown
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('settings.json is not an object')
  return v as Settings
}

function rulesIn(s: Settings): string[] {
  const allow = s.permissions?.allow
  return Array.isArray(allow) ? allow.filter((r): r is string => typeof r === 'string' && MAILBOX_RULE.test(r)) : []
}

/** The mailbox rules present, read only. Missing or unreadable settings have none. */
export function findMailboxRules(path: string): string[] {
  try {
    return rulesIn(parse(readFileSync(path, 'utf8')))
  } catch {
    return []
  }
}

/** A JSON value's place in the text, from a scanner that keeps exact byte spans. */
interface Node {
  start: number
  end: number
  kind: 'object' | 'array' | 'string' | 'other'
  /** Objects: each member's key and value. */
  members?: { key: string; value: Node }[]
  /** Arrays: each element. */
  items?: Node[]
}

/** Scans JSON without changing anything: spans only, for editing the text in place (MIP2-1421). */
function scan(text: string): Node {
  let i = 0
  const ws = () => {
    while (i < text.length && ' \t\r\n'.includes(text[i]!)) i++
  }
  const fail = (): never => {
    throw new Error(`settings.json isn't valid JSON near character ${i}`)
  }
  const str = (): Node => {
    const start = i++
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1
    if (text[i] !== '"') fail()
    i++
    return { start, end: i, kind: 'string' }
  }
  const value = (): Node => {
    ws()
    const c = text[i]
    if (c === '"') return str()
    if (c === '{' || c === '[') {
      const start = i++
      const node: Node = c === '{' ? { start, end: 0, kind: 'object', members: [] } : { start, end: 0, kind: 'array', items: [] }
      const close = c === '{' ? '}' : ']'
      ws()
      if (text[i] === close) return (i++, { ...node, end: i })
      for (;;) {
        if (c === '{') {
          ws()
          if (text[i] !== '"') fail()
          const k = str()
          ws()
          if (text[i++] !== ':') fail()
          node.members!.push({ key: JSON.parse(text.slice(k.start, k.end)) as string, value: value() })
        } else node.items!.push(value())
        ws()
        if (text[i] === ',') (i++, ws())
        else if (text[i] === close) return (i++, { ...node, end: i })
        else fail()
      }
    }
    const start = i
    while (i < text.length && !',}] \t\r\n'.includes(text[i]!)) i++
    if (i === start) fail()
    return { start, end: i, kind: 'other' }
  }
  const root = value()
  ws()
  if (i !== text.length) fail()
  return root
}

/** The one member named `key`; two with that name are ambiguous, so the edit is refused. */
function member(node: Node | undefined, key: string): Node | undefined {
  const found = (node?.members ?? []).filter(m => m.key === key)
  if (found.length > 1) throw new Error(`settings.json has "${key}" twice. Edit it by hand.`)
  return found[0]?.value
}

/**
 * The text with only the matching `permissions.allow` entries removed (MIP2-1421).
 * Every other byte stays as it was, so large integers, escapes, number
 * forms and layout survive. The result must parse to the original minus
 * those entries, or nothing is changed.
 */
export function withoutMailboxRules(text: string): { text: string; removed: string[] } {
  const root = scan(text)
  if (root.kind !== 'object') throw new Error('settings.json is not an object')
  const allow = member(member(root, 'permissions'), 'allow')
  if (allow?.kind !== 'array') return { text, removed: [] }
  const items = allow.items!
  const hit = items.map(n => n.kind === 'string' && MAILBOX_RULE.test(JSON.parse(text.slice(n.start, n.end)) as string))
  const removed = items.filter((_, k) => hit[k]).map(n => JSON.parse(text.slice(n.start, n.end)) as string)
  if (!removed.length) return { text, removed }
  // Every cut is a range of the original text, worked out before any is made:
  // - none kept: the whole inside of the brackets;
  // - a removed element before the last kept one: from its start to the next element's start;
  // - removed elements after the last kept one: from the end of that kept one to the end of the last.
  // The ranges don't overlap, so applying them last to first keeps each one valid (MIP2-1421).
  const kept = items.map((_, k) => k).filter(k => !hit[k])
  const cuts: [number, number][] = []
  if (!kept.length) cuts.push([allow.start + 1, allow.end - 1])
  else {
    const lastKept = kept.at(-1)!
    for (let k = 0; k < lastKept; k++) if (hit[k]) cuts.push([items[k]!.start, items[k + 1]!.start])
    if (lastKept < items.length - 1) cuts.push([items[lastKept]!.end, items.at(-1)!.end])
  }
  let out = text
  for (const [from, to] of cuts.sort((a, b) => b[0] - a[0])) out = out.slice(0, from) + out.slice(to)
  const want = parse(text)
  ;(want.permissions as { allow: unknown[] }).allow = (want.permissions!.allow as unknown[]).filter(r => !(typeof r === 'string' && removed.includes(r)))
  let check: unknown
  try {
    check = parse(out)
  } catch {
    check = null
  }
  if (JSON.stringify(check) !== JSON.stringify(want)) {
    throw new Error("Nothing was changed: the edit didn't come out as planned, so your settings file is as it was. Remove the two rules by hand, or keep them for now.")
  }
  return { text: out, removed }
}

export interface RemoveResult {
  removed: string[]
  /** The backup, an exact copy of the file before the change; null when nothing was removed. */
  backup: string | null
}

export function removeMailboxRules(link: string, now: Date = new Date()): RemoveResult {
  // A symlinked settings.json (a dotfiles repo) is edited where it points:
  // that's the file Claude Code reads. Replacing the link would detach it (MIP2-1421).
  const path = realpathSync(link)
  const before = statSync(path)
  const text = readFileSync(path, 'utf8')
  const { text: next, removed } = withoutMailboxRules(text)
  if (!removed.length) return { removed, backup: null }
  const backup = `${link}.ccc-backup-${now.toISOString().replace(/[:.]/g, '-')}`
  // COPYFILE_EXCL: never overwrite an earlier backup.
  copyFileSync(path, backup, constants.COPYFILE_EXCL)
  const tmp = `${path}.ccc-tmp`
  writeFileSync(tmp, next, { mode: before.mode & 0o777, flag: 'wx' })
  const now2 = statSync(path)
  if (now2.mtimeMs !== before.mtimeMs || now2.size !== before.size) {
    // Claude Code or Alex wrote it meanwhile: change nothing.
    try {
      renameSync(tmp, `${tmp}-discarded`)
    } catch {
      // Left for inspection.
    }
    throw new Error('settings.json changed while removing the rules. Nothing was changed; try again.')
  }
  renameSync(tmp, path)
  return { removed, backup }
}
