import * as fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

/**
 * Directory where atelier expects whisper.cpp models to live. Used by
 * both the recorder (to find a model at runtime) and the setup wizard
 * (to download them). Keep them all in one place so users can `ls` it
 * to see what languages they have support for.
 */
export const WHISPER_MODELS_DIR = path.join(os.homedir(), ".atelier-models");

/**
 * Default model used when nothing else is configured. We default to
 * `medium` (multilingual) — it's the sweet spot for meeting / call
 * transcripts where speakers may switch languages and the audio is
 * lossy. Users who want speed over quality can opt down to small /
 * base / tiny via the setup wizard or by passing `--model <file>` to
 * `atelier session setup`.
 */
export const DEFAULT_WHISPER_MODEL_FILE = "ggml-medium.bin";

/**
 * Canonical location atelier looks at for the default whisper.cpp
 * model when no preferences are set anywhere. Kept as a path
 * constant for callers that haven't migrated to {@link resolveWhisperModelPath}.
 */
export const DEFAULT_WHISPER_MODEL_PATH = path.join(
  WHISPER_MODELS_DIR,
  DEFAULT_WHISPER_MODEL_FILE
);

/**
 * Registry of whisper.cpp models atelier knows how to download via the
 * setup wizard / `--add-language`. Keys are the canonical filenames
 * users will see under `~/.atelier-models/`. Sizes are approximate;
 * source: huggingface.co/ggerganov/whisper.cpp.
 */
export interface WhisperModelInfo {
  file: string;
  /** Approximate on-disk size, for the wizard's confirm prompt. */
  size: string;
  /** Download URL — direct, no auth needed. */
  url: string;
  /** True for the multilingual variants (no `.en` in the filename). */
  multilingual: boolean;
  /** One-line description shown to the user when picking. */
  description: string;
}

export const WHISPER_MODELS: readonly WhisperModelInfo[] = [
  {
    file: "ggml-tiny.en.bin",
    size: "~75 MB",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.en.bin",
    multilingual: false,
    description: "English-only, fastest, smallest. Lowest quality — fine for clean short notes.",
  },
  {
    file: "ggml-tiny.bin",
    size: "~75 MB",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-tiny.bin",
    multilingual: true,
    description: "Multilingual, fastest. Lowest quality — fine for clean short notes.",
  },
  {
    file: "ggml-base.en.bin",
    size: "~140 MB",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin",
    multilingual: false,
    description: "English-only, noticeably better quality than tiny.",
  },
  {
    file: "ggml-base.bin",
    size: "~140 MB",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
    multilingual: true,
    description: "Multilingual, better quality than tiny. Good lightweight option.",
  },
  {
    file: "ggml-small.bin",
    size: "~470 MB",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin",
    multilingual: true,
    description: "Multilingual, much better non-English quality. Slower per minute of audio.",
  },
  {
    file: "ggml-medium.en.bin",
    size: "~1.5 GB",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.en.bin",
    multilingual: false,
    description: "English-only, high quality. Strong choice for English meetings / calls.",
  },
  {
    file: "ggml-medium.bin",
    size: "~1.5 GB",
    url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-medium.bin",
    multilingual: true,
    description: "Multilingual, high quality. atelier's default — best balance for meetings and calls.",
  },
];

/**
 * Recommended model for a given BCP-47-ish language code. We default
 * to the medium variants — they're the sweet spot for meeting / call
 * audio where speakers may switch languages and the recording may be
 * lossy. English users get `ggml-medium.en.bin`; everyone else gets
 * `ggml-medium.bin`. Users who want a smaller download or faster
 * transcription can pick a lighter model from {@link WHISPER_MODELS}
 * directly via the wizard or `atelier session setup --model ...`.
 */
export function recommendedWhisperModel(language: string): WhisperModelInfo {
  const norm = language.trim().toLowerCase();
  if (norm === "en" || norm === "english") {
    return WHISPER_MODELS.find((m) => m.file === "ggml-medium.en.bin")!;
  }
  return WHISPER_MODELS.find((m) => m.file === "ggml-medium.bin")!;
}

/**
 * Resolve which whisper model path the runtime should use, given the
 * caller's overrides. Priority:
 *   1. Explicit `modelFile` argument (e.g. the per-session override).
 *   2. `$ATELIER_WHISPER_MODEL` env var (absolute path; legacy escape hatch).
 *   3. The default file under {@link WHISPER_MODELS_DIR}.
 *
 * The returned path is NOT verified to exist — caller can `fs.access`
 * it before passing to whisper-cli, and surface a useful error.
 */
export function resolveWhisperModelPath(
  env: NodeJS.ProcessEnv = process.env,
  modelFile?: string
): string {
  if (modelFile) {
    // Bare filename → look it up in the models dir; absolute path → use as-is.
    if (modelFile.includes(path.sep) || path.isAbsolute(modelFile)) {
      return modelFile;
    }
    return path.join(WHISPER_MODELS_DIR, modelFile);
  }
  const envOverride = (env.ATELIER_WHISPER_MODEL ?? "").trim();
  if (envOverride) return envOverride;
  return DEFAULT_WHISPER_MODEL_PATH;
}

/**
 * Audio capture + transcription helpers for `atelier session record`.
 *
 * Atelier doesn't bundle audio or ML — instead it shells out to whatever
 * the user already has on PATH. That keeps the CLI installable as a
 * plain npm package and avoids platform-specific native modules.
 *
 * Capture: prefer `sox` (cross-platform, handles graceful stop on
 * SIGTERM), fall back to `ffmpeg` (almost always installed, but the
 * input flags differ per OS — see {@link ffmpegInputArgs}).
 *
 * Transcription is pluggable via two mechanisms, in priority order:
 *
 *   1. `ATELIER_TRANSCRIBER` env var — a shell command line. Atelier
 *      runs it via `sh -c "$ATELIER_TRANSCRIBER" -- <wav>` so the wav
 *      path lands as `$1`. The command must print the transcript text
 *      to stdout. Exit code 0 means success.
 *
 *   2. `whisper` (OpenAI's python CLI) detected on PATH — atelier
 *      invokes it as `whisper --model tiny --output_format txt
 *      --output_dir <tmp> <wav>` and reads the produced .txt back.
 *
 * If neither resolves, atelier still records (the wav is saved next
 * to session.yaml) and the agent-mode follow-up tells the assistant
 * to transcribe the file and `atelier session note <id>` the result.
 */

// ============================================================
// Recorder detection
// ============================================================

export type RecorderKind = "sox" | "ffmpeg";

export interface RecorderHandle {
  kind: RecorderKind;
  /** Absolute path to the binary that will be spawned. */
  binary: string;
}

/**
 * Locate a usable recorder by probing `which`. ffmpeg-only — atelier's
 * recording features (live VU meter, chunked segments, device-by-name,
 * segment_start_number resume) all rely on ffmpeg-specific flags that
 * sox doesn't have. We kept "sox" as a valid {@link RecorderKind} for
 * back-compat with audio.yaml files from earlier versions; reading
 * those still works, but `detectRecorder` won't ever return one.
 */
export async function detectRecorder(
  probe: (cmd: string) => Promise<string | null> = whichBinary
): Promise<RecorderHandle | null> {
  const bin = await probe("ffmpeg");
  if (bin) return { kind: "ffmpeg", binary: bin };
  return null;
}

/**
 * Build argv for the recorder process. The output path is the wav
 * file the recorder writes; whichever recorder we picked, we target
 * 16 kHz mono PCM because that's what most STT systems expect.
 *
 * When `chunkSeconds` is set, the recorder is asked to produce a
 * series of segments instead of one growing file. `outPath` is then
 * a printf-style template (`chunks/%04d.wav`) — the recorder fills
 * in the ordinal. Only ffmpeg supports segmenting today; sox throws
 * because forcing it through sub-processes would race the audio
 * stream and lose seconds at every rotation.
 */
export function recorderArgs(
  kind: RecorderKind,
  outPath: string,
  opts: {
    platform?: NodeJS.Platform;
    device?: string;
    chunkSeconds?: number;
    /**
     * Where to start the segment counter when chunkSeconds is set.
     * Used by recordCmd's auto-continue logic so that resuming after
     * a device-disconnect doesn't overwrite chunks 0000-N already on
     * disk. Without this, ffmpeg would restart at 0000.wav and clobber.
     */
    chunkStartNumber?: number;
    /**
     * When true, ffmpeg forks a second output to stdout as raw s16le
     * PCM that the meter renderer reads to draw a live VU bar. ~16
     * KB/sec of extra data — trivial. ffmpeg only.
     */
    meterPipe?: boolean;
    /**
     * Pre-built `-f <driver> -i <device>` argv fragment for a system-
     * audio loopback source (BlackHole on macOS, .monitor on Linux,
     * screen-capture-recorder on Windows). When set, ffmpeg captures
     * BOTH mic AND this source, mixes them with amix, and writes the
     * combined stream to the primary output (+ meter pipe if enabled).
     * Resolved upstream by {@link detectSystemAudioSource}.
     */
    systemAudioInput?: readonly string[];
    /**
     * Dual-bar meter mode. When 2 and a system-audio source is in
     * play, the meter pipe carries STEREO PCM: left = mic, right =
     * system audio. Renderer shows two side-by-side bars. Default 1
     * = single mono meter.
     */
    meterChannels?: 1 | 2;
  } = {}
): string[] {
  const platform = opts.platform ?? process.platform;
  if (kind === "sox") {
    if (opts.chunkSeconds !== undefined) {
      throw new Error(
        "Chunked recording isn't supported with sox yet — install ffmpeg or use the default single-file mode."
      );
    }
    // `-d` reads from the default audio device on every platform sox
    // supports. 16-bit signed PCM mono at 16kHz keeps the wav small
    // and STT-friendly.
    return [
      "-d",
      "-r",
      "16000",
      "-c",
      "1",
      "-b",
      "16",
      "-e",
      "signed-integer",
      "-t",
      "wav",
      outPath,
    ];
  }
  // ffmpeg — input flags depend on the OS.
  const segmentArgs =
    opts.chunkSeconds !== undefined
      ? [
          "-f",
          "segment",
          "-segment_time",
          String(opts.chunkSeconds),
          "-reset_timestamps",
          "1",
          // When resuming after a device-disconnect, start numbering
          // at chunkStartNumber rather than 0 so we don't clobber
          // already-finalised chunks. No-op on the first attempt
          // (chunkStartNumber undefined or 0).
          ...(opts.chunkStartNumber && opts.chunkStartNumber > 0
            ? ["-segment_start_number", String(opts.chunkStartNumber)]
            : []),
        ]
      : [];
  const hasSystemAudio =
    opts.systemAudioInput && opts.systemAudioInput.length > 0;

  // --------------------------------------------------------------
  // SINGLE-INPUT PATH: mic only. Each output reads from the input
  // implicitly — no -map flags needed.
  // --------------------------------------------------------------
  if (!hasSystemAudio) {
    const primary = [
      ...segmentArgs,
      "-ar",
      "16000",
      "-ac",
      "1",
      "-sample_fmt",
      "s16",
      "-y",
      outPath,
    ];
    const meter = opts.meterPipe
      ? [
          "-ar",
          "8000",
          "-ac",
          "1",
          "-sample_fmt",
          "s16",
          "-f",
          "s16le",
          "pipe:1",
        ]
      : [];
    return [
      "-loglevel",
      "error",
      ...ffmpegInputArgs(platform, opts.device),
      ...primary,
      ...meter,
    ];
  }

  // --------------------------------------------------------------
  // DUAL-INPUT PATH: mic + system-audio loopback, mixed via amix.
  //
  // ffmpeg's filter graph:
  //   [0:a][1:a] amix=inputs=2:duration=longest:dropout_transition=0 [mixed]
  //   ([mixed] asplit=2 [main] [meter])   ← only when meter is on
  //
  // -map [main]   → primary wav / segmented chunks (16 kHz mono)
  // -map [meter]  → raw 8 kHz PCM piped to stdout for the VU bar
  //
  // duration=longest: ends when whichever input ends last (matters if
  // the OS yanks one device mid-call — we keep recording from the
  // surviving stream until ffmpeg shuts down).
  // dropout_transition=0: don't smoothly fade between mono/mixed when
  // one input gains/loses silence — gives clearer audio for STT.
  // --------------------------------------------------------------
  // When the meter is enabled, build it AS STEREO so the renderer
  // can show separate bars for mic (left) vs system audio (right).
  // `amerge=inputs=2` interleaves mic-mono + sys-mono into a 2-channel
  // stream. amix builds the mono-summed recording in parallel.
  // Without the meter we just amix into a single output.
  const wantsDualMeter = opts.meterPipe && opts.meterChannels === 2;
  const filterComplex = !opts.meterPipe
    ? "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0[mixed]"
    : wantsDualMeter
      ? "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0[mixed];[0:a][1:a]amerge=inputs=2[meter]"
      : "[0:a][1:a]amix=inputs=2:duration=longest:dropout_transition=0[mixed];[mixed]asplit=2[main][meter]";

  const mainLabel = opts.meterPipe && !wantsDualMeter ? "[main]" : "[mixed]";

  const primary = [
    "-map",
    mainLabel,
    ...segmentArgs,
    "-ar",
    "16000",
    "-ac",
    "1",
    "-sample_fmt",
    "s16",
    "-y",
    outPath,
  ];
  const meter = opts.meterPipe
    ? [
        "-map",
        "[meter]",
        "-ar",
        "8000",
        "-ac",
        wantsDualMeter ? "2" : "1",
        "-sample_fmt",
        "s16",
        "-f",
        "s16le",
        "pipe:1",
      ]
    : [];
  return [
    "-loglevel",
    "error",
    ...ffmpegInputArgs(platform, opts.device),
    ...opts.systemAudioInput!,
    "-filter_complex",
    filterComplex,
    ...primary,
    ...meter,
  ];
}

/**
 * Per-OS ffmpeg input device flags. macOS uses avfoundation, Linux
 * defaults to ALSA (`default` device), Windows uses dshow. Users can
 * override the device via `--device` if their setup needs it.
 *
 * The `device` string accepts three shapes on macOS:
 *   - `":N"`         — avfoundation device at index N (legacy / fallback)
 *   - `":Name"`      — avfoundation device by name (preferred; survives index reorder)
 *   - `"Name"`       — bare name, atelier prefixes with `:` automatically
 *
 * Passing devices by NAME is what recordCmd does for the auto-picked
 * default — index 0 isn't reliably the system default on Macs with
 * virtual-loopback devices installed (Voxal, BlackHole, Teams Audio,
 * etc.). See {@link pickDefaultAudioInput}.
 */
export function ffmpegInputArgs(
  platform: NodeJS.Platform,
  device?: string
): string[] {
  if (platform === "darwin") {
    let target = device ?? ":0";
    // Bare names get the avfoundation ":" prefix so users don't have
    // to remember the syntax. Anything already starting with ":" or
    // matching a "video:audio" spec is left alone.
    if (!target.includes(":")) target = ":" + target;
    return ["-f", "avfoundation", "-i", target];
  }
  if (platform === "win32") {
    return ["-f", "dshow", "-i", device ?? "audio=default"];
  }
  // Linux + everything else: ALSA's `default` works on most distros;
  // PulseAudio users can pass --device pulse.
  return ["-f", "alsa", "-i", device ?? "default"];
}

// ============================================================
// Transcriber detection
// ============================================================

export type TranscriberKind = "env" | "whisper";

export interface TranscriberHandle {
  kind: TranscriberKind;
  /** Human-readable label for status output. */
  label: string;
  /**
   * Run transcription on the wav at {@link wavPath}. Returns the
   * transcript text. Throws on non-zero exit.
   */
  transcribe(wavPath: string): Promise<string>;
}

/**
 * Resolve a transcriber following the priority order documented at
 * the top of this file. Returns null when nothing's configured.
 *
 * `whisperOpts` are forwarded to the whisper.cpp invocation when
 * that branch fires — they let recordCmd thread per-recording model
 * + language preferences through without atelier needing global
 * state. Honored only by the whisper-cli branch; env-var and Python
 * whisper transcribers ignore them (the env command owns its own
 * config, the Python CLI uses different flag names).
 */
export async function detectTranscriber(
  env: NodeJS.ProcessEnv = process.env,
  probe: (cmd: string) => Promise<string | null> = whichBinary,
  whisperOpts: { modelFile?: string; language?: string } = {}
): Promise<TranscriberHandle | null> {
  const envCmd = (env.ATELIER_TRANSCRIBER ?? "").trim();
  if (envCmd) {
    return {
      kind: "env",
      label: `$ATELIER_TRANSCRIBER (${truncate(envCmd, 50)})`,
      transcribe: (wav) => runEnvTranscriber(envCmd, wav),
    };
  }
  const whisperPy = await probe("whisper");
  if (whisperPy) {
    return {
      kind: "whisper",
      label: `whisper (Python, ${whisperPy})`,
      transcribe: (wav) => runWhisperTranscriber(whisperPy, wav),
    };
  }
  // whisper.cpp's CLI lands under the name `whisper-cli` when installed
  // via `brew install whisper-cpp`. Different binary, different args
  // than the Python whisper, same atelier interface.
  const whisperCpp = await probe("whisper-cli");
  if (whisperCpp) {
    const langSuffix =
      whisperOpts.language && whisperOpts.language !== "auto"
        ? `, lang=${whisperOpts.language}`
        : "";
    return {
      kind: "whisper",
      label: `whisper-cli (whisper.cpp, ${whisperCpp}${langSuffix})`,
      transcribe: (wav) =>
        runWhisperCppTranscriber(whisperCpp, wav, env, whisperOpts),
    };
  }
  return null;
}

/**
 * Run the user-supplied $ATELIER_TRANSCRIBER. We invoke it via
 * `sh -c "$cmd" -- <wav>` so the command sees the wav path as `$1`.
 * Anything written to stdout is the transcript; stderr passes
 * through to the terminal so the user sees progress / errors.
 */
async function runEnvTranscriber(cmd: string, wavPath: string): Promise<string> {
  return await runCaptureStdout("sh", ["-c", cmd, "--", wavPath]);
}

/**
 * Invoke whisper.cpp's `whisper-cli`. Like the Python whisper it writes
 * a .txt file rather than emitting stdout, so we pass `-of <stem>` into
 * a tmpdir and read the produced `<stem>.txt` back.
 *
 * Model selection: ATELIER_WHISPER_MODEL env var if set, otherwise
 * `~/.atelier-models/ggml-medium.bin` (atelier's recommended default
 * — multilingual, high quality, fits the meeting / call use case).
 * Users who'd rather use a smaller model can pick one in
 * `atelier session setup` or set ATELIER_WHISPER_MODEL to a different
 * file under `~/.atelier-models/`.
 */
async function runWhisperCppTranscriber(
  binary: string,
  wavPath: string,
  env: NodeJS.ProcessEnv,
  opts: { modelFile?: string; language?: string } = {}
): Promise<string> {
  const model = resolveWhisperModelPath(env, opts.modelFile);
  try {
    await fs.access(model);
  } catch {
    throw new Error(
      `Whisper model not found at ${model}. Run \`atelier session setup\` to ` +
        `download one, or set $ATELIER_WHISPER_MODEL to an existing ggml-*.bin.`
    );
  }
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-wcpp-"));
  const stem = path.basename(wavPath, path.extname(wavPath));
  try {
    const args = [
      "-m",
      model,
      "-f",
      wavPath,
      "-otxt",
      "-of",
      path.join(tmpDir, stem),
      "--no-prints",
    ];
    // Language: only pass when explicitly configured. Whisper.cpp's
    // default is auto-detect on multilingual models; English-only
    // models (.en.bin) ignore --language entirely so it's safe to
    // always pass when set.
    if (opts.language && opts.language.trim().length > 0) {
      args.push("--language", opts.language.trim());
    }
    await runDiscardStdout(binary, args);
    return await fs.readFile(path.join(tmpDir, stem + ".txt"), "utf8");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Invoke OpenAI's `whisper` Python CLI. It doesn't print to stdout —
 * it writes `<basename>.txt` into `--output_dir`. We use a temp dir
 * and read that file.
 */
async function runWhisperTranscriber(
  binary: string,
  wavPath: string
): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-whisper-"));
  try {
    await runDiscardStdout(binary, [
      "--model",
      "tiny",
      "--output_format",
      "txt",
      "--output_dir",
      tmpDir,
      "--language",
      "en",
      wavPath,
    ]);
    const stem = path.basename(wavPath, path.extname(wavPath));
    return await fs.readFile(path.join(tmpDir, stem + ".txt"), "utf8");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

// ============================================================
// Real-time PCM analysis (level meter)
// ============================================================

/**
 * Convert raw s16le PCM bytes from a stream into a sequence of
 * {@link AudioMeterFrame}s, one per ~100ms window. Used by the
 * live VU meter during `session record` so the user sees the mic
 * actually picking up audio instead of staring at a dead terminal.
 *
 * Why an explicit window size instead of yielding per chunk? Node
 * stream chunks vary wildly (sometimes 64 KB at once, sometimes
 * 32 bytes); fixed-time windows give a smooth refresh rate that
 * doesn't depend on the OS's pipe buffering.
 */
export function pcmLevelStream(
  stream: NodeJS.ReadableStream,
  sampleRate: number,
  startedAtMs: number,
  windowMs: number = 100,
  channels: number = 1
): AsyncIterable<AudioMeterFrame> {
  // Each "window" is N audio frames (per-channel sample triples for
  // stereo, samples for mono). bytesPerWindow accounts for interleaved
  // channels — 100 ms at 8 kHz stereo = 1600 bytes (800 frames × 2 ch × 2 bytes).
  const framesPerWindow = Math.max(1, Math.floor((sampleRate * windowMs) / 1000));
  const bytesPerWindow = framesPerWindow * channels * 2; // s16 = 2 bytes/sample/channel

  // We need to chunk the incoming bytes precisely on window boundaries.
  // An async generator drives reads from the stream's internal buffer
  // via 'readable' events, accumulating bytes until we have one window.
  async function* iter(): AsyncIterable<AudioMeterFrame> {
    let buffered: Buffer = Buffer.alloc(0);
    let done = false;
    const onEnd = () => {
      done = true;
    };
    stream.on("end", onEnd);
    stream.on("close", onEnd);
    try {
      while (!done) {
        // Pull whatever's available. `read()` returns null when nothing
        // is buffered; in that case wait for a 'readable' event.
        const chunk = stream.read() as Buffer | null;
        if (chunk == null) {
          if (done) break;
          await new Promise<void>((resolve) => {
            const onReadable = () => {
              stream.off("end", onResolve);
              resolve();
            };
            const onResolve = () => {
              stream.off("readable", onReadable);
              resolve();
            };
            stream.once("readable", onReadable);
            stream.once("end", onResolve);
          });
          continue;
        }
        buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
        while (buffered.length >= bytesPerWindow) {
          const window = buffered.subarray(0, bytesPerWindow);
          buffered = buffered.subarray(bytesPerWindow);
          yield analyseWindow(window, Date.now() - startedAtMs, channels);
        }
      }
      // Tail — anything <1 window left when the stream ends gets
      // dropped. Not worth a final partial frame for the meter.
    } finally {
      stream.off("end", onEnd);
      stream.off("close", onEnd);
    }
  }

  return iter();
}

/**
 * Compute peak + RMS in dB for one window of s16le PCM samples.
 * Exported so unit tests can hit it directly with synthesised data
 * instead of round-tripping through a stream.
 */
export function analyseWindow(
  pcm: Buffer,
  elapsedMs: number,
  channels: number = 1
): AudioMeterFrame {
  // Read as Int16 LE in place — no copy. For multi-channel interleaved
  // PCM (e.g. stereo meter pipe: L0 R0 L1 R1 …), we walk samples by
  // channel and compute per-channel peak + sum-of-squares so the dual
  // meter can show mic vs system audio independently.
  const view = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  const totalSamples = pcm.byteLength >>> 1;
  const framesPerChannel = Math.floor(totalSamples / Math.max(channels, 1));
  const peaks = new Array<number>(channels).fill(0);
  const sumSquares = new Array<number>(channels).fill(0);
  for (let f = 0; f < framesPerChannel; f++) {
    for (let c = 0; c < channels; c++) {
      const idx = (f * channels + c) * 2;
      const sample = view.getInt16(idx, true);
      const abs = sample < 0 ? -sample : sample;
      if (abs > peaks[c]) peaks[c] = abs;
      sumSquares[c] += sample * sample;
    }
  }
  const peaksNorm = peaks.map((p) =>
    framesPerChannel === 0 ? 0 : p / 32768
  );
  const rmsNorm = sumSquares.map((s) =>
    framesPerChannel === 0 ? 0 : Math.sqrt(s / framesPerChannel) / 32768
  );
  const peakDbs = peaksNorm.map(amplitudeToDb);
  const rmsDbs = rmsNorm.map(amplitudeToDb);
  // Scalar fields = max across channels — keeps the existing single-bar
  // renderer working unchanged when the caller doesn't opt into stereo.
  const aggregatePeak = peaksNorm.reduce((m, v) => (v > m ? v : m), 0);
  const aggregatePeakDb = peakDbs.reduce((m, v) => (v > m ? v : m), -90);
  const aggregateRmsDb = rmsDbs.reduce((m, v) => (v > m ? v : m), -90);
  return {
    peak: aggregatePeak,
    peakDb: aggregatePeakDb,
    rmsDb: aggregateRmsDb,
    peaks: peaksNorm,
    peakDbs,
    rmsDbs,
    elapsedMs,
  };
}

/**
 * Convert a linear 0..1 amplitude to dB. Clamps to -90 at the bottom
 * to match what the post-recording volumedetect helper reports for
 * pure silence — keeps the two surfaces consistent.
 */
export function amplitudeToDb(amplitude: number): number {
  if (amplitude <= 0) return -90;
  const db = 20 * Math.log10(amplitude);
  return db < -90 ? -90 : db;
}

// ============================================================
// Recording lifecycle
// ============================================================

/**
 * One window of the live VU meter. Emitted ~10 times/second when
 * `meter: true` was passed to startRecording. Always carries
 * aggregate scalar peak/RMS values (the loudest channel) plus
 * per-channel arrays. Mono inputs have arrays of length 1; stereo
 * meter pipes (the dual mic/system bar) have arrays of length 2
 * with index 0 = mic, index 1 = system audio.
 */
export interface AudioMeterFrame {
  /** Peak sample amplitude across all channels, 0.0–1.0 (linear). */
  peak: number;
  /** Peak in dB. 0 = clip, -90 ≈ digital silence (clamped). Loudest channel. */
  peakDb: number;
  /** RMS in dB across the loudest channel. */
  rmsDb: number;
  /** Per-channel peak amplitude (linear). Length matches the meter channel count. */
  peaks: number[];
  /** Per-channel peak in dB. */
  peakDbs: number[];
  /** Per-channel RMS in dB. */
  rmsDbs: number[];
  /** Wall-clock ms since recording began. */
  elapsedMs: number;
}

export interface RecordingHandle {
  /** Path to the wav being written. */
  outPath: string;
  /** The recorder child process. */
  child: ChildProcess;
  /**
   * Stop the recorder cleanly. Sends 'q' on stdin for ffmpeg (finalises
   * the wav header) or SIGTERM for sox. Resolves when the child has
   * exited and the wav is fully flushed.
   */
  stop(): Promise<void>;
  /**
   * Resolves when the recorder process exits. Resolves cleanly for
   * caller-initiated shutdowns (via `stop()`) regardless of exit code,
   * since both ffmpeg and sox can exit non-zero on graceful stop on
   * some platforms. Rejects only when the recorder dies without us
   * asking it to (mic permission denied, device busy, disk full).
   */
  exited: Promise<void>;
  /**
   * Async iterable of VU meter windows. Present only when
   * `meter: true` was passed and the recorder supports it (ffmpeg
   * today; sox falls through with `levels: null`). One frame every
   * ~100ms, until the recorder exits.
   */
  levels: AsyncIterable<AudioMeterFrame> | null;
  /**
   * Tail of the recorder's stderr — useful when it crashes and we
   * need to tell the user *why*. Captures up to ~32 KB; older bytes
   * roll off. Empty until the recorder writes something.
   */
  stderrTail(): string;
}

export function startRecording(
  recorder: RecorderHandle,
  outPath: string,
  opts: {
    platform?: NodeJS.Platform;
    device?: string;
    /** Seconds per segment when running in chunked mode. ffmpeg-only. */
    chunkSeconds?: number;
    /**
     * Starting segment number — used by the auto-continue path to
     * resume numbering after a device-disconnect crash. Default 0.
     */
    chunkStartNumber?: number;
    /**
     * When true (and the recorder supports it), the handle exposes a
     * `levels` async iterable for a live VU meter. Currently ffmpeg-only;
     * sox recordings silently skip the meter.
     */
    meter?: boolean;
    /**
     * Pre-built `-f <driver> -i <device>` argv fragment for a system-
     * audio loopback source. When set, ffmpeg captures mic + this
     * source and mixes them via amix. Resolved by recordCmd via
     * {@link detectSystemAudioSource}.
     */
    systemAudioInput?: readonly string[];
    /**
     * Optional sidecar that produces the PCM the systemAudioInput
     * reads (typically `-i pipe:0`). When set, atelier spawns this
     * before ffmpeg and pipes its stdout into ffmpeg's stdin. Used
     * by the macOS ScreenCaptureKit helper; Linux + Windows leave
     * this undefined because their loopback sources are real
     * avfoundation/dshow/pulse devices read directly by ffmpeg.
     */
    systemAudioHelper?: { cmd: string; args: string[] };
    /**
     * 1 = single mono VU bar (default). 2 = dual side-by-side bars,
     * with mic on the left and system audio on the right. Only
     * effective with `meter: true` and a system-audio source.
     */
    meterChannels?: 1 | 2;
  } = {}
): RecordingHandle {
  // Only ffmpeg supports the secondary pipe output we use for metering.
  // Asking for it from sox would either fail (sox can't do dual output
  // to file+stdout in a single process) or interfere with the wav write.
  const meterEnabled = Boolean(opts.meter) && recorder.kind === "ffmpeg";
  // Dual meter only fires when (a) the caller asked for it,
  // (b) the input has > 1 channel (otherwise mic vs system split
  // is meaningless), and (c) the meter pipe itself is enabled.
  // Dual-bar meter is only meaningful when a system-audio source is
  // also being captured — otherwise both bars would show the same
  // mic level. Falls back to a single bar when the caller doesn't
  // pass --system-audio.
  const dualMeter =
    opts.meterChannels === 2 &&
    !!opts.systemAudioInput &&
    opts.systemAudioInput.length > 0 &&
    meterEnabled;
  const args = recorderArgs(recorder.kind, outPath, {
    ...opts,
    meterPipe: meterEnabled,
    systemAudioInput: opts.systemAudioInput,
    meterChannels: dualMeter ? 2 : 1,
  });
  // System-audio helper (macOS SCK case): spawn the sidecar BEFORE
  // ffmpeg so its stdout is ready to feed ffmpeg's stdin as PCM input.
  // The helper writes 16 kHz mono Int16 LE PCM matching what the
  // -f s16le -i pipe:0 ffmpegInput config expects. We capture its
  // stderr for diagnostic purposes (mostly the one-line startup
  // status; real errors get logged in atelier's main flow).
  let helperChild: ChildProcess | null = null;
  if (opts.systemAudioHelper) {
    helperChild = spawn(opts.systemAudioHelper.cmd, opts.systemAudioHelper.args, {
      stdio: ["ignore", "pipe", "inherit"],
    });
    helperChild.on("error", (err) => {
      // Surface helper-startup failures into ffmpeg's stderr ring so
      // the existing diagnoseRecorderExit path picks them up.
      // eslint-disable-next-line no-console
      console.error(`[atelier] system-audio helper failed: ${err.message}`);
    });
  }

  // ffmpeg needs stdin piped so we can write 'q' to ask it to
  // finalise (or, when the SCK helper is in use, so we can pipe its
  // PCM stdout into ffmpeg as the second input). When the meter is
  // enabled we capture stdout for raw PCM analysis. We always pipe
  // stderr (rather than "inherit") so we can pattern-match the
  // recorder's exit reason — eg "Failed to capture frame" when
  // avfoundation loses the audio device mid-recording.
  const child = spawn(recorder.binary, args, {
    stdio: ["pipe", meterEnabled ? "pipe" : "ignore", "pipe"],
  });
  const startedAt = Date.now();

  // Wire the helper's stdout into ffmpeg's stdin. ffmpeg consumes
  // this as its `-i pipe:0` input alongside the mic. EPIPE on
  // helper-side closes are silenced — when atelier stops the
  // recorder, we SIGTERM the helper too, and any in-flight writes
  // would otherwise crash with "write EPIPE".
  if (helperChild && helperChild.stdout && child.stdin) {
    helperChild.stdout.pipe(child.stdin);
    helperChild.stdout.on("error", () => {
      /* EPIPE on stop — expected */
    });
    child.stdin.on("error", () => {
      /* EPIPE on stop — expected */
    });
  }

  // Ring-buffer the recorder's stderr so we have something to show
  // the user when it crashes. 32 KB is plenty for ffmpeg / sox error
  // messages and prevents memory growth on long sessions where
  // ffmpeg might emit periodic progress lines.
  const STDERR_MAX_BYTES = 32 * 1024;
  let stderrBuf = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrBuf += chunk.toString("utf8");
    if (stderrBuf.length > STDERR_MAX_BYTES) {
      stderrBuf = stderrBuf.slice(stderrBuf.length - STDERR_MAX_BYTES);
    }
  });

  // Tracks whether the caller asked us to stop the recorder. If yes,
  // we accept any exit code as a graceful shutdown — ffmpeg legitimately
  // exits with 255 after receiving 'q' on stdin, sox can exit non-zero
  // after SIGTERM on some platforms. Only crashes the caller didn't
  // initiate (mic permission denied, recorder couldn't bind the device,
  // disk full mid-segment) reject the exit promise.
  let stopRequested = false;

  const exited: Promise<void> = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (
        stopRequested ||
        code === 0 ||
        code === null ||
        signal === "SIGTERM" ||
        signal === "SIGINT"
      ) {
        resolve();
      } else {
        reject(new Error(`${recorder.kind} exited with code ${code}`));
      }
    });
  });
  // Silence Node's "unhandled rejection" path: if the recorder dies
  // before any code awaits `exited`, the rejection bubbles to the
  // event loop and prints a stack trace. Attach a no-op so the
  // rejection is observed; callers still see real errors via the
  // explicit await in stop() or their own exit-watcher.
  exited.catch(() => {});

  // Build the levels iterator off ffmpeg's stdout when the meter is on.
  // The stream is raw 8 kHz mono signed-16-bit-little-endian PCM, so each
  // sample is 2 bytes. We batch into 100ms windows = 800 samples = 1600
  // bytes, compute peak + RMS in dB, and yield one frame per window.
  const levels: AsyncIterable<AudioMeterFrame> | null = meterEnabled
    ? pcmLevelStream(child.stdout!, 8000, startedAt, 100, dualMeter ? 2 : 1)
    : null;

  return {
    outPath,
    child,
    exited,
    levels,
    stderrTail: () => stderrBuf,
    async stop() {
      stopRequested = true;
      // Stop the system-audio helper first so it doesn't keep pushing
      // PCM into a ffmpeg that's mid-shutdown. SIGTERM gives the SCK
      // stream a moment to flush + tear down.
      if (helperChild && helperChild.pid) {
        try {
          process.kill(helperChild.pid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
      // 'q' on stdin path is only valid when stdin ISN'T being used for
      // PCM input (no SCK helper). With the helper piping bytes in,
      // writing 'q' would corrupt the PCM stream — go straight to
      // SIGTERM. ffmpeg handles SIGTERM gracefully on the recording
      // side (finalises wav headers, flushes segments).
      const stdinFreeForQuit =
        recorder.kind === "ffmpeg" &&
        !helperChild &&
        child.stdin &&
        !child.stdin.destroyed;
      if (stdinFreeForQuit) {
        try {
          child.stdin!.write("q");
          child.stdin!.end();
        } catch {
          /* fall through to SIGTERM */
        }
      }
      if (child.pid) {
        // SIGTERM fallback. For the SCK / helper path we send it
        // immediately (no 'q' available). For the legacy mic-only
        // path we wait 3s for 'q' to take effect first.
        const escalateAfterMs = stdinFreeForQuit ? 3000 : 0;
        const timer = setTimeout(() => {
          try {
            process.kill(child.pid!, "SIGTERM");
          } catch {
            /* already gone */
          }
        }, escalateAfterMs);
        timer.unref();
        try {
          await exited;
        } finally {
          clearTimeout(timer);
        }
        return;
      }
      await exited;
    },
  };
}

// ============================================================
// Audio level measurement (silence detection)
// ============================================================

export interface AudioLevel {
  /** Mean signal level in dB. -91 dB ≈ digital silence; speech is roughly -20 to -30 dB. */
  mean: number;
  /** Peak signal level in dB. */
  max: number;
}

/**
 * Measure the audio level of a wav by running it through ffmpeg's
 * volumedetect filter. Returns null when:
 *   - the file is empty / unreadable
 *   - ffmpeg isn't on PATH (no point requiring it just for the warning)
 *   - the output format isn't parseable
 *
 * Used by recordCmd's post-stop "is this actually silent?" guard so we
 * can warn the user before they spend N minutes wondering why every
 * chunk transcribes to [BLANK_AUDIO]. -91 dB across the board almost
 * always means ffmpeg got no real audio (mic permission, wrong default
 * input device, hardware mute).
 */
export async function measureAudioLevel(
  wavPath: string
): Promise<AudioLevel | null> {
  try {
    const stat = await fs.stat(wavPath);
    if (stat.size < 1024) return null; // too small to have meaningful audio
  } catch {
    return null;
  }
  const ffPath = await whichBinary("ffmpeg");
  if (!ffPath) return null;
  return await new Promise<AudioLevel | null>((resolve) => {
    const child = spawn(
      ffPath,
      [
        "-hide_banner",
        "-nostats",
        "-i",
        wavPath,
        "-af",
        "volumedetect",
        "-f",
        "null",
        "-",
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    child.stderr!.on("data", (c) => (stderr += String(c)));
    child.on("error", () => resolve(null));
    child.on("exit", (code) => {
      if (code !== 0) return resolve(null);
      const meanMatch = stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
      const maxMatch = stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
      if (!meanMatch || !maxMatch) return resolve(null);
      resolve({ mean: parseFloat(meanMatch[1]), max: parseFloat(maxMatch[1]) });
    });
  });
}

/**
 * Threshold below which we treat captured audio as "effectively silent"
 * and warn the user. -75 dB sits comfortably below a quiet office floor
 * (~ -55 dB) but well above ADC noise (-90+ dB), so we only fire on
 * recordings where ffmpeg captured nothing the agent could transcribe.
 */
export const SILENT_AUDIO_THRESHOLD_DB = -75;

// ============================================================
// Audio input device enumeration (macOS / avfoundation)
// ============================================================

export interface AudioInputDevice {
  /** Index in avfoundation's enumeration. Order can shift between probes. */
  index: number;
  /** Human-readable device name. Stable across probes when the device is plugged in. */
  name: string;
}

/**
 * Patterns matching well-known virtual / loopback / VPN audio devices
 * that show up in avfoundation's list but produce silence unless audio
 * is explicitly routed through them. Used by {@link pickDefaultAudioInput}
 * to avoid silently recording 30 minutes of -90 dB from "Voxal Virtual
 * Device" because it happened to be at index 0.
 *
 * The pattern list is conservative — only names that are virtually
 * always virtual. If a real device matches (rare; user-config aggregate
 * devices), the user can pin it with --device by name.
 */
const VIRTUAL_DEVICE_PATTERNS: readonly RegExp[] = [
  /voxal/i,
  /blackhole/i,
  /soundflower/i,
  /loopback/i,
  /^virtual /i, // "Virtual Audio Cable" etc — anchor to avoid matching brand names
  /aggregate device/i,
  /microsoft teams audio/i,
  /zoom audio device/i,
  /krisp/i,
  /vb-cable/i,
  /backboard/i,
];

/** Patterns matching macOS built-in / hardware mics — preferred when picking automatically. */
const BUILTIN_DEVICE_PATTERNS: readonly RegExp[] = [
  /macbook .* microphone/i,
  /built-in microphone/i,
  /internal microphone/i,
  /imac microphone/i,
  /studio display microphone/i,
];

/**
 * Enumerate avfoundation audio input devices on macOS. Returns [] on
 * other platforms (we could add ALSA / dshow listing later if anyone
 * needs it). Spawns `ffmpeg -list_devices true` which writes the
 * device list to stderr and exits non-zero — that's expected, we
 * parse stderr regardless of exit code.
 */
export async function listAudioInputs(): Promise<AudioInputDevice[]> {
  if (process.platform !== "darwin") return [];
  const ffPath = await whichBinary("ffmpeg");
  if (!ffPath) return [];
  return await new Promise<AudioInputDevice[]>((resolve) => {
    const child = spawn(
      ffPath,
      [
        "-hide_banner",
        "-f",
        "avfoundation",
        "-list_devices",
        "true",
        "-i",
        "",
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    child.stderr!.on("data", (c) => (stderr += String(c)));
    child.on("error", () => resolve([]));
    child.on("exit", () => {
      const out: AudioInputDevice[] = [];
      let inAudio = false;
      for (const line of stderr.split("\n")) {
        // The header marking the audio block. Sections in ffmpeg's
        // output are: "AVFoundation video devices:" then audio.
        if (/AVFoundation\s+audio\s+devices/i.test(line)) {
          inAudio = true;
          continue;
        }
        if (!inAudio) continue;
        // Leaving the audio block — either another "* devices" header,
        // an error line, or end of stream.
        if (/AVFoundation\s+\w+\s+devices/i.test(line) && !/audio/i.test(line)) break;
        if (/Error|input file/i.test(line)) break;
        // Pull "[0] Device Name" entries. Strip ffmpeg's "[AVFoundation indev @ 0x...]" prefix first.
        const stripped = line.replace(/^\[[^\]]+\]\s*/, "");
        const m = stripped.match(/^\[(\d+)\]\s+(.+)$/);
        if (m) out.push({ index: parseInt(m[1], 10), name: m[2].trim() });
      }
      resolve(out);
    });
  });
}

/**
 * Pick the best default device from a list. Two-step preference:
 *   1. Skip anything matching a known virtual / loopback pattern.
 *   2. Among the remaining real devices, prefer built-in hardware mics.
 *   3. Fall back to the first real device, or the first device overall
 *      if everything looks virtual.
 *
 * Returns null when the list is empty. Caller decides whether to fall
 * back to ":0" or surface an error.
 */
export function pickDefaultAudioInput(
  devices: AudioInputDevice[]
): AudioInputDevice | null {
  if (devices.length === 0) return null;
  const real = devices.filter(
    (d) => !VIRTUAL_DEVICE_PATTERNS.some((re) => re.test(d.name))
  );
  if (real.length > 0) {
    const builtIn = real.find((d) =>
      BUILTIN_DEVICE_PATTERNS.some((re) => re.test(d.name))
    );
    return builtIn ?? real[0];
  }
  // Everything looked virtual. Last resort: return whatever's first
  // and let the silence guard catch it if the recording is dead.
  return devices[0];
}

/** Is this device name on our "almost certainly virtual / not a real mic" list? */
export function isLikelyVirtualDevice(name: string): boolean {
  return VIRTUAL_DEVICE_PATTERNS.some((re) => re.test(name));
}

// ============================================================
// System-audio loopback (cross-platform)
// ============================================================

/**
 * Names of Windows dshow audio devices that are actually system-audio
 * loopback sources. Used by {@link detectWindowsSystemAudio} to find a
 * working capture device on Windows.
 *
 * macOS no longer uses this list — system audio comes from
 * ScreenCaptureKit via the bundled Swift helper, no virtual driver
 * needed. Linux uses PulseAudio `.monitor` sources via pactl.
 */
const LOOPBACK_DEVICE_PATTERNS: readonly RegExp[] = [
  /virtual-audio-capturer/i, // screen-capture-recorder driver
  /stereo mix/i,             // Realtek built-in (often disabled by default)
  /cable output/i,           // VB-Cable
  /what u hear/i,            // Creative Sound Blaster
];

/** Does this Windows dshow device name look like a system-audio loopback source? */
export function isLoopbackInputDevice(name: string): boolean {
  return LOOPBACK_DEVICE_PATTERNS.some((re) => re.test(name));
}

/**
 * Description of how to capture system audio on the current OS,
 * resolved at recording time. The result is plugged into ffmpeg's
 * argv as a second input, then mixed with the mic via amix.
 *
 * `available: false` doesn't error out atelier — the caller decides
 * whether to fall back to mic-only or surface the setup hint to the
 * user. The hint always points at a concrete next step (install
 * BlackHole / check pactl / install screen-capture-recorder).
 */
export interface SystemAudioSource {
  available: boolean;
  /** `-f <driver> -i <device>` argv fragment ready to splice into ffmpeg args. */
  ffmpegInput: string[];
  /** Human-readable name for the banner / agent follow-up. */
  label: string;
  /** Per-OS install / config instructions when `available: false`. */
  setupHint: string;
  /**
   * Optional sidecar command that produces the PCM the ffmpegInput
   * reads. Set on macOS (the ScreenCaptureKit helper). When present,
   * atelier spawns this BEFORE ffmpeg and pipes the helper's stdout
   * into ffmpeg's stdin. The ffmpegInput is then `-i pipe:0`.
   *
   * Other platforms leave this undefined — Linux's PulseAudio
   * `.monitor` source and Windows's dshow loopback drivers are
   * read directly by ffmpeg as a normal device input.
   */
  helperCommand?: { cmd: string; args: string[] };
}

/**
 * Detect a system-audio capture source on the current OS. Each
 * platform has a totally different audio stack:
 *
 *   - macOS:   needs a CoreAudio loopback driver. BlackHole is the
 *              free standard; we also recognise Soundflower + Loopback.
 *   - Linux:   PulseAudio (and the PipeWire compat layer) expose a
 *              `<sink>.monitor` source for every output device. Zero
 *              install; we just need to find it via `pactl`.
 *   - Windows: WASAPI loopback via dshow. screen-capture-recorder is
 *              the most common free driver; we also try Stereo Mix
 *              and VB-Cable.
 *
 * Tests inject `probes` to stub the per-OS detection without spawning
 * subprocesses. Production callers leave probes undefined and we use
 * the real system probes.
 */
export interface SystemAudioProbes {
  /** Returns true when the binary is on PATH. */
  binaryOnPath?: (cmd: string) => Promise<boolean>;
  /** Returns the avfoundation audio input device list (macOS). */
  listAudioInputs?: () => Promise<AudioInputDevice[]>;
  /** Returns `pactl get-default-sink` output, e.g. "alsa_output.pci...analog-stereo". */
  pulseDefaultSink?: () => Promise<string | null>;
  /** Returns `pactl list short sources` parsed as names. Lines ending in `.monitor` are loopback sources. */
  pulseSources?: () => Promise<string[]>;
  /** Returns dshow device names ffmpeg reports on Windows. */
  dshowDevices?: () => Promise<string[]>;
}

export async function detectSystemAudioSource(
  platform: NodeJS.Platform = process.platform,
  probes: SystemAudioProbes = {}
): Promise<SystemAudioSource> {
  if (platform === "darwin") return detectMacOSSystemAudio(probes);
  if (platform === "linux") return detectLinuxSystemAudio(probes);
  if (platform === "win32") return detectWindowsSystemAudio(probes);
  return {
    available: false,
    ffmpegInput: [],
    label: "",
    setupHint: `System-audio capture isn't implemented for platform ${platform} yet.`,
  };
}

/**
 * macOS system-audio capture via the bundled ScreenCaptureKit helper.
 *
 * No BlackHole / Multi-Output Device / Aggregate Device required —
 * Apple's first-party API gives us the system audio stream directly.
 * The only user-visible cost is a one-time Screen Recording permission
 * prompt on first run.
 *
 * Returns `available: false` when:
 *   - The compiled helper binary isn't on disk (atelier was installed
 *     without the macOS build step, or the user is on a non-macOS box
 *     that fell through here somehow).
 *   - macOS is older than 13.0 (Ventura) — SCK isn't available.
 */
async function detectMacOSSystemAudio(
  probes: SystemAudioProbes
): Promise<SystemAudioSource> {
  void probes; // no longer probing avfoundation device list — SCK doesn't need it
  const helperPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "macos-helper",
    "systemaudio"
  );
  try {
    await fs.access(helperPath, fsConstants.X_OK);
  } catch {
    return {
      available: false,
      ffmpegInput: [],
      label: "",
      setupHint:
        "atelier's macOS system-audio helper isn't installed.\n" +
        "  This binary normally builds during `npm install` via swiftc.\n" +
        "  If you have Xcode Command Line Tools, you can rebuild it now:\n" +
        "    npm run build:macos-helper --prefix <atelier-cli-package>\n" +
        "  Or check Xcode CLT: xcode-select --install",
    };
  }
  // ffmpeg reads 16 kHz mono Int16 LE PCM from stdin — exactly what
  // the helper produces. atelier hooks the helper's stdout up to
  // ffmpeg's stdin in startRecording.
  return {
    available: true,
    ffmpegInput: ["-f", "s16le", "-ar", "16000", "-ac", "1", "-i", "pipe:0"],
    label: "ScreenCaptureKit (macOS native)",
    setupHint: "",
    helperCommand: { cmd: helperPath, args: [] },
  };
}

async function detectLinuxSystemAudio(
  probes: SystemAudioProbes
): Promise<SystemAudioSource> {
  // PulseAudio CLI ships with both PulseAudio and the PipeWire compat
  // layer, so it covers ~all modern Linux distros. If pactl isn't
  // installed we can't do auto-detect, but we tell the user how to
  // fix it. The .monitor source is automatic — no driver to install.
  const probe = probes.binaryOnPath ?? binaryOnPath;
  if (!(await probe("pactl"))) {
    return {
      available: false,
      ffmpegInput: [],
      label: "",
      setupHint:
        "Install pulseaudio-utils (or pipewire-pulse on PipeWire distros):\n" +
        "  Debian/Ubuntu:  sudo apt install pulseaudio-utils\n" +
        "  Fedora:         sudo dnf install pulseaudio-utils\n" +
        "  Arch:           sudo pacman -S libpulse\n" +
        "Then re-run with --system-audio. atelier picks the default output's .monitor source automatically.",
    };
  }
  const defaultSink =
    (probes.pulseDefaultSink ? await probes.pulseDefaultSink() : await runPulseGetDefaultSink()) ?? "";
  const sources = probes.pulseSources
    ? await probes.pulseSources()
    : await runPulseListSources();
  // Prefer the monitor of the current default sink (so we record what
  // the user is actually hearing). Fall back to any .monitor.
  const preferred = defaultSink ? `${defaultSink}.monitor` : "";
  const monitor =
    sources.find((s) => s === preferred) ??
    sources.find((s) => s.endsWith(".monitor")) ??
    null;
  if (!monitor) {
    return {
      available: false,
      ffmpegInput: [],
      label: "",
      setupHint:
        "No PulseAudio .monitor source found. Check:\n" +
        "  pactl list short sources\n" +
        "Each output device should have a corresponding *.monitor source. If your\n" +
        "system uses ALSA-only (no PulseAudio/PipeWire), install pipewire and pipewire-pulse.",
    };
  }
  return {
    available: true,
    ffmpegInput: ["-f", "pulse", "-i", monitor],
    label: monitor,
    setupHint: "",
  };
}

async function detectWindowsSystemAudio(
  probes: SystemAudioProbes
): Promise<SystemAudioSource> {
  const devices = probes.dshowDevices
    ? await probes.dshowDevices()
    : await listDshowAudioDevices();
  const loopback = devices.find((d) => isLoopbackInputDevice(d));
  if (!loopback) {
    return {
      available: false,
      ffmpegInput: [],
      label: "",
      setupHint:
        "Install a loopback driver — recommended option (free, no admin needed):\n" +
        "  https://github.com/rdp/screen-capture-recorder-to-video-windows-free/releases\n" +
        "  Installs a \"virtual-audio-capturer\" dshow device that captures system output.\n" +
        "Alternatives:\n" +
        "  - Enable Stereo Mix in Sound Control Panel → Recording → right-click → Show Disabled Devices\n" +
        "  - VB-Cable: https://vb-audio.com/Cable/",
    };
  }
  return {
    available: true,
    ffmpegInput: ["-f", "dshow", "-i", `audio=${loopback}`],
    label: loopback,
    setupHint: "",
  };
}

async function runPulseGetDefaultSink(): Promise<string | null> {
  return await new Promise<string | null>((resolve) => {
    const child = spawn("pactl", ["get-default-sink"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout!.on("data", (c) => (out += String(c)));
    child.on("error", () => resolve(null));
    child.on("exit", (code) => resolve(code === 0 ? out.trim() : null));
  });
}

async function runPulseListSources(): Promise<string[]> {
  return await new Promise<string[]>((resolve) => {
    const child = spawn("pactl", ["list", "short", "sources"], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout!.on("data", (c) => (out += String(c)));
    child.on("error", () => resolve([]));
    child.on("exit", () => {
      // Format per line: "<index>\t<name>\t<module>\t<format>\t<state>"
      const names: string[] = [];
      for (const line of out.split("\n")) {
        const parts = line.split("\t");
        if (parts.length >= 2 && parts[1]) names.push(parts[1]);
      }
      resolve(names);
    });
  });
}

async function listDshowAudioDevices(): Promise<string[]> {
  // ffmpeg -list_devices true emits the list to stderr and exits with
  // non-zero (we ignore that — parsing stderr is the point). Lines for
  // audio devices look like: [dshow @ 0xN] "<Device Name>" (audio)
  return await new Promise<string[]>((resolve) => {
    const child = spawn(
      "ffmpeg",
      [
        "-hide_banner",
        "-list_devices",
        "true",
        "-f",
        "dshow",
        "-i",
        "dummy",
      ],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    child.stderr!.on("data", (c) => (stderr += String(c)));
    child.on("error", () => resolve([]));
    child.on("exit", () => {
      const out: string[] = [];
      let inAudio = false;
      for (const line of stderr.split("\n")) {
        if (/DirectShow audio devices/i.test(line)) {
          inAudio = true;
          continue;
        }
        if (/DirectShow\s+\w+\s+devices/i.test(line) && !/audio/i.test(line)) break;
        if (!inAudio) continue;
        const m = line.match(/"([^"]+)"\s*(?:\(audio\))?/);
        if (m && m[1]) out.push(m[1]);
      }
      resolve(out);
    });
  });
}

// ============================================================
// Recorder crash diagnosis
// ============================================================

/**
 * Likely cause of an unexpected recorder exit. Used by recordCmd to
 * turn a generic "ffmpeg exited with code 1" into a message that
 * actually tells the user what to fix.
 */
export type RecorderCrashCause =
  | "device-changed" // mic disconnect / default input changed mid-recording
  | "device-stuck" // ffmpeg kept running but produced silence (phantom device handle)
  | "device-busy" // another process holds the mic
  | "permission-denied" // macOS TCC bit not granted
  | "device-not-found" // no input device at the requested index
  | "unknown";

export interface RecorderCrashDiagnosis {
  cause: RecorderCrashCause;
  /** One-line human summary for ui.error(). */
  summary: string;
  /** Multi-line detail / what-to-do hint, may be empty. */
  hint: string;
  /** Raw stderr tail so the user can dig in if our classifier is wrong. */
  rawStderrTail: string;
}

/**
 * Inspect a recorder's stderr after an unexpected exit and classify
 * the cause. Patterns are based on observed ffmpeg/avfoundation
 * output; we err on the side of "say what we know" rather than
 * pretending to diagnose problems we can't.
 *
 * The hint always points at a concrete next step (toggle a setting,
 * re-run a command, plug the device back in) so the user isn't left
 * staring at an error wondering what to do.
 */
export function diagnoseRecorderExit(
  stderrTail: string,
  exitCode: number | null
): RecorderCrashDiagnosis {
  const haystack = stderrTail.toLowerCase();
  const raw = stderrTail;

  // Most common case on macOS: user switched mic, AirPods disconnected,
  // USB device unplugged. avfoundation emits one of these.
  if (
    /failed to capture frame/.test(haystack) ||
    /io error/.test(haystack) ||
    /input\/output error/.test(haystack) ||
    /device disconnected/.test(haystack) ||
    /av_interleaved_write_frame/.test(haystack)
  ) {
    return {
      cause: "device-changed",
      summary:
        "Recorder lost the audio device mid-recording (default input changed, mic disconnected, or device unplugged).",
      hint:
        "ffmpeg locks onto the device that was default when recording started — if you change inputs in System Settings, swap headphones, or unplug a USB mic, the stream dies.\n" +
        "Whatever was captured before the disconnect is intact; rerun `atelier session record` without swapping devices to continue.",
      rawStderrTail: raw,
    };
  }

  if (/permission/.test(haystack) || /not authorized/.test(haystack)) {
    return {
      cause: "permission-denied",
      summary: "macOS hasn't granted microphone permission to this terminal.",
      hint:
        "System Settings → Privacy & Security → Microphone → enable your terminal app, then fully quit + relaunch it (toggle alone isn't enough).",
      rawStderrTail: raw,
    };
  }

  if (/device.* busy/.test(haystack) || /already in use/.test(haystack)) {
    return {
      cause: "device-busy",
      summary: "Another process is holding the microphone.",
      hint:
        "Close other apps that may be using the mic (Zoom, Teams, Voice Memos, browser tabs with mic access), then try again.",
      rawStderrTail: raw,
    };
  }

  if (
    /no such input device/.test(haystack) ||
    /no audio device/.test(haystack) ||
    /could not find/.test(haystack)
  ) {
    return {
      cause: "device-not-found",
      summary: "No audio input device available at the configured index.",
      hint:
        "Pass `--device <name-or-index>` to point ffmpeg at a specific input, or check that you have a working mic enabled in System Settings → Sound → Input.",
      rawStderrTail: raw,
    };
  }

  return {
    cause: "unknown",
    summary: `Recorder exited unexpectedly (code ${exitCode ?? "null"}).`,
    hint: stderrTail.trim()
      ? "Stderr from the recorder is below — paste it into an issue if the cause isn't obvious."
      : "No stderr was captured. Try running ffmpeg directly to see what's happening (see `atelier session setup`).",
    rawStderrTail: raw,
  };
}

// ============================================================
// Process helpers
// ============================================================

async function runCaptureStdout(cmd: string, args: string[]): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "inherit"] });
    const chunks: Buffer[] = [];
    child.stdout!.on("data", (c) => chunks.push(Buffer.from(c)));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

async function runDiscardStdout(cmd: string, args: string[]): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "inherit"] });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with code ${code}`));
    });
  });
}

/**
 * `which` lookup — returns the absolute path to a binary if it's on
 * PATH, otherwise null. Used by both recorder + transcriber probes.
 * Sync internally (spawnSync) but wrapped in a Promise for symmetry
 * with the rest of the file.
 */
async function whichBinary(cmd: string): Promise<string | null> {
  const which = process.platform === "win32" ? "where" : "which";
  const res = spawnSync(which, [cmd], { encoding: "utf8" });
  if (res.status !== 0) return null;
  const first = (res.stdout ?? "").split(/\r?\n/).find((l) => l.trim().length > 0);
  return first ? first.trim() : null;
}

/**
 * Public boolean version — used by the audio-setup wizard to decide
 * whether a configured recorder/transcriber is reachable right now.
 */
export async function binaryOnPath(cmd: string): Promise<boolean> {
  return (await whichBinary(cmd)) !== null;
}

/**
 * Public absolute-path version. Returns the binary's location or
 * null when it isn't on PATH. Used when atelier needs to print the
 * actual path it'll spawn (instead of a bare name) — e.g. the
 * sox→ffmpeg auto-upgrade in `session record --chunk`.
 */
export async function resolveBinary(cmd: string): Promise<string | null> {
  return await whichBinary(cmd);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
