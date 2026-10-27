// Module boundaries, checked mechanically (D-004, D-006):
// - the renderer imports only @ccc/contract and its own files;
// - only the coupling package starts processes, so only it runs `claude`;
// - the contract package imports nothing.

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = join(import.meta.dirname, '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(join(ROOT, dir), { recursive: true, encoding: 'utf8' })
    .filter(f => /\.(ts|tsx|mjs|js)$/.test(f))
    .map(f => join(dir, f))
}

function importsOf(file: string): string[] {
  const text = readFileSync(join(ROOT, file), 'utf8')
  return [...text.matchAll(/^\s*(?:import|export)[^'"]*from\s+['"]([^'"]+)['"]/gm)].map(m => m[1]!)
}

describe('module boundaries', () => {
  it('the renderer imports only the contract, React, xterm.js and its own files', () => {
    // xterm.js draws the attached session (Focus); it reads nothing but what main sends it.
    const allowed = new Set(['@ccc/contract', 'react', 'react-dom/client', '@xterm/xterm', '@xterm/addon-fit'])
    for (const file of sourceFiles('src/renderer')) {
      for (const spec of importsOf(file)) {
        const target = spec.startsWith('.') ? resolve(ROOT, dirname(file), spec) : ''
        // Its own files, and src/shared, which holds the window.ccc types.
        const own = target.startsWith(join(ROOT, 'src', 'renderer') + sep) || target.startsWith(join(ROOT, 'src', 'shared') + sep)
        expect(allowed.has(spec) || own, `${file} imports ${spec}`).toBe(true)
      }
    }
  })

  it('the contract package imports nothing outside itself', () => {
    for (const file of sourceFiles('packages/contract/src')) {
      for (const spec of importsOf(file)) {
        expect(spec.startsWith('./'), `${file} imports ${spec}`).toBe(true)
      }
    }
  })

  it('only the coupling package starts processes', () => {
    const files = [...sourceFiles('src'), ...sourceFiles('packages')].filter(
      f => !f.startsWith(join('packages', 'coupling')),
    )
    for (const file of files) {
      for (const spec of importsOf(file)) {
        expect(['node:child_process', 'child_process', 'node-pty'], `${relative(ROOT, file)} imports ${spec}`).not.toContain(spec)
      }
    }
  })

  // Plugin options reach a command hook's environment, so the plugin that
  // carries the channel secret ships function hooks only (D-017, MIP2-1376 §6).
  it('the reporter mod ships no command hooks', () => {
    const hooks = JSON.parse(readFileSync(join(ROOT, 'mod/hooks/hooks.json'), 'utf8'))
    expect(Object.keys(hooks)).toEqual(['modules'])
    const manifest = JSON.parse(readFileSync(join(ROOT, 'mod/.claude-plugin/plugin.json'), 'utf8'))
    for (const key of ['hooks', 'mcpServers', 'lspServers', 'commands', 'agents']) expect(manifest).not.toHaveProperty(key)
  })
})
