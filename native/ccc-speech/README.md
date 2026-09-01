# ccc-speech

A ~115 KB Swift CLI that transcribes a WAV file with Apple's on-device Speech
models (`DictationTranscriber`, macOS 26+). It links only OS frameworks — no
bundled weights, nothing to license, no effect on DMG size.

## Why it exists

Electron cannot reach the Speech framework, and macOS exposes **no supported way
to start or stop system dictation programmatically** — AppKit has a
`startDictation:` action and no counterpart, Electron dropped the `selector`
MenuItem property, and there is no dictation role. Owning the audio is the only
route to a real start/stop control, and it is also what lets a transcript be
routed somewhere other than the focused text field (a terminal, an unfocused
session).

## Interface

    ccc-speech probe                 -> {"available":bool,"locales":["en-US",...]}
    ccc-speech transcribe <file.wav> -> {"text":"..."}

Errors are `{"error":"..."}` with exit 1. `CCC_SPEECH_LOCALE` selects the locale
(default `en-US`).

File-in / JSON-out, one shot. A process that cannot hold a microphone open
cannot leak one, and it dies with the work.

**It never opens the microphone.** The app captures audio and hands over a
finished file, so this binary needs no TCC identity of its own — which sidesteps
the bundled-helper trap where a spawned executable is denied because it has no
Info.plist to carry a usage string.

## The one non-obvious thing

Use `analyzer.analyzeSequence(from: audioFile)`. Building an
`AsyncStream<AnalyzerInput>` by hand and converting buffers with
`AVAudioConverter` — the shape every streaming example shows — fails with a bare
`nilError` that names nothing. The file overload does its own conversion.

## Building

    xcrun swiftc -O -parse-as-library -target arm64-apple-macos26.0 \
      -o ccc-speech main.swift

`-parse-as-library` is required for an async `main`. The deployment target must
be pinned: a plain build on a macOS 26 machine stamps `minos 26.x`, and the app
itself declares `LSMinimumSystemVersion 12.0`. The feature is gated to 26+ at
runtime anyway, so 26.0 is the honest floor here — but check any future binary
with `vtool -show-build-version` before shipping it.
