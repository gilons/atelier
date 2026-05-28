import * as fs from "node:fs/promises";
import * as path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import {
  saveAudioConfig,
  loadAudioConfig,
  type AudioConfig,
  type AudioRecorderKind,
  type AudioTranscriberKind,
} from "@atelier/core";
import { ui } from "./ui.js";
import { PromptSession } from "./prompt.js";
import {
  DEFAULT_WHISPER_MODEL_PATH,
  WHISPER_MODELS,
  WHISPER_MODELS_DIR,
  recommendedWhisperModel,
  type WhisperModelInfo,
} from "./audio.js";

/**
 * First-run setup for `atelier session record`.
 *
 * When the user invokes `session record` and atelier finds either no
 * audio.yaml or a configured recorder that's not on PATH, this
 * wizard kicks in (interactive shells only). It:
 *
 *   1. Detects the platform's package manager (brew / apt / dnf /
 *      pacman / choco / winget).
 *   2. Lets the user pick sox (preferred) or ffmpeg as the recorder.
 *   3. If brew is available on macOS, offers to run the install
 *      directly. Otherwise prints the exact command for the user to
 *      run themselves + waits for them to confirm "done" before
 *      re-probing.
 *   4. Asks how they want transcription handled — agent (default),
 *      whisper (auto-detected), or a custom $ATELIER_TRANSCRIBER.
 *   5. Saves the choices to `.atelier/audio.yaml` so subsequent
 *      `session record` calls skip the wizard.
 *
 * In agent / non-TTY mode, the wizard is suppressed and a follow-up
 * block tells the agent which commands to suggest the user run.
 */

// ============================================================
// Package-manager detection
// ============================================================

export type PackageManager =
  | "brew"
  | "apt"
  | "dnf"
  | "pacman"
  | "choco"
  | "winget";

export function detectPackageManager(
  platform: NodeJS.Platform = process.platform,
  probe: (cmd: string) => boolean = isOnPath
): PackageManager | null {
  if (platform === "darwin") {
    if (probe("brew")) return "brew";
    return null;
  }
  if (platform === "win32") {
    if (probe("winget")) return "winget";
    if (probe("choco")) return "choco";
    return null;
  }
  // Linux + everything else — order matches "most common first".
  for (const pm of ["apt", "dnf", "pacman"] as const) {
    if (probe(pm)) return pm;
  }
  return null;
}

function isOnPath(cmd: string): boolean {
  const which = process.platform === "win32" ? "where" : "which";
  return spawnSync(which, [cmd], { stdio: "ignore" }).status === 0;
}

// ============================================================
// Install command planning
// ============================================================

export interface InstallPlan {
  /** Human label for the line we print before prompting. */
  label: string;
  /** Exact command (argv-style, joined for display). */
  command: string;
  /** If true, atelier can run it directly without sudo. */
  autoRunnable: boolean;
}

/**
 * What command would install the given recorder kind under the
 * given package manager? Returns null when there's no known route
 * (rare — most distros have sox + ffmpeg in their core repos).
 */
export function installPlanFor(
  kind: AudioRecorderKind,
  pm: PackageManager | null
): InstallPlan | null {
  if (!pm) return null;
  switch (pm) {
    case "brew":
      // brew never needs sudo — atelier can run it for the user.
      return {
        label: `brew install ${kind}`,
        command: `brew install ${kind}`,
        autoRunnable: true,
      };
    case "apt":
      return {
        label: `sudo apt-get install -y ${kind}`,
        command: `sudo apt-get install -y ${kind}`,
        autoRunnable: false,
      };
    case "dnf":
      return {
        label: `sudo dnf install -y ${kind}`,
        command: `sudo dnf install -y ${kind}`,
        autoRunnable: false,
      };
    case "pacman":
      return {
        label: `sudo pacman -S --noconfirm ${kind}`,
        command: `sudo pacman -S --noconfirm ${kind}`,
        autoRunnable: false,
      };
    case "choco":
      return {
        label: `choco install ${kind} -y`,
        command: `choco install ${kind} -y`,
        autoRunnable: false, // choco needs an elevated shell
      };
    case "winget":
      // winget package ids — sox isn't in the default repo, point at
      // a known-good one for each kind.
      return {
        label:
          kind === "sox"
            ? "winget install ChrisBagwell.SoX"
            : "winget install Gyan.FFmpeg",
        command:
          kind === "sox"
            ? "winget install ChrisBagwell.SoX"
            : "winget install Gyan.FFmpeg",
        autoRunnable: false,
      };
  }
}

// ============================================================
// Whisper model bootstrap
// ============================================================

/**
 * Download a whisper.cpp model into ~/.atelier-models/. Returns the
 * file path on success, or null when the download failed (caller
 * logs context). If the model is already on disk, treats that as
 * success without re-downloading.
 *
 * Uses `curl -fL` because it's everywhere on macOS/Linux + handles
 * redirects cleanly. We deliberately don't pull a Node HTTP library
 * for this — keeping the CLI dep-light is a design goal.
 *
 * Pass a {@link WhisperModelInfo} from {@link WHISPER_MODELS} to pick
 * a specific variant; omit the argument to grab atelier's default
 * (multilingual medium).
 */
export async function downloadWhisperModel(
  model?: WhisperModelInfo
): Promise<string | null> {
  const info =
    model ??
    WHISPER_MODELS.find((m) => m.file === path.basename(DEFAULT_WHISPER_MODEL_PATH)) ??
    WHISPER_MODELS[0];
  const target = path.join(WHISPER_MODELS_DIR, info.file);
  try {
    await fs.access(target);
    return target;
  } catch {
    /* not present, proceed */
  }
  await fs.mkdir(path.dirname(target), { recursive: true });
  return await new Promise<string | null>((resolve) => {
    const child = spawn(
      "curl",
      ["-fL", "--progress-bar", "-o", target, info.url],
      { stdio: "inherit" }
    );
    child.on("exit", (code) => resolve(code === 0 ? target : null));
    child.on("error", () => resolve(null));
  });
}

/**
 * Convenience: download the recommended whisper model for a given
 * language code. English → medium.en (best English quality);
 * anything else → multilingual medium. Used by `atelier session
 * setup --add-language <code>` to grab the model the user needs
 * without making them remember filenames. Pass an explicit
 * {@link WhisperModelInfo} to {@link downloadWhisperModel} when the
 * user wants a different size.
 */
export async function downloadWhisperModelForLanguage(
  language: string
): Promise<{ path: string | null; model: WhisperModelInfo }> {
  const model = recommendedWhisperModel(language);
  const result = await downloadWhisperModel(model);
  return { path: result, model };
}

// ============================================================
// Running the install (auto-runnable case)
// ============================================================

/**
 * Spawn the install command and stream its output to the parent
 * terminal. Resolves with true when it exits 0, false otherwise.
 * Only call this when {@link InstallPlan.autoRunnable} is true.
 */
export async function runInstall(plan: InstallPlan): Promise<boolean> {
  const parts = plan.command.split(/\s+/);
  const [cmd, ...args] = parts;
  return await new Promise<boolean>((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("exit", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  });
}

// ============================================================
// Wizard
// ============================================================

export interface WizardResult {
  config: AudioConfig;
  /** Did the recorder land on PATH after setup? */
  ready: boolean;
}

/**
 * Run the interactive setup. Caller must have an open
 * {@link PromptSession}; this function does not close it.
 *
 * `recorderAvailable` is injected so tests + the real recorder share
 * the same notion of "is ffmpeg on PATH right now". The wizard
 * calls it AFTER an install to verify success.
 *
 * `opts.recorderOnly` skips the transcription section — used by
 * `session record`'s first-run check, which should only ensure
 * recording works without forcing the user into transcription
 * decisions at the moment they want to start recording. The full
 * wizard (recorder + transcription) is reachable explicitly via
 * `atelier session setup`.
 */
export async function runAudioSetupWizard(
  workspaceRoot: string,
  session: PromptSession,
  recorderAvailable: (kind: AudioRecorderKind) => Promise<boolean>,
  transcriberAvailable: (kind: AudioTranscriberKind) => Promise<boolean>,
  opts: { recorderOnly?: boolean } = {}
): Promise<WizardResult> {
  ui.blank();
  ui.print(ui.bold("Audio setup for `session record`"));
  ui.print(
    `  ${ui.dim("One-time setup — saves your choice to .atelier/audio.yaml.")}`
  );
  ui.blank();

  const pm = detectPackageManager();

  // -----------
  // Recorder — ffmpeg only.
  // -----------
  // Atelier needs ffmpeg, period. Everything we've built (live VU meter,
  // chunked segments via -f segment, device-by-name, segment_start_number
  // resume, dual-output for the meter pipe) depends on ffmpeg features
  // that sox doesn't have. So the wizard no longer asks "pick a
  // recorder" — it just verifies ffmpeg is on PATH and offers to install
  // when it's not. Existing audio.yaml files with `recorder: sox` are
  // still loadable (back-compat) but new files always store "ffmpeg".
  const recorderKind: AudioRecorderKind = "ffmpeg";
  ui.print(ui.bold("Recorder"));
  ui.print(
    `  ${ui.dim("atelier uses ffmpeg for mic capture (live VU meter, chunked")}`
  );
  ui.print(
    `  ${ui.dim("segments, device-by-name — all features need ffmpeg).")}`
  );

  let recorderReady = await recorderAvailable("ffmpeg");
  if (recorderReady) {
    ui.success("ffmpeg already on PATH — you're set.");
  } else {
    const plan = installPlanFor("ffmpeg", pm);
    if (plan && plan.autoRunnable) {
      ui.blank();
      ui.print(`  ${ui.dim("Will run: ")}${ui.cyan(plan.command)}`);
      const ok = await session.confirm(`Install ffmpeg now?`, {
        default: true,
      });
      if (ok) {
        ui.print(`  ${ui.dim("Installing…")}`);
        const success = await runInstall(plan);
        recorderReady = success && (await recorderAvailable("ffmpeg"));
        if (recorderReady) ui.success("ffmpeg installed.");
        else ui.warn("ffmpeg install didn't complete — see output above.");
      }
    } else if (plan) {
      // Needs sudo / different package manager — print and wait.
      ui.blank();
      ui.print(`  ${ui.dim("Run this in another terminal, then come back:")}`);
      ui.print(`    ${ui.cyan(plan.command)}`);
      ui.blank();
      const done = await session.confirm(`Done?`, { default: true });
      if (done) {
        recorderReady = await recorderAvailable("ffmpeg");
        if (!recorderReady) ui.warn("Still can't find ffmpeg on PATH.");
      }
    } else {
      ui.blank();
      ui.print(
        `  ${ui.dim("No known package manager detected on this system.")}`
      );
      ui.print(
        `  ${ui.dim("Install ffmpeg however you normally would, then re-run setup.")}`
      );
    }
  }

  // -----------
  // Transcriber
  // -----------
  // recorderOnly mode (called from `session record`'s first-run check)
  // skips this entire block. The user came to record, not to make
  // transcription decisions — those happen later via `session setup`
  // or `session setup --add-language`. We default transcriber=agent
  // (atelier doesn't try to invoke anything) so existing recordings
  // still work; the agent reaches for whatever it has.
  let transcriberKind: AudioTranscriberKind = "agent";
  let whisperLanguage = "";
  let whisperModelFile = "";

  if (!opts.recorderOnly) {
  ui.blank();
  ui.print(ui.bold("Transcription"));
  ui.print(
    `  ${ui.dim("Atelier stores recorded audio as wav chunks. A separate STT tool")}`
  );
  ui.print(
    `  ${ui.dim("turns those chunks into transcript text. Pick which one:")}`
  );
  ui.print("");
  ui.print("  1) Default — atelier installs whisper-cpp + a model");
  ui.print("       atelier records and signals the agent. The agent reaches");
  ui.print("       for whisper as its STT (or you can invoke it once via");
  ui.print("       `session record --inline-transcribe` for one-shot use).");
  ui.print("");
  ui.print("  2) Bring my own — I'll set $ATELIER_TRANSCRIBER");
  ui.print("       export ATELIER_TRANSCRIBER='<your-stt-cmd> \"$1\"'");
  ui.print("       Command gets the wav as $1, prints transcript to stdout.");
  ui.print("       Same flow as option 1 — the agent (or --inline-transcribe)");
  ui.print("       calls into it. atelier itself never auto-runs anything.");
  ui.print("");
  ui.print("  3) None — my agent has its own STT integration");
  ui.print("       Atelier just records + stores chunks under");
  ui.print("       `.atelier/sessions/<id>/chunks/`. The agent reads them");
  ui.print("       directly and produces transcripts via its own pipeline.");
  ui.blank();
  const transcriberChoice = (
    await session.ask("Choice", { default: "1" })
  ).trim();
  // Default (1) → atelier-managed whisper. (2) → user's env-var command.
  // (3) → no atelier-side transcriber; agent handles it independently.
  transcriberKind = "whisper";
  if (transcriberChoice === "2") transcriberKind = "env";
  else if (transcriberChoice === "3") transcriberKind = "agent";

  if (transcriberKind === "whisper") {
    // Step 1: language. Picking this BEFORE installing the model so
    // we can grab the right variant (English-only vs multilingual).
    //
    // Default is auto-detect: whisper figures out the language per
    // recording. Works across mixed-language workflows without anyone
    // having to remember to pass --lang. The "English only" path
    // remains for users who only ever record in English and want the
    // (slightly) faster, English-tuned tiny.en model.
    ui.blank();
    ui.print(ui.bold("Recording language"));
    ui.print(
      `  ${ui.dim("Whisper auto-detects language per recording on multilingual models.")}`
    );
    ui.print("  1) Auto-detect (recommended — works for any language, multilingual model)");
    ui.print("  2) English only (smaller English-tuned model, faster but English-only)");
    ui.print("  3) Pin to one non-English language (de / fr / es / ja / …)");
    ui.blank();
    const langChoice = (
      await session.ask("Choice", { default: "1" })
    ).trim();
    if (langChoice === "2") {
      whisperLanguage = "en";
    } else if (langChoice === "3") {
      const code = (
        await session.ask("Language code (e.g. de, fr, es)", { default: "de" })
      ).trim();
      whisperLanguage = code || "de";
    } else {
      whisperLanguage = "auto";
    }
    // Step 2: model size. atelier defaults to `medium` because it's
    // the sweet spot for meeting / call audio — but `medium` is ~1.5
    // GB and slower per minute. Let the user opt down if they'd
    // rather have a smaller download or faster transcription.
    ui.blank();
    ui.print(ui.bold("Model size"));
    ui.print(
      `  ${ui.dim("Bigger = better transcripts (esp. for noisy / multilingual audio).")}`
    );
    ui.print(
      `  ${ui.dim("Smaller = faster + smaller download. atelier defaults to medium.")}`
    );
    ui.print("  1) medium  — ~1.5 GB, best quality (recommended)");
    ui.print("  2) small   — ~470 MB, good quality, ~3× faster than medium");
    ui.print("  3) base    — ~140 MB, decent quality, fast");
    ui.print("  4) tiny    — ~75 MB, low quality, fastest");
    ui.blank();
    const sizeChoice = (
      await session.ask("Choice", { default: "1" })
    ).trim();
    const sizeKey: "medium" | "small" | "base" | "tiny" =
      sizeChoice === "2"
        ? "small"
        : sizeChoice === "3"
          ? "base"
          : sizeChoice === "4"
            ? "tiny"
            : "medium";
    // Resolve to a concrete file based on (language, size). English-only
    // variants exist for tiny / base / medium; "small" has multilingual
    // only. When the user pins to a non-English language we always pick
    // the multilingual variant.
    const englishOnly = whisperLanguage === "en";
    const modelFileBySize: Record<typeof sizeKey, string> = {
      medium: englishOnly ? "ggml-medium.en.bin" : "ggml-medium.bin",
      small: "ggml-small.bin",
      base: englishOnly ? "ggml-base.en.bin" : "ggml-base.bin",
      tiny: englishOnly ? "ggml-tiny.en.bin" : "ggml-tiny.bin",
    };
    const wantedFile = modelFileBySize[sizeKey];
    const modelInfo =
      WHISPER_MODELS.find((m) => m.file === wantedFile) ??
      recommendedWhisperModel(whisperLanguage);
    whisperModelFile = modelInfo.file;

    // Step 3: install whisper-cpp if needed.
    let have = await transcriberAvailable("whisper");
    if (have) {
      ui.blank();
      ui.success("whisper already on PATH — you're set.");
    } else if (pm === "brew") {
      ui.blank();
      ui.print(`  ${ui.dim("Will run: ")}${ui.cyan("brew install whisper-cpp")}`);
      const ok = await session.confirm(`Install whisper-cpp now?`, {
        default: true,
      });
      if (ok) {
        ui.print(`  ${ui.dim("Installing whisper-cpp (~1 min)…")}`);
        const success = await runInstall({
          label: "brew install whisper-cpp",
          command: "brew install whisper-cpp",
          autoRunnable: true,
        });
        if (success) {
          ui.success("whisper-cpp installed.");
          have = await transcriberAvailable("whisper");
        } else {
          ui.warn("whisper-cpp install didn't complete — see output above.");
        }
      } else {
        ui.print(
          `  ${ui.dim("Skipped. Atelier will pick whichever whisper binary is on PATH when you record.")}`
        );
      }
    } else {
      ui.blank();
      ui.print(`  ${ui.dim("whisper isn't on PATH yet. Pick one:")}`);
      ui.print(`    ${ui.cyan("pip3 install --user openai-whisper")}    # full Python whisper (pulls PyTorch)`);
      ui.print(`    ${ui.cyan("see https://github.com/ggerganov/whisper.cpp")}    # lighter native build`);
      ui.print(`  ${ui.dim("Atelier will pick whichever ends up on PATH when you record.")}`);
    }

    // Step 4: model download. Uses the language-aware pick from step 2.
    if (have) {
      ui.blank();
      ui.print(
        `  ${ui.dim("Recommended model for")} ${ui.bold(whisperLanguage)}${ui.dim(":")} ${ui.cyan(modelInfo.file)} ${ui.dim("(" + modelInfo.size + ")")}`
      );
      ui.print(`  ${ui.dim(modelInfo.description)}`);
      const modelOk = await session.confirm(
        `Download ${modelInfo.file} (${modelInfo.size})?`,
        { default: true }
      );
      if (modelOk) {
        const downloaded = await downloadWhisperModel(modelInfo);
        if (downloaded) ui.success(`Model saved to ${downloaded}.`);
        else ui.warn("Model download didn't complete — see output above.");
      } else {
        ui.print(
          `  ${ui.dim("Skip noted — drop a ggml-*.bin in ~/.atelier-models/ later, or use `atelier session setup --add-language <code>`.")}`
        );
      }
    }
  } else if (transcriberKind === "env") {
    ui.blank();
    ui.print(
      `  ${ui.dim("Set ATELIER_TRANSCRIBER in your shell — the command receives the")}`
    );
    ui.print(
      `  ${ui.dim("wav path as $1 and must print transcript text to stdout. Example:")}`
    );
    ui.print(
      `    ${ui.cyan(`export ATELIER_TRANSCRIBER='whisper --model tiny "$1" --output_format txt -o /tmp >/dev/null && cat /tmp/$(basename "$1" .wav).txt'`)}`
    );
  }
  } else {
    // recorderOnly mode: skipped transcription decisions entirely.
    // Tell the user how to configure it later without nagging now.
    ui.blank();
    ui.print(
      `  ${ui.dim("Skipped transcription setup — atelier just records + stores wavs.")}`
    );
    ui.print(
      `  ${ui.dim("Run `atelier session setup` (or `--add-language <code>`) when you")}`
    );
    ui.print(
      `  ${ui.dim("want to wire up a transcription tool.")}`
    );
  }

  const config: AudioConfig = {
    version: 1,
    recorder: recorderKind,
    transcriber: transcriberKind,
  };
  if (whisperLanguage || whisperModelFile) {
    config.whisper = {};
    if (whisperModelFile) config.whisper.model = whisperModelFile;
    if (whisperLanguage) config.whisper.language = whisperLanguage;
  }
  await saveAudioConfig(workspaceRoot, config);

  ui.blank();
  ui.success(`Saved to .atelier/audio.yaml.`);
  return { config, ready: recorderReady };
}

// ============================================================
// Agent-mode fallback (non-TTY)
// ============================================================

/**
 * Print the install hints the agent should pass to the user. Used in
 * agent / non-TTY contexts where a wizard would deadlock.
 */
export function printNonInteractiveSetupHelp(
  needs: { recorder: boolean; transcriber: boolean }
): void {
  const pm = detectPackageManager();
  ui.blank();
  ui.print(ui.bold("`session record` needs one-time setup"));
  if (needs.recorder) {
    const plan = installPlanFor("sox", pm);
    ui.print("  Install a recorder (sox recommended):");
    if (plan) {
      ui.print(`    ${ui.cyan(plan.command)}`);
    } else {
      ui.print(`    ${ui.dim("install sox however you usually install CLI tools")}`);
    }
  }
  if (needs.transcriber) {
    ui.print("");
    ui.print(
      "  Pick a transcriber (optional — without one atelier keeps the wav and"
    );
    ui.print("  asks the agent to transcribe it):");
    ui.print(`    ${ui.cyan("pip3 install --user openai-whisper")}    # local`);
    ui.print(
      `    ${ui.cyan('export ATELIER_TRANSCRIBER=\'<your-stt-cmd> "$1"\'')}    # custom`
    );
  }
  ui.print("");
  ui.print(
    `  Then re-run interactively with ${ui.cyan("atelier session setup")} to save the preference.`
  );
  ui.blank();
}

// ============================================================
// Convenience: ensure audio is ready before recording
// ============================================================

export interface EnsureAudioReadyResult {
  /** Resolved config — never null when ready=true. */
  config: AudioConfig | null;
  /** Can we proceed with recording right now? */
  ready: boolean;
}

/**
 * Make sure the workspace has a usable audio config + a recorder on
 * PATH. Loads existing audio.yaml when valid; otherwise runs the
 * wizard (interactive) or prints non-interactive help (agent mode).
 */
export async function ensureAudioReady(
  workspaceRoot: string,
  opts: {
    interactive: boolean;
    recorderAvailable: (kind: AudioRecorderKind) => Promise<boolean>;
    transcriberAvailable: (kind: AudioTranscriberKind) => Promise<boolean>;
  }
): Promise<EnsureAudioReadyResult> {
  const existing = await loadAudioConfig(workspaceRoot);
  if (existing) {
    // Always probe ffmpeg — sox is back-compat only and doesn't have
    // the features atelier's recorder relies on. A v1 file with
    // `recorder: sox` reads fine but we treat ffmpeg as the source
    // of truth at runtime.
    const ok = await opts.recorderAvailable("ffmpeg");
    if (ok) return { config: existing, ready: true };
    if (!opts.interactive) {
      ui.error("ffmpeg isn't on PATH anymore.");
      printNonInteractiveSetupHelp({ recorder: true, transcriber: false });
      return { config: existing, ready: false };
    }
  }

  if (!opts.interactive) {
    ui.error("`session record` hasn't been set up yet.");
    printNonInteractiveSetupHelp({ recorder: true, transcriber: true });
    return { config: null, ready: false };
  }

  const session = new PromptSession();
  try {
    // First-run from `session record` only sets up the recorder.
    // Transcription configuration is a separate concern — the user
    // came here to record, not to make STT decisions. They can run
    // `atelier session setup` later for the full transcription flow.
    const { config, ready } = await runAudioSetupWizard(
      workspaceRoot,
      session,
      opts.recorderAvailable,
      opts.transcriberAvailable,
      { recorderOnly: true }
    );
    return { config, ready };
  } finally {
    session.close();
  }
}
