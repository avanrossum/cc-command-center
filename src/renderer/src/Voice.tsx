// Voice input — capture, encode, transcribe.
//
// macOS offers no supported way to start or stop system dictation programmatically,
// so a real Start/Stop control means owning the audio. That ownership is also what
// lets a transcript go somewhere other than the focused field — into a terminal, or
// into a session you are not looking at.
//
// Capture is MediaRecorder → decodeAudioData → hand-encoded WAV, NOT an AudioWorklet.
// The worklet route needs addModule() on a blob: URL, and the packaged renderer runs
// under `script-src 'self'`, which blocks it. Loosening the CSP to capture audio
// would trade the protection that made the microphone entitlement safe in the first
// place for a nicer-looking pipeline.
import { useCallback, useEffect, useRef, useState } from 'react'

const TARGET_RATE = 16000 // what the speech models want; also 6x smaller than 96k

/** Mix to mono and resample, then write a 16-bit PCM WAV. */
function encodeWav(buffer: AudioBuffer, rate = TARGET_RATE): ArrayBuffer {
  const chans = buffer.numberOfChannels
  const mono = new Float32Array(buffer.length)
  for (let c = 0; c < chans; c++) {
    const d = buffer.getChannelData(c)
    for (let i = 0; i < d.length; i++) mono[i] += d[i] / chans
  }
  // Linear resample. Speech at 16k does not reward anything fancier, and a
  // dependency-free path keeps this file honest about what it does.
  const ratio = buffer.sampleRate / rate
  const outLen = Math.max(1, Math.floor(mono.length / ratio))
  const pcm = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const s = Math.max(-1, Math.min(1, mono[Math.floor(i * ratio)] ?? 0))
    pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  const bytes = new ArrayBuffer(44 + pcm.length * 2)
  const v = new DataView(bytes)
  const ascii = (off: number, str: string): void => {
    for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i))
  }
  ascii(0, 'RIFF')
  v.setUint32(4, 36 + pcm.length * 2, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  v.setUint32(16, 16, true)
  v.setUint16(20, 1, true) // PCM
  v.setUint16(22, 1, true) // mono
  v.setUint32(24, rate, true)
  v.setUint32(28, rate * 2, true)
  v.setUint16(32, 2, true)
  v.setUint16(34, 16, true)
  ascii(36, 'data')
  v.setUint32(40, pcm.length * 2, true)
  new Int16Array(bytes, 44).set(pcm)
  return bytes
}

export type VoiceStatus = 'idle' | 'recording' | 'working' | 'error'

export function useVoice(onText: (text: string) => void): {
  status: VoiceStatus
  error: string | null
  seconds: number
  toggle: () => void
} {
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [seconds, setSeconds] = useState(0)
  const rec = useRef<MediaRecorder | null>(null)
  const chunks = useRef<Blob[]>([])
  const stream = useRef<MediaStream | null>(null)
  const tick = useRef<ReturnType<typeof setInterval> | null>(null)

  // Release the microphone on unmount. A component that goes away mid-recording
  // must not leave the input light on.
  useEffect(() => {
    return () => {
      try {
        rec.current?.state === 'recording' && rec.current.stop()
      } catch {
        /* already stopped */
      }
      stream.current?.getTracks().forEach((t) => t.stop())
      if (tick.current) clearInterval(tick.current)
    }
  }, [])

  const stopTimer = (): void => {
    if (tick.current) clearInterval(tick.current)
    tick.current = null
    setSeconds(0)
  }

  const finish = useCallback(
    async (blob: Blob) => {
      setStatus('working')
      try {
        const ctx = new AudioContext()
        const decoded = await ctx.decodeAudioData(await blob.arrayBuffer())
        void ctx.close()
        const wav = encodeWav(decoded)
        const r = await window.cc.voiceTranscribe(wav)
        if (r.error) {
          setError(r.error)
          setStatus('error')
          return
        }
        const text = (r.text ?? '').trim()
        if (!text) {
          // Silence and failure are different outcomes and must not look alike.
          setError('nothing was heard')
          setStatus('error')
          return
        }
        onText(text)
        setStatus('idle')
        setError(null)
      } catch (e) {
        setError((e as Error).message)
        setStatus('error')
      }
    },
    [onText],
  )

  const toggle = useCallback(() => {
    if (status === 'recording') {
      try {
        rec.current?.stop()
      } catch {
        /* ignore */
      }
      return
    }
    if (status === 'working') return
    setError(null)
    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then((s) => {
        stream.current = s
        chunks.current = []
        const m = new MediaRecorder(s)
        rec.current = m
        m.ondataavailable = (e) => {
          if (e.data.size) chunks.current.push(e.data)
        }
        m.onstop = () => {
          stopTimer()
          s.getTracks().forEach((t) => t.stop()) // drop the mic immediately
          stream.current = null
          const blob = new Blob(chunks.current, { type: m.mimeType || 'audio/webm' })
          if (!blob.size) {
            setError('nothing was recorded')
            setStatus('error')
            return
          }
          void finish(blob)
        }
        m.start()
        setStatus('recording')
        setSeconds(0)
        tick.current = setInterval(() => setSeconds((n) => n + 1), 1000)
      })
      .catch((e: Error) => {
        // The most common cause by far is consent, so say that rather than echoing
        // a DOMException name at someone.
        setError(
          e.name === 'NotAllowedError'
            ? 'microphone access was denied — allow it in System Settings › Privacy & Security › Microphone'
            : e.message,
        )
        setStatus('error')
      })
  }, [status, finish])

  return { status, error, seconds, toggle }
}

export function VoiceButton({
  onText,
  ready,
  onNeedsSetup,
  title,
}: {
  onText: (text: string) => void
  /** False when no engine/model is configured — the button becomes a pointer to Settings. */
  ready: boolean
  onNeedsSetup: () => void
  title?: string
}): React.ReactElement {
  const { status, error, seconds, toggle } = useVoice(onText)
  if (!ready) {
    return (
      <button
        className="vbtn vbtn-setup"
        onClick={onNeedsSetup}
        title="No voice engine is set up yet — open Settings › Voice"
      >
        ● set up voice…
      </button>
    )
  }
  const label =
    status === 'recording'
      ? `■ stop (${seconds}s)`
      : status === 'working'
        ? '… transcribing'
        : '● dictate'
  return (
    <button
      className={`vbtn${status === 'recording' ? ' rec' : ''}${status === 'error' ? ' err' : ''}`}
      onClick={toggle}
      disabled={status === 'working'}
      title={error ?? title ?? 'Dictate — click to start, click again to stop'}
    >
      {status === 'error' ? '⚠ retry' : label}
    </button>
  )
}
