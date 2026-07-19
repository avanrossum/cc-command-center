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
  const isOption = (l: string) => /^\d+[.)]\s|^Yes\b|^Yes,|^No\b|^No,|keep planning/i.test(l)
  const sigIdx = lines.findIndex((l) =>
    /Do you want to (?:proceed|make this edit|create|run)\b|Would you like to proceed\?|Do you trust the files/i.test(
      l,
    ),
  )
  if (sigIdx < 0) return undefined
  // Gather the contiguous block of content lines directly above the prompt (up to
  // the first blank-line gap), skipping the numbered option lines. Bash dialogs
  // render the command AND a description line here; a plan approval renders many.
  // Only return when that block is a SINGLE unambiguous line — otherwise we can't
  // tell command from description without guessing, so degrade to the coarse label
  // rather than risk showing the wrong one (verbatim is load-bearing).
  const block: string[] = []
  for (let i = sigIdx - 1; i >= 0; i--) {
    const l = lines[i]
    if (isOption(l)) continue
    if (!l) {
      if (block.length) break // blank line ends the block once we've started collecting
      continue
    }
    block.unshift(l)
  }
  if (block.length !== 1) return undefined
  const cmd = block[0]
  return cmd.length > 0 && cmd.length <= 200 ? cmd : undefined
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
