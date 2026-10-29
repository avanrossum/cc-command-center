// The reporter mod measures the PATH its session's tools run with (MIP2-1539, Research MIP2-1534).

import { describe, expect, it } from 'vitest'
import { measurePath } from '../mod/hooks/path.ts'

const engine = (path: string | Error, home = '/Users/x') =>
  ({
    env: { get: async (k: string) => (k === 'HOME' ? home : undefined) },
    process: {
      run: async (argv: readonly string[]) => {
        expect(argv).toEqual(['/bin/sh', '-c', 'printf %s "$PATH"'])
        if (path instanceof Error) throw path
        return { exitCode: 0, stdout: path, stderr: '' }
      },
    },
  }) as never

describe('measurePath', () => {
  it('reports presence flags and a count, never the PATH', async () => {
    const full = await measurePath(engine('/opt/homebrew/bin:/Users/x/.local/bin:/usr/bin:/bin'))
    expect(full).toEqual({ localBin: true, homebrew: true, entries: 4 })
    expect(JSON.stringify(full)).not.toContain('/usr/bin')
    expect(await measurePath(engine('/usr/bin:/bin:/usr/sbin:/sbin'))).toEqual({ localBin: false, homebrew: false, entries: 4 })
  })

  it('says nothing when the child fails, so the session reads as may be missing', async () => {
    expect(await measurePath(engine(new Error('cannot start')))).toBeUndefined()
  })
})
