import * as fs from "node:fs/promises";
import {
  requireWorkspaceRoot,
  addDoc,
  listDocs,
  loadDoc,
  removeDoc,
  renameDoc,
  updateDoc,
  DocAlreadyExistsError,
  DocNotFoundError,
  DocFileError,
  DocReferenceValidationError,
  NotInsideWorkspaceError,
} from "@atelier/core";
import type { Command } from "../command.js";
import { ui } from "../ui.js";

/**
 * `atelier doc` — the documentation surface.
 *
 * Knowledge artifacts (PRDs, RFCs, runbooks, transcripts) the agent
 * has indexed: an agent-curated summary + a `link` back to the source.
 * One of the typed surfaces that replaces the generic `item`. Atelier
 * never fetches the source; the agent does, via its own integrations.
 *
 *   atelier doc add <source>:<docId> --title "..." [--link <url>]
 *     [--overview "..."] [--class prd] [--owner sarah-chen]
 *     [--body-text "..." | --body-file <path>]
 */

function parseRef(ref: string): { source: string; docId: string } | null {
  const i = ref.indexOf(":");
  if (i <= 0 || i === ref.length - 1) return null;
  return { source: ref.slice(0, i), docId: ref.slice(i + 1) };
}

async function resolveRoot(cwd: string): Promise<string | number> {
  try {
    return await requireWorkspaceRoot(cwd);
  } catch (err) {
    if (err instanceof NotInsideWorkspaceError) {
      ui.error(err.message);
      return 1;
    }
    throw err;
  }
}

const addCmd: Command = {
  name: "add",
  summary: "Index a documentation entry (agent-curated summary + link).",
  description:
    "Creates .atelier/documentation/<source>/<docId>/summary.md. The\n" +
    "agent fetched the doc via its own integration, wrote the summary,\n" +
    "and records --link so it can re-read the original later.",
  positionals: ["ref"],
  options: {
    title: { type: "string", short: "t" },
    overview: { type: "string", short: "o" },
    class: { type: "string", short: "c" },
    link: { type: "string", short: "l" },
    owner: { type: "string" },
    "from-session": { type: "string" },
    "body-text": { type: "string" },
    "body-file": { type: "string" },
    "no-validate-source": { type: "boolean" },
  },
  async run({ values, positionals, cwd }) {
    const ref = parseRef(positionals[0] ?? "");
    if (!ref) {
      ui.error("Missing or malformed <source>:<docId>.");
      ui.print(`  ${ui.dim('Usage: atelier doc add notion:prd-123 --title "Onboarding PRD" --link <url>')}`);
      return 2;
    }
    const title = values.title as string | undefined;
    if (!title) {
      ui.error("Missing --title.");
      return 2;
    }
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;

    let body = (values["body-text"] as string | undefined) ?? "";
    const bodyFile = values["body-file"] as string | undefined;
    if (bodyFile) {
      try {
        body = await fs.readFile(bodyFile, "utf8");
      } catch (err) {
        ui.error(`Couldn't read --body-file: ${(err as Error).message}`);
        return 2;
      }
    }

    try {
      const doc = await addDoc(root, {
        source: ref.source,
        docId: ref.docId,
        title,
        overview: values.overview as string | undefined,
        classification: values.class as string | undefined,
        link: values.link as string | undefined,
        owner: values.owner as string | undefined,
        fromSession: values["from-session"] as string | undefined,
        body,
        skipSourceValidation: values["no-validate-source"] === true,
      });
      ui.success(`Indexed documentation ${ui.bold(`${doc.source}:${doc.docId}`)}`);
      ui.print(`  ${ui.dim("title:")} ${doc.title}`);
      if (doc.classification) ui.print(`  ${ui.dim("class:")} ${doc.classification}`);
      if (doc.owner) ui.print(`  ${ui.dim("owner:")} ${doc.owner}`);
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

const listCmd: Command = {
  name: "list",
  summary: "List indexed documentation.",
  options: { source: { type: "string", short: "s" }, class: { type: "string", short: "c" } },
  async run({ values, cwd, mode }) {
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;
    const { docs, errors } = await listDocs(root, values.source as string | undefined);
    const classFilter = values.class as string | undefined;
    const shown = classFilter ? docs.filter((d) => d.doc.classification === classFilter) : docs;

    if (shown.length === 0 && errors.length === 0) {
      const hint = mode === "repl" ? "/doc add" : "atelier doc add";
      ui.info("No documentation indexed.");
      ui.print(`  ${ui.dim(`Use \`${hint} <source>:<id> --title "..."\`.`)}`);
      return 0;
    }
    for (const { doc } of shown) {
      const cls = doc.classification ? ` ${ui.dim("[" + doc.classification + "]")}` : "";
      ui.print(`  ${ui.green("·")} ${doc.source}:${doc.docId}${cls}  ${doc.title}`);
    }
    ui.blank();
    if (errors.length > 0) {
      ui.warn(`${errors.length} documentation file(s) failed to parse:`);
      for (const e of errors) ui.print(`    ${ui.red("✗")} ${e.filePath}`);
    }
    return 0;
  },
};

const showCmd: Command = {
  name: "show",
  summary: "Show a documentation entry's summary.",
  positionals: ["ref"],
  async run({ positionals, cwd }) {
    const ref = parseRef(positionals[0] ?? "");
    if (!ref) {
      ui.error("Usage: atelier doc show <source>:<docId>");
      return 2;
    }
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;
    try {
      const doc = await loadDoc(root, ref.source, ref.docId);
      ui.print(ui.bold(doc.title));
      ui.print(`  ${ui.dim("ref:")}     ${doc.source}:${doc.docId}`);
      if (doc.classification) ui.print(`  ${ui.dim("class:")}   ${doc.classification}`);
      if (doc.link) ui.print(`  ${ui.dim("link:")}    ${doc.link}`);
      if (doc.owner) ui.print(`  ${ui.dim("owner:")}   ${doc.owner}`);
      if (doc.fromSession) ui.print(`  ${ui.dim("session:")} ${doc.fromSession}`);
      ui.print(`  ${ui.dim("updated:")} ${doc.updatedAt}`);
      ui.blank();
      process.stdout.write(doc.body);
      if (!doc.body.endsWith("\n")) ui.blank();
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

const updateCmd: Command = {
  name: "update",
  summary: "Update a documentation entry's fields.",
  positionals: ["ref"],
  options: {
    title: { type: "string", short: "t" },
    overview: { type: "string", short: "o" },
    class: { type: "string", short: "c" },
    "clear-class": { type: "boolean" },
    link: { type: "string", short: "l" },
    owner: { type: "string" },
    "clear-owner": { type: "boolean" },
  },
  async run({ values, positionals, cwd }) {
    const ref = parseRef(positionals[0] ?? "");
    if (!ref) {
      ui.error("Usage: atelier doc update <source>:<docId> [--title ...]");
      return 2;
    }
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;
    try {
      const next = await updateDoc(root, ref.source, ref.docId, {
        title: values.title as string | undefined,
        overview: values.overview as string | undefined,
        classification: values["clear-class"] === true ? null : (values.class as string | undefined),
        link: values.link as string | undefined,
        owner: values["clear-owner"] === true ? null : (values.owner as string | undefined),
      });
      ui.success(`Updated ${ui.bold(`${next.source}:${next.docId}`)}`);
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
  summary: "Rename a documentation entry's docId.",
  positionals: ["ref", "new-id"],
  async run({ positionals, cwd }) {
    const ref = parseRef(positionals[0] ?? "");
    const newId = positionals[1];
    if (!ref || !newId) {
      ui.error("Usage: atelier doc rename <source>:<docId> <new-docId>");
      return 2;
    }
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;
    try {
      const next = await renameDoc(root, ref.source, ref.docId, newId);
      ui.success(`Renamed to ${ui.bold(`${next.source}:${next.docId}`)}`);
      return 0;
    } catch (err) {
      if (err instanceof DocNotFoundError || err instanceof DocAlreadyExistsError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

const removeCmd: Command = {
  name: "remove",
  summary: "Delete a documentation entry.",
  positionals: ["ref"],
  async run({ positionals, cwd }) {
    const ref = parseRef(positionals[0] ?? "");
    if (!ref) {
      ui.error("Usage: atelier doc remove <source>:<docId>");
      return 2;
    }
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;
    try {
      const removed = await removeDoc(root, ref.source, ref.docId);
      ui.success(`Removed ${ui.bold(`${removed.source}:${removed.docId}`)}`);
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
  summary: "Index documentation — PRDs, RFCs, runbooks, transcripts.",
  description:
    "The documentation surface. Each entry is an agent-curated summary +\n" +
    "a link back to the source (atelier doesn't store the source itself).\n" +
    "One of the typed surfaces replacing the generic item.",
  subcommands: [addCmd, listCmd, showCmd, updateCmd, renameCmd, removeCmd],
};
