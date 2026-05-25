import * as fs from "node:fs/promises";
import {
  requireWorkspaceRoot,
  startSession,
  appendToSession,
  endSession,
  loadSession,
  listSessions,
  removeSession,
  listDocs,
  SessionNotFoundError,
  SessionAlreadyExistsError,
  NotInsideWorkspaceError,
} from "@atelier/core";
import type { Command } from "../command.js";
import { ui } from "../ui.js";

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
 *   4. (agent extracts ideas) `atelier doc add ... --from-session <id>`
 *   5. `atelier session show <id>`                               → transcript + items
 *
 * For pre-recorded conversations, `atelier session import` skips the
 * live-append cycle and creates the session + populates transcript +
 * marks it ended in one call.
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
    "  --text-file PATH read content from a file (useful for large batches)\n",
  positionals: ["id"],
  options: {
    text: { type: "string" },
    "text-file": { type: "string" },
  },
  async run({ positionals, values, cwd }) {
    const id = positionals[0];
    if (!id) {
      ui.error("Usage: atelier session note <id> --text \"...\"");
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
    try {
      await appendToSession(workspaceRoot, id, text);
      // Keep the response tiny — chatty output during a transcribing
      // loop would flood the terminal. Just a single line so the
      // agent (or human) sees the append landed.
      ui.print(`${ui.green("·")} appended ${text.length} chars to ${ui.bold(id)}.`);
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
 *   3. For each idea, suggest `atelier doc add ... --from-session <id>`
 *      so the new item points back at the conversation.
 *   4. Surface action items to the user before committing.
 */
function printSessionEndedFollowUp(id: string, title: string): void {
  ui.blank();
  ui.print(ui.bold("Next step for the assistant"));
  ui.print(
    `  Read the transcript at ${ui.cyan(`.atelier/sessions/${id}/transcript.md`)} and propose`
  );
  ui.print(`  items for the user to confirm. For each idea, decide:`);
  ui.print(`    - which category fits: ${ui.dim("docs | design | pm")}`);
  ui.print(`    - which registered source under that category to attach to`);
  ui.print(`      (run ${ui.dim("`atelier source list`")} if you're not sure)`);
  ui.print(`    - what classification ("ticket", "frame", "prd", …) the source's tool uses`);
  ui.blank();
  ui.print("  Confirm each idea with the user, then create the item linking back");
  ui.print("  to this session so the conversation stays discoverable:");
  ui.print(
    `    ${ui.cyan(`atelier doc add <source>:<itemId> --title "..." --link <url> \\`)}`
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
    const { docs } = await listDocs(workspaceRoot);
    const linked = docs.filter((d) => d.doc.fromSession === id);
    if (linked.length > 0) {
      ui.print(ui.bold(`Items from this session (${linked.length})`));
      for (const { doc } of linked) {
        const cls = doc.classification ? ` [${doc.classification}]` : "";
        ui.print(`  ${ui.green("·")} ${doc.source}:${doc.docId}${ui.dim(cls)} — ${doc.title}`);
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

export const sessionCommand: Command = {
  name: "session",
  summary: "Record conversations + link items back to them.",
  description:
    "Atelier's speaking-module surface. The agent does live transcription;\n" +
    "this command tree captures the session boundary, stores transcript\n" +
    "chunks, and lets items created downstream point back via\n" +
    "--from-session so you can answer 'what came out of that meeting?'\n" +
    "later via `atelier session show <id>`.",
  subcommands: [startCmd, noteCmd, importCmd, endCmd, listCmd, showCmd, removeCmd],
};
