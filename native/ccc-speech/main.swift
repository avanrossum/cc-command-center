// ccc-speech — transcribe a WAV file with Apple's on-device Speech models.
//
// Exists because Electron cannot reach the Speech framework, and because macOS
// exposes NO supported way to start or stop system dictation programmatically
// (there is a `startDictation:` action and no counterpart). Owning the audio is
// the only way to get a real start/stop control, and it is also what lets a
// transcript be routed somewhere other than the focused text field.
//
// Deliberately file-in / JSON-out rather than a streaming service: the caller
// records, stops, and wants one string. A one-shot process cannot leak a hot
// microphone, holds no state, and dies with the work.
//
// The microphone is NEVER opened here — the app captures audio and hands over a
// finished file, so this binary needs no TCC identity of its own. That sidesteps
// the usual bundled-helper permission trap, where a spawned executable is denied
// because it has no Info.plist to carry a usage string.
//
// Usage:  ccc-speech probe                 -> {"available":bool,"locales":[...]}
//         ccc-speech transcribe <file.wav> -> {"text":"..."}
// Exit 0 with JSON on stdout in both cases; errors are {"error":"..."} + exit 1.

import Foundation
import Speech
import AVFoundation

func emit(_ obj: [String: Any], exit code: Int32 = 0) -> Never {
    if let d = try? JSONSerialization.data(withJSONObject: obj),
       let s = String(data: d, encoding: .utf8) {
        print(s)
    }
    exit(code)
}

func fail(_ message: String) -> Never {
    emit(["error": message], exit: 1)
}

@available(macOS 26.0, *)
func makeTranscriber(_ locale: Locale) -> DictationTranscriber {
    // .shortDictation is tuned for utterances rather than long-form media, which is
    // exactly what a press-to-talk button produces.
    DictationTranscriber(locale: locale, preset: .shortDictation)
}

@available(macOS 26.0, *)
func probe() async -> Never {
    let locales = await Set(DictationTranscriber.supportedLocales).map { $0.identifier(.bcp47) }.sorted()
    emit(["available": !locales.isEmpty, "locales": locales])
}

@available(macOS 26.0, *)
func transcribe(path: String, localeID: String) async -> Never {
    let url = URL(fileURLWithPath: path)
    guard FileManager.default.fileExists(atPath: path) else { fail("no such file: \(path)") }

    let transcriber = makeTranscriber(Locale(identifier: localeID))

    // The model for a locale is an OS-managed asset and may simply not be present.
    // Report that as its own condition — "nothing was said" and "the model was never
    // downloaded" are different problems and the caller must not conflate them.
    if let request = try? await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
        do { try await request.downloadAndInstall() }
        catch { fail("speech model for \(localeID) is not installed and could not be downloaded: \(error.localizedDescription)") }
    }

    let file: AVAudioFile
    do { file = try AVAudioFile(forReading: url) }
    catch { fail("could not read audio: \(error.localizedDescription)") }

    let analyzer = SpeechAnalyzer(modules: [transcriber])

    // Consume results concurrently. `results` finishes when the analyzer does, so this
    // task must be running before analysis starts or the early results are dropped.
    let collector = Task { () -> String in
        var parts: [String] = []
        do {
            for try await result in transcriber.results {
                parts.append(String(result.text.characters))
            }
        } catch { /* keep whatever arrived before the failure */ }
        return parts.joined()
    }

    // analyzeSequence(from:) takes the AVAudioFile directly and does its own format
    // conversion. Feeding it a hand-built AsyncStream of AnalyzerInput and converting
    // by hand instead fails with a bare `nilError`, which is worth knowing because the
    // manual path is the one every streaming example shows.
    do {
        let lastSample = try await analyzer.analyzeSequence(from: file)
        if let lastSample {
            try await analyzer.finalizeAndFinish(through: lastSample)
        } else {
            try await analyzer.finalizeAndFinishThroughEndOfInput()
        }
    } catch {
        collector.cancel()
        fail("transcription failed: \(String(describing: error)) | \(error.localizedDescription)")
    }

    let text = await collector.value
    emit(["text": text.trimmingCharacters(in: .whitespacesAndNewlines)])
}

// ---- entry ----
// @main rather than top-level code: -parse-as-library is what lets `main` be async,
// and the transcription API is async throughout.
@main
struct CCCSpeech {
    static func main() async {
        guard #available(macOS 26.0, *) else {
            fail("Apple on-device speech requires macOS 26 or later")
        }
        let args = CommandLine.arguments
        let command = args.count > 1 ? args[1] : "probe"
        let localeID = ProcessInfo.processInfo.environment["CCC_SPEECH_LOCALE"] ?? "en-US"

        switch command {
        case "probe":
            await probe()
        case "transcribe":
            guard args.count > 2 else { fail("usage: ccc-speech transcribe <file.wav>") }
            await transcribe(path: args[2], localeID: localeID)
        default:
            fail("unknown command: \(command)")
        }
    }
}
