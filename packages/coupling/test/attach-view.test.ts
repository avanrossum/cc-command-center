// Focus's attach pool (MIP2-1396): at most four attached views, and leaving
// always ends the attach process, which frees the supervisor's spare
// (Research MIP2-1403).

import { describe, expect, it, vi } from 'vitest'
import { AttachPool, bracketedPaste, KEPT_ATTACHED, quotePath, type AttachProcess } from '../src/attach-view.ts'

const id = (n: number) => `0000000${n}-0000-4000-8000-000000000000`

function fakeProcess() {
  const written: string[] = []
  const signals: (string | undefined)[] = []
  let exit: ((e: { exitCode: number }) => void) | null = null
  const p: AttachProcess = {
    write: d => void written.push(d),
    resize: () => {},
    kill: s => {
      signals.push(s)
      exit?.({ exitCode: 0 })
    },
    onData: () => {},
    onExit: cb => void (exit = cb),
  }
  return { p, written, signals, end: (code = 0) => exit?.({ exitCode: code }) }
}

function makePool() {
  const procs = new Map<string, ReturnType<typeof fakeProcess>>()
  const exits: [string, number][] = []
  let t = 0
  const pool = new AttachPool(
    { attach: async sid => ({ file: '/bin/claude', args: ['attach', sid.slice(0, 8)], cwd: '/' }) },
    { data: () => {}, exit: (sid, code) => void exits.push([sid, code]) },
    cmd => {
      const f = fakeProcess()
      procs.set(cmd.args[1]!, f)
      return f.p
    },
    () => ++t,
  )
  return { pool, procs, exits }
}

describe('AttachPool', () => {
  it('keeps four views attached and ends the least recently used fifth', async () => {
    vi.useFakeTimers()
    const { pool, procs } = makePool()
    for (let n = 1; n <= KEPT_ATTACHED; n++) await pool.open(id(n), 80, 24)
    await pool.open(id(1), 80, 24)
    await pool.open(id(5), 80, 24)
    // The second view was used least recently, so it is the one ended.
    expect(procs.get('00000002')!.written).toEqual(['\x1a'])
    vi.advanceTimersByTime(1000)
    expect(procs.get('00000002')!.signals).toEqual(['SIGTERM'])
    expect(pool.attached().sort()).toEqual([id(1), id(3), id(4), id(5)])
    vi.useRealTimers()
  })

  it('leaving sends Ctrl+Z, and SIGTERM only if the process is still there', async () => {
    vi.useFakeTimers()
    const { pool, procs, exits } = makePool()
    await pool.open(id(1), 80, 24)
    pool.leave(id(1))
    procs.get('00000001')!.end(0)
    vi.advanceTimersByTime(1000)
    expect(procs.get('00000001')!.signals).toEqual([])
    expect(exits).toEqual([[id(1), 0]])
    // Closing a pane leaves no attach process behind, so no claimed spare.
    expect(pool.attached()).toEqual([])
    vi.useRealTimers()
  })

  it('ignores input for a view that is leaving or gone', async () => {
    const { pool, procs } = makePool()
    await pool.open(id(1), 80, 24)
    pool.leave(id(1))
    pool.write(id(1), 'x')
    pool.write(id(2), 'y')
    expect(procs.get('00000001')!.written).toEqual(['\x1a'])
  })

  it('refuses anything that is not a session id', async () => {
    await expect(makePool().pool.open('../x', 80, 24)).rejects.toThrow('not a session id')
  })
})

describe('paste helpers', () => {
  it('wraps text as one bracketed paste and drops an embedded end marker', () => {
    expect(bracketedPaste('a\x1b[201~b')).toBe('\x1b[200~ab\x1b[201~')
  })

  it.each([
    ['/Users/a/file.ts', '/Users/a/file.ts'],
    ['/Users/a/My File.txt', `'/Users/a/My File.txt'`],
    [`/Users/a/it's.md`, `'/Users/a/it'\\''s.md'`],
    ['/tmp/$(rm -rf ~)', `'/tmp/$(rm -rf ~)'`],
  ])('quotes %s', (p, q) => expect(quotePath(p)).toBe(q))
})
