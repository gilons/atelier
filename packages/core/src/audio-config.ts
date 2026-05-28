import * as fs from "node:fs/promises";
import * as path from "node:path";
import { workspacePaths } from "./paths.js";
import { writeYamlFile, readYamlFile } from "./yaml-io.js";
import { WorkspaceValidationError } from "./workspace.js";

/**
 * Persisted audio preferences for `atelier session record`.
 *
 * Lives at `.atelier/audio.yaml`. Written by the session-record setup
 * wizard the first time the user runs `session record` (or by an
 * explicit `atelier session setup`). The file just records the user's
 * *preference* — atelier still re-probes PATH at runtime, so a brew
 * update that moves the binary doesn't invalidate the config.
 */

export type AudioRecorderKind = "sox" | "ffmpeg";
export type AudioTranscriberKind =
  | "agent" // no auto-transcription; the agent transcribes the saved wav
  | "whisper" // OpenAI's Python whisper CLI, auto-detected on PATH
  | "env"; // user's $ATELIER_TRANSCRIBER command

/**
 * Whisper-specific preferences. Honored when `transcriber: whisper`
 * is set. Both fields are optional — atelier falls back to its
 * built-in default (multilingual `ggml-medium.bin`) when nothing's
 * been chosen so existing v1 configs that predate language support
 * keep working.
 */
export interface WhisperPreferences {
  /**
   * Filename of the whisper.cpp model under `~/.atelier-models/`.
   * Examples: "ggml-medium.bin" (multilingual, ~1.5 GB — atelier's
   * default), "ggml-small.bin" (multilingual, ~470 MB),
   * "ggml-base.bin" (multilingual, ~140 MB),
   * "ggml-tiny.en.bin" (English-only, ~75 MB).
   */
  model?: string;
  /**
   * BCP-47-ish language code passed to whisper-cli's --language flag.
   * Common values: "en", "de", "fr", "es", "ja", "auto" (let whisper
   * detect per file). Ignored on English-only models like
   * ggml-medium.en.bin / ggml-tiny.en.bin.
   */
  language?: string;
}

export interface AudioConfig {
  version: 1;
  recorder: AudioRecorderKind;
  transcriber: AudioTranscriberKind;
  /** Whisper-specific preferences; relevant only when transcriber === "whisper". */
  whisper?: WhisperPreferences;
}

const AUDIO_CONFIG_FILE = "audio.yaml";

function audioConfigPath(workspaceRoot: string): string {
  return path.join(workspacePaths(workspaceRoot).atelier, AUDIO_CONFIG_FILE);
}

/**
 * Load the workspace's audio preferences. Returns null when the file
 * hasn't been created yet (first-time use) — the caller decides
 * whether to launch the setup wizard, fall back to a default, or
 * error out.
 */
export async function loadAudioConfig(
  workspaceRoot: string
): Promise<AudioConfig | null> {
  const file = audioConfigPath(workspaceRoot);
  const raw = await readYamlFile(file);
  if (raw === null) return null;
  return validateAudioConfig(raw, file);
}

/**
 * Persist audio preferences. Overwrites any existing audio.yaml.
 */
export async function saveAudioConfig(
  workspaceRoot: string,
  cfg: AudioConfig
): Promise<void> {
  // Re-validate to keep the on-disk file honest regardless of caller.
  validateAudioConfig(cfg, audioConfigPath(workspaceRoot));
  const file = audioConfigPath(workspaceRoot);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const out: Record<string, unknown> = {
    version: cfg.version,
    recorder: cfg.recorder,
    transcriber: cfg.transcriber,
  };
  // Persist whisper only when the user has actually chosen settings —
  // an empty {} on disk is more confusing than just omitting the block.
  if (cfg.whisper && (cfg.whisper.model || cfg.whisper.language)) {
    const w: Record<string, unknown> = {};
    if (cfg.whisper.model) w.model = cfg.whisper.model;
    if (cfg.whisper.language) w.language = cfg.whisper.language;
    out.whisper = w;
  }
  await writeYamlFile(
    file,
    out,
    "# Atelier audio preferences for `session record`.\n" +
      "# Created by the first-run setup wizard. Edit by hand or run\n" +
      "# `atelier session setup` to change the recorder or transcriber.\n" +
      "# `whisper.language`/`whisper.model` apply when transcriber=whisper.\n"
  );
}

const RECORDER_KINDS: readonly AudioRecorderKind[] = ["sox", "ffmpeg"];
const TRANSCRIBER_KINDS: readonly AudioTranscriberKind[] = [
  "agent",
  "whisper",
  "env",
];

function validateAudioConfig(raw: unknown, file: string): AudioConfig {
  if (!raw || typeof raw !== "object") {
    throw new WorkspaceValidationError(file, "expected a YAML object");
  }
  const r = raw as Record<string, unknown>;
  if (r.version !== 1) {
    throw new WorkspaceValidationError(
      file,
      `unknown audio.yaml version: ${String(r.version)} (expected 1)`
    );
  }
  if (typeof r.recorder !== "string" || !RECORDER_KINDS.includes(r.recorder as AudioRecorderKind)) {
    throw new WorkspaceValidationError(
      file,
      `recorder must be one of: ${RECORDER_KINDS.join(", ")}`
    );
  }
  if (
    typeof r.transcriber !== "string" ||
    !TRANSCRIBER_KINDS.includes(r.transcriber as AudioTranscriberKind)
  ) {
    throw new WorkspaceValidationError(
      file,
      `transcriber must be one of: ${TRANSCRIBER_KINDS.join(", ")}`
    );
  }
  const cfg: AudioConfig = {
    version: 1,
    recorder: r.recorder as AudioRecorderKind,
    transcriber: r.transcriber as AudioTranscriberKind,
  };
  // whisper block is fully optional. We only validate shape when present.
  if (r.whisper !== undefined) {
    if (typeof r.whisper !== "object" || r.whisper === null) {
      throw new WorkspaceValidationError(
        file,
        "whisper must be an object with optional `model` and `language` string fields"
      );
    }
    const w = r.whisper as Record<string, unknown>;
    const prefs: WhisperPreferences = {};
    if (w.model !== undefined) {
      if (typeof w.model !== "string" || w.model.trim().length === 0) {
        throw new WorkspaceValidationError(
          file,
          "whisper.model, if present, must be a non-empty string (e.g. \"ggml-tiny.bin\")"
        );
      }
      // Path traversal guard — model file lives under ~/.atelier-models/,
      // a name with slashes would escape the directory.
      if (w.model.includes("/") || w.model.includes("\\")) {
        throw new WorkspaceValidationError(
          file,
          "whisper.model must be a bare filename, not a path"
        );
      }
      prefs.model = w.model;
    }
    if (w.language !== undefined) {
      if (typeof w.language !== "string" || w.language.trim().length === 0) {
        throw new WorkspaceValidationError(
          file,
          "whisper.language, if present, must be a non-empty string (e.g. \"en\", \"de\", \"auto\")"
        );
      }
      prefs.language = w.language;
    }
    if (prefs.model || prefs.language) cfg.whisper = prefs;
  }
  return cfg;
}
