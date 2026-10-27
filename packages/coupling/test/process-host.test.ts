// Which terminal an interactive session runs in (MIP2-1466).

import { describe, expect, it } from 'vitest'
import { terminalHostOf, terminalName, type PsRow } from '../src/process-host.ts'

const tree = (rows: Record<number, PsRow>) => async (pid: number) => rows[pid] ?? null

describe('terminalHostOf', () => {
  it("walks a session's parents to the terminal app", async () => {
    // claude ← -zsh ← login ← iTerm2, as on Alex's machine.
    const ps = tree({
      60893: { ppid: 60800, comm: 'claude' },
      60800: { ppid: 60799, comm: '-zsh' },
      60799: { ppid: 600, comm: 'login' },
      600: { ppid: 1, comm: '/Applications/iTerm.app/Contents/MacOS/iTerm2' },
    })
    expect(await terminalHostOf(60893, ps)).toBe('iTerm2')
  })

  it('names tmux only when no terminal app is above it, and returns null when nothing is found', async () => {
    expect(await terminalHostOf(10, tree({ 10: { ppid: 9, comm: 'claude' }, 9: { ppid: 8, comm: 'zsh' }, 8: { ppid: 1, comm: 'tmux: server' } }))).toBe('tmux')
    expect(await terminalHostOf(10, tree({ 10: { ppid: 9, comm: 'claude' }, 9: { ppid: 1, comm: 'launchd' } }))).toBeNull()
  })

  it('knows the common terminals by process name', () => {
    expect(terminalName('/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal')).toBe('Terminal')
    expect(terminalName('/Applications/Ghostty.app/Contents/MacOS/ghostty')).toBe('Ghostty')
    expect(terminalName('/Applications/WezTerm.app/Contents/MacOS/wezterm-gui')).toBe('WezTerm')
    expect(terminalName('/Applications/Visual Studio Code.app/Contents/Frameworks/Code Helper.app/Contents/MacOS/Code Helper')).toBe('VS Code')
    expect(terminalName('zsh')).toBeNull()
  })
})
