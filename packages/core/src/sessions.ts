import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import * as YAML from "yaml";
import { workspacePaths } from "./paths.js";
import { writeYamlFile } from "./yaml-io.js";
import { validateSessionFrontMatter, formatIssues } from "./validation.js";
import type { Session, SessionFrontMatter } from "./types.js";

/**
 * Sessions: atelier's record of one bounded conversation
 * (brainstorm, stand-up, user interview, etc.).
 *
 * Each session lives at:
 *
 *   .atelier/sessions/<id>/
 *     session.yaml     — metadata: title, participants, status,
 *                        startedAt, endedAt
 *     transcript.md    — running transcript text. The agent appends
 *                        chunks via `atelier session note`.
 *
 * Atelier does NOT do the transcription itself. The user's agent
 * (Claude voice mode, Otter, a phone pipeline, …) provides the
 * transcript chunks; atelier stores + organizes them. An optional
 * native recording mode (`atelier session record`) can be layered
 * on later without changing this storage shape.
 *
 * Items created from a session set their `fromSession` field to the
 * session id, so `loadItemsFromSession(id)` (and the CLI's
 * `atelier session show <id>`) can enumerate "what came out of this
 * conversation" later.
 */

export class SessionNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`No session with id "${id}".`);
    this.name = "SessionNotFoundError";
  }
}

export class SessionAlreadyExistsError extends Error {
  constructor(public readonly id: string) {
    super(`A session with id "${id}" already exists.`);
    this.name = "SessionAlreadyExistsError";
  }
}

export class SessionFileError extends Error {
  constructor(public readonly filePath: string, public readonly detail: string) {
    super(`Invalid session file at ${filePath}:\n${detail}`);
    this.name = "SessionFileError";
  }
}

// ============================================================
// Path helpers
// ============================================================

function sessionFolderPath(workspaceRoot: string, id: string): string {
  return path.join(workspacePaths(workspaceRoot).sessions, id);
}

function sessionYamlPath(workspaceRoot: string, id: string): string {
  return path.join(sessionFolderPath(workspaceRoot, id), "session.yaml");
}

function sessionTranscriptPath(workspaceRoot: string, id: string): string {
  return path.join(sessionFolderPath(workspaceRoot, id), "transcript.md");
}

// ============================================================
// Id derivation
// ============================================================

/**
 * Build a session id from a title + a date. Lowercase slug with a
 * short random suffix so two sessions with the same title on the
 * same day don't collide. Falls back to "session-<random>" when
 * the title slug is empty.
 */
export function deriveSessionId(title: string, startedAt: Date = new Date()): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  const date = startedAt.toISOString().slice(0, 10); // YYYY-MM-DD
  const suffix = crypto.randomBytes(2).toString("hex"); // 4 hex chars
  if (slug) return `${slug}-${date}-${suffix}`;
  return `session-${date}-${suffix}`;
}

// ============================================================
// Parse / serialize
// ============================================================

function parseSessionYaml(text: string, filePath: string): SessionFrontMatter {
  let raw: unknown;
  try {
    raw = YAML.parse(text);
  } catch (err) {
    throw new SessionFileError(filePath, `YAML parse error: ${(err as Error).message}`);
  }
  const result = validateSessionFrontMatter(raw);
  if (!result.ok || !result.value) {
    throw new SessionFileError(filePath, formatIssues(result.issues));
  }
  return result.value;
}

// ============================================================
// CRUD
// ============================================================

export interface StartSessionOptions {
  /** Display title for the session. Used to derive the id if not given. */
  title: string;
  /** Optional list of participants. Free-form names. */
  participants?: string[];
  /** Explicit id. When omitted, derived from title + date. */
  id?: string;
  /**
   * Initial transcript content. When the agent is importing a full
   * transcript from elsewhere (Otter / Whisper / paste), this is
   * the body of transcript.md. Otherwise the file starts empty.
   */
  transcript?: string;
  /**
   * Mark the session as already ended (status: "ended", endedAt set).
   * Used by `atelier session import` for finished conversations.
   */
  alreadyEnded?: boolean;
  /**
   * Length of each audio chunk in seconds when the session is being
   * recorded in chunked mode. Persisted to session.yaml so
   * `atelier session check` can echo the polling cadence back to the
   * agent without the user having to remember what they passed.
   */
  chunkSeconds?: number;
  /**
   * Language code (e.g. "en", "de", "auto") to use when transcribing
   * this session. Overrides the workspace-level audio.yaml setting.
   * Persisted so the agent's polling loop can pass the right
   * `--language` to its STT after the user has moved on.
   */
  language?: string;
}

export async function startSession(
  workspaceRoot: string,
  opts: StartSessionOptions
): Promise<Session> {
  if (!opts.title) throw new Error("title is required");
  const startedAt = new Date();
  const id = opts.id ?? deriveSessionId(opts.title, startedAt);
  const folder = sessionFolderPath(workspaceRoot, id);

  try {
    await fs.access(folder);
    throw new SessionAlreadyExistsError(id);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }

  const fm: SessionFrontMatter = {
    id,
    title: opts.title,
    status: opts.alreadyEnded ? "ended" : "active",
    startedAt: startedAt.toISOString(),
  };
  if (opts.participants && opts.participants.length > 0) {
    fm.participants = opts.participants;
  }
  if (opts.alreadyEnded) fm.endedAt = startedAt.toISOString();
  if (opts.chunkSeconds !== undefined) fm.chunkSeconds = opts.chunkSeconds;
  if (opts.language) fm.language = opts.language;

  await fs.mkdir(folder, { recursive: true });
  await writeYamlFile(
    sessionYamlPath(workspaceRoot, id),
    fm,
    "Atelier session metadata.\nThe transcript itself lives in transcript.md alongside this file."
  );
  await fs.writeFile(
    sessionTranscriptPath(workspaceRoot, id),
    opts.transcript ?? "",
    "utf8"
  );

  return { ...fm, transcript: opts.transcript ?? "" };
}

/**
 * Append a chunk to a session's transcript.md. The agent calls this
 * with a single utterance, a paragraph, or a whole batch. Atelier
 * appends verbatim — the agent owns the formatting (including
 * timestamps + speaker labels if it wants them).
 *
 * Rejects when the session is already ended; the agent should
 * `session start` a new one for follow-up work instead of
 * extending a closed conversation. The exception is chunked-mode
 * draining — use {@link appendChunkTranscript} when the note is a
 * post-recording transcription of an actual chunk on disk; that
 * variant is allowed on ended sessions because the audio was
 * captured while it was active.
 */
export async function appendToSession(
  workspaceRoot: string,
  id: string,
  text: string
): Promise<Session> {
  const session = await loadSession(workspaceRoot, id);
  if (session.status === "ended") {
    throw new Error(
      `Session "${id}" is ended (closed at ${session.endedAt}). Start a new session to add more notes.`
    );
  }
  const filePath = sessionTranscriptPath(workspaceRoot, id);
  // Append with a newline so chunks don't run together by accident.
  // Idempotency / dedupe is the agent's job — atelier just appends.
  await fs.appendFile(filePath, text.endsWith("\n") ? text : text + "\n", "utf8");
  return await loadSession(workspaceRoot, id);
}

/**
 * End a session: set status='ended' and stamp endedAt. Idempotent —
 * ending an already-ended session is a no-op (we don't move the
 * endedAt back; the original close time is what's interesting).
 */
export async function endSession(
  workspaceRoot: string,
  id: string
): Promise<Session> {
  const session = await loadSession(workspaceRoot, id);
  if (session.status === "ended") return session;
  const fm: SessionFrontMatter = {
    id: session.id,
    title: session.title,
    status: "ended",
    startedAt: session.startedAt,
    endedAt: new Date().toISOString(),
  };
  if (session.participants) fm.participants = session.participants;
  if (session.chunkSeconds !== undefined) fm.chunkSeconds = session.chunkSeconds;
  if (session.language) fm.language = session.language;
  await writeYamlFile(
    sessionYamlPath(workspaceRoot, id),
    fm,
    "Atelier session metadata.\nThe transcript itself lives in transcript.md alongside this file."
  );
  return { ...fm, transcript: session.transcript };
}

export async function loadSession(
  workspaceRoot: string,
  id: string
): Promise<Session> {
  const yamlPath = sessionYamlPath(workspaceRoot, id);
  let yamlText: string;
  try {
    yamlText = await fs.readFile(yamlPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SessionNotFoundError(id);
    }
    throw err;
  }
  const fm = parseSessionYaml(yamlText, yamlPath);
  let transcript = "";
  try {
    transcript = await fs.readFile(sessionTranscriptPath(workspaceRoot, id), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    // Missing transcript.md is OK — fresh session, no notes yet.
  }
  return { ...fm, transcript };
}

export interface SessionListing {
  session: SessionFrontMatter;
  folder: string;
}

/**
 * List every session in the workspace. Walks the
 * `.atelier/sessions/` directory; parse errors on individual
 * session.yaml files are collected into `errors` rather than thrown
 * so one bad session doesn't block the rest.
 */
export async function listSessions(workspaceRoot: string): Promise<{
  sessions: SessionListing[];
  errors: { folder: string; error: Error }[];
}> {
  const root = workspacePaths(workspaceRoot).sessions;
  const errors: { folder: string; error: Error }[] = [];
  const out: SessionListing[] = [];

  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { sessions: [], errors: [] };
    }
    throw err;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!e.isDirectory()) continue;
    const folder = path.join(root, e.name);
    const yamlPath = path.join(folder, "session.yaml");
    try {
      const text = await fs.readFile(yamlPath, "utf8");
      const fm = parseSessionYaml(text, yamlPath);
      out.push({ session: fm, folder });
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
      errors.push({ folder, error: err as Error });
    }
  }
  // Sort by startedAt descending (most recent first) — what the
  // user wants by default in `atelier session list`.
  out.sort((a, b) => b.session.startedAt.localeCompare(a.session.startedAt));
  return { sessions: out, errors };
}

/**
 * Delete a session — removes the whole folder (session.yaml +
 * transcript.md + anything else the agent dropped in there).
 *
 * Items that referenced this session via `fromSession` are NOT
 * touched — they keep the orphaned id in their front-matter. That's
 * intentional: a deleted session may still be useful provenance
 * even if the audio/transcript is gone. The agent or user can
 * decide later whether to scrub the references.
 */
export async function removeSession(
  workspaceRoot: string,
  id: string
): Promise<SessionFrontMatter> {
  const session = await loadSession(workspaceRoot, id);
  const folder = sessionFolderPath(workspaceRoot, id);
  await fs.rm(folder, { recursive: true, force: true });
  return {
    id: session.id,
    title: session.title,
    status: session.status,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    participants: session.participants,
  };
}

// ============================================================
// Chunked recordings — polling support for the agent
// ============================================================

/**
 * Where chunked audio recordings land within a session folder. Each
 * file is one segment produced by the recorder (e.g. `0001.wav`,
 * `0002.wav`, …). The folder only exists for sessions started with
 * `atelier session record --chunk N`; non-chunked sessions write a
 * single `recording.wav` at the session root instead.
 */
function sessionChunksDir(workspaceRoot: string, id: string): string {
  return path.join(sessionFolderPath(workspaceRoot, id), "chunks");
}

/**
 * Marker file listing chunks the agent has already turned into
 * transcript notes. One filename per line. Append-only so we don't
 * lose history if the file's edited by hand. The agent updates it
 * via `atelier session note --chunk <name>`.
 */
function sessionConsumedFile(workspaceRoot: string, id: string): string {
  return path.join(sessionFolderPath(workspaceRoot, id), "consumed.txt");
}

export interface SessionChunkInfo {
  /** Filename relative to `chunks/`, e.g. "0001.wav". */
  name: string;
  /** Absolute path on disk. */
  filePath: string;
  /** File size in bytes — proxy for "is this finished or still being written?" */
  bytes: number;
  /** True when the chunk hasn't been recorded against in consumed.txt yet. */
  pending: boolean;
}

/**
 * List every chunk under a session's `chunks/` folder (if it exists)
 * along with whether each one is still pending agent processing.
 * Returns an empty array for non-chunked sessions — callers can
 * check `session.chunkSeconds` to know which mode they're in.
 *
 * Files are sorted by name so the ordinal recorder output stays in
 * time order even with lots of segments.
 */
export async function listSessionChunks(
  workspaceRoot: string,
  id: string
): Promise<SessionChunkInfo[]> {
  // Ensures the session exists / surfaces SessionNotFoundError
  // consistently with the rest of the API.
  await loadSession(workspaceRoot, id);

  const dir = sessionChunksDir(workspaceRoot, id);
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const consumed = await readConsumedSet(workspaceRoot, id);
  const wavs = entries
    .filter((e) => e.isFile() && /\.(wav|m4a|flac|mp3|ogg)$/i.test(e.name))
    .map((e) => e.name)
    .sort();
  const out: SessionChunkInfo[] = [];
  for (const name of wavs) {
    const filePath = path.join(dir, name);
    let bytes = 0;
    try {
      bytes = (await fs.stat(filePath)).size;
    } catch {
      /* race with the recorder rotating — treat as 0 */
    }
    out.push({
      name,
      filePath,
      bytes,
      pending: !consumed.has(name),
    });
  }
  return out;
}

/**
 * Mark a chunk as consumed (the agent has transcribed it + appended
 * to transcript.md). Idempotent — re-marking is a no-op. Use this
 * via `atelier session note --chunk <name>` rather than calling
 * directly from agent code so the note + the mark land together.
 */
export async function markChunkConsumed(
  workspaceRoot: string,
  id: string,
  chunkName: string
): Promise<void> {
  if (!chunkName || chunkName.includes("/") || chunkName.includes("\\")) {
    throw new Error(`Invalid chunk name "${chunkName}" — pass a basename, not a path.`);
  }
  await loadSession(workspaceRoot, id);
  const existing = await readConsumedSet(workspaceRoot, id);
  if (existing.has(chunkName)) return;
  const file = sessionConsumedFile(workspaceRoot, id);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, chunkName + "\n", "utf8");
}

/**
 * Atomically append a transcript chunk + mark the source audio chunk
 * as consumed. Unlike {@link appendToSession}, this is allowed on
 * sessions whose status is already "ended" because the chunked-mode
 * workflow always transcribes *after* recording stops — the audio
 * was captured while the session was active.
 *
 * Safety: we verify the chunk filename actually exists under the
 * session's `chunks/` folder before allowing the append, so this
 * relaxed rule can't be abused to drop free-form notes on closed
 * sessions ("chunk: imaginary.wav" wouldn't match anything on disk).
 */
export async function appendChunkTranscript(
  workspaceRoot: string,
  id: string,
  chunkName: string,
  text: string
): Promise<Session> {
  if (!chunkName || chunkName.includes("/") || chunkName.includes("\\")) {
    throw new Error(`Invalid chunk name "${chunkName}" — pass a basename, not a path.`);
  }
  // Surfaces SessionNotFoundError consistently with the rest of the API.
  await loadSession(workspaceRoot, id);

  // The chunk has to exist on disk. This prevents "drop a note on a
  // closed session by lying about the chunk name" attacks against
  // the relaxed ended-session rule below.
  const chunkPath = path.join(sessionChunksDir(workspaceRoot, id), chunkName);
  try {
    await fs.access(chunkPath);
  } catch {
    throw new Error(
      `No chunk named "${chunkName}" under .atelier/sessions/${id}/chunks/. Run \`atelier session check ${id}\` to see what's pending.`
    );
  }

  const filePath = sessionTranscriptPath(workspaceRoot, id);
  await fs.appendFile(filePath, text.endsWith("\n") ? text : text + "\n", "utf8");
  await markChunkConsumed(workspaceRoot, id, chunkName);
  return await loadSession(workspaceRoot, id);
}

async function readConsumedSet(
  workspaceRoot: string,
  id: string
): Promise<Set<string>> {
  const file = sessionConsumedFile(workspaceRoot, id);
  try {
    const text = await fs.readFile(file, "utf8");
    return new Set(text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw err;
  }
}

