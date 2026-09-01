// Voice input — engine discovery, model management, transcription.
//
// Two engines, deliberately. Apple's on-device DictationTranscriber needs no
// download and works the moment the button is pressed, which is what stops the
// feature being dead on arrival for someone who has installed nothing. Whisper is
// the upgrade: better on technical vocabulary, which is most of what gets dictated
// into a coding agent. (Measured: Apple heard "verify the migration" as "verify the
// immigration" — exactly the failure that matters here.)
//
// NO MODEL WEIGHTS ARE SHIPPED. They are large and their licensing is a recurring
// tax, so models are downloaded on request or pointed at where they already live.
// The app is a consumer of engines it did not build, in the same spirit as the
// digests panel being a consumer of feeds it did not write.
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, statSync, createWriteStream, unlinkSync, renameSync } from 'node:fs'
import { join, basename, isAbsolute } from 'node:path'
import os from 'node:os'

export type EngineKind = 'apple' | 'whisper'

export interface VoiceEngine {
  kind: EngineKind
  /** Absolute path to the executable, or '' for an engine with nothing to run. */
  path: string
  label: string
  available: boolean
  /** Why it cannot be used, when available is false. Shown verbatim in settings. */
  detail?: string
  /** Whisper needs a model; Apple does not. */
  needsModel: boolean
}

export interface VoiceModel {
  id: string
  label: string
  /** Absolute path once installed. */
  path: string
  sizeMb: number
  installed: boolean
  /** Absent for models the user pointed at by hand. */
  url?: string
  note?: string
}

// ggml Whisper weights, the format whisper.cpp reads. Sizes are the real download
// sizes, rounded — they are the whole reason this is a download and not a bundle.
// Quantised variants are listed where they are the better default: q5 costs very
// little accuracy for roughly half the bytes.
const CATALOG: Omit<VoiceModel, 'path' | 'installed'>[] = [
  {
    id: 'ggml-base.en.bin',
    label: 'Base (English)',
    sizeMb: 148,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin',
    note: 'Fast. Fine for short prompts; weaker on identifiers and file paths.',
  },
  {
    id: 'ggml-small.en.bin',
    label: 'Small (English)',
    sizeMb: 488,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin',
    note: 'The usual sweet spot for dictating code talk.',
  },
  {
    id: 'ggml-medium.en.bin',
    label: 'Medium (English)',
    sizeMb: 1533,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin',
    note: 'Noticeably better on jargon; slower per utterance.',
  },
  {
    id: 'ggml-large-v3-turbo-q5_0.bin',
    label: 'Large v3 Turbo (quantised)',
    sizeMb: 574,
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin',
    note: 'Best accuracy per megabyte here. Multilingual.',
  },
]

export function catalog(): Omit<VoiceModel, 'path' | 'installed'>[] {
  return CATALOG
}

/** Where downloaded models live. Kept out of the app bundle so updates never touch them. */
export function modelsDir(userData: string): string {
  return join(userData, 'voice-models')
}

// Common install locations, plus PATH. Homebrew's formula installs `whisper-cli`;
// older builds and hand-compiled trees leave `main`, which is too generic a name to
// go looking for on PATH but is safe to accept at an explicit whisper.cpp path.
const WHISPER_NAMES = ['whisper-cli', 'whisper-cpp', 'whisper']
const EXTRA_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', join(os.homedir(), '.local/bin')]

function which(name: string): string | null {
  try {
    const out = execFileSync('/usr/bin/which', [name], { encoding: 'utf8', timeout: 3000 }).trim()
    return out && existsSync(out) ? out : null
  } catch {
    return null
  }
}

/** Locate a Whisper CLI without requiring the user to know where it is. */
export function findWhisper(explicit?: string): string | null {
  if (explicit && isAbsolute(explicit) && existsSync(explicit)) return explicit
  for (const n of WHISPER_NAMES) {
    const p = which(n)
    if (p) return p
  }
  for (const d of EXTRA_DIRS) {
    for (const n of WHISPER_NAMES) {
      const p = join(d, n)
      if (existsSync(p)) return p
    }
  }
  return null
}

/** Ask the bundled helper whether Apple's on-device speech is usable here. */
export function probeApple(helperPath: string): { available: boolean; detail?: string } {
  if (!helperPath || !existsSync(helperPath)) {
    return { available: false, detail: 'helper not bundled in this build' }
  }
  try {
    const raw = execFileSync(helperPath, ['probe'], { encoding: 'utf8', timeout: 10_000 })
    const j = JSON.parse(raw) as { available?: boolean; locales?: string[]; error?: string }
    if (j.error) return { available: false, detail: j.error }
    const n = j.locales?.length ?? 0
    return { available: !!j.available, detail: j.available ? `${n} locales installed` : 'no speech locales installed' }
  } catch (e) {
    return { available: false, detail: (e as Error).message.split('\n')[0] }
  }
}

export function detectEngines(helperPath: string, whisperOverride?: string): VoiceEngine[] {
  const apple = probeApple(helperPath)
  const whisper = findWhisper(whisperOverride)
  return [
    {
      kind: 'apple',
      path: helperPath,
      label: 'Apple on-device (macOS 26+)',
      available: apple.available,
      detail: apple.detail,
      needsModel: false,
    },
    {
      kind: 'whisper',
      path: whisper ?? '',
      label: whisper ? `Whisper — ${basename(whisper)}` : 'Whisper (not found)',
      available: !!whisper,
      detail: whisper ?? 'install with: brew install whisper-cpp',
      needsModel: true,
    },
  ]
}

/** Catalog entries plus anything already sitting in the models directory. */
export function listModels(dir: string, extra: string[] = []): VoiceModel[] {
  const out: VoiceModel[] = []
  const seen = new Set<string>()
  for (const c of CATALOG) {
    const p = join(dir, c.id)
    out.push({ ...c, path: p, installed: existsSync(p) })
    seen.add(p)
  }
  // Files dropped into the directory by hand, and models the user pointed at
  // elsewhere. A model is a file the engine reads; there is no reason to insist it
  // came from our list.
  try {
    for (const f of readdirSync(dir)) {
      const p = join(dir, f)
      if (seen.has(p) || !f.endsWith('.bin')) continue
      seen.add(p)
      out.push({ id: f, label: f, path: p, sizeMb: Math.round(statSync(p).size / 1048576), installed: true })
    }
  } catch {
    /* directory may not exist yet */
  }
  for (const p of extra) {
    if (seen.has(p) || !existsSync(p)) continue
    seen.add(p)
    out.push({
      id: p,
      label: `${basename(p)} (linked)`,
      path: p,
      sizeMb: Math.round(statSync(p).size / 1048576),
      installed: true,
    })
  }
  return out
}

/**
 * Download one catalog model. Writes to a .part file and renames on success, so an
 * interrupted download can never be mistaken for an installed model — the same
 * atomic-write discipline the digest feeds use.
 */
export async function downloadModel(
  id: string,
  dir: string,
  onProgress: (received: number, total: number) => void,
  signal?: AbortSignal,
): Promise<{ ok: boolean; error?: string }> {
  const entry = CATALOG.find((c) => c.id === id)
  if (!entry?.url) return { ok: false, error: 'unknown model' }
  mkdirSync(dir, { recursive: true })
  const finalPath = join(dir, entry.id)
  const partPath = `${finalPath}.part`
  try {
    const res = await fetch(entry.url, { signal })
    if (!res.ok || !res.body) return { ok: false, error: `HTTP ${res.status}` }
    const total = Number(res.headers.get('content-length') ?? 0)
    let received = 0
    const file = createWriteStream(partPath)
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      onProgress(received, total)
      if (!file.write(Buffer.from(value))) {
        await new Promise<void>((r) => {
          file.once('drain', () => r())
        })
      }
    }
    await new Promise<void>((resolve, reject) => {
      file.end((e?: Error | null) => (e ? reject(e) : resolve()))
    })
    renameSync(partPath, finalPath)
    return { ok: true }
  } catch (e) {
    try {
      unlinkSync(partPath)
    } catch {
      /* nothing to clean */
    }
    return { ok: false, error: (e as Error).message }
  }
}

export function removeModel(path: string, dir: string): boolean {
  // Only ever delete inside our own directory. A "linked" model lives wherever the
  // user put it and is not ours to remove.
  if (!path.startsWith(dir)) return false
  try {
    unlinkSync(path)
    return true
  } catch {
    return false
  }
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ out: string; err: string; code: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (e, stdout, stderr) => {
      resolve({ out: stdout ?? '', err: stderr ?? '', code: e ? ((e as { code?: number }).code ?? 1) : 0 })
    })
  })
}

/** Apple helper: WAV path in, one string out. */
export async function transcribeApple(
  helperPath: string,
  wav: string,
  locale = 'en-US',
): Promise<{ text?: string; error?: string }> {
  const r = await run(helperPath, ['transcribe', wav], 120_000)
  try {
    const j = JSON.parse(r.out.trim()) as { text?: string; error?: string }
    return j.error ? { error: j.error } : { text: j.text ?? '' }
  } catch {
    return { error: r.err.trim() || `helper exited ${r.code}` }
  }
}

/**
 * whisper.cpp: WAV path + model in, text on stdout.
 *
 * `-nt` suppresses timestamps and `-oted`/`-otxt` are NOT used — writing a sidecar
 * file next to the user's audio is a surprise, and stdout is enough for one
 * utterance. Whisper prints progress and model banners on stderr, so only stdout is
 * parsed.
 */
export async function transcribeWhisper(
  bin: string,
  model: string,
  wav: string,
): Promise<{ text?: string; error?: string }> {
  if (!existsSync(model)) return { error: 'the selected model file is missing' }
  const r = await run(bin, ['-m', model, '-f', wav, '-nt', '-np'], 300_000)
  const text = r.out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('['))
    .join(' ')
    .trim()
  if (!text && r.code !== 0) return { error: r.err.trim().split('\n').slice(-2).join(' ') || `exited ${r.code}` }
  return { text }
}
