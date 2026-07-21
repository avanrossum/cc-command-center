// Terminal font discovery.
//
// xterm's font is a plain CSS `fontFamily` string, so any font the OS can
// resolve for CSS works — nothing is bundled. We offer the user only fonts that
// (a) are actually CSS-addressable on this machine and (b) are monospaced, since
// a proportional font wrecks Claude's TUI alignment.
//
// Two discovery paths, unioned:
//   - window.queryLocalFonts() (Local Font Access API; always allowed in
//     Electron) enumerates installed families.
//   - A curated list of common coding fonts is probed too, because enumeration
//     misses some (notably macOS does NOT expose "SF Mono" — and, as it happens,
//     "SF Mono" isn't CSS-addressable either, so the canvas test below correctly
//     drops it rather than offering a name that would silently fall back).
//
// Every candidate is then filtered with a canvas measurement that uses the SAME
// font-resolution path xterm uses, so the offered list matches what the terminal
// will actually render.

export const DEFAULT_TERMINAL_FONT = 'Menlo, Monaco, "Courier New", monospace'
export const DEFAULT_TERMINAL_FONT_SIZE = 12.5

// Turn a stored setting into a CSS font-family value. Empty → the default stack.
// The input is treated as ONE family name and always emitted as `"<name>",
// monospace`, so the worst case for a bad/typo'd name is the monospace fallback
// — never a proportional default. CSS-breaking punctuation (quotes, backslashes,
// semicolons, braces, angle brackets) is stripped; a real family name uses none
// of them, and spaces/hyphens ("Fira Code", "PT Mono") are kept.
export function fontFamilyCss(raw: string | null | undefined): string {
  const v = (raw || '').trim()
  if (!v) return DEFAULT_TERMINAL_FONT
  const safe = v.replace(/["'\\;{}<>]/g, '').trim()
  if (!safe) return DEFAULT_TERMINAL_FONT
  return `"${safe}", monospace`
}

const CURATED = [
  'SF Mono',
  'JetBrains Mono',
  'JetBrainsMono Nerd Font',
  'Fira Code',
  'FiraCode Nerd Font',
  'Cascadia Code',
  'Cascadia Mono',
  'Source Code Pro',
  'IBM Plex Mono',
  'Hack',
  'Hack Nerd Font',
  'Roboto Mono',
  'Ubuntu Mono',
  'Inconsolata',
  'Consolas',
  'DejaVu Sans Mono',
  'Liberation Mono',
  'Menlo',
  'Monaco',
  'Courier New',
  'Andale Mono',
  'PT Mono',
  'Space Mono',
  'Victor Mono',
  'Anonymous Pro',
  'Iosevka',
  'Berkeley Mono',
  'Comic Mono',
  'Monaspace Neon',
  'MesloLGS NF',
]

// Symbol / dingbat families are technically monospaced but aren't text fonts.
const SYMBOL = /wingding|webding|dingbat|ornament|symbol|emoji|braille|\bicons?\b|glyph/i

function makeTester(ctx: CanvasRenderingContext2D): (fam: string) => boolean {
  const S = 'mmmmmmmmmmlliWWWW0123@'
  const q = (fam: string) => `"${fam.replace(/"/g, '')}"`
  const widthWith = (fam: string, base: string): number => {
    ctx.font = `48px ${q(fam)}, ${base}`
    return ctx.measureText(S).width
  }
  const adv = (fam: string, ch: string): number => {
    ctx.font = `64px ${q(fam)}`
    return ctx.measureText(ch).width
  }
  // Installed = CSS-addressable: rendering with the family overrides at least one
  // generic baseline (a name the OS can't resolve just yields the baseline width).
  // Two baselines (monospace + serif) so a real monospace font — which matches the
  // monospace generic — is still caught by differing from serif.
  const installed = (fam: string): boolean => {
    const monoBase = widthWith('__ccc_no_such_font__', 'monospace')
    const serifBase = widthWith('__ccc_no_such_font__', 'serif')
    return (
      Math.abs(widthWith(fam, 'monospace') - monoBase) > 0.5 ||
      Math.abs(widthWith(fam, 'serif') - serifBase) > 0.5
    )
  }
  // Monospaced = every measured glyph shares one advance width. No fallback in
  // the measuring font, so a non-installed family collapses to the default
  // proportional font and fails this test (installed() gates it anyway).
  const monospace = (fam: string): boolean => {
    if (SYMBOL.test(fam)) return false
    const chars = ['i', 'W', 'l', 'm', 'x', '0', ' ', '@']
    const w = chars.map((c) => adv(fam, c))
    return w[0] > 0 && w.every((x) => Math.abs(x - w[0]) < 0.5)
  }
  return (fam: string) => installed(fam) && monospace(fam)
}

// Installed, monospaced, CSS-addressable families, sorted. Runs a few thousand
// cheap canvas measurements (<~50ms). Falls back to whatever curated fonts probe
// as usable if enumeration is unavailable.
export async function listMonospaceFonts(): Promise<string[]> {
  const cv = document.createElement('canvas')
  const ctx = cv.getContext('2d')
  if (!ctx) return []
  const usable = makeTester(ctx)

  let enumerated: string[] = []
  try {
    const q = (window as unknown as { queryLocalFonts?: () => Promise<Array<{ family: string }>> })
      .queryLocalFonts
    if (typeof q === 'function') {
      const fonts = await q()
      enumerated = fonts.map((f) => f.family)
    }
  } catch {
    // Not available / blocked — the curated probe below still yields a usable list.
  }

  const candidates = Array.from(new Set([...enumerated, ...CURATED]))
  return candidates.filter(usable).sort((a, b) => a.localeCompare(b))
}
