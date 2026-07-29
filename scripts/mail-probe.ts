// Assertions for the pure mailbox helpers. These two decisions fail SILENTLY when
// they are wrong — a broken spool-name round-trip stops a restart from re-claiming
// undelivered mail, and a target lookup that picks the dead row stalls a message
// forever with no log line — so they get real coverage. Run: npx tsx scripts/mail-probe.ts
import { spoolName, tokenFromSpoolName, resolveTargetSession } from '../src/main/engine/mailbox'
import type { LiveSession } from '../src/main/engine/types'

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

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
