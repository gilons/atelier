import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  requireWorkspaceRoot,
  startSession,
  appendToSession,
  appendChunkTranscript,
  endSession,
  loadSession,
  listSessions,
  listSessionChunks,
  markChunkConsumed,
  removeSession,
  listItems,
  loadAudioConfig,
  workspacePaths,
  SessionNotFoundError,
  SessionAlreadyExistsError,
  NotInsideWorkspaceError,
} from "@atelier/core";
import type { Command } from "../command.js";
import { ui } from "../ui.js";
import {
  detectRecorder,
  detectTranscriber,
  startRecording,
  binaryOnPath,
  resolveBinary,
  measureAudioLevel,
  diagnoseRecorderExit,
  listAudioInputs,
  pickDefaultAudioInput,
  isLikelyVirtualDevice,
  detectSystemAudioSource,
  SILENT_AUDIO_THRESHOLD_DB,
  type AudioMeterFrame,
  type RecorderCrashCause,
} from "../audio.js";
import { ensureAudioReady, runAudioSetupWizard } from "../audio-setup.js";
import { PromptSession } from "../prompt.js";

/**
 * `atelier session` — record conversations and link items back to them.
 *
 * Atelier's "speaking-module" surface. The agent (Claude voice mode,
 * Otter, Whisper sidecar, a phone pipeline) does the actual
 * transcription; this command tree captures the session boundary,
 * stores the transcript chunks the agent appends, and lets items
 * created downstream point back via `fromSession`.
 *
 * Workflow:
 *
 *   1. `atelier session start --title "Q3 planning"`            → returns an id
 *   2. (agent transcribes live) `atelier session note <id> ...` → appends chunks
 *   3. `atelier session end <id>`                                → closes the session
 *   4. (agent extracts ideas) `atelier item add ... --from-session <id>`
 *   5. `atelier session show <id>`                               → transcript + items
 *
 * For pre-recorded conversations, `atelier session import` skips the
 * live-append cycle and creates the session + populates transcript +
 * marks it ended in one call.
 *
 * For native-mic capture, `atelier session record --title "..."` starts
 * a session, spawns `sox` or `ffmpeg` to record from the default audio
 * device, and on Ctrl-C runs the configured transcriber
 * ($ATELIER_TRANSCRIBER or auto-detected `whisper`) to append the
 * transcript before closing the session.
 */

function isAgentMode(): boolean {
  const v = (process.env.ATELIER_AGENT ?? "").trim().toLowerCase();
  if (!v) return false;
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

function parseParticipants(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const out = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return out.length > 0 ? out : undefined;
}

// ============================================================
// start
// ============================================================

const startCmd: Command = {
  name: "start",
  summary: "Open a new session (live conversation about to begin).",
  description:
    'Creates `.atelier/sessions/<id>/` with session.yaml + an empty\n' +
    'transcript.md. Returns the id so the agent can `session note <id>`\n' +
    'as it transcribes utterances live.\n\n' +
    "For pre-recorded conversations, use `atelier session import` instead\n" +
    "to create + populate + close in one call.",
  options: {
    title: { type: "string", short: "t" },
    participants: { type: "string", short: "p" },
    id: { type: "string" },
  },
  async run({ values, cwd }) {
    const title = values.title as string | undefined;
    if (!title) {
      ui.error('--title is required (e.g. --title "Q3 planning").');
      return 2;
    }
    let workspaceRoot: string;
    try {
      workspaceRoot = await requireWorkspaceRoot(cwd);
    } catch (err) {
      if (err instanceof NotInsideWorkspaceError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
    try {
      const s = await startSession(workspaceRoot, {
        title,
        participants: parseParticipants(values.participants as string | undefined),
        id: values.id as string | undefined,
      });
      ui.success(`Session ${ui.bold(s.id)} started.`);
      ui.print(
        `  ${ui.dim("Append transcript chunks with `atelier session note " + s.id + " --text \"...\"`.")}`
      );
      ui.print(
        `  ${ui.dim("Close it with `atelier session end " + s.id + "` when the conversation wraps.")}`
      );
      // Print just the id on its own line at the very end so an
      // agent driving the command can capture it cleanly via stdout
      // tail (or shell expansion).
      ui.print(s.id);
      return 0;
    } catch (err) {
      if (err instanceof SessionAlreadyExistsError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

// ============================================================
// note — append a chunk
// ============================================================

const noteCmd: Command = {
  name: "note",
  summary: "Append a transcript chunk to a session.",
  description:
    "The agent calls this with each utterance, paragraph, or batch.\n" +
    "Atelier appends verbatim — speaker labels / timestamps / formatting\n" +
    "are the agent's call.\n\n" +
    "Two ways to pass text:\n" +
    '  --text "..."     inline string\n' +
    "  --text-file PATH read content from a file (useful for large batches)\n\n" +
    "For chunked recordings, pass --chunk <name> (e.g. --chunk 0003.wav)\n" +
    "to mark that audio chunk as consumed so `session check` won't list\n" +
    "it again. The append + the mark land atomically per call.",
  positionals: ["id"],
  options: {
    text: { type: "string" },
    "text-file": { type: "string" },
    chunk: { type: "string" },
  },
  async run({ positionals, values, cwd }) {
    const id = positionals[0];
    if (!id) {
      ui.error("Usage: atelier session note <id> --text \"...\"  [--chunk <name>]");
      return 2;
    }
    const inline = values.text as string | undefined;
    const file = values["text-file"] as string | undefined;
    if (inline && file) {
      ui.error("Pass either --text or --text-file, not both.");
      return 2;
    }
    let text: string | undefined;
    if (inline) text = inline;
    else if (file) {
      try {
        text = await fs.readFile(file, "utf8");
      } catch (err) {
        ui.error(`Couldn't read --text-file: ${(err as Error).message}`);
        return 1;
      }
    }
    if (!text) {
      ui.error("--text or --text-file is required.");
      return 2;
    }

    let workspaceRoot: string;
    try {
      workspaceRoot = await requireWorkspaceRoot(cwd);
    } catch (err) {
      if (err instanceof NotInsideWorkspaceError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
    const chunkName = values.chunk as string | undefined;
    try {
      if (chunkName) {
        // Chunked-mode drain: allowed on ended sessions because the
        // audio was captured during the active period. The new core
        // helper verifies the chunk exists on disk before appending
        // so this can't be used to drop free-form notes on closed
        // sessions with a fake chunk name.
        await appendChunkTranscript(workspaceRoot, id, chunkName, text);
      } else {
        await appendToSession(workspaceRoot, id, text);
      }
      // Keep the response tiny — chatty output during a transcribing
      // loop would flood the terminal. Just a single line so the
      // agent (or human) sees the append landed.
      const tail = chunkName ? ` (chunk ${chunkName} consumed)` : "";
      ui.print(`${ui.green("·")} appended ${text.length} chars to ${ui.bold(id)}${tail}.`);
      return 0;
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      if (err instanceof Error && /is ended/.test(err.message)) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

// ============================================================
// check — agent polling endpoint for chunked recordings
// ============================================================

const checkCmd: Command = {
  name: "check",
  summary: "Poll a chunked recording for new audio chunks to transcribe.",
  description:
    "Returns the session status, the cadence the recording was started\n" +
    "at (so the agent knows how often to wake up), and the list of\n" +
    "audio chunks that haven't been marked consumed yet via\n" +
    "`atelier session note <id> --chunk <name>`. For non-chunked\n" +
    "sessions, reports status only (no chunks to drain).\n\n" +
    "Designed to be called every ~N seconds by the agent during a\n" +
    "live recording, and one final time after `status: ended` to\n" +
    "drain any chunks recorded just before stop.",
  positionals: ["id"],
  async run({ positionals, cwd }) {
    const id = positionals[0];
    if (!id) {
      ui.error("Usage: atelier session check <id>");
      return 2;
    }
    let workspaceRoot: string;
    try {
      workspaceRoot = await requireWorkspaceRoot(cwd);
    } catch (err) {
      if (err instanceof NotInsideWorkspaceError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }

    let s;
    try {
      s = await loadSession(workspaceRoot, id);
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }

    const chunks = await listSessionChunks(workspaceRoot, id);
    const pending = chunks.filter((c) => c.pending);
    const consumed = chunks.length - pending.length;

    ui.print(`${ui.dim("session:")}   ${ui.bold(s.id)} — ${s.title}`);
    ui.print(`${ui.dim("status:")}    ${s.status === "ended" ? ui.green(s.status) : ui.yellow(s.status)}`);
    if (s.chunkSeconds !== undefined) {
      ui.print(`${ui.dim("interval:")}  ${s.chunkSeconds}s per chunk`);
    }
    if (s.language) {
      const langLabel =
        s.language === "auto"
          ? `${s.language} ${ui.dim("(whisper auto-detect)")}`
          : s.language;
      ui.print(`${ui.dim("language:")}  ${langLabel}`);
    }
    ui.print(`${ui.dim("chunks:")}    ${chunks.length} total, ${consumed} consumed, ${pending.length} pending`);
    ui.blank();

    if (pending.length > 0) {
      ui.print(ui.bold("Pending chunks (transcribe these next)"));
      for (const c of pending) {
        ui.print(
          `  ${ui.cyan("·")} ${c.name.padEnd(12)}  ${formatBytes(c.bytes).padStart(8)}  ${ui.dim(c.filePath)}`
        );
      }
      ui.blank();
    }

    if (isAgentMode()) {
      printCheckFollowUp(s.id, s.status, s.chunkSeconds, pending);
    }
    return 0;
  },
};

/**
 * Tell the agent what to do next based on what session check just
 * reported. Three branches:
 *   - still recording, pending chunks  → transcribe each, then sleep
 *   - still recording, nothing pending → sleep, check again
 *   - ended, no pending                → run item-extraction
 */
function printCheckFollowUp(
  id: string,
  status: "active" | "ended",
  chunkSeconds: number | undefined,
  pending: { name: string; filePath: string }[]
): void {
  ui.print(ui.bold("Next step for the assistant"));
  if (pending.length > 0) {
    ui.print(`  Transcribe each pending chunk and mark it consumed:`);
    for (const c of pending) {
      ui.print(
        `    ${ui.cyan(`atelier session note ${id} --chunk ${c.name} --text-file <transcript.txt>`)}`
      );
    }
    ui.blank();
  }
  if (status === "active") {
    const cadence = chunkSeconds ? `~${chunkSeconds}s` : "the chunk cadence";
    ui.print(`  Then wait ${cadence} and run ${ui.cyan(`atelier session check ${id}`)} again.`);
  } else {
    if (pending.length === 0) {
      ui.print(`  Recording is done and every chunk is consumed.`);
      ui.print(
        `  Extract items from ${ui.cyan(`.atelier/sessions/${id}/transcript.md`)} and link them back:`
      );
      ui.print(
        `    ${ui.cyan(`atelier item add <source>:<itemId> --title "..." --from-session ${id}`)}`
      );
    } else {
      ui.print(
        `  Once the pending chunks above are drained, re-run ${ui.cyan(`atelier session check ${id}`)} —`
      );
      ui.print(`  it'll switch to item-extraction mode.`);
    }
  }
  ui.blank();
}

// ============================================================
// import — create + populate + end in one call
// ============================================================

const importCmd: Command = {
  name: "import",
  summary: "Create a session from an existing transcript (no live append cycle).",
  description:
    "Useful for transcripts captured outside atelier (Otter, a Slack\n" +
    "thread, a phone-call summary). Creates the session, drops the\n" +
    "transcript in, marks it ended — all atomically.",
  options: {
    title: { type: "string", short: "t" },
    participants: { type: "string", short: "p" },
    id: { type: "string" },
    "transcript-file": { type: "string" },
    "transcript-text": { type: "string" },
  },
  async run({ values, cwd }) {
    const title = values.title as string | undefined;
    if (!title) {
      ui.error('--title is required.');
      return 2;
    }
    const file = values["transcript-file"] as string | undefined;
    const inline = values["transcript-text"] as string | undefined;
    if (file && inline) {
      ui.error("Pass either --transcript-file or --transcript-text, not both.");
      return 2;
    }
    if (!file && !inline) {
      ui.error("Pass --transcript-file <path> or --transcript-text \"...\"");
      return 2;
    }
    let transcript: string;
    if (inline) transcript = inline;
    else {
      try {
        transcript = await fs.readFile(file!, "utf8");
      } catch (err) {
        ui.error(`Couldn't read --transcript-file: ${(err as Error).message}`);
        return 1;
      }
    }

    let workspaceRoot: string;
    try {
      workspaceRoot = await requireWorkspaceRoot(cwd);
    } catch (err) {
      if (err instanceof NotInsideWorkspaceError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
    try {
      const s = await startSession(workspaceRoot, {
        title,
        participants: parseParticipants(values.participants as string | undefined),
        id: values.id as string | undefined,
        transcript,
        alreadyEnded: true,
      });
      ui.success(`Imported session ${ui.bold(s.id)} (${transcript.length} chars).`);
      if (isAgentMode()) {
        printSessionEndedFollowUp(s.id, s.title);
      }
      ui.print(s.id);
      return 0;
    } catch (err) {
      if (err instanceof SessionAlreadyExistsError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

// ============================================================
// setup — first-run wizard (also re-runnable to reconfigure)
// ============================================================

const setupCmd: Command = {
  name: "setup",
  summary: "Configure or re-configure native-mic recording.",
  description:
    "Pick a recorder (sox / ffmpeg) and a transcriber (agent / whisper /\n" +
    "your own ATELIER_TRANSCRIBER command), and save the choice to\n" +
    "`.atelier/audio.yaml`. The wizard also offers to run the install\n" +
    "command for you when the package manager doesn't need sudo (brew).\n\n" +
    "Use --add-language <code> to skip the full wizard and just grab\n" +
    "the recommended whisper model for that language — useful when you\n" +
    "want to add support for a new language without changing anything else.",
  options: {
    "add-language": { type: "string" },
  },
  async run({ values, cwd }) {
    let workspaceRoot: string;
    try {
      workspaceRoot = await requireWorkspaceRoot(cwd);
    } catch (err) {
      if (err instanceof NotInsideWorkspaceError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }

    // --add-language fast path: pick the recommended model for the
    // language, download it, and update audio.yaml's whisper block.
    // No interactive wizard — safe to run from scripts.
    const addLang = (values["add-language"] as string | undefined)?.trim();
    if (addLang) {
      return await addWhisperLanguage(workspaceRoot, addLang);
    }

    if (!process.stdin.isTTY) {
      ui.error(
        "`session setup` is interactive — run it in a terminal, not from a script or pipe."
      );
      return 1;
    }
    const session = new PromptSession();
    try {
      const { ready } = await runAudioSetupWizard(
        workspaceRoot,
        session,
        (kind) => binaryOnPath(kind),
        (kind) =>
          kind === "whisper"
            ? // "whisper" covers both flavors atelier knows about:
              //   - OpenAI's Python `whisper`
              //   - whisper.cpp's `whisper-cli`
              // Probe both so users with either don't see a false negative.
              (async () =>
                (await binaryOnPath("whisper")) ||
                (await binaryOnPath("whisper-cli")))()
            : Promise.resolve(true)
      );
      if (ready) {
        ui.print(
          `  ${ui.dim("You can now run `atelier session record --title \"…\"`.")}`
        );
      }
      return 0;
    } finally {
      session.close();
    }
  },
};

/**
 * `atelier session setup --add-language <code>` — grab the recommended
 * whisper model for that language and update audio.yaml#whisper.language
 * to it. Idempotent: if the model already exists on disk, it's a
 * config-only change; otherwise it downloads. Non-interactive.
 */
async function addWhisperLanguage(
  workspaceRoot: string,
  language: string
): Promise<number> {
  // Lazy import — keeps the audio-setup ESM out of the hot path of
  // non-recording commands (session list, etc.).
  const { downloadWhisperModelForLanguage } = await import(
    "../audio-setup.js"
  );
  const { loadAudioConfig, saveAudioConfig } = await import("@atelier/core");

  ui.print(
    `  ${ui.dim("Resolving recommended whisper model for")} ${ui.bold(language)}${ui.dim("…")}`
  );
  const { path: downloaded, model } =
    await downloadWhisperModelForLanguage(language);
  if (!downloaded) {
    ui.error("Model download didn't complete — see curl output above.");
    return 1;
  }
  ui.success(`${model.file} ready at ${downloaded}.`);

  // Update audio.yaml so future recordings pick this language by default.
  const cfg = (await loadAudioConfig(workspaceRoot)) ?? {
    version: 1 as const,
    recorder: "ffmpeg" as const,
    transcriber: "whisper" as const,
  };
  cfg.whisper = {
    ...(cfg.whisper ?? {}),
    model: model.file,
    language,
  };
  await saveAudioConfig(workspaceRoot, cfg);
  ui.success(
    `Saved language=${language}, model=${model.file} to .atelier/audio.yaml.`
  );
  ui.print(
    `  ${ui.dim("Override per-recording with `atelier session record --lang <code>`.")}`
  );
  return 0;
}

// ============================================================
// record — native-mic capture
// ============================================================

const recordCmd: Command = {
  name: "record",
  summary: "Record from the default mic and (optionally) chunk for live agent polling.",
  description:
    "Spawns ffmpeg to capture audio at 16 kHz mono.\n" +
    "Atelier is always signal-only — it records and stores; a separate\n" +
    "STT tool (agent-orchestrated or atelier-inline opt-in) handles\n" +
    "transcription.\n\n" +
    "Two recording modes:\n\n" +
    "  - DEFAULT (no --chunk):  one growing recording.wav. Press Ctrl-C\n" +
    "    to stop. Atelier ends the session — transcript.md stays empty.\n" +
    "    The agent transcribes the wav later (or pass --inline-transcribe\n" +
    "    to make atelier run whisper / $ATELIER_TRANSCRIBER on the spot).\n\n" +
    "  - CHUNKED (--chunk N):   ffmpeg rotates a new wav every N seconds\n" +
    "    into .atelier/sessions/<id>/chunks/####.wav. The agent polls with\n" +
    "    `atelier session check <id>` every ~N seconds to learn about new\n" +
    "    finished chunks, transcribes each via whatever STT it has, and\n" +
    "    appends with `atelier session note <id> --chunk <name>`.\n\n" +
    "--inline-transcribe (single-file mode only, opt-in): on Ctrl-C,\n" +
    "atelier runs the configured transcriber (whisper or\n" +
    "$ATELIER_TRANSCRIBER) on the wav and appends the result before\n" +
    "ending the session. Useful for one-shot recordings without an\n" +
    "agent loop. Off by default.\n\n" +
    "System audio capture is ON by default — atelier mixes your mic\n" +
    "with what the system is playing (call audio from Zoom / Teams /\n" +
    "FaceTime / a browser tab) into a single track. Per-OS source:\n" +
    "  macOS:    ScreenCaptureKit via bundled Swift helper (no drivers,\n" +
    "            one-time Screen Recording permission prompt)\n" +
    "  Linux:    PulseAudio / PipeWire .monitor source via pactl\n" +
    "  Windows:  dshow loopback (screen-capture-recorder / VB-Cable / Stereo Mix)\n" +
    "On detection failure atelier warns + records mic only.\n" +
    "Pass --no-system-audio to record mic only with no warning.\n\n" +
    "Auto-continue (chunked mode only): if the recorder crashes because\n" +
    "the audio device changed mid-recording (default input swap, mic\n" +
    "disconnect, AirPods drop), atelier waits 2s and respawns ffmpeg,\n" +
    "continuing chunk numbering from where it left off. Up to 4 attempts.\n" +
    "Disable with --no-auto-continue if you'd rather see the crash.",
  options: {
    title: { type: "string", short: "t" },
    participants: { type: "string", short: "p" },
    id: { type: "string" },
    device: { type: "string" },
    "keep-audio": { type: "boolean" },
    chunk: { type: "string" },
    "inline-transcribe": { type: "boolean" },
    // Default ON for chunked mode: if the recorder dies because the
    // audio device changed (AirPods disconnect, default input swap,
    // USB mic unplug), atelier respawns ffmpeg and resumes chunk
    // numbering. Pass --no-auto-continue to disable.
    "no-auto-continue": { type: "boolean" },
    // Diagnostic: list available audio input devices and exit. Useful
    // for figuring out what to pass to --device when auto-pick gets
    // confused by an aggregate/virtual device on your machine.
    "list-devices": { type: "boolean" },
    // Per-recording language override for the transcriber. Falls back
    // to audio.yaml#whisper.language when unset, then to whisper-cli's
    // auto-detect. Stored in session.yaml so the agent's drain step
    // knows which language to pass downstream.
    lang: { type: "string" },
    // Mix system-audio output into the recording alongside the mic.
    // Cross-platform: ScreenCaptureKit on macOS (via the bundled Swift
    // helper, one-time permission prompt), PulseAudio .monitor on
    // Linux, dshow loopback on Windows. atelier auto-detects what's
    // available; on detection failure the recording continues with
    // mic only after a one-line warning.
    //
    // DEFAULT IS ON. Pass --no-system-audio to record mic only with
    // no warning. The legacy --system-audio flag remains a no-op
    // alias kept for back-compat with existing scripts.
    "system-audio": { type: "boolean" },
    "no-system-audio": { type: "boolean" },
  },
  async run({ values, cwd }) {
    // --list-devices short-circuit: print the avfoundation audio
    // device list and exit. Doesn't require a workspace; useful when
    // the user is figuring out what to pass to --device.
    if (values["list-devices"] === true) {
      const devices = await listAudioInputs();
      if (devices.length === 0) {
        ui.warn(
          "No audio input devices detected (or device listing isn't supported on this platform yet)."
        );
        return 1;
      }
      const auto = pickDefaultAudioInput(devices);
      ui.print(ui.bold("Audio input devices"));
      for (const d of devices) {
        const marker =
          auto && d.index === auto.index ? ui.green(" ← atelier auto-pick") : "";
        const virtual = isLikelyVirtualDevice(d.name)
          ? ui.dim(" [virtual]")
          : "";
        ui.print(`  [${d.index}] ${d.name}${virtual}${marker}`);
      }
      ui.blank();
      ui.print(
        `  ${ui.dim("Pin a specific one with `--device \"<name>\"` (atelier matches by name).")}`
      );
      return 0;
    }

    const title = values.title as string | undefined;
    if (!title) {
      ui.error('--title is required (e.g. --title "Q3 planning").');
      return 2;
    }

    // Parse --chunk first so we can fail fast on a bad value before
    // we touch the workspace.
    let chunkSeconds: number | undefined;
    if (values.chunk !== undefined) {
      const n = Number(values.chunk);
      if (!Number.isFinite(n) || n <= 0) {
        ui.error(`--chunk must be a positive number of seconds (got "${values.chunk}").`);
        return 2;
      }
      chunkSeconds = n;
    }
    let workspaceRoot: string;
    try {
      workspaceRoot = await requireWorkspaceRoot(cwd);
    } catch (err) {
      if (err instanceof NotInsideWorkspaceError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }

    // Resolve inline-transcribe behavior. atelier is signal-only by
    // default in EVERY mode — chunked or single-file. The audio.yaml
    // `transcriber` field tells atelier *which tool to install /
    // recommend* (so the agent's polling loop knows what to reach for),
    // it never triggers atelier-side auto-transcription on Ctrl-C.
    //
    // `--inline-transcribe` is the explicit one-shot opt-in: "I don't
    // have an agent loop, run whisper now and append the transcript
    // before ending the session." `--no-inline-transcribe` is now a
    // no-op alias for the default; kept for back-compat with scripts.
    const cfg = await loadAudioConfig(workspaceRoot);
    const inlineFlag = values["inline-transcribe"];
    const inlineTranscribe = inlineFlag === true;

    const setup = await ensureAudioReady(workspaceRoot, {
      interactive: Boolean(process.stdin.isTTY) && !isAgentMode(),
      recorderAvailable: (kind) => binaryOnPath(kind),
      transcriberAvailable: (kind) =>
        kind === "whisper" ? binaryOnPath("whisper") : Promise.resolve(true),
    });
    if (!setup.ready) return 1;

    let recorder = await detectRecorder();
    if (!recorder) {
      ui.error("Setup said the recorder was ready, but it isn't on PATH right now.");
      return 1;
    }
    // detectRecorder is ffmpeg-only now — the legacy sox→ffmpeg
    // auto-upgrade branch for chunked mode is no longer needed.
    // void to avoid a "declared but never read" warning on resolveBinary
    // in case TypeScript flags it as unused after this cleanup.
    void resolveBinary;
    // Resolve the audio input device. Every record start re-enumerates
    // avfoundation's device list and re-picks — no stale state from
    // prior sessions, no surprise virtual loopback devices at index 0.
    //
    // User can pin a specific device with --device "<name>" (or :N for
    // raw index); otherwise pickDefaultAudioInput filters known virtuals
    // (Voxal, BlackHole, Teams Audio, …) and prefers built-in mics.
    let resolvedDevice: string | undefined =
      (values.device as string | undefined) ?? undefined;
    let chosenDeviceLabel = "";
    if (recorder.kind === "ffmpeg" && process.platform === "darwin") {
      if (resolvedDevice) {
        chosenDeviceLabel = `${resolvedDevice} (user-pinned via --device)`;
      } else {
        const devices = await listAudioInputs();
        const pick = pickDefaultAudioInput(devices);
        if (pick) {
          resolvedDevice = `:${pick.name}`;
          const skipped = devices.filter(
            (d) => d.index !== pick.index && isLikelyVirtualDevice(d.name)
          );
          const skippedSuffix = skipped.length
            ? ` (skipped virtual: ${skipped.map((d) => d.name).join(", ")})`
            : "";
          chosenDeviceLabel = `${pick.name}${skippedSuffix}`;
        } else {
          // Couldn't enumerate (no ffmpeg, or empty list) — fall through
          // and let avfoundation pick :0.
          chosenDeviceLabel = ":0 (auto, ffmpeg device-list unavailable)";
        }
      }
    }

    // (Aggregate-device probing + macOS routing pre-flight removed
    // alongside the BlackHole / Multi-Output Device path. SCK helper
    // doesn't need either — it captures system audio via Apple's API
    // without rerouting macOS's default output.)

    // Resolve the system-audio capture source if --system-audio is set.
    // Cross-platform: BlackHole on macOS, PulseAudio .monitor on Linux,
    // screen-capture-recorder / Stereo Mix / VB-Cable on Windows. When
    // nothing's installed, surface the per-OS setup hint and bail out
    // — recording won't be what the user asked for (call audio missing)
    // so silently degrading to mic-only would be worse than failing.
    // System-audio capture defaults to ON. Two ways to opt out:
    //   --no-system-audio: explicit opt-out, silent (no warning)
    //   user-explicit failure case (--system-audio + setup broken):
    //     was historically a hard error; now also degrades gracefully
    //     so a misconfigured machine never blocks the user's recording.
    //     If they really want hard failure, they read the warning.
    const wantSystemAudio = values["no-system-audio"] !== true;
    let systemAudioInput: string[] | undefined;
    let systemAudioHelper: { cmd: string; args: string[] } | undefined;
    let systemAudioLabel = "";
    if (wantSystemAudio) {
      const sys = await detectSystemAudioSource();
      if (sys.available) {
        systemAudioInput = [...sys.ffmpegInput];
        systemAudioHelper = sys.helperCommand;
        systemAudioLabel = sys.label;
      } else {
        // Default-on but setup isn't available — degrade to mic-only
        // with a one-line warning + the setup hint, so the user
        // knows the option exists and how to enable it.
        ui.warn(
          "System audio capture unavailable — recording mic only. Pass --no-system-audio to silence this warning."
        );
        if (sys.setupHint.trim()) {
          for (const line of sys.setupHint.split("\n")) ui.print(`  ${ui.dim(line)}`);
        }
        ui.blank();
      }
    }

    // Resolve the language preference for THIS recording. Precedence:
    // explicit --lang flag → audio.yaml#whisper.language → "" (no
    // opinion → whisper-cli auto-detects on multilingual models,
    // English-only models ignore the flag).
    const sessionLanguage =
      (values.lang as string | undefined)?.trim() ||
      cfg?.whisper?.language ||
      undefined;

    const transcriber = inlineTranscribe
      ? await detectTranscriber(process.env, undefined, {
          modelFile: cfg?.whisper?.model,
          language: sessionLanguage,
        })
      : null;

    // Create the session up front so the recording lives in its folder.
    let session;
    try {
      session = await startSession(workspaceRoot, {
        title,
        participants: parseParticipants(values.participants as string | undefined),
        id: values.id as string | undefined,
        chunkSeconds,
        language: sessionLanguage,
      });
    } catch (err) {
      if (err instanceof SessionAlreadyExistsError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }

    const sessionDir = path.join(workspacePaths(workspaceRoot).sessions, session.id);
    const chunked = chunkSeconds !== undefined;
    let recorderTarget: string;
    if (chunked) {
      const chunksDir = path.join(sessionDir, "chunks");
      await fs.mkdir(chunksDir, { recursive: true });
      // %04d → 0001, 0002, … — ffmpeg fills in the segment number.
      recorderTarget = path.join(chunksDir, "%04d.wav");
    } else {
      recorderTarget = path.join(sessionDir, "recording.wav");
    }

    ui.success(`Session ${ui.bold(session.id)} started.`);
    ui.print(`  ${ui.dim("recorder:")}    ${recorder.kind} (${recorder.binary})`);
    if (chosenDeviceLabel) {
      ui.print(`  ${ui.dim("input:")}       ${chosenDeviceLabel}`);
    }
    if (systemAudioLabel) {
      ui.print(
        `  ${ui.dim("system audio:")} ${systemAudioLabel} ${ui.dim("(mixed with mic via amix)")}`
      );
    }
    if (chunked) {
      ui.print(`  ${ui.dim("mode:")}        chunked (${chunkSeconds}s per segment)`);
      ui.print(`  ${ui.dim("chunks dir:")}  ${path.dirname(recorderTarget)}`);
    } else {
      ui.print(`  ${ui.dim("wav file:")}    ${recorderTarget}`);
    }
    if (inlineTranscribe) {
      ui.print(
        `  ${ui.dim("transcriber:")} ${
          transcriber ? transcriber.label : ui.yellow("none on PATH — wav will stay for the agent")
        }`
      );
    } else {
      ui.print(
        `  ${ui.dim("transcriber:")} ${ui.dim("(agent — atelier signals via session check)")}`
      );
    }
    if (sessionLanguage) {
      const label =
        sessionLanguage === "auto"
          ? `${sessionLanguage} ${ui.dim("(whisper auto-detect)")}`
          : sessionLanguage;
      ui.print(`  ${ui.dim("language:")}    ${label}`);
    }
    ui.blank();
    ui.print(`  ${ui.bold("Recording… press Ctrl-C to stop.")}`);

    // In chunked + agent mode, tell the agent the polling cadence
    // up front so it can schedule itself before chunks start landing.
    if (chunked && isAgentMode()) {
      printChunkedRecordingFollowUp(session.id, chunkSeconds!);
    }

    // Live VU meter: only when stdout is a real terminal AND we're not
    // in agent mode (the meter overwrites its own line via \r — useless
    // and noisy in piped/log output). sox doesn't support the dual-output
    // we need; startRecording will just leave levels null there.
    const meterOn =
      Boolean(process.stdout.isTTY) &&
      !isAgentMode() &&
      recorder.kind === "ffmpeg";

    // Auto-continue config. Chunked mode only — single-file mode can't
    // resume a wav cleanly (the RIFF header byte-count is finalised on
    // close), so a crash there is terminal. Disable via --no-auto-continue.
    const autoContinue =
      chunked && values["no-auto-continue"] !== true;
    const MAX_ATTEMPTS = 4;
    const RESUME_DELAY_MS = 2000;

    // The signal handler points at "the current attempt's handle". When
    // the loop respawns, we swap the pointer rather than re-register
    // listeners every iteration (cleaner cleanup, avoids leaking).
    let currentHandle: ReturnType<typeof startRecording> | null = null;
    let stopping = false;
    const onSignal = () => {
      if (stopping) return;
      stopping = true;
      if (meterOn) clearMeterLine();
      ui.blank();
      ui.print(`  ${ui.dim("Stopping recorder…")}`);
      if (currentHandle) void currentHandle.stop();
    };
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    let crashed: { exitCode: number | null; stderrTail: string } | null = null;
    let attempts = 0;
    let resumes = 0;
    try {
      while (attempts < MAX_ATTEMPTS) {
        attempts++;
        // Pick up chunk numbering from where we left off so a respawn
        // doesn't clobber 0000.wav. Existing chunks on disk = the
        // next free index.
        const existingChunks = chunked
          ? (await listSessionChunks(workspaceRoot, session.id)).length
          : 0;
        const handle = startRecording(recorder, recorderTarget, {
          device: resolvedDevice,
          chunkSeconds,
          chunkStartNumber: existingChunks,
          meter: meterOn,
          systemAudioInput,
          systemAudioHelper,
          // Dual mic/sys meter whenever a system-audio source is in
          // play — left = mic, right = system. Falls back to single
          // mono bar for plain mic-only recordings.
          meterChannels: systemAudioInput ? 2 : 1,
        });
        currentHandle = handle;

        // Stuck-device watchdog: when ffmpeg keeps producing silence
        // forever (because the OS routed the underlying device to a
        // phantom handle), the level meter sees -90 dB but ffmpeg
        // never crashes. We surface this to the user at 10s and
        // force-respawn at 60s.
        let stuckDetected = false;
        const meterTask =
          handle.levels !== null
            ? renderMeter(handle.levels, {
                onStuckHint: () => {
                  if (meterOn) clearMeterLine();
                  ui.warn(
                    "No audio detected after 10s — your input device may be wrong or disconnected."
                  );
                  ui.print(
                    `  ${ui.dim("Check System Settings → Sound → Input. atelier will restart the recorder")}`
                  );
                  ui.print(
                    `  ${ui.dim("automatically at 60s if silence continues. Ctrl-C to stop now.")}`
                  );
                  ui.blank();
                },
                onStuckTimeout: () => {
                  // The meter loop already returned at this point; we just
                  // mark the flag and tell ffmpeg to wrap up. Treat the
                  // resulting exit as a device-stuck crash so auto-continue
                  // takes over (which re-queries avfoundation for the
                  // CURRENT default device — usually fixing the issue).
                  stuckDetected = true;
                  ui.warn(
                    "Still no audio at 60s — restarting recorder to pick up the current input device…"
                  );
                  void handle.stop();
                },
              })
            : Promise.resolve();

        let attemptCrash:
          | { exitCode: number | null; stderrTail: string; cause?: RecorderCrashCause }
          | null = null;
        try {
          await handle.exited;
          // Graceful exit — but was it user-initiated, or did the
          // stuck-device watchdog stop the recorder for us?
          if (stuckDetected) {
            attemptCrash = {
              exitCode: (handle.child.exitCode ?? null) as number | null,
              stderrTail: handle.stderrTail(),
              cause: "device-stuck",
            };
          } else {
            crashed = null;
            break;
          }
        } catch {
          if (meterOn) clearMeterLine();
          attemptCrash = {
            exitCode: (handle.child.exitCode ?? null) as number | null,
            stderrTail: handle.stderrTail(),
          };
        } finally {
          await meterTask.catch(() => {});
        }

        // Decide whether to auto-continue. device-changed (crash) AND
        // device-stuck (watchdog-triggered) both qualify — they share
        // the same fix: respawn ffmpeg, let avfoundation re-init.
        const cause =
          attemptCrash.cause ??
          diagnoseRecorderExit(attemptCrash.stderrTail, attemptCrash.exitCode).cause;
        const canRetry =
          autoContinue &&
          (cause === "device-changed" || cause === "device-stuck") &&
          !stopping &&
          attempts < MAX_ATTEMPTS;
        if (!canRetry) {
          crashed = attemptCrash;
          break;
        }

        resumes++;
        ui.blank();
        ui.warn(
          cause === "device-stuck"
            ? `Recorder was stuck on a silent device (attempt ${attempts}/${MAX_ATTEMPTS}).`
            : `Audio device disconnected (attempt ${attempts}/${MAX_ATTEMPTS}).`
        );
        ui.print(
          `  ${ui.dim(`Waiting ${RESUME_DELAY_MS / 1000}s for the OS to settle, then resuming…`)}`
        );
        await new Promise<void>((r) => setTimeout(r, RESUME_DELAY_MS));
        if (stopping) {
          // User Ctrl-C'd during the wait — respect it.
          crashed = attemptCrash;
          break;
        }
        const nextStart = chunked
          ? (await listSessionChunks(workspaceRoot, session.id)).length
          : 0;
        ui.print(
          `  ${ui.dim(`Resuming with ${recorder.kind} from chunk ${String(nextStart).padStart(4, "0")}.wav…`)}`
        );
        ui.blank();
        ui.print(`  ${ui.bold("Recording (resumed)… press Ctrl-C to stop.")}`);
        // Fall through — next iteration spawns a fresh handle.
      }
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
      if (meterOn) clearMeterLine();
      currentHandle = null;
    }

    // If we crashed (and didn't recover via auto-continue), surface
    // the diagnosis BEFORE post-stop bookkeeping so the user knows
    // why before seeing chunk counts.
    if (crashed) {
      const diag = diagnoseRecorderExit(crashed.stderrTail, crashed.exitCode);
      ui.error(diag.summary);
      if (diag.hint) {
        for (const line of diag.hint.split("\n")) {
          ui.print(`  ${line}`);
        }
      }
      if (crashed.stderrTail.trim() && diag.cause === "unknown") {
        ui.blank();
        ui.print(`  ${ui.dim("ffmpeg stderr (last lines):")}`);
        const tailLines = crashed.stderrTail.trim().split("\n").slice(-10);
        for (const line of tailLines) ui.print(`    ${ui.dim(line)}`);
      }
      ui.blank();
    } else if (resumes > 0) {
      ui.blank();
      ui.success(
        `Auto-continue recovered ${resumes} device disconnect(s) during this session.`
      );
    }

    // -----------
    // Post-stop bookkeeping
    // -----------
    // Track the wavs we want to silence-check below. Single-file mode
    // has one; chunked mode has whatever the recorder produced.
    let wavsForLevelCheck: string[] = [];
    // Did we crash before capturing anything usable? If so we'll bail
    // with exit 1 after closing the session; if we crashed but have
    // material on disk we treat it as a graceful early stop.
    let crashWithNothingUsable = false;
    if (chunked) {
      // Report what the recorder produced — gives the agent (or human)
      // a clean number to compare against `session check` output.
      const chunks = await listSessionChunks(workspaceRoot, session.id);
      const usable = chunks.filter((c) => c.bytes >= 1024);
      if (crashed && usable.length === 0) {
        crashWithNothingUsable = true;
      } else if (crashed) {
        ui.warn(
          `Recording stopped after ${usable.length} usable chunk(s) — kept them; transcribe via \`session check\`.`
        );
      } else {
        ui.success(`Captured ${chunks.length} chunk(s).`);
      }
      wavsForLevelCheck = usable.map((c) => c.filePath);
    } else {
      let wavBytes = 0;
      try {
        wavBytes = (await fs.stat(recorderTarget)).size;
      } catch {
        /* missing */
      }
      if (wavBytes < 1024) {
        ui.warn(`Recording is empty or near-empty (${wavBytes} bytes).`);
        if (crashed) crashWithNothingUsable = true;
      } else if (crashed) {
        ui.warn(
          `Recording stopped early — kept ${formatBytes(wavBytes)} of audio for transcription.`
        );
        wavsForLevelCheck = [recorderTarget];
      } else {
        ui.success(`Captured ${formatBytes(wavBytes)}.`);
        wavsForLevelCheck = [recorderTarget];
      }

      if (inlineTranscribe && transcriber && wavBytes >= 1024) {
        ui.print(`  ${ui.dim("Transcribing with " + transcriber.label + "…")}`);
        try {
          const transcript = await transcriber.transcribe(recorderTarget);
          const text = transcript.trim();
          if (text) {
            await appendToSession(workspaceRoot, session.id, text);
            ui.success(`Appended ${text.length} chars of transcript.`);
          } else {
            ui.warn("Transcriber returned empty text — wav kept for the agent to retry.");
          }
        } catch (err) {
          ui.warn(`Transcription failed: ${(err as Error).message}`);
          ui.print(
            `  ${ui.dim("The wav is still at " + recorderTarget + "; the agent can transcribe it.")}`
          );
        }
      }

      if (values["keep-audio"] === false) {
        try {
          await fs.unlink(recorderTarget);
        } catch {
          /* already gone */
        }
      }
    }

    // Silence guard — if the bulk of what we captured is below the
    // speech threshold, the user almost certainly has a mic-permission
    // or input-device issue. Warn loudly BEFORE the agent follow-up so
    // they don't waste time transcribing 30 minutes of [BLANK_AUDIO].
    //
    // "Bulk" rather than "every" so a 20-min recording with one ambient
    // noise burst still gets flagged. 75% silent → speech happened in
    // <25% of the recording, which is almost never what the user wanted.
    if (wavsForLevelCheck.length > 0) {
      const levels = await Promise.all(
        wavsForLevelCheck.map((p) => measureAudioLevel(p))
      );
      const measured = levels.filter((l): l is NonNullable<typeof l> => l !== null);
      const silentCount = measured.filter(
        (l) => l.mean < SILENT_AUDIO_THRESHOLD_DB
      ).length;
      const silentRatio = measured.length ? silentCount / measured.length : 0;
      const mostlySilent = measured.length > 0 && silentRatio >= 0.75;
      if (mostlySilent) {
        ui.blank();
        const detail =
          measured.length === 1
            ? `mean ${measured[0].mean.toFixed(1)} dB`
            : `${silentCount}/${measured.length} files below ${SILENT_AUDIO_THRESHOLD_DB} dB`;
        ui.warn(`Captured audio is effectively silent (${detail}).`);
        ui.print(
          `  ${ui.dim("Speech sits around -25 dB; -90 dB ≈ digital silence. ffmpeg got")}`
        );
        ui.print(
          `  ${ui.dim("no real audio from your input device. Most common cause on macOS:")}`
        );
        ui.print(
          `    ${ui.cyan("System Settings → Privacy & Security → Microphone")}`
        );
        ui.print(
          `  ${ui.dim("→ enable your terminal app (Terminal / iTerm / Warp / VS Code), then")}`
        );
        ui.print(`  ${ui.dim("FULLY QUIT + relaunch it (toggle alone isn't enough).")}`);
        ui.blank();
        ui.print(`  ${ui.dim("Verify with:")}`);
        ui.print(
          `    ${ui.cyan('ffmpeg -y -f avfoundation -i :0 -t 5 -ar 16000 -ac 1 /tmp/mic.wav && \\\n      ffmpeg -i /tmp/mic.wav -af volumedetect -f null - 2>&1 | grep volume')}`
        );
        ui.print(`  ${ui.dim("Expected when working: mean_volume around -25 dB while you talk.")}`);
        ui.blank();
      }
    }

    try {
      const ended = await endSession(workspaceRoot, session.id);
      ui.success(`Session ${ui.bold(ended.id)} ended at ${ended.endedAt}.`);
    } catch (err) {
      ui.warn(`Couldn't end session: ${(err as Error).message}`);
    }
    if (isAgentMode()) {
      if (chunked) {
        // Chunked sessions get a drain-then-extract follow-up so the
        // agent finishes off remaining chunks before moving to items.
        printChunkedSessionEndedFollowUp(session.id, title);
      } else {
        printSessionEndedFollowUp(session.id, title, {
          wavPath:
            inlineTranscribe && transcriber ? undefined : recorderTarget,
        });
      }
    }
    ui.print(session.id);
    // Crashed and didn't capture anything usable → exit 1 so scripts /
    // CI catch the failure. Crashed but kept material on disk → exit 0;
    // the session is closed and the agent can transcribe what's there.
    return crashWithNothingUsable ? 1 : 0;
  },
};

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

// ============================================================
// Live VU meter renderer
// ============================================================

/**
 * Number of bar segments in the meter. 24 fits comfortably on a
 * standard terminal without wrapping when combined with timecode
 * and a dB readout.
 */
const METER_BAR_WIDTH = 24;
/** Lowest dB we visualise — anything quieter pegs the empty end of the bar. */
const METER_FLOOR_DB = -60;
/** Threshold (same as SILENT_AUDIO_THRESHOLD_DB) — peakDb above this counts as "real audio." */
const METER_AUDIO_HEARD_DB = -75;
/** Time of all-silence before we print the stuck-device hint to the user. */
const STUCK_HINT_AT_MS = 10_000;
/** Time of all-silence before we force a recorder restart (auto-continue takeover). */
const STUCK_RESTART_AT_MS = 60_000;

/**
 * Consume an audio-meter iterable and render a live bar+dB readout to
 * stdout, updating the same line via \r. Stops when the iterable ends
 * (ffmpeg exited) or throws. Safe to call when stdout isn't a TTY —
 * the caller decides whether to invoke this; we don't second-guess.
 *
 * Also watches for the "phantom device" case: when ffmpeg keeps running
 * after the user disconnects their input device, avfoundation may
 * silently feed it zeros forever. We surface this with a hint after
 * 10s of all-silence and a forced restart after 60s — both via the
 * callbacks the caller passes in.
 */
async function renderMeter(
  frames: AsyncIterable<AudioMeterFrame>,
  callbacks?: {
    /** Fires once when 10s have elapsed without ever hearing audio above the speech threshold. */
    onStuckHint?: () => void;
    /** Fires once when 60s have elapsed without ever hearing audio — signals "give up and respawn ffmpeg." */
    onStuckTimeout?: () => void;
  }
): Promise<void> {
  let everHeardAudio = false;
  let hintFired = false;
  let timeoutFired = false;
  for await (const frame of frames) {
    if (frame.peakDb > METER_AUDIO_HEARD_DB) {
      everHeardAudio = true;
    }
    const time = formatElapsed(frame.elapsedMs);
    const dot = ui.red("●");
    const channels = frame.peakDbs?.length ?? 1;
    if (channels >= 2) {
      // Dual-bar layout: mic on the left (channel 0), system audio
      // on the right (channel 1). Narrower bars per channel to keep
      // the whole line within an 80-char terminal.
      const micBar = barFor(frame.peakDbs[0], DUAL_BAR_WIDTH);
      const sysBar = barFor(frame.peakDbs[1], DUAL_BAR_WIDTH);
      const micDb = formatDb(frame.peakDbs[0]);
      const sysDb = formatDb(frame.peakDbs[1]);
      process.stdout.write(
        `\r  ${dot} ${time}  ${ui.dim("mic")} ${micBar} ${micDb}    ${ui.dim("sys")} ${sysBar} ${sysDb}   `
      );
    } else {
      const bar = barFor(frame.peakDb);
      // The peakDb readout: pad to a stable width so the line doesn't
      // jiggle as the number changes from "-5.2" to "-21.3" to "-90".
      const dbStr = formatDb(frame.peakDb);
      process.stdout.write(`\r  ${dot} ${time}  ${bar}  ${dbStr}   `);
    }

    if (!everHeardAudio) {
      if (!hintFired && frame.elapsedMs >= STUCK_HINT_AT_MS) {
        hintFired = true;
        callbacks?.onStuckHint?.();
      }
      if (!timeoutFired && frame.elapsedMs >= STUCK_RESTART_AT_MS) {
        timeoutFired = true;
        callbacks?.onStuckTimeout?.();
        // Stop consuming frames — the recorder will be killed by the
        // callback and we don't want to keep rendering during shutdown.
        return;
      }
    }
  }
}

/** Narrower bar per channel in dual mode so two bars fit on one line. */
const DUAL_BAR_WIDTH = 14;

/**
 * Pad the dB readout to a stable width so the line doesn't jiggle as
 * the number changes from "-5.2" to "-21.3" to "-90".
 */
function formatDb(db: number): string {
  return (db <= -90 ? "  -∞" : db.toFixed(1).padStart(5)) + " dB";
}

/**
 * Clear the meter's current line so the next ui.print/ui.warn lands
 * on a fresh row instead of mid-bar. Called from the SIGINT handler
 * and the finally block in recordCmd.
 */
function clearMeterLine(): void {
  // \r then erase-to-end-of-line (CSI K). Works on every terminal
  // we care about (macOS Terminal, iTerm, kitty, Linux xterm, Warp,
  // Windows Terminal). Falls back gracefully to a long blank line
  // on the unlikely chance the terminal doesn't grok the escape.
  process.stdout.write("\r\x1b[K");
}

/** Format ms-since-start as `mm:ss`. Keeps the meter narrow. */
function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

/**
 * Build the bar string for a given dB level. Map [METER_FLOOR_DB, 0]
 * → [0, METER_BAR_WIDTH] and colour the result green / yellow / red
 * based on where the level sits:
 *   - quieter than -30 dB → yellow (might be too quiet for STT)
 *   - -30 to -6 dB        → green  (healthy speech range)
 *   - -6 to 0 dB          → red    (close to clipping)
 *
 * The "fill" character is a solid block; the "empty" is a thin dot
 * so an empty bar still has a visible frame.
 */
function barFor(db: number, width: number = METER_BAR_WIDTH): string {
  const clamped = Math.max(METER_FLOOR_DB, Math.min(0, db));
  const ratio = (clamped - METER_FLOOR_DB) / -METER_FLOOR_DB;
  const filled = Math.round(ratio * width);
  const fill = "█".repeat(filled);
  const empty = "·".repeat(width - filled);
  // Coloring runs by zone — the LOUDEST zone wins, so a peak above -6
  // shows red even if part of the bar would be green. This makes
  // clipping risk visually obvious.
  if (db > -6) return ui.red(fill) + ui.dim(empty);
  if (db > -30) return ui.green(fill) + ui.dim(empty);
  return ui.yellow(fill) + ui.dim(empty);
}

/**
 * Follow-up printed when a chunked recording STARTS — tells the
 * agent the polling cadence so it can schedule itself before chunks
 * begin landing. Without this, the agent might wake up too early
 * (no chunks yet, wasted turn) or too late (chunks pile up).
 */
function printChunkedRecordingFollowUp(id: string, seconds: number): void {
  ui.blank();
  ui.print(ui.bold("Next step for the assistant"));
  ui.print(
    `  Recording is chunked at ${ui.cyan(seconds + "s")} per segment. Wake yourself`
  );
  ui.print(`  up every ~${seconds}s and run:`);
  ui.print(`    ${ui.cyan(`atelier session check ${id}`)}`);
  ui.print(`  to learn about new finished chunks. For each unconsumed chunk:`);
  ui.print(`    1. Transcribe the wav with whatever STT you've got.`);
  ui.print(
    `    2. Append the transcript + mark the chunk consumed atomically:`
  );
  ui.print(
    `         ${ui.cyan(`atelier session note ${id} --chunk <name> --text-file <transcript.txt>`)}`
  );
  ui.print(
    `  Keep checking until \`session check\` reports status=ended and zero pending.`
  );
  ui.blank();
}

/**
 * Follow-up printed when a chunked recording ENDS. The agent might
 * still have chunks to drain — make that explicit before the
 * item-extraction step.
 */
function printChunkedSessionEndedFollowUp(id: string, title: string): void {
  ui.blank();
  ui.print(ui.bold("Next step for the assistant"));
  ui.print(`  Recording stopped. To finish this session:`);
  ui.print(`    1. Run ${ui.cyan(`atelier session check ${id}`)} once more.`);
  ui.print(
    `    2. For any chunks still listed pending, transcribe + note them:`
  );
  ui.print(
    `         ${ui.cyan(`atelier session note ${id} --chunk <name> --text-file <transcript.txt>`)}`
  );
  ui.print(`    3. When pending hits zero, read the assembled transcript at`);
  ui.print(
    `       ${ui.cyan(`.atelier/sessions/${id}/transcript.md`)} and extract items via:`
  );
  ui.print(
    `         ${ui.cyan(`atelier item add <source>:<itemId> --title "..." --from-session ${id}`)}`
  );
  ui.blank();
  ui.print(`  Session: ${ui.dim(title)} (id ${ui.bold(id)})`);
  ui.blank();
}

// ============================================================
// end
// ============================================================

const endCmd: Command = {
  name: "end",
  summary: "Mark a session as ended (no more notes appended).",
  positionals: ["id"],
  async run({ positionals, cwd }) {
    const id = positionals[0];
    if (!id) {
      ui.error("Usage: atelier session end <id>");
      return 2;
    }
    let workspaceRoot: string;
    try {
      workspaceRoot = await requireWorkspaceRoot(cwd);
    } catch (err) {
      if (err instanceof NotInsideWorkspaceError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
    try {
      const s = await endSession(workspaceRoot, id);
      ui.success(`Session ${ui.bold(s.id)} ended at ${s.endedAt}.`);
      if (isAgentMode()) {
        printSessionEndedFollowUp(s.id, s.title);
      }
      return 0;
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

/**
 * Next-step block printed after a session closes (in agent mode).
 *
 * Tells the agent to:
 *   1. Read the transcript.
 *   2. Extract ideas → propose items (categorized as docs/design/pm).
 *   3. For each idea, suggest `atelier item add ... --from-session <id>`
 *      so the new item points back at the conversation.
 *   4. Surface action items to the user before committing.
 */
function printSessionEndedFollowUp(
  id: string,
  title: string,
  opts: { wavPath?: string } = {}
): void {
  ui.blank();
  ui.print(ui.bold("Next step for the assistant"));
  if (opts.wavPath) {
    // Recorder ran but no transcriber resolved — the agent needs to
    // transcribe the wav itself before the item-extraction step.
    ui.print(
      `  1. Transcribe the audio at ${ui.cyan(opts.wavPath)} using whichever`
    );
    ui.print(
      `     STT integration is wired up (Whisper sidecar, ASR API, etc.) and`
    );
    ui.print(`     append the result with:`);
    ui.print(
      `       ${ui.cyan(`atelier session note ${id} --text-file <transcript.txt>`)}`
    );
    ui.blank();
    ui.print(`  2. Then extract items from the transcript:`);
  } else {
    ui.print(`  1. Extract items from the transcript:`);
  }
  ui.print(
    `     Read the transcript at ${ui.cyan(`.atelier/sessions/${id}/transcript.md`)} and propose`
  );
  ui.print(`     items for the user to confirm. For each idea, decide:`);
  ui.print(`    - which category fits: ${ui.dim("docs | design | pm")}`);
  ui.print(`    - which registered source under that category to attach to`);
  ui.print(`      (run ${ui.dim("`atelier source list`")} if you're not sure)`);
  ui.print(`    - what classification ("ticket", "frame", "prd", …) the source's tool uses`);
  ui.blank();
  ui.print("  Confirm each idea with the user, then create the item linking back");
  ui.print("  to this session so the conversation stays discoverable:");
  ui.print(
    `    ${ui.cyan(`atelier item add <source>:<itemId> --title "..." --link <url> \\`)}`
  );
  ui.print(`      ${ui.cyan(`--from-session ${id} --body-text "<summary>"`)}`);
  ui.blank();
  ui.print("  For design-category sources, you can also drive the user's design");
  ui.print(`  tool (Figma, Excalidraw, …) directly via its MCP / browser ext to`);
  ui.print(`  scaffold the frame before recording the atelier item.`);
  ui.blank();
  ui.print(`  Session: ${ui.dim(title)} (id ${ui.bold(id)})`);
  ui.blank();
}

// ============================================================
// list
// ============================================================

const listCmd: Command = {
  name: "list",
  summary: "List recorded sessions (newest first).",
  async run({ cwd }) {
    let workspaceRoot: string;
    try {
      workspaceRoot = await requireWorkspaceRoot(cwd);
    } catch (err) {
      if (err instanceof NotInsideWorkspaceError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
    const { sessions, errors } = await listSessions(workspaceRoot);
    if (sessions.length === 0 && errors.length === 0) {
      ui.info("No sessions recorded yet.");
      ui.print(
        `  ${ui.dim('Start one with `atelier session start --title "..."`.')}`
      );
      return 0;
    }
    if (sessions.length > 0) {
      const idWidth = Math.max("ID".length, ...sessions.map((s) => s.session.id.length));
      const titleWidth = Math.max(
        "TITLE".length,
        ...sessions.map((s) => s.session.title.length)
      );
      ui.print(
        `    ${ui.dim("ID".padEnd(idWidth))}  ${ui.dim("TITLE".padEnd(titleWidth))}  ${ui.dim("STATUS")}  ${ui.dim("STARTED")}`
      );
      for (const { session: s } of sessions) {
        const status = s.status === "active" ? ui.green("active ") : ui.dim("ended  ");
        const started = s.startedAt.slice(0, 16).replace("T", " ");
        ui.print(
          `  ${ui.green("·")} ${s.id.padEnd(idWidth)}  ${s.title.padEnd(titleWidth)}  ${status}  ${started}`
        );
      }
    }
    if (errors.length > 0) {
      ui.warn(`${errors.length} session(s) failed to parse:`);
      for (const e of errors) {
        ui.print(`    ${ui.red("✗")} ${e.folder}`);
        ui.print(`      ${ui.dim(e.error.message.split("\n")[0])}`);
      }
    }
    return 0;
  },
};

// ============================================================
// show
// ============================================================

const showCmd: Command = {
  name: "show",
  summary: "Show a session's transcript + items born from it.",
  positionals: ["id"],
  async run({ positionals, cwd }) {
    const id = positionals[0];
    if (!id) {
      ui.error("Usage: atelier session show <id>");
      return 2;
    }
    let workspaceRoot: string;
    try {
      workspaceRoot = await requireWorkspaceRoot(cwd);
    } catch (err) {
      if (err instanceof NotInsideWorkspaceError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
    let session;
    try {
      session = await loadSession(workspaceRoot, id);
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
    ui.print(ui.bold(session.title) + `  ${ui.dim("(id: " + session.id + ")")}`);
    ui.print(`  ${ui.dim("status:")}      ${session.status}`);
    ui.print(`  ${ui.dim("startedAt:")}   ${session.startedAt}`);
    if (session.endedAt) ui.print(`  ${ui.dim("endedAt:")}     ${session.endedAt}`);
    if (session.participants && session.participants.length > 0) {
      ui.print(`  ${ui.dim("participants:")} ${session.participants.join(", ")}`);
    }
    ui.blank();

    // Items linked back to this session via fromSession.
    const { items } = await listItems(workspaceRoot);
    const linked = items.filter((d) => d.item.fromSession === id);
    if (linked.length > 0) {
      ui.print(ui.bold(`Items from this session (${linked.length})`));
      for (const { item } of linked) {
        const cls = item.classification ? ` [${item.classification}]` : "";
        ui.print(`  ${ui.green("·")} ${item.source}:${item.docId}${ui.dim(cls)} — ${item.title}`);
      }
      ui.blank();
    } else {
      ui.print(ui.dim("(no items linked back to this session yet)"));
      ui.blank();
    }

    ui.print(ui.bold("Transcript"));
    ui.print(`  ${ui.dim(".atelier/sessions/" + session.id + "/transcript.md")}`);
    ui.blank();
    if (session.transcript) {
      // Indent two spaces so the transcript reads as a quoted block.
      for (const line of session.transcript.split("\n")) {
        ui.print("  " + line);
      }
    } else {
      ui.print(ui.dim("  (empty)"));
    }
    return 0;
  },
};

// ============================================================
// remove
// ============================================================

const removeCmd: Command = {
  name: "remove",
  summary: "Delete a session (transcript + metadata).",
  description:
    "Items that referenced this session via `fromSession` keep the\n" +
    "orphaned id in their front-matter — deleted sessions may still be\n" +
    "useful provenance.",
  positionals: ["id"],
  async run({ positionals, cwd }) {
    const id = positionals[0];
    if (!id) {
      ui.error("Usage: atelier session remove <id>");
      return 2;
    }
    let workspaceRoot: string;
    try {
      workspaceRoot = await requireWorkspaceRoot(cwd);
    } catch (err) {
      if (err instanceof NotInsideWorkspaceError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
    try {
      const removed = await removeSession(workspaceRoot, id);
      ui.success(`Removed session ${ui.bold(removed.id)} (${removed.title}).`);
      return 0;
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

const watchCmd: Command = {
  name: "watch",
  summary: "Live-preview a session's design draft (Mermaid markdown) in the browser.",
  description:
    "Opens a localhost page that renders this session's design-draft.md\n" +
    "and auto-refreshes as the system-design agent's live companion mode\n" +
    "updates it during a call. This is the Markdown visualization for\n" +
    "when no Figma/Excalidraw/Lucid is connected — when a design tool IS\n" +
    "connected, the agent shares that tool's live link instead.\n\n" +
    "Runs until you press Ctrl-C. The page pulls markdown-it + Mermaid\n" +
    "from a CDN, so the view needs internet (recording does not).",
  positionals: ["id"],
  options: {
    port: { type: "string" },
    "no-open": { type: "boolean" },
  },
  async run({ values, positionals, cwd }) {
    const id = positionals[0];
    if (!id) {
      ui.error("Usage: atelier session watch <id>");
      return 2;
    }
    let workspaceRoot: string;
    try {
      workspaceRoot = await requireWorkspaceRoot(cwd);
    } catch (err) {
      if (err instanceof NotInsideWorkspaceError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }

    let session;
    try {
      session = await loadSession(workspaceRoot, id);
    } catch (err) {
      if (err instanceof SessionNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }

    const draftPath = path.join(workspacePaths(workspaceRoot).sessions, id, "design-draft.md");
    // Seed a placeholder so the page has something to show before the
    // agent's first update.
    try {
      await fs.access(draftPath);
    } catch {
      await fs.writeFile(
        draftPath,
        `# Live design draft — ${session.title}\n\n_Waiting for the conversation… the system-design agent will fill this in as you talk._\n`,
        "utf8"
      );
    }

    let port: number | undefined;
    if (values.port !== undefined) {
      const parsed = Number(values.port);
      if (!Number.isInteger(parsed) || parsed < 0) {
        ui.error("--port must be a non-negative integer.");
        return 2;
      }
      port = parsed;
    }

    const { startDesignPreviewServer, openInBrowser } = await import("../design-preview.js");
    const server = await startDesignPreviewServer({
      draftPath,
      title: `${session.title} — live design`,
      port,
    });

    ui.success(`Live design preview: ${ui.cyan(server.url)}`);
    ui.print(
      `  ${ui.dim("Auto-refreshes as the agent updates")} ${ui.dim(draftPath)}`
    );
    ui.print(`  ${ui.dim("Press Ctrl-C to stop.")}`);
    ui.blank();

    if (values["no-open"] !== true) openInBrowser(server.url);

    await new Promise<void>((resolve) => {
      const stop = () => {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    await server.close();
    ui.print(ui.dim("Preview stopped."));
    return 0;
  },
};

export const sessionCommand: Command = {
  name: "session",
  summary: "Record conversations + link items back to them.",
  description:
    "Atelier's speaking-module surface. The agent does live transcription;\n" +
    "this command tree captures the session boundary, stores transcript\n" +
    "chunks, and lets items created downstream point back via\n" +
    "--from-session so you can answer 'what came out of that meeting?'\n" +
    "later via `atelier session show <id>`.",
  subcommands: [
    startCmd,
    recordCmd,
    setupCmd,
    noteCmd,
    checkCmd,
    importCmd,
    endCmd,
    listCmd,
    showCmd,
    watchCmd,
    removeCmd,
  ],
};
