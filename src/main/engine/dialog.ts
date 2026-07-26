// Pure parsing helpers for the "why" line — no Electron, no fs — so they can be
// unit-tested and tightened against real captured dialogs without booting the app.

// The gated action (command / file / target) from a Claude Code permission dialog,
// given the ANSI-stripped PTY tail. Conservative: returns undefined unless a single
// clean content line is isolated, so a mangled parse degrades to a coarse label
// rather than showing a WRONG command — the verbatim string is load-bearing (a
// human may approve on it). Tighten against real captures, same discipline as the
// PROMPT_SIGNATURES table in index.ts.
export function parseDialogCommand(strippedTail: string): string | undefined {
  if (!strippedTail) return undefined
  const lines = strippedTail.split('\n').map((l) =>
    l
      .replace(/[─-╿]/g, '') // box-drawing glyphs (U+2500–U+257F)
      .replace(/^[\s│┃|>❯•*]+/, '') // leading gutter / cursor / bullet
      .replace(/[\s│┃|]+$/, '') // trailing box edge
      .trim(),
  )
  const sigIdx = lines.findIndex((l) =>
    /Do you want to (?:proceed|make this edit|create|run)\b|Would you like to proceed\?|Do you trust the files/i.test(
      l,
    ),
  )
  if (sigIdx < 0) return undefined
  const ok = (s: string | undefined): string | undefined =>
    s && s.length > 0 && s.length <= 200 ? s : undefined

  // 1. The question often names its own target — "make this edit to report.txt?",
  //    "create foo.plist?". Prefer that: it is unambiguous, and for an edit the
  //    content above the question is the DIFF, which is not a "why" line and is
  //    usually long enough to have been cut off anyway.
  const inline = /\b(?:make this edit to|create|run)\s+(.+?)\s*\?\s*$/i.exec(lines[sigIdx])
  if (inline) return ok(inline[1].trim())

  // 2. Otherwise the dialog renders a labelled block above the question:
  //      Bash command
  //      <the command>            <- the one we want
  //      <a plain-English description>
  //      This command requires approval
  //    Anchor on the header and take the first content line under it, rather than
  //    walking up from the question (which lands on the trailing notice).
  const HEADER = /^(?:bash command|command|edit file|write file|create file|read file)$/i
  for (let i = sigIdx - 1; i >= 0; i--) {
    if (!HEADER.test(lines[i])) continue
    for (let j = i + 1; j < sigIdx; j++) {
      if (lines[j]) return ok(lines[j])
    }
    break
  }

  // 3. No header and no inline target: fall back to a single unambiguous content
  //    line directly above the question. Conservative on purpose — showing the
  //    WRONG command is worse than showing a coarse label, because a human may
  //    approve on the strength of it.
  const NOISE =
    /^\d+[.)]\s|^Yes\b|^Yes,|^No\b|^No,|keep planning|requires approval$|^esc to |^tab to /i
  const block: string[] = []
  for (let i = sigIdx - 1; i >= 0; i--) {
    const l = lines[i]
    if (NOISE.test(l)) continue
    if (!l) {
      if (block.length) break
      continue
    }
    block.unshift(l)
  }
  return block.length === 1 ? ok(block[0]) : undefined
}

// The last assistant message, but only when it reads as a question — the "your
// turn" why. Returns the trimmed question, or undefined (a reply that is not a
// question is not a needs-you line — protects the high-signal rule).
export function questionFromText(text: string | null | undefined): string | undefined {
  if (!text) return undefined
  const norm = text.replace(/\s+/g, ' ').trim()
  if (!norm.includes('?')) return undefined
  // The sentence ending at the last '?'. Keep the tail (which holds the '?') when it
  // runs long, so the actual question survives truncation.
  const upto = norm.slice(0, norm.lastIndexOf('?') + 1)
  const prevEnd = Math.max(upto.lastIndexOf('. ', upto.length - 2), upto.lastIndexOf('! ', upto.length - 2))
  const sentence = upto.slice(prevEnd + 1).trim()
  if (!sentence) return undefined
  return sentence.length > 160 ? '…' + sentence.slice(-159) : sentence
}
