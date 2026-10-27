// HMAC-SHA256 from crypto.subtle.digest, as RFC 2104 defines it. The mod's
// environment has `digest` but no `importKey` (Research MIP2-1376 §2), so the
// mod can't use crypto.subtle's own HMAC. Node has the same global, so the
// tests check this against Node's createHmac.

const encoder = new TextEncoder()

async function sha256(...parts: Uint8Array[]): Promise<Uint8Array> {
  const all = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    all.set(p, at)
    at += p.length
  }
  return new Uint8Array(await crypto.subtle.digest('SHA-256', all))
}

export async function hmacSha256(key: Uint8Array, message: string): Promise<Uint8Array> {
  const block = new Uint8Array(64)
  block.set(key.length > 64 ? await sha256(key) : key)
  const inner = block.map(b => b ^ 0x36)
  const outer = block.map(b => b ^ 0x5c)
  return sha256(outer, await sha256(inner, encoder.encode(message)))
}
