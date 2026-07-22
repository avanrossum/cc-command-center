// Syntax highlighting for code artifacts. highlight.js core + a curated set of
// the languages an agent is likely to write — registered explicitly so the bundle
// only carries what we use. An extension we didn't map falls back to auto-detect.
import hljs from 'highlight.js/lib/core'
import 'highlight.js/styles/github-dark.css'

import bash from 'highlight.js/lib/languages/bash'
import c from 'highlight.js/lib/languages/c'
import cpp from 'highlight.js/lib/languages/cpp'
import csharp from 'highlight.js/lib/languages/csharp'
import css from 'highlight.js/lib/languages/css'
import go from 'highlight.js/lib/languages/go'
import ini from 'highlight.js/lib/languages/ini'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import kotlin from 'highlight.js/lib/languages/kotlin'
import lua from 'highlight.js/lib/languages/lua'
import markdown from 'highlight.js/lib/languages/markdown'
import perl from 'highlight.js/lib/languages/perl'
import php from 'highlight.js/lib/languages/php'
import python from 'highlight.js/lib/languages/python'
import r from 'highlight.js/lib/languages/r'
import ruby from 'highlight.js/lib/languages/ruby'
import rust from 'highlight.js/lib/languages/rust'
import scala from 'highlight.js/lib/languages/scala'
import sql from 'highlight.js/lib/languages/sql'
import swift from 'highlight.js/lib/languages/swift'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

const LANGS: Record<string, LanguageFn> = {
  bash, c, cpp, csharp, css, go, ini, java, javascript, json, kotlin, lua, markdown, perl, php,
  python, r, ruby, rust, scala, sql, swift, typescript, xml, yaml,
}
type LanguageFn = Parameters<typeof hljs.registerLanguage>[1]
for (const [name, fn] of Object.entries(LANGS)) hljs.registerLanguage(name, fn)

// File extension → registered language name.
const EXT_LANG: Record<string, string> = {
  py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript', sh: 'bash', bash: 'bash', zsh: 'bash', rb: 'ruby',
  go: 'go', rs: 'rust', java: 'java', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
  cs: 'csharp', php: 'php', swift: 'swift', kt: 'kotlin', scala: 'scala', css: 'css',
  scss: 'css', less: 'css', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'ini', xml: 'xml',
  sql: 'sql', lua: 'lua', pl: 'perl', r: 'r',
}

// Highlighted HTML for a code file, or null if highlighting fails (caller shows
// the raw text). Uses the extension's language, else auto-detect.
export function highlightCode(code: string, filename: string): string | null {
  const ext = filename.includes('.') ? (filename.split('.').pop() ?? '').toLowerCase() : ''
  const lang = EXT_LANG[ext]
  try {
    if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value
    return hljs.highlightAuto(code).value
  } catch {
    return null
  }
}
