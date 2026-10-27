// First run step 1 (MIP2-1412): removing the old mailbox rules from a copy
// of Claude Code's settings. Only those entries go; a backup comes first.

import { chmodSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { claudeSettingsPath, findMailboxRules, removeMailboxRules, withoutMailboxRules } from '../src/main/mailbox.ts'

// Shaped like Alex's file on 2026-10-27, with values replaced.
const SETTINGS = {
  env: { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet', NAME: 'café — dash' },
  permissions: { allow: ['Bash(npm run check)', 'Edit(~/.claude/ccc/mail/**)', 'Read(~/x/**)', 'Edit(~/.claude/ccc/mail-dev/**)'], deny: ['Edit(~/.claude/ccc/mail/**)'], defaultMode: 'auto' },
  model: 'opus',
  hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '~/.claude/hooks/x.sh' }] }] },
  enabledPlugins: { 'a@b': true },
  effortLevel: 'medium',
  tui: { theme: 'dark' },
}

let dir: string
let file: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ccc-mailbox-'))
  file = join(dir, 'settings.json')
  writeFileSync(file, JSON.stringify(SETTINGS, null, 2) + '\n')
  chmodSync(file, 0o600)
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('mailbox rules', () => {
  it('finds the two rules and nothing else', () => {
    expect(findMailboxRules(file)).toEqual(['Edit(~/.claude/ccc/mail/**)', 'Edit(~/.claude/ccc/mail-dev/**)'])
    expect(findMailboxRules(join(dir, 'missing.json'))).toEqual([])
  })

  it('removes only those allow entries, keeps every other key and value, and backs up first', () => {
    const original = readFileSync(file, 'utf8')
    const r = removeMailboxRules(file, new Date('2026-10-27T06:00:00Z'))
    expect(r.removed).toHaveLength(2)
    expect(readFileSync(r.backup!, 'utf8')).toBe(original)
    const after = JSON.parse(readFileSync(file, 'utf8'))
    expect(after.permissions.allow).toEqual(['Bash(npm run check)', 'Read(~/x/**)'])
    // A deny rule naming the same folder is not a grant; it stays.
    expect(after).toEqual({ ...SETTINGS, permissions: { ...SETTINGS.permissions, allow: ['Bash(npm run check)', 'Read(~/x/**)'] } })
    expect(Object.keys(after)).toEqual(Object.keys(SETTINGS))
    expect(readFileSync(file, 'utf8').endsWith('}\n')).toBe(true)
    expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  it('does nothing, and makes no backup, when there is nothing to remove', () => {
    removeMailboxRules(file)
    const files = readdirSync(dir).length
    const again = removeMailboxRules(file)
    expect(again).toEqual({ removed: [], backup: null })
    expect(readdirSync(dir).length).toBe(files)
  })

  it('keeps a file with a 4-space indent and no final newline in that shape', () => {
    const t = JSON.stringify({ permissions: { allow: ['Edit(~/.claude/ccc/mail/**)'] } }, null, 4)
    expect(withoutMailboxRules(t).text).toBe(JSON.stringify({ permissions: { allow: [] } }, null, 4))
  })

  it('changes only the rule entries, byte for byte, whatever else the file holds (MIP2-1421)', () => {
    const before = [
      '{',
      '  "cleanupPeriodDays": 12345678901234567890,',
      '  "ratio": 1.0,',
      '  "title": "caf\\u00e9 \\/ dash",',
      '  "compact": {"a":1,"b":[1,2]},',
      '  "permissions": {',
      '    "allow": [',
      '      "Bash(npm test)",',
      '      "Edit(~/.claude/ccc/mail/**)",',
      '      "Edit(~/.claude/ccc/mail-dev/**)"',
      '    ],',
      '    "deny": ["Edit(~/.claude/ccc/mail/**)"]',
      '  }',
      '}',
      '',
    ].join('\n')
    const after = before.replace(',\n      "Edit(~/.claude/ccc/mail/**)",\n      "Edit(~/.claude/ccc/mail-dev/**)"', '')
    expect(withoutMailboxRules(before)).toEqual({ text: after, removed: ['Edit(~/.claude/ccc/mail/**)', 'Edit(~/.claude/ccc/mail-dev/**)'] })
  })

  it('cuts first, middle, last and only elements cleanly, inline or not', () => {
    const t = (allow: string) => `{"permissions":{"allow":${allow}}}`
    const M = '"Edit(~/.claude/ccc/mail/**)"'
    expect(withoutMailboxRules(t(`[${M}, "a", "b"]`)).text).toBe(t('["a", "b"]'))
    expect(withoutMailboxRules(t(`["a", ${M}, "b"]`)).text).toBe(t('["a", "b"]'))
    expect(withoutMailboxRules(t(`["a", "b", ${M}]`)).text).toBe(t('["a", "b"]'))
    expect(withoutMailboxRules(t(`[ ${M} ]`)).text).toBe(t('[]'))
    expect(withoutMailboxRules(t(`["a", ${M}, ${M.replace('mail', 'mail-dev')}]`)).text).toBe(t('["a"]'))
  })

  it("handles Alex's shape: both rules adjacent at the start of allow, in JSON.stringify layout (MIP2-1421)", () => {
    const shape = {
      env: { CLAUDE_CODE_SUBAGENT_MODEL: 'sonnet' },
      permissions: { allow: ['Edit(~/.claude/ccc/mail/**)', 'Edit(~/.claude/ccc/mail-dev/**)', 'Bash(git status:*)', 'Read(~/x/**)'] },
      model: 'opus',
    }
    const text = JSON.stringify(shape, null, 2) + '\n'
    const out = withoutMailboxRules(text)
    expect(out.text).toBe(JSON.stringify({ ...shape, permissions: { allow: ['Bash(git status:*)', 'Read(~/x/**)'] } }, null, 2) + '\n')
  })

  it('handles the rules as the only entries, adjacent in the middle, and as a trailing pair (QA minimal cases)', () => {
    const M = '"Edit(~/.claude/ccc/mail/**)"'
    const D = '"Edit(~/.claude/ccc/mail-dev/**)"'
    const t = (allow: string) => `{"permissions":{"allow":${allow}}}`
    expect(withoutMailboxRules(t(`[${M},${D}]`)).text).toBe(t('[]'))
    expect(withoutMailboxRules(t(`[\n  ${M},\n  ${D}\n]`)).text).toBe(t('[]'))
    expect(withoutMailboxRules(t(`["a", ${M}, ${D}, "b"]`)).text).toBe(t('["a", "b"]'))
    expect(withoutMailboxRules(t(`["a", "b", ${M}, ${D}]`)).text).toBe(t('["a", "b"]'))
    expect(withoutMailboxRules(t(`[${M}, "a", ${D}, "b", ${M}]`)).text).toBe(t('["a", "b"]'))
  })

  it('refuses a duplicate "permissions" or "allow", which JSON readers resolve differently', () => {
    expect(() => withoutMailboxRules('{"permissions":{"allow":[]},"permissions":{"allow":["Edit(~/.claude/ccc/mail/**)"]}}')).toThrow('twice')
    expect(() => withoutMailboxRules('{"permissions":{"allow":[],"allow":["Edit(~/.claude/ccc/mail/**)"]}}')).toThrow('twice')
  })

  it("edits a symlinked file at its target and keeps the link (MIP2-1421)", () => {
    const target = join(dir, 'dotfiles-settings.json')
    const link = join(dir, 'linked.json')
    writeFileSync(target, readFileSync(file, 'utf8'))
    symlinkSync(target, link)
    const r = removeMailboxRules(link, new Date('2026-10-27T06:00:00Z'))
    expect(r.removed).toHaveLength(2)
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(findMailboxRules(target)).toEqual([])
    expect(r.backup!.startsWith(link)).toBe(true)
  })

  it('points at the real file unless a QA run names a copy', () => {
    expect(claudeSettingsPath({}, false)).toBe(join(homedir(), '.claude', 'settings.json'))
    expect(claudeSettingsPath({ CCC_QA: '1', CCC_CLAUDE_SETTINGS: '/x/settings.json' }, false)).toBe('/x/settings.json')
    expect(() => claudeSettingsPath({ CCC_CLAUDE_SETTINGS: '/x/settings.json' }, false)).toThrow('CCC_QA=1')
    expect(() => claudeSettingsPath({ CCC_QA: '1', CCC_CLAUDE_SETTINGS: '/x' }, true)).toThrow('unpackaged')
  })
})
