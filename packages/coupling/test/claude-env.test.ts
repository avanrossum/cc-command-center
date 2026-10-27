// The environment every `claude` the app runs gets (MIP2-1420): an
// allowlist, so nothing from the process that started the app reaches a
// supervisor or a session's Bash.

import { describe, expect, it } from 'vitest'
import { claudeEnv } from '../src/claude-cli.ts'

const FROM_AN_AGENT_SESSION = {
  HOME: '/Users/x',
  PATH: '/usr/bin:/bin',
  USER: 'x',
  LANG: 'en_US.UTF-8',
  LC_CTYPE: 'UTF-8',
  TERM: 'xterm-256color',
  TMPDIR: '/var/folders/t/',
  SSH_AUTH_SOCK: '/private/tmp/agent.sock',
  HTTPS_PROXY: 'http://proxy:3128',
  CLAUDE_CONFIG_DIR: '/Users/x/.claude-ccc-qa',
  // What MIP2-1419 saw a supervisor pass on:
  CLAUDE_CODE_CHILD_SESSION: '1',
  CLAUDE_CODE_SESSION_ID: 'c0ffee07-0000-4000-8000-000000000000',
  CLAUDE_PID: '33691',
  CLAUDECODE: '1',
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  CLAUDE_CODE_SESSION_ATTENDED: '1',
  CLAUDE_CODE_MESSAGING_SOCKET: '/tmp/cc-socks/33691.sock',
  CLAUDE_CODE_MESSAGING_TOKEN: 'secret-token',
  CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: '1',
  VITEST: 'true',
  VITEST_POOL_ID: '1',
  NODE_OPTIONS: '--require /x/hook.js',
  ANTHROPIC_API_KEY: 'sk-ant-should-not-pass',
  CCC_QA: '1',
  CCC_USER_DATA: '/tmp/ccc-qa/data',
  ELECTRON_RUN_AS_NODE: '1',
  npm_config_ignore_scripts: 'true',
}

describe('claudeEnv', () => {
  it('passes only allowlisted variables', () => {
    expect(claudeEnv(FROM_AN_AGENT_SESSION)).toEqual({
      HOME: '/Users/x',
      PATH: '/usr/bin:/bin',
      USER: 'x',
      LANG: 'en_US.UTF-8',
      LC_CTYPE: 'UTF-8',
      TERM: 'xterm-256color',
      TMPDIR: '/var/folders/t/',
      SSH_AUTH_SOCK: '/private/tmp/agent.sock',
      HTTPS_PROXY: 'http://proxy:3128',
      CLAUDE_CONFIG_DIR: '/Users/x/.claude-ccc-qa',
    })
  })

  it('passes no CLAUDE_CODE_*, messaging, test or app variable, the mod reload switch included (MIP2-1457)', () => {
    const out = claudeEnv(FROM_AN_AGENT_SESSION)
    expect(Object.keys(out).filter(k => /^(CLAUDE_CODE|CLAUDECODE|CLAUDE_PID|VITEST|NODE_OPTIONS|CCC_|ELECTRON|npm_|ANTHROPIC)/.test(k))).toEqual([])
    // The switch goes in each launch's --settings env, never on the supervisor.
    expect(claudeEnv({ CLAUDE_CODE_PLUGIN_DIR_WATCH: '1' })).toEqual({})
    expect(claudeEnv({})).toEqual({})
  })

  it("adds the reload switch only for a session's own command (MIP2-1463)", async () => {
    const { sessionEnv, SESSION_SWITCHES } = await import('../src/claude-cli.ts')
    expect(SESSION_SWITCHES).toEqual({ CLAUDE_CODE_PLUGIN_DIR_WATCH: '0' })
    expect(sessionEnv({ HOME: '/Users/x' })).toEqual({ HOME: '/Users/x', CLAUDE_CODE_PLUGIN_DIR_WATCH: '0' })
    expect(claudeEnv({ HOME: '/Users/x' })).toEqual({ HOME: '/Users/x' })
  })
})
