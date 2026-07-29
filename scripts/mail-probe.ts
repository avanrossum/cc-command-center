// Assertions for the pure mailbox helpers. These two decisions fail SILENTLY when
// they are wrong — a broken spool-name round-trip stops a restart from re-claiming
// undelivered mail, and a target lookup that picks the dead row stalls a message
// forever with no log line — so they get real coverage. Run: npx tsx scripts/mail-probe.ts
import {
  spoolName,
  tokenFromSpoolName,
  resolveTargetSession,
  nextDraft,
  matchDirectedChild,
} from '../src/main/engine/mailbox'
import type { LiveSession } from '../src/main/engine/types'
import { buildResumeArgs, EMPTY_RESUME_FLAGS } from '../src/main/engine/resumeFlags'

let failed = 0
function check(name: string, got: unknown, want: unknown): void {
  const ok = JSON.stringify(got) === JSON.stringify(want)
  if (!ok) failed++
  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${name}${ok ? '' : `\n        got ${JSON.stringify(got)}\n       want ${JSON.stringify(want)}`}`)
}

// --- spool naming round-trip ---
const TOKENS = [
  'cc-1785292933431-0', // the real mint shape
  'cc-1785292933431-12',
  'cc-0-0',
]
for (const t of TOKENS) {
  check(`round-trip ${t}`, tokenFromSpoolName(spoolName(t, 1785292933431, 7)), t)
}
check('two claims in the same ms differ', spoolName('cc-1-0', 100, 0) === spoolName('cc-1-0', 100, 1), false)
check('non-spool file is not ours', tokenFromSpoolName('cc-1785292933431-0.msg'), undefined)
check('unrelated file is not ours', tokenFromSpoolName('notes.txt'), undefined)
check('no path traversal in a name', spoolName('cc-1-0', 2, 3).includes('/'), false)

// --- alive-preferring target lookup ---
const mk = (sessionId: string, pid: number, alive: boolean, state: LiveSession['state']) =>
  ({
    sessionId,
    pid,
    alive,
    state,
    cwd: '/tmp',
    isSpare: false,
    stateReason: 'test',
  }) as LiveSession

const resumed = [
  mk('S1', 100, false, 'unknown'), // the stale row, listed FIRST — the trap
  mk('S1', 200, true, 'idle'),
  mk('S2', 300, true, 'working'),
]
check('prefers the alive row over a dead duplicate', resolveTargetSession(resumed, 'S1')?.pid, 200)
check('alive row found when listed first', resolveTargetSession([resumed[1], resumed[0]], 'S1')?.pid, 200)
check('falls back to the dead row when that is all there is', resolveTargetSession([resumed[0]], 'S1')?.pid, 100)
check('unknown id resolves to nothing', resolveTargetSession(resumed, 'S9'), undefined)
check('empty fleet resolves to nothing', resolveTargetSession([], 'S1'), undefined)
check('does not cross-match another session', resolveTargetSession(resumed, 'S2')?.pid, 300)

// --- unsent-draft accounting ---
// A run of keystrokes, applied in order, ending in the draft length.
const type = (keys: string[], from = 0) => keys.reduce((n, k) => nextDraft(n, k), from)

check('typing counts characters', type(['h', 'e', 'l', 'l', 'o']), 5)
check('a burst arrives as one payload', type(['hello']), 5)
check('backspace decrements', type(['a', 'b', 'c', '\x7f']), 2)
check('backspace floors at zero', type(['a', '\x7f', '\x7f', '\x7f']), 0)
check('bare Enter submits', type(['h', 'i', '\r']), 0)
check('bare LF submits', type(['h', 'i', '\n']), 0)
check('CRLF submits', type(['h', 'i', '\r\n']), 0)
check('Ctrl-C clears', type(['d', 'r', 'a', 'f', 't', '\x03']), 0)
check('Ctrl-U clears', type(['d', 'r', 'a', 'f', 't', '\x15']), 0)
check('Esc clears', type(['d', 'r', 'a', 'f', 't', '\x1b']), 0)
// The dangerous direction is a draft that reads as EMPTY while text is on screen —
// that is what lets a delivery paste into it and send the half-written prompt.
check('kitty Shift+Enter does NOT clear', type(['h', 'i', '\x1b[13;2u']), 2)
check('ESC+CR Shift+Enter does NOT clear', type(['h', 'i', '\x1b\r']), 2)
check('arrow keys do not clear', type(['h', 'i', '\x1b[A', '\x1b[D']), 2)
check('Ctrl-W (word delete) does not clear', type(['h', 'i', '\x17']), 2)
check('a bracketed paste counts its content', type(['\x1b[200~abcd\x1b[201~']), 4)
check('paste adds to what is already typed', type(['h', 'i', '\x1b[200~abcd\x1b[201~']), 6)
check('a newline inside a paste does not submit', type(['\x1b[200~a\rb\x1b[201~']), 3)
check('two pastes in one payload both count', type(['\x1b[200~ab\x1b[201~\x1b[200~cde\x1b[201~']), 5)
check('empty input changes nothing', type(['', ''], 3), 3)
check('unicode counts by code point', type(['héllo']), 5)
check('emoji counts as one', type(['👍']), 1)
// Tab is autocomplete / mode cycling in Claude Code, not a character — but it must
// not CLEAR either, or a draft would read empty with text still on screen.
check('tab is not text and does not clear', type(['a', '\t']), 1)
// The realistic sequence: type, submit, type again — the box is only "dirty" when it is.
check('type → submit → type', type(['a', 's', 'k', '\r', 'n', 'e', 'x', 't']), 4)

// --- addressing ---
// The case that bit in the wild: a parent addressed @"a child that had ended". The
// edge went with the node, so the quoted name matched nothing, the message fell
// through to "send it to the parent instead", and the sender had no parent — so it
// was reported as "no parent link", a complaint about a relationship nobody mentioned.
const NAMES: Record<string, string> = { C1: 'reviewer', C2: 'db work', P: 'parent' }
const nameOf = (x: LiveSession) => NAMES[x.sessionId] ?? ''
const fleet = [mk('P', 1, true, 'idle'), mk('C1', 2, true, 'idle'), mk('C2', 3, true, 'idle')]
const kids = [
  { parent_id: 'P', child_id: 'C1', trusted: 1 },
  { parent_id: 'P', child_id: 'C2', trusted: 0 },
]
const addr = (rest: string, edges = kids, sessions = fleet) =>
  matchDirectedChild(sessions, edges, 'P', rest, nameOf)

check('quoted name routes to that child', addr('"reviewer" hello')?.kind, 'match')
check('quoted match carries the body only', (addr('"reviewer" hello') as { body: string }).body, 'hello')
check('quoted match is case-insensitive', addr('"REVIEWER" hi')?.kind, 'match')
check('a name with a space still routes', addr('"db work" hi')?.kind, 'match')
check('trust travels with the edge', (addr('"db work" hi') as { trusted: boolean }).trusted, false)
// The regression guard: this MUST NOT fall through to the parent.
check('a quoted name that no longer exists FAILS', addr('"ghost" hello')?.kind, 'unknown')
check('the failure names what was wanted', (addr('"ghost" hi') as { wanted: string }).wanted, 'ghost')
check('the failure lists who IS reachable', (addr('"ghost" hi') as { candidates: string[] }).candidates, ['reviewer', 'db work'])
check('with no children at all it still fails', addr('"ghost" hi', [])?.kind, 'unknown')
check('an ended child is gone from the candidates', (addr('"ghost" hi', kids, [fleet[0], fleet[1]]) as { candidates: string[] }).candidates, ['reviewer'])
// A BARE @word may just be a message that starts with '@' — a miss there still goes
// to the parent, which is what lets "@scoped/pkg …" reach a human instead of failing.
check('bare name routes when it matches', addr('reviewer hello')?.kind, 'match')
check('bare miss stays undefined (falls through to the parent)', addr('scoped/pkg is broken'), undefined)
check('bare prefix cannot match mid-word', addr('reviewerish thing'), undefined)

// --- child launch argv ---
// Spawning a child used to hard-code ['--permission-mode','auto']; it now goes
// through buildResumeArgs so a picked model/effort rides along. The default path
// must still produce exactly what it did before, or parent↔child messaging stalls
// on the mailbox-write gate that auto mode exists to clear.
check('default child is auto and nothing else', buildResumeArgs({ ...EMPTY_RESUME_FLAGS, mode: 'auto' }), [
  '--permission-mode',
  'auto',
])
check('no mode, no flags', buildResumeArgs(EMPTY_RESUME_FLAGS), [])
check('a picked model and effort ride along', buildResumeArgs({ model: 'claude-sonnet-5', context: '', effort: 'low', mode: 'auto' }), [
  '--model',
  'claude-sonnet-5',
  '--effort',
  'low',
  '--permission-mode',
  'auto',
])
check('1M is a model suffix, not a flag', buildResumeArgs({ model: 'claude-opus-4-8', context: '1m', effort: '', mode: '' }), [
  '--model',
  'claude-opus-4-8[1m]',
])
check('1M with no model emits nothing', buildResumeArgs({ model: '', context: '1m', effort: '', mode: '' }), [])

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
