// atelier-systemaudio
//
// Tiny helper that subscribes to macOS's ScreenCaptureKit audio stream
// and writes 16 kHz mono signed-16-bit-LE PCM to stdout. atelier uses
// this as a second ffmpeg input (alongside the mic) so it can record
// what the user hears in headphones without requiring BlackHole, a
// Multi-Output Device, or an Aggregate Device.
//
// Apple intends ScreenCaptureKit as the modern path for system-audio
// capture — it's a first-party API with no virtual-driver dance. The
// only user-visible side effect is a one-time Screen Recording
// permission prompt the first time the helper runs.
//
// Built as a standalone command-line binary with an embedded Info.plist
// so macOS shows a useful description in the permission dialog. Compile:
//
//   swiftc -O \
//     -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist \
//     -Xlinker macos-helper/Info.plist \
//     -o dist/macos-helper/systemaudio \
//     macos-helper/atelier-systemaudio.swift

import Foundation
import ScreenCaptureKit
import CoreMedia

// =============================================================
// stderr — print()/NSLog go to stdout, which is our PCM channel
// =============================================================

@inline(__always)
func eprint(_ msg: String) {
    if let data = (msg + "\n").data(using: .utf8) {
        FileHandle.standardError.write(data)
    }
}

// Exit codes the parent (atelier) inspects to surface meaningful errors.
// 0 = clean stop (SIGINT/SIGTERM)
// 1 = unknown / general failure (details on stderr)
// 2 = unsupported macOS version (< 13)
// 3 = Screen Recording permission denied
// 4 = no display found (rare; SCK requires at least one)

// =============================================================
// SCStream subscriber
// =============================================================

@available(macOS 13.0, *)
final class SystemAudioCapturer: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private let sampleRate: Int
    private let channelCount: Int
    private let stdoutHandle = FileHandle.standardOutput

    init(sampleRate: Int = 16000, channelCount: Int = 1) {
        self.sampleRate = sampleRate
        self.channelCount = channelCount
        super.init()
    }

    func start() async throws {
        // SCContentFilter requires a display reference even when we only
        // care about audio. Any on-screen display works — we configure
        // the stream to do effectively no video processing below.
        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(
                false,
                onScreenWindowsOnly: false
            )
        } catch {
            // Most commonly hit when Screen Recording permission hasn't
            // been granted yet. The first call triggers the prompt; this
            // failure path runs when the user denied or hasn't responded.
            eprint("atelier-systemaudio: could not query shareable content: \(error.localizedDescription)")
            eprint("atelier-systemaudio: this usually means Screen Recording permission is missing.")
            eprint("atelier-systemaudio: grant it in System Settings → Privacy & Security → Screen Recording, then re-run.")
            exit(3)
        }
        guard let display = content.displays.first else {
            eprint("atelier-systemaudio: no displays available (need at least one for SCContentFilter)")
            exit(4)
        }

        let filter = SCContentFilter(
            display: display,
            excludingApplications: [],
            exceptingWindows: []
        )

        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true // don't capture our own stderr beeps etc
        config.sampleRate = sampleRate
        config.channelCount = channelCount
        // Minimise the video side — SCK requires the config to declare a
        // frame size but we never read the video output, so any tiny
        // resolution is fine. 1 fps keeps overhead near zero.
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)

        stream = SCStream(filter: filter, configuration: config, delegate: self)
        try stream?.addStreamOutput(self, type: .audio, sampleHandlerQueue: nil)
        try await stream?.startCapture()

        eprint("atelier-systemaudio: capturing at \(sampleRate) Hz, \(channelCount) channel(s)")
    }

    // MARK: SCStreamOutput

    func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .audio, sampleBuffer.isValid else { return }
        emitPCM(from: sampleBuffer)
    }

    // MARK: SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        eprint("atelier-systemaudio: stream stopped: \(error.localizedDescription)")
        exit(1)
    }

    // =============================================================
    // CMSampleBuffer → Float32 samples → Int16 LE → stdout
    // =============================================================

    private func emitPCM(from sampleBuffer: CMSampleBuffer) {
        // ScreenCaptureKit hands us packed Float32 LE samples. We need
        // s16 LE to match what atelier's ffmpeg dual-input pipeline
        // expects (-f s16le -ar 16000 -ac 1 -i pipe:0).
        guard let dataBuffer = CMSampleBufferGetDataBuffer(sampleBuffer) else { return }

        var totalLength: Int = 0
        var dataPointer: UnsafeMutablePointer<Int8>? = nil
        let status = CMBlockBufferGetDataPointer(
            dataBuffer,
            atOffset: 0,
            lengthAtOffsetOut: nil,
            totalLengthOut: &totalLength,
            dataPointerOut: &dataPointer
        )
        guard status == kCMBlockBufferNoErr, let basePointer = dataPointer else { return }

        let floatCount = totalLength / MemoryLayout<Float32>.size
        if floatCount == 0 { return }

        // Rebind the Int8 pointer to Float32 — same bytes, different view.
        basePointer.withMemoryRebound(to: Float32.self, capacity: floatCount) { floatPointer in
            // Convert to Int16 in a stack-allocated buffer to avoid per-
            // sample allocation. 16 kHz mono ≈ 1.6 KB per 100 ms window;
            // negligible.
            var int16Buffer = [Int16](repeating: 0, count: floatCount)
            for i in 0..<floatCount {
                let sample = floatPointer[i]
                let clamped = max(-1.0, min(1.0, sample))
                int16Buffer[i] = Int16(clamped * 32767.0)
            }
            int16Buffer.withUnsafeBufferPointer { buf in
                let bytes = Data(buffer: buf)
                // FileHandle.write is non-throwing here; SIGPIPE if the
                // parent closes stdout will terminate us, which is what
                // we want — atelier killing ffmpeg closes the pipe.
                self.stdoutHandle.write(bytes)
            }
        }
    }
}

// =============================================================
// Main
// =============================================================

if #available(macOS 13.0, *) {
    let capturer = SystemAudioCapturer()

    // SIGINT (Ctrl-C) and SIGTERM (atelier asking us to wrap up) both
    // exit cleanly. The PCM stream we've written is already flushed —
    // FileHandle.write is synchronous.
    signal(SIGINT) { _ in exit(0) }
    signal(SIGTERM) { _ in exit(0) }

    Task {
        do {
            try await capturer.start()
        } catch {
            eprint("atelier-systemaudio: failed to start: \(error.localizedDescription)")
            exit(1)
        }
    }

    // SCStream calls our delegate methods on its own queues; we just
    // need to keep the main runloop alive so the process doesn't exit.
    RunLoop.main.run()
} else {
    eprint("atelier-systemaudio: requires macOS 13.0 or later (this is older)")
    exit(2)
}
