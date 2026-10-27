// Text the cards show: ages, paths, token counts.

export function age(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h`
  return `${Math.floor(h / 24)}d`
}

/** Time until a Unix-seconds reset: `2h 14m`, `9m`, `4d 3h`. */
export function untilReset(resetsAtSec: number | null, now: number): string {
  if (resetsAtSec === null) return ''
  const m = Math.max(0, Math.round((resetsAtSec * 1000 - now) / 60_000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ${m % 60}m`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** `/Users/<name>/x` as `~/x`. The renderer doesn't know the home folder, and macOS homes have this shape. */
export function tildify(path: string): string {
  return path.replace(/^\/Users\/[^/]+(?=\/|$)/, '~')
}

export function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M tok`
  if (n >= 1000) return `${Math.round(n / 1000)}k tok`
  return `${n} tok`
}

/** `claude-sonnet-5-5` as `sonnet 5.5`. Unknown shapes pass through. */
export function modelName(id: string): string {
  const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id)
  return m ? `${m[1]} ${m[2]}.${m[3]}` : id
}

const MONO_FALLBACK = 'ui-monospace, "SF Mono", Menlo, monospace'
/** The terminal's default size when none is set (before MIP2-1424, the only size). */
export const TERMINAL_FONT_SIZE = 13

/** The terminal font from settings (MIP2-1424): the chosen family first, then the system monospace. main checks the name (validate.ts FONT_NAME). */
export function terminalFont(settings: { terminalFont?: string; terminalFontSize?: number } | undefined): { fontFamily: string; fontSize: number } {
  const name = settings?.terminalFont
  return { fontFamily: name ? `"${name}", ${MONO_FALLBACK}` : MONO_FALLBACK, fontSize: settings?.terminalFontSize ?? TERMINAL_FONT_SIZE }
}
