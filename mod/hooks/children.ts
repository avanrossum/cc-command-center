// Contractor sessions a session starts (MIP2-1410). Pure, so the app's tests
// run it without the engine.

/**
 * The sessions a Bash call started with `claude --bg`, from the line Claude
 * Code prints: `backgrounded · <shortId>` and, when named, ` · <name>`. The
 * wording is on the per-release list (MIP2-1392).
 */
export function backgroundedChildren(r: unknown): { shortId: string; name: string | null }[] {
  const out = (r ?? {}) as { result?: { stdout?: unknown }; text?: unknown }
  const text = [out.result?.stdout, out.text].filter((x): x is string => typeof x === 'string').join('\n')
  const seen = new Map<string, string | null>()
  for (const m of text.matchAll(/backgrounded · ([0-9a-f]{8})(?: · ([^\n]{1,120}))?/g)) {
    if (!seen.has(m[1]!) || m[2]) seen.set(m[1]!, m[2]?.trim() || null)
  }
  return [...seen].map(([shortId, name]) => ({ shortId, name }))
}
