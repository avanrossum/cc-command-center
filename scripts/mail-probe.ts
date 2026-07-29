// Assertions for the pure mailbox helpers. These two decisions fail SILENTLY when
// they are wrong — a broken spool-name round-trip stops a restart from re-claiming
// undelivered mail, and a target lookup that picks the dead row stalls a message
// forever with no log line — so they get real coverage. Run: npx tsx scripts/mail-probe.ts
import {
  spoolName,
  tokenFromSpoolName,
  resolveTargetSession,
  nextDraft,
  matchDirectedPeer,
  type Peer,
  isUserAddress,
  stripUserAddress,
  parseQuery,
  mayMessage,
  aliasCandidate,
  parseAck,
} from '../src/main/engine/mailbox'
import type { LiveSession } from '../src/main/engine/types'
import { buildResumeArgs, EMPTY_RESUME_FLAGS } from '../src/main/engine/resumeFlags'
import { nextModes, modePrelude, NO_MODES } from '../src/main/engine/vt'
import { readFileSync, existsSync } from 'node:fs'


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

// --- addressing over permitted peers ---
// The case that bit in the wild: a parent addressed @"a child that had ended". The
// edge went with the node, so the quoted name matched nothing, the message fell
// through to "send it to the parent instead", and the sender had no parent — so it
// was reported as "no parent link", a complaint about a relationship nobody mentioned.
const NAMES: Record<string, string> = { C1: 'reviewer', C2: 'db work', P: 'parent' }
const ALIAS: Record<string, string> = { C1: 'reviewer-c1', C2: 'db-work-c2' }
// Most stable first: alias, then the drifting display name.
const peer = (sessionId: string, allowed = true, live = true): Peer => ({
  sessionId,
  handles: [ALIAS[sessionId], NAMES[sessionId]].filter(Boolean),
  allowed,
  live,
})
const PEERS = () => [peer('C1'), peer('C2')]
const addr = (rest: string, peers: Peer[] = PEERS()) => matchDirectedPeer(peers, rest)

check('quoted name routes to that peer', addr('"reviewer" hello')?.kind, 'match')
check('quoted match carries the body only', (addr('"reviewer" hello') as { body: string }).body, 'hello')
check('quoted match is case-insensitive', addr('"REVIEWER" hi')?.kind, 'match')
check('a name with a space still routes', addr('"db work" hi')?.kind, 'match')
// The regression guard: this MUST NOT fall through to the parent.
check('a name you cannot reach FAILS', addr('"ghost" hello')?.kind, 'unknown')
check('the failure names what was wanted', (addr('"ghost" hi') as { wanted: string }).wanted, 'ghost')
check('the failure lists who IS reachable, by alias', (addr('"ghost" hi') as { candidates: string[] }).candidates, ['reviewer-c1', 'db-work-c2'])
check('with no peers at all it still fails', addr('"ghost" hi', [])?.kind, 'unknown')
// Default deny: an un-permitted peer is MATCHED (so its mail holds and flushes when
// you grant it) but never counted as reachable in the failure hint.
check('an un-permitted peer still matches, to hold', addr('"reviewer" hi', [peer('C1', false)])?.kind, 'match')
check('...and carries allowed=false', (addr('"reviewer" hi', [peer('C1', false)]) as { peer: Peer }).peer.allowed, false)
check('an un-permitted peer is not advertised as reachable', (addr('"ghost" hi', [peer('C1', false)]) as { candidates: string[] }).candidates, [])
// The point of the alias: it keeps resolving after Claude's auto-title drifts.
check('the immutable alias resolves', addr('"reviewer-c1" hi')?.kind, 'match')
check('the display name still resolves', addr('"reviewer" hi')?.kind, 'match')
NAMES.C1 = 'something else entirely'
check('alias survives a title change', addr('"reviewer-c1" hi')?.kind, 'match')
check('the OLD display name stops resolving', addr('"reviewer" hi')?.kind, 'unknown')
NAMES.C1 = 'reviewer'
// A BARE @word may just be a message that starts with '@' — a miss there still goes
// to the parent, which is what lets "@scoped/pkg …" reach a human instead of failing.
check('bare name routes when it matches', addr('reviewer hello')?.kind, 'match')
check('bare miss stays undefined (falls through to the parent)', addr('scoped/pkg is broken'), undefined)
check('bare prefix cannot match mid-word', addr('reviewerish thing'), undefined)

// The restart case, found in the wild: a message addressed to a session that had been
// removed, evaluated while the OTHER sessions had not resumed yet. The peer list used
// to come from live sessions, so the sender was told it had no sessions to message at
// all — a statement about the fleet being cold, dressed up as a statement about the
// sender's links.
const COLD = [peer('C1', true, false), peer('C2', true, false)]
check('a cold fleet still lists the sender\'s peers', (addr('"ghost" hi', COLD) as { candidates: string[] }).candidates, [
  'reviewer-c1 (not running)',
  'db-work-c2 (not running)',
])
check('a known peer that is not running still MATCHES', addr('"reviewer-c1" hi', COLD)?.kind, 'match')
check('...and is flagged not-live, so its mail holds instead of failing', (addr('"reviewer-c1" hi', COLD) as { peer: Peer }).peer.live, false)
// Only a sender with genuinely no links should hear that it has none.
check('no links at all is still reported honestly', (addr('"ghost" hi', []) as { candidates: string[] }).candidates, [])
// Running peers are not annotated — the note is only there when it explains something.
check('a running peer is listed plainly', (addr('"ghost" hi', [peer('C1')]) as { candidates: string[] }).candidates, ['reviewer-c1'])

// --- reserved addresses and the directory lane ---
check('@"user" is reserved', isUserAddress('"user" the build is green'), true)
check('bare @user works too', isUserAddress('user hey'), true)
check('case does not matter', isUserAddress('"USER" hey'), true)
// Must not swallow a peer whose name merely STARTS with "user".
check('a peer named user-docs is not @user', isUserAddress('"user-docs" hi'), false)
check('a peer named userland is not @user', isUserAddress('userland hi'), false)
check('the note survives address stripping', stripUserAddress('"user" the build is green'), 'the build is green')
check('bare form strips too', stripUserAddress('user: all done'), 'all done')

check('?WHO is a query', parseQuery('?WHO')?.verb, 'WHO')
check('?whois carries its argument', parseQuery('?whois reviewer-c1'), { verb: 'WHOIS', arg: 'reviewer-c1' })
check('?INBOX takes no argument', parseQuery('?INBOX'), { verb: 'INBOX', arg: '' })
// A message that DISCUSSES the lane is not a query — same anchoring as ACK.
check('a query mentioned in prose is not a query', parseQuery('you can write ?WHO to list peers'), undefined)
check('an unknown verb is not a query', parseQuery('?WHATEVER'), undefined)

// --- read receipts / control-sequence hygiene ---
// The receipt lane is matched on the whole file, like the exit sentinel, so a peer
// cannot forge a receipt (or a kill) by writing one into a message body.
const CONTROL_RE = /\bACK\s+m-\d+-\d+\b|\[\[CCC:EXIT\]\]/gi

check('a bare ACK is a receipt', parseAck('ACK m-1785-7')?.id, 'm-1785-7')
check('case does not matter', parseAck('ack m-1785-7')?.id, 'm-1785-7')
check('leading whitespace is fine', parseAck('\n  ACK m-1785-7')?.id, 'm-1785-7')
// What sessions ACTUALLY did in the wild: acknowledged and replied in one write. The
// first version demanded the ACK be the whole file, so none of this matched and the
// parent got a message with "ACK m-…" stapled to the front.
const combined = parseAck('ACK m-1785-7\n\nSession: Test 1 — status: idle')
check('an ACK followed by a reply is a receipt', combined?.id, 'm-1785-7')
check('...and the reply survives to be routed', combined?.rest, 'Session: Test 1 — status: idle')
check('an ACK alone leaves no reply', parseAck('ACK m-1785-7')?.rest, '')
check('CRLF line endings work', parseAck('ACK m-1785-7\r\nhello')?.rest, 'hello')
// Still not a receipt: the id must lead a line of its own.
check('an ACK inside prose is NOT a receipt', parseAck('please ACK m-1785-7 when done'), undefined)
check('a trailing sentence on the SAME line is NOT a receipt', parseAck('ACK m-1785-7 and also hello'), undefined)
check('a malformed id is not a receipt', parseAck('ACK nonsense'), undefined)
// A body is sanitised on the way IN to a session, so forwarding it cannot smuggle
// a control verb into the recipient's own outbox.
const scrub = (s: string) => s.replace(CONTROL_RE, '[redacted]')
check('an ACK in a body is redacted', scrub('reply with ACK m-1-2 ok?'), 'reply with [redacted] ok?')
check('an exit sentinel in a body is redacted', scrub('write [[CCC:EXIT]] now'), 'write [redacted] now')
check('ordinary text is untouched', scrub('acknowledge the m-form please'), 'acknowledge the m-form please')

// --- permanent addresses ---
check('derived from the name', aliasCandidate('reviewer', 'abc12345'), 'reviewer-abc')
check('spaces become hyphens', aliasCandidate('DB Work', 'xyz99999'), 'db-work-xyz')
// The suffix is what keeps two sessions with the same name apart.
check('same name, different session', aliasCandidate('reviewer', 'zzz00000'), 'reviewer-zzz')
check('an unnamed session still gets one', aliasCandidate(null, 'abc12345'), 'session-abc')
check('an all-punctuation name still gets one', aliasCandidate('!!!', 'abc12345'), 'session-abc')
// Truncation must not leave a dangling separator — that reads as "name--suffix".
check('no double hyphen when the cut lands on one', aliasCandidate('a-website-called-mipyip-d6', '7b5aaaaa'), 'a-website-called-mipyip-7b5')
check('a long name is cut cleanly', aliasCandidate('x'.repeat(40), 'abc12345'), 'x'.repeat(24) + '-abc')
check('a session id with dashes still yields a suffix', aliasCandidate('r', '2e-df-53', ), 'r-2ed')

// --- who may message whom ---
// Default deny is the whole safety property here, so every arm gets an assertion.
// mayMessage is pure over (grants, edges) — no DB — so it can be exercised directly.
type G = import('../src/main/engine/mailbox').GrantRow
const grant = (a: string, b: string, mode: G['mode']): [string, G] => [
  `${a}|${b}`,
  { a_id: a, b_id: b, mode, granted_at: 1, granted_by: 'user', revoked_at: null },
]
const E = (parent_id: string, child_id: string, trusted: number) => ({ parent_id, child_id, trusted })
const may = (g: [string, G][], edges: ReturnType<typeof E>[], from: string, to: string) =>
  mayMessage(new Map(g), edges, from, to)

check('default DENY with nothing granted', may([], [], 'A', 'B'), false)
check('a session cannot message itself', may([grant('A', 'A', 'both')], [], 'A', 'A'), false)
check('a trusted edge permits parent → child', may([], [E('A', 'B', 1)], 'A', 'B'), true)
check('a trusted edge permits child → parent', may([], [E('A', 'B', 1)], 'B', 'A'), true)
check('an UNtrusted edge permits nothing', may([], [E('A', 'B', 0)], 'A', 'B'), false)
check('an unrelated edge permits nothing', may([], [E('A', 'C', 1)], 'A', 'B'), false)
// A grant reaches across the tree — that is the mesh.
check('a granted pair with no edge may message', may([grant('A', 'B', 'both')], [], 'A', 'B'), true)
check('...in both directions', may([grant('A', 'B', 'both')], [], 'B', 'A'), true)
// Direction is stored against the SORTED pair, so it must survive being asked either way.
check('a_to_b permits A → B', may([grant('A', 'B', 'a_to_b')], [], 'A', 'B'), true)
check('a_to_b DENIES B → A', may([grant('A', 'B', 'a_to_b')], [], 'B', 'A'), false)
check('b_to_a permits B → A', may([grant('A', 'B', 'b_to_a')], [], 'B', 'A'), true)
check('b_to_a DENIES A → B', may([grant('A', 'B', 'b_to_a')], [], 'A', 'B'), false)
// Revoke is stored, not deleted, so it OVERRIDES the trusted edge underneath. Deleting
// the row instead would fall back through to the edge and the revoke would do nothing.
check('an explicit revoke beats a trusted edge', may([grant('A', 'B', 'none')], [E('A', 'B', 1)], 'A', 'B'), false)
check('...in both directions', may([grant('A', 'B', 'none')], [E('A', 'B', 1)], 'B', 'A'), false)
check('a grant beats an untrusted edge', may([grant('A', 'B', 'both')], [E('A', 'B', 0)], 'A', 'B'), true)

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

// --- sticky terminal modes ---
// Claude Code pushes the kitty keyboard protocol once, at the very start of its
// output, and never again. The renderer rebuilds its xterm on every session switch and
// re-attach replays only a capped buffer — so once a session outgrew that buffer the
// push was gone and Shift+Enter silently submitted instead of inserting a newline.
const fold = (chunks: string[]) => chunks.reduce(nextModes, NO_MODES)

check('the kitty push is captured', fold(['\x1b[>1u']).kitty, '\x1b[>1u')
check('a pop turns it back off', fold(['\x1b[>1u', '\x1b[<1u']).kitty, '')
check('state is the CURRENT setting, not a history', fold(['\x1b[>1u', '\x1b[<1u', '\x1b[>5u']).kitty, '\x1b[>5u')
check('bracketed paste is tracked too', fold(['\x1b[?2004h']).bracketedPaste, '\x1b[?2004h')
check('...and its disable', fold(['\x1b[?2004h', '\x1b[?2004l']).bracketedPaste, '')
check('ordinary output changes nothing', fold(['hello \x1b[31mworld\x1b[0m']), NO_MODES)
// It must never invent a mode: a session that never asked for kitty must not get it.
check('nothing set means nothing replayed', modePrelude(NO_MODES), '')
check('only what the session set is replayed', modePrelude(fold(['\x1b[?2004h'])), '\x1b[?2004h')
check('both replay together', modePrelude(fold(['\x1b[>1u', '\x1b[?2004h'])), '\x1b[>1u\x1b[?2004h')
// Split across chunk boundaries is the realistic case — PTY data arrives arbitrarily.
check('a mode later in the stream still lands', fold(['boot...', '\x1b[>1u', 'more output']).kitty, '\x1b[>1u')
// The regression itself: the push scrolls out of a capped buffer, but the tracked
// state does not, so the prelude still re-establishes it.
const CAP = 64
const stream = ['\x1b[>1u', 'x'.repeat(500)]
const modes = fold(stream)
const replayed = stream.join('').slice(-CAP)
check('the push HAS scrolled out of the replay', replayed.includes('\x1b[>1u'), false)
check('...but the prelude still restores it', modePrelude(modes), '\x1b[>1u')

// Against the REAL bytes captured from Claude Code 2.1.220 at startup, if present.
const CAPTURE = 'test/fixtures/startup-modes-2.1.220.bin'
if (existsSync(CAPTURE)) {
  const real = readFileSync(CAPTURE, 'latin1')
  check('real startup capture: kitty push found', fold([real]).kitty, '\x1b[>1u')
  check('real capture: prelude is non-empty', modePrelude(fold([real])).length > 0, true)
} else {
  console.log(`ok    (skipped: no ${CAPTURE})`)
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed')
process.exit(failed ? 1 : 0)
