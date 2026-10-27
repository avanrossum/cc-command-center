// The channel's shared rules and the mod's decision building (MIP2-1390).

import { createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  answersValid,
  buildDecision,
  cardQuestions,
  fromHex,
  MAC_HEX,
  rememberable,
  SECRET_HEX,
  toHex,
} from '../mod/hooks/channel-wire.ts'
import { hmacSha256 } from '../mod/hooks/hmac.ts'

const ROOT = '/Users/example/.ccc/ch'

describe('hmacSha256 (built from digest)', () => {
  it('matches Node createHmac for key lengths 0 to 200 and non-ASCII text', async () => {
    for (const len of [0, 1, 31, 32, 63, 64, 65, 100, 200]) {
      for (const message of ['', 'req\nPOST\n/v1/hello\n', 'café ✓ 日本 🎉'.repeat(50)]) {
        const key = randomBytes(len)
        const want = createHmac('sha256', key).update(message, 'utf8').digest('hex')
        expect(toHex(await hmacSha256(new Uint8Array(key), message))).toBe(want)
      }
    }
  })
})

describe('fromHex', () => {
  it.each([
    ['a'.repeat(64), true],
    ['A'.repeat(64), false],
    ['a'.repeat(63), false],
    ['a'.repeat(65), false],
    ['g'.repeat(64), false],
    [`${'a'.repeat(62)}zz`, false],
    ['', false],
  ])('%s → %s', (text, ok) => {
    expect(fromHex(text, SECRET_HEX) !== null).toBe(ok)
  })

  it('round-trips', () => {
    const hex = randomBytes(32).toString('hex')
    expect(toHex(fromHex(hex, MAC_HEX)!)).toBe(hex)
  })
})

const QUESTIONS = [
  { question: 'Which color?', header: 'Color', options: [{ label: 'Red' }, { label: 'Blue' }], multiSelect: false },
  { question: 'Which size?', header: 'Size', options: [{ label: 'S' }, { label: 'L' }], multiSelect: false },
]

describe('cardQuestions', () => {
  it('takes single-choice questions', () => {
    expect(cardQuestions({ questions: QUESTIONS })).toEqual(QUESTIONS)
  })
  it.each([
    [{ questions: [{ ...QUESTIONS[0], multiSelect: true }] }],
    [{ questions: [{ question: 'Free text?', options: [], multiSelect: false }] }],
    [{ questions: [] }],
    [{}],
    [null],
  ])('refuses %o (D-010: the session view answers it)', input => {
    expect(cardQuestions(input)).toBeNull()
  })
})

describe('answersValid', () => {
  it('takes one option label per question', () => {
    expect(answersValid(QUESTIONS, { 'Which color?': 'Blue', 'Which size?': 'S' })).toBe(true)
  })
  it.each([
    [{ 'Which color?': 'Blue' }],
    [{ 'Which color?': 'Green', 'Which size?': 'S' }],
    [{ __any__: 'Blue', 'Which size?': 'S' }],
    [{ 'Which color?': 'Blue', 'Which size?': 'S', extra: 'x' }],
    [{ 'Which color?': 1, 'Which size?': 'S' }],
    ['Blue'],
  ])('refuses %o', answers => {
    expect(answersValid(QUESTIONS, answers)).toBe(false)
  })
})

describe('rememberable', () => {
  it('keeps the session suggestions, at session scope', () => {
    expect(
      rememberable(
        [
          { type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }], behavior: 'allow', destination: 'localSettings' },
          { type: 'addDirectories', directories: ['/tmp/work'], destination: 'userSettings' },
        ],
        ROOT,
      ),
    ).toEqual([
      { type: 'addRules', rules: [{ toolName: 'WebFetch', ruleContent: 'domain:example.com' }], behavior: 'allow', destination: 'session' },
      { type: 'addDirectories', directories: ['/tmp/work'], destination: 'session' },
    ])
  })

  it('drops setMode, removals and deny rules', () => {
    expect(
      rememberable(
        [
          { type: 'setMode', mode: 'bypassPermissions', destination: 'userSettings' },
          { type: 'removeRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' },
          { type: 'addRules', rules: [{ toolName: 'Bash' }], behavior: 'deny', destination: 'session' },
          { type: 'replaceRules', rules: [{ toolName: 'Bash' }], behavior: 'allow', destination: 'session' },
        ],
        ROOT,
      ),
    ).toEqual([])
  })

  it('drops any grant that reaches the channel root: inside it, the root itself, or a folder above it', () => {
    expect(
      rememberable(
        [
          { type: 'addDirectories', directories: [`${ROOT}/ab12cd34`, ROOT, '/Users/example', '/', '/tmp/ok'] },
          { type: 'addRules', rules: [{ toolName: 'Read', ruleContent: `${ROOT}/**` }, { toolName: 'Read', ruleContent: '//tmp/ok/**' }], behavior: 'allow' },
        ],
        ROOT,
      ),
    ).toEqual([
      { type: 'addDirectories', directories: ['/tmp/ok'], destination: 'session' },
      { type: 'addRules', rules: [{ toolName: 'Read', ruleContent: '//tmp/ok/**' }], behavior: 'allow', destination: 'session' },
    ])
  })

  it('keeps no Bash or bare-tool rule, nothing home-relative or with .., and no rule above the channel root (gate L-4)', () => {
    expect(
      rememberable(
        [
          {
            type: 'addRules',
            rules: [
              { toolName: 'Bash' },
              { toolName: 'Bash', ruleContent: 'cat:*' },
              { toolName: 'Read' },
              { toolName: 'Read', ruleContent: '~/.ccc/**' },
              { toolName: 'Read', ruleContent: '/tmp/../Users/**' },
              { toolName: 'Read', ruleContent: '//Users/**' },
              { toolName: 'Edit', ruleContent: '/tmp/x' },
              // Relative to the session's folder (gate run 2, L-4): a single slash, or none.
              { toolName: 'Read', ruleContent: '/tmp/x/**' },
              { toolName: 'Read', ruleContent: '**' },
              { toolName: 'Glob', ruleContent: '.ccc/**' },
              { toolName: 'WebFetch', ruleContent: 'domain:x/..' },
            ],
            behavior: 'allow',
          },
          { type: 'addDirectories', directories: ['~/work', '/tmp/a/../b', 'relative'] },
        ],
        ROOT,
      ),
    ).toEqual([])
  })
})

describe('buildDecision', () => {
  const bash = { tool: 'Bash', input: { command: 'ls' }, suggestions: [{ type: 'addDirectories', directories: ['/tmp'] }] }

  it('denies with the app message', () => {
    expect(buildDecision(bash, { status: 'answer', verdict: 'deny' }, ROOT)).toEqual({
      behavior: 'deny',
      message: 'Denied from CC Command Center.',
    })
  })

  it('allows without remembering unless asked', () => {
    expect(buildDecision(bash, { status: 'answer', verdict: 'allow' }, ROOT)).toEqual({ behavior: 'allow' })
  })

  it('remembers only the session suggestions, re-scoped', () => {
    expect(buildDecision(bash, { status: 'answer', verdict: 'allow', remember: true }, ROOT)).toEqual({
      behavior: 'allow',
      updatedPermissions: [{ type: 'addDirectories', directories: ['/tmp'], destination: 'session' }],
    })
  })

  it('ignores fields the app adds (setMode, rules of its own, updatedInput)', () => {
    const hostile = {
      status: 'answer',
      verdict: 'allow',
      updatedPermissions: [{ type: 'setMode', mode: 'bypassPermissions', destination: 'userSettings' }],
      updatedInput: { command: 'rm -rf ~' },
      setMode: 'bypassPermissions',
    } as unknown as Parameters<typeof buildDecision>[1]
    expect(buildDecision(bash, hostile, ROOT)).toEqual({ behavior: 'allow' })
  })

  it('answers a question with the original questions and checked answers', () => {
    const ask = { tool: 'AskUserQuestion', input: { questions: QUESTIONS }, suggestions: [] }
    const answers = { 'Which color?': 'Blue', 'Which size?': 'L' }
    expect(buildDecision(ask, { status: 'answer', verdict: 'allow', answers }, ROOT)).toEqual({
      behavior: 'allow',
      updatedInput: { questions: QUESTIONS, answers },
    })
  })

  it('leaves the dialog for a mismatched answer, a multi-select question, or plan approval', () => {
    const ask = { tool: 'AskUserQuestion', input: { questions: QUESTIONS }, suggestions: [] }
    expect(buildDecision(ask, { status: 'answer', verdict: 'allow', answers: { __any__: 'Blue' } }, ROOT)).toBeNull()
    const multi = { tool: 'AskUserQuestion', input: { questions: [{ ...QUESTIONS[0], multiSelect: true }] }, suggestions: [] }
    expect(buildDecision(multi, { status: 'answer', verdict: 'allow', answers: { 'Which color?': 'Red' } }, ROOT)).toBeNull()
    expect(buildDecision({ tool: 'ExitPlanMode', input: {}, suggestions: [] }, { status: 'answer', verdict: 'allow' }, ROOT)).toBeNull()
  })
})
