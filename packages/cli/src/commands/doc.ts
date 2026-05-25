import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  requireWorkspaceRoot,
  addDoc,
  listDocs,
  loadDoc,
  removeDoc,
  renameDoc,
  updateDoc,
  encodeDocFilenameStem,
  listSources,
  DocAlreadyExistsError,
  DocNotFoundError,
  DocFileError,
  DocReferenceValidationError,
  NotInsideWorkspaceError,
} from "@atelier/core";
import type { Command, InvocationMode } from "../command.js";
import { ui } from "../ui.js";
import { pickSourceOrAll } from "../source-picker.js";
import { PromptSession } from "../prompt.js";

/**
 * `atelier doc` — manage the workspace's doc map.
 *
 * Atelier stores an agent-curated summary per tracked document. The
 * agent that registered the doc fetched it with its own integrations,
 * produced the summary (overview + keywords + anchors), and wrote
 * it via `/doc add`. To re-read the original, the agent follows
 * `link` again.
 *
 * Two ways to add a doc:
 *   - Scripted (agent-driven):
 *       atelier doc add <source>:<docId> \
 *         --title "..." [--link <url>] [--overview "..."] \
 *         [--body-file <path> | --body-text "..."]
 *   - Interactive (human-driven):
 *       /doc add   → prompts for source, docId, title, link, opens
 *                    $EDITOR on a summary scaffold.
 */

// classification is free-form text now (atelier indexes docs, design,
// and PM items, and each has its own native vocabulary). We accept
// whatever the agent passes — no enum check.
function validClassification(s: string): s is string {
  return typeof s === "string" && s.length > 0;
}

/**
 * Detect whether atelier is running under an AI agent that's going
 * to act on the follow-up instructions we print after a successful
 * /doc add. Standard truthy-env-var convention — any non-empty
 * value other than "0", "false", "off", "no" enables agent mode.
 */
function isAgentMode(): boolean {
  const v = (process.env.ATELIER_AGENT ?? "").trim().toLowerCase();
  if (!v) return false;
  return v !== "0" && v !== "false" && v !== "off" && v !== "no";
}

/**
 * Slugify a free-form filename / title into a safe docId.
 * Lowercase, alphanumeric + hyphens. Spaces → hyphens. Falls back
 * to a placeholder when nothing usable survives.
 */
function normalizeFilenameToDocId(raw: string): string {
  const trimmed = raw.trim().replace(/\.(md|txt)$/i, "");
  const slug = trimmed
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return slug;
}

// ============================================================
// add (scripted: flags) — and editor flow when no flags given
// ============================================================

const addCmd: Command = {
  name: "add",
  summary: "Add a doc summary to the workspace (or open $EDITOR for one).",
  description:
    "The doc map is atelier's index of agent-curated summaries — each\n" +
    "entry holds a title, an optional `link` the agent uses to refetch\n" +
    "the original, and a markdown summary body.\n\n" +
    "Scripted form (agents):\n" +
    '  atelier doc add <source>:<docId> --title "..." [--link <url>] \\\n' +
    "    [--overview \"...\"] [--classification <c>] [--body-file <path>]\n\n" +
    "Interactive form (humans):\n" +
    "  /doc add  → prompts for source, docId, title, link, then opens\n" +
    "             $EDITOR on a summary scaffold.",
  positionals: ["sourceAndDocId"],
  options: {
    title: { type: "string", short: "t" },
    link: { type: "string", short: "l" },
    overview: { type: "string" },
    classification: { type: "string", short: "c" },
    parent: { type: "string" },
    "from-session": { type: "string" },
    "body-file": { type: "string" },
    "body-text": { type: "string" },
    "no-validate-source": { type: "boolean" },
  },
  async run({ positionals, values, cwd, mode }) {
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

    const ref = positionals[0] as string | undefined;
    const title = values.title as string | undefined;

    // No positional + no flags → interactive editor flow.
    if (!ref && !title) {
      return await runEditorAdd(workspaceRoot, mode);
    }

    if (!ref) {
      ui.error("Missing <source>:<docId> argument.");
      ui.print(
        `  ${ui.dim('Usage: atelier doc add <source>:<docId> --title "<title>" [options]')}`
      );
      return 2;
    }
    const colon = ref.indexOf(":");
    if (colon < 1 || colon === ref.length - 1) {
      ui.error(
        `Expected "<source>:<docId>" — got "${ref}". The source id is everything before the first colon.`
      );
      return 2;
    }
    const source = ref.slice(0, colon);
    const docId = ref.slice(colon + 1);
    if (!title) {
      ui.error('--title is required when using the scripted form.');
      return 2;
    }

    const classification = values.classification as string | undefined;
    if (classification !== undefined && !validClassification(classification)) {
      ui.error(
        `Classification must be a non-empty string.`
      );
      return 2;
    }

    let body: string | undefined;
    const bodyFile = values["body-file"] as string | undefined;
    const bodyText = values["body-text"] as string | undefined;
    if (bodyFile && bodyText) {
      ui.error("Pass either --body-file or --body-text, not both.");
      return 2;
    }
    if (bodyFile) {
      try {
        body = await fs.readFile(bodyFile, "utf8");
      } catch (err) {
        ui.error(`Could not read --body-file: ${(err as Error).message}`);
        return 1;
      }
    } else if (bodyText) {
      body = bodyText;
    }

    try {
      const doc = await addDoc(workspaceRoot, {
        source,
        docId,
        title,
        overview: values.overview as string | undefined,
        classification: classification,
        link: values.link as string | undefined,
        parent: values.parent as string | undefined,
        fromSession: values["from-session"] as string | undefined,
        body,
        skipSourceValidation: values["no-validate-source"] === true,
      });
      ui.success(`Indexed doc ${ui.bold(doc.docId)} in source ${ui.bold(doc.source)}.`);
      if (isAgentMode()) {
        printAgentFollowUp(doc.source, doc.docId, { manual: false });
      }
      void mode;
      return 0;
    } catch (err) {
      if (err instanceof DocAlreadyExistsError || err instanceof DocReferenceValidationError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

// ============================================================
// Editor flow (interactive — opens $EDITOR on a summary scaffold)
// ============================================================

async function runEditorAdd(
  workspaceRoot: string,
  mode: InvocationMode
): Promise<number> {
  const session = new PromptSession();
  let source: string;
  let filename: string;
  let title: string;
  let link: string;
  try {
    // Source: prompt with a picker when multiple are registered.
    const sources = await listSources(workspaceRoot);
    if (sources.length === 0) {
      session.close();
      ui.error("No sources registered. Run `atelier source register <id> --name \"...\"` first.");
      return 1;
    }
    if (sources.length === 1) {
      source = sources[0].id;
    } else {
      const picked = await pickSourceOrAll(workspaceRoot, {
        question: "Which source does this doc belong to?",
        help: "The agent will use this source's config to fetch the doc when needed.",
        skipBelow: 0,
      });
      if (picked === null) {
        session.close();
        ui.print(`  ${ui.dim("Aborted.")}`);
        return 0;
      }
      if (!picked) {
        session.close();
        ui.error("A specific source is required for /doc add — not an 'all sources' filter.");
        return 2;
      }
      source = picked;
    }
    filename = (await session.ask("Filename (becomes the docId)")).trim();
    if (!filename) {
      session.close();
      ui.error("Filename is required.");
      return 2;
    }
    title = (await session.ask("Title (optional)", { default: filename })).trim();
    link = (await session.ask("Link / URL (optional)")).trim();
  } finally {
    session.close();
  }

  const docId = normalizeFilenameToDocId(filename);
  if (!docId) {
    ui.error(`Filename "${filename}" doesn't produce a usable docId.`);
    return 2;
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-edit-"));
  const tmpFile = path.join(tmpDir, docId + ".md");
  const scaffold = buildSummaryScaffold(title, link);
  await fs.writeFile(tmpFile, scaffold, "utf8");

  ui.print(`  ${ui.dim(`Opening ${editorCommandHint()} on ${tmpFile}…`)}`);
  try {
    await runEditorOnFile(tmpFile);
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    ui.error(`Editor failed: ${(err as Error).message}`);
    return 1;
  }

  const content = await fs.readFile(tmpFile, "utf8");
  await fs.rm(tmpDir, { recursive: true, force: true });

  if (content === scaffold || content.trim().length === 0) {
    ui.info("Nothing saved.");
    if (!hasWaitingEditor()) {
      ui.print(
        `  ${ui.dim("Hint: if your editor opens but returns immediately (VS Code, Sublime),")}`
      );
      ui.print(
        `  ${ui.dim('set EDITOR="code -w" or "subl -w" so atelier waits for you to save and close.')}`
      );
    }
    return 0;
  }

  try {
    await addDoc(workspaceRoot, {
      source,
      docId,
      title,
      link: link || undefined,
      body: content,
      skipSourceValidation: false,
    });
  } catch (err) {
    if (err instanceof DocAlreadyExistsError) {
      ui.error(
        `A doc with id "${docId}" already exists in source "${source}". Use a different filename or remove the existing entry first.`
      );
      return 1;
    }
    if (err instanceof DocReferenceValidationError) {
      ui.error(err.message);
      return 1;
    }
    throw err;
  }
  ui.success(`Added doc ${ui.bold(docId)} to source ${ui.bold(source)}.`);
  if (isAgentMode()) {
    printAgentFollowUp(source, docId, { manual: true });
  }
  void mode;
  return 0;
}

function buildSummaryScaffold(title: string, link: string): string {
  const lines: string[] = [`# ${title}`, ""];
  if (link) {
    lines.push(`> Source: ${link}`);
    lines.push("");
  }
  lines.push("## Overview");
  lines.push("");
  lines.push("<one or two sentences about what the document covers>");
  lines.push("");
  lines.push("## Keywords");
  lines.push("");
  lines.push("- ");
  lines.push("- ");
  lines.push("");
  lines.push("## Anchors");
  lines.push("");
  lines.push("- ");
  lines.push("");
  return lines.join("\n");
}

function runEditorOnFile(file: string): Promise<void> {
  const editorCmd = pickEditor();
  const [cmd, ...args] = editorCmd.split(/\s+/).filter(Boolean);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, [...args, file], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0 || code === null) resolve();
      else
        reject(
          new Error(
            `editor "${editorCmd}" exited with ${signal ? "signal " + signal : "code " + code}`
          )
        );
    });
  });
}

function pickEditor(): string {
  const fromEnv = ((process.env.VISUAL || process.env.EDITOR) ?? "").trim();
  if (fromEnv) return fromEnv;
  return process.platform === "win32" ? "notepad" : "vi";
}

function editorCommandHint(): string {
  const e = pickEditor();
  return e === "vi" || e === "notepad" ? `the default editor (${e})` : `\`${e}\``;
}

function hasWaitingEditor(): boolean {
  const e = pickEditor();
  if (/^(vi|vim|nvim|nano|emacs|pico|hx|helix|micro|notepad)/.test(e)) return true;
  if (/\b(-w|--wait)\b/.test(e)) return true;
  return false;
}

// ============================================================
// Agent follow-up
// ============================================================

/**
 * Structured next-step block for the AI agent watching the terminal.
 * Suppressed entirely outside agent mode (ATELIER_AGENT unset). Two
 * shapes depending on whether the doc was added manually:
 *
 *   - manual: true  → suggest renaming the docId if generic, then
 *                     write/refine summary, then map to features.
 *   - manual: false → agent provided the summary already; just the
 *                     filename + feature/spec mapping steps.
 */
function printAgentFollowUp(
  sourceId: string,
  docId: string,
  opts: { manual: boolean }
): void {
  const folder = `.atelier/docs/${sourceId}/${encodeDocFilenameStem(docId)}`;
  const docRef = `${sourceId}:${docId}`;
  ui.blank();
  ui.print(ui.bold("Next step for the assistant"));
  let step = 1;

  if (opts.manual) {
    ui.print(
      `  ${step}. Read the doc body. If the filename ${ui.cyan(`"${docId}"`)} looks generic`
    );
    ui.print(
      "     or doesn't reflect the content, propose a more descriptive slug:"
    );
    ui.print(
      `       ${ui.cyan(`/doc rename ${sourceId} ${docId} <better-slug>`)}`
    );
    ui.print(
      "     Confirm with the user before running. Continue the steps below"
    );
    ui.print("     with the new docId in the paths if you rename.");
    ui.blank();
    step++;
  }

  ui.print(
    `  ${step}. Refine the summary at:  ${ui.cyan(`${folder}/summary.md`)}`
  );
  ui.blank();
  ui.print("     The summary should include:");
  ui.print("       - A 1–2 sentence overview of what the document is about.");
  ui.print("       - 5–10 keywords under a `## Keywords` heading (topics, dates,");
  ui.print("         project names, people, decisions — for future agent discovery).");
  ui.print("       - The doc's anchor points under a `## Anchors` heading.");
  ui.blank();
  ui.print("     To re-read the original document, follow the `link` field in");
  ui.print("     the summary's front-matter using whichever source integration");
  ui.print("     applies (run `atelier source show " + sourceId + "` to see how to connect).");
  ui.blank();
  step++;

  ui.print(
    `  ${step}. Suggest how this doc maps to the workspace's features and specs.`
  );
  ui.print(`     Run:`);
  ui.print(`       ${ui.dim("/feature list")}     — see what's tracked`);
  ui.print(`       ${ui.dim("/spec list")}        — see active specs`);
  ui.blank();
  ui.print(
    "     If the doc describes work that's NOT yet tracked, propose creating"
  );
  ui.print("     a new entry with this doc already attached:");
  ui.print(
    `       ${ui.cyan(`/feature add "<name>" --doc ${docRef}`)}`
  );
  ui.print(
    `       ${ui.cyan(`/spec new "<title>" --doc ${docRef}`)}`
  );
  ui.blank();
  ui.print(
    "     If the doc informs an EXISTING feature/spec, append the doc ref"
  );
  ui.print(
    `     to its YAML directly: \`- {source: ${sourceId}, docId: "${docId}"}\``
  );
  ui.print("     under `docRefs:` in the entry's file.");
  ui.blank();
  ui.print(
    "     Always confirm the mapping with the user before running or editing."
  );
  ui.blank();
}

// ============================================================
// list / show / remove / update / rename
// ============================================================

const listCmd: Command = {
  name: "list",
  summary: "List indexed documents.",
  options: {
    source: { type: "string", short: "s" },
    classification: { type: "string", short: "c" },
  },
  async run({ values, cwd, mode }) {
    let sourceFilter = values.source as string | undefined;
    const classFilter = values.classification as string | undefined;
    if (classFilter !== undefined && !validClassification(classFilter)) {
      ui.error(
        `--classification must be a non-empty string.`
      );
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

    if (sourceFilter === undefined && mode === "repl") {
      const picked = await pickSourceOrAll(workspaceRoot, {
        question: "Filter to which source?",
        help: "Pick a source to narrow the list, or leave on 'All sources' for everything.",
      });
      if (picked === null) {
        ui.print(`  ${ui.dim("Aborted.")}`);
        return 0;
      }
      sourceFilter = picked;
    }

    const { docs, errors } = await listDocs(workspaceRoot, sourceFilter);
    const filtered = classFilter
      ? docs.filter((d) => d.doc.classification === classFilter)
      : docs;

    if (filtered.length === 0 && errors.length === 0) {
      if (sourceFilter || classFilter) {
        ui.info("No docs match the filter.");
      } else {
        const addHint = mode === "repl" ? "/doc add" : "atelier doc add";
        ui.info("No docs indexed yet.");
        ui.print(
          `  ${ui.dim(`Add one with \`${addHint}\` — the editor opens on a summary scaffold.`)}`
        );
      }
      return 0;
    }

    if (filtered.length > 0) {
      const sourceWidth = Math.max(
        "SOURCE".length,
        ...filtered.map((d) => d.doc.source.length)
      );
      const docIdWidth = Math.max(
        "DOC-ID".length,
        ...filtered.map((d) => d.doc.docId.length)
      );
      const classWidth = Math.max(
        "CLASS".length,
        ...filtered.map((d) => (d.doc.classification ?? "-").length)
      );
      ui.print(
        `    ${ui.dim("SOURCE".padEnd(sourceWidth))}  ${ui.dim("DOC-ID".padEnd(docIdWidth))}  ${ui.dim("CLASS".padEnd(classWidth))}  ${ui.dim("TITLE")}`
      );
      for (const { doc } of filtered) {
        const cls = doc.classification ?? "-";
        ui.print(
          `  ${ui.green("·")} ${doc.source.padEnd(sourceWidth)}  ${doc.docId.padEnd(docIdWidth)}  ${cls.padEnd(classWidth)}  ${doc.title}`
        );
      }
      ui.blank();
    }

    if (errors.length > 0) {
      ui.warn(`${errors.length} doc file(s) failed to parse:`);
      for (const e of errors) {
        ui.print(`    ${ui.red("✗")} ${e.filePath}`);
        ui.print(`      ${ui.dim(e.error.message.split("\n")[0])}`);
      }
      ui.blank();
    }
    return 0;
  },
};

const showCmd: Command = {
  name: "show",
  summary: "Show a doc's metadata and summary body.",
  positionals: ["source", "docId"],
  async run({ positionals, cwd }) {
    const [source, docId] = positionals;
    if (!source || !docId) {
      ui.error("Usage: atelier doc show <source> <docId>");
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
      const doc = await loadDoc(workspaceRoot, source, docId);
      ui.print(ui.bold(doc.title));
      ui.print(`  ${ui.dim("source:")}         ${doc.source}`);
      ui.print(`  ${ui.dim("docId:")}          ${doc.docId}`);
      if (doc.classification) {
        ui.print(`  ${ui.dim("classification:")} ${doc.classification}`);
      }
      if (doc.overview) ui.print(`  ${ui.dim("overview:")}       ${doc.overview}`);
      if (doc.link) ui.print(`  ${ui.dim("link:")}           ${doc.link}`);
      ui.print(`  ${ui.dim("created:")}        ${doc.createdAt}`);
      ui.print(`  ${ui.dim("updated:")}        ${doc.updatedAt}`);
      ui.blank();
      if (doc.body) {
        process.stdout.write(doc.body);
        if (!doc.body.endsWith("\n")) ui.blank();
      } else {
        ui.print(ui.dim("(empty summary)"));
      }
      return 0;
    } catch (err) {
      if (err instanceof DocNotFoundError || err instanceof DocFileError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

const removeCmd: Command = {
  name: "remove",
  summary: "Remove a doc from the index.",
  positionals: ["source", "docId"],
  async run({ positionals, cwd }) {
    const [source, docId] = positionals;
    if (!source || !docId) {
      ui.error("Usage: atelier doc remove <source> <docId>");
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
      const doc = await removeDoc(workspaceRoot, source, docId);
      ui.success(`Removed doc ${ui.bold(doc.docId)} from source ${ui.bold(doc.source)}.`);
      return 0;
    } catch (err) {
      if (err instanceof DocNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

const renameCmd: Command = {
  name: "rename",
  summary: "Rename a doc (change its docId / folder name).",
  positionals: ["source", "oldDocId", "newDocId"],
  async run({ positionals, cwd }) {
    const [source, oldDocId, newDocId] = positionals;
    if (!source || !oldDocId || !newDocId) {
      ui.error("Usage: atelier doc rename <source> <oldDocId> <newDocId>");
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
      const doc = await renameDoc(workspaceRoot, source, oldDocId, newDocId);
      ui.success(
        `Renamed ${ui.bold(oldDocId)} → ${ui.bold(doc.docId)} in source ${ui.bold(doc.source)}.`
      );
      return 0;
    } catch (err) {
      if (err instanceof DocNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      if (err instanceof DocAlreadyExistsError) {
        ui.error(
          `Can't rename: a doc with id "${newDocId}" already exists in source "${source}".`
        );
        return 1;
      }
      throw err;
    }
  },
};

const updateCmd: Command = {
  name: "update",
  summary: "Update a doc's metadata or summary body.",
  positionals: ["source", "docId"],
  options: {
    title: { type: "string", short: "t" },
    overview: { type: "string" },
    classification: { type: "string", short: "c" },
    link: { type: "string", short: "l" },
    "body-file": { type: "string" },
    "body-text": { type: "string" },
  },
  async run({ positionals, values, cwd }) {
    const [source, docId] = positionals;
    if (!source || !docId) {
      ui.error("Usage: atelier doc update <source> <docId> [options]");
      return 2;
    }
    const classification = values.classification as string | undefined;
    if (classification !== undefined && classification !== "" && !validClassification(classification)) {
      ui.error(
        `Classification must be a non-empty string.`
      );
      return 2;
    }
    const bodyFile = values["body-file"] as string | undefined;
    const bodyText = values["body-text"] as string | undefined;
    if (bodyFile && bodyText) {
      ui.error("Pass either --body-file or --body-text, not both.");
      return 2;
    }
    let body: string | undefined;
    if (bodyFile) {
      try {
        body = await fs.readFile(bodyFile, "utf8");
      } catch (err) {
        ui.error(`Could not read --body-file: ${(err as Error).message}`);
        return 1;
      }
    } else if (bodyText) {
      body = bodyText;
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
      const doc = await updateDoc(workspaceRoot, source, docId, {
        title: values.title as string | undefined,
        overview: values.overview as string | undefined,
        classification:
          classification === undefined
            ? undefined
            : classification === ""
              ? null
              : classification,
        link: values.link as string | undefined,
        body,
      });
      ui.success(`Updated doc ${ui.bold(doc.docId)} in source ${ui.bold(doc.source)}.`);
      return 0;
    } catch (err) {
      if (err instanceof DocNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

export const docCommand: Command = {
  name: "doc",
  summary: "Manage the doc map.",
  description:
    "Atelier's doc map is an agent-curated index of summaries — each entry\n" +
    "captures a title, an optional link the agent uses to refetch the\n" +
    "original, and a markdown summary body. The agent does the fetching;\n" +
    "atelier just stores what the agent wrote.",
  subcommands: [addCmd, listCmd, showCmd, updateCmd, renameCmd, removeCmd],
};
