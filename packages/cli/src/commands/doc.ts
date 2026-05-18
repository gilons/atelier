import * as fs from "node:fs/promises";
import {
  requireWorkspaceRoot,
  addDoc,
  listDocs,
  loadDoc,
  removeDoc,
  updateDoc,
  DOC_CLASSIFICATIONS,
  DocAlreadyExistsError,
  DocNotFoundError,
  DocFileError,
  DocReferenceValidationError,
  NotInsideWorkspaceError,
  type DocClassification,
} from "@atelier/core";
import type { Command } from "../command.js";
import { ui } from "../ui.js";

function validClassification(s: string): s is DocClassification {
  return (DOC_CLASSIFICATIONS as readonly string[]).includes(s);
}

const addCmd: Command = {
  name: "add",
  summary: "Index a document in the doc map.",
  description:
    "Adds an entry to .atelier/docs/<source>/<doc-id>.md with the\n" +
    "metadata you provide. The source must be registered (see\n" +
    "`atelier source list`). For Slice 6 we register entries manually;\n" +
    "Slice 8's sync engine will populate this automatically.\n\n" +
    "If --body-file is given, its content is stored as the document\n" +
    "body. Otherwise the body is empty and you can fill it in later.",
  options: {
    source: { type: "string", short: "s" },
    "doc-id": { type: "string" },
    title: { type: "string", short: "t" },
    summary: { type: "string" },
    classification: { type: "string", short: "c" },
    url: { type: "string", short: "u" },
    "body-file": { type: "string" },
    "no-validate-source": { type: "boolean" },
  },
  async run({ values, cwd }) {
    const source = values.source as string | undefined;
    const docId = values["doc-id"] as string | undefined;
    const title = values.title as string | undefined;
    if (!source || !docId || !title) {
      ui.error("Missing required option(s).");
      ui.print(
        `  ${ui.dim("Usage: atelier doc add --source <id> --doc-id <id> --title <title> [options]")}`
      );
      return 2;
    }
    const classification = values.classification as string | undefined;
    if (classification !== undefined && !validClassification(classification)) {
      ui.error(
        `Invalid classification "${classification}". Valid: ${DOC_CLASSIFICATIONS.join(", ")}.`
      );
      return 2;
    }

    let body: string | undefined;
    if (values["body-file"]) {
      try {
        body = await fs.readFile(values["body-file"] as string, "utf8");
      } catch (err) {
        ui.error(`Could not read --body-file: ${(err as Error).message}`);
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
      const doc = await addDoc(workspaceRoot, {
        source,
        docId,
        title,
        summary: values.summary as string | undefined,
        classification: classification as DocClassification | undefined,
        url: values.url as string | undefined,
        body,
        fetchedAt: body !== undefined ? new Date().toISOString() : undefined,
        skipSourceValidation: values["no-validate-source"] === true,
      });
      ui.success(`Indexed doc ${ui.bold(doc.docId)} in source ${ui.bold(doc.source)}`);
      ui.blank();
      ui.print(`  ${ui.dim("Title:")}          ${doc.title}`);
      if (doc.summary) ui.print(`  ${ui.dim("Summary:")}        ${doc.summary}`);
      if (doc.classification) {
        ui.print(`  ${ui.dim("Classification:")} ${doc.classification}`);
      }
      if (doc.url) ui.print(`  ${ui.dim("URL:")}            ${doc.url}`);
      ui.blank();
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
  summary: "List indexed documents.",
  options: {
    source: { type: "string", short: "s" },
    classification: { type: "string", short: "c" },
  },
  async run({ values, cwd, mode }) {
    const sourceFilter = values.source as string | undefined;
    const classFilter = values.classification as string | undefined;
    if (classFilter !== undefined && !validClassification(classFilter)) {
      ui.error(
        `Invalid --classification "${classFilter}". Valid: ${DOC_CLASSIFICATIONS.join(", ")}.`
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

    const { docs, errors } = await listDocs(workspaceRoot, sourceFilter);
    const filtered = classFilter
      ? docs.filter((d) => d.doc.classification === classFilter)
      : docs;

    if (filtered.length === 0 && errors.length === 0) {
      if (sourceFilter || classFilter) {
        ui.info("No docs match the filter.");
      } else {
        const syncHint = mode === "repl" ? "/sync" : "atelier sync";
        ui.info("No docs indexed yet.");
        ui.print(
          `  ${ui.dim(`Run \`${syncHint}\` to pull from registered sources.`)}`
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
  summary: "Show a doc's metadata and body.",
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
      if (doc.summary) ui.print(`  ${ui.dim("summary:")}        ${doc.summary}`);
      if (doc.url) ui.print(`  ${ui.dim("url:")}            ${doc.url}`);
      if (doc.lastFetched) {
        ui.print(`  ${ui.dim("lastFetched:")}    ${doc.lastFetched}`);
      }
      if (doc.contentHash) {
        ui.print(`  ${ui.dim("contentHash:")}    ${doc.contentHash}`);
      }
      ui.print(`  ${ui.dim("created:")}        ${doc.createdAt}`);
      ui.print(`  ${ui.dim("updated:")}        ${doc.updatedAt}`);
      ui.blank();
      if (doc.body) {
        process.stdout.write(doc.body);
        if (!doc.body.endsWith("\n")) ui.blank();
      } else {
        ui.print(ui.dim("(empty body)"));
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
      ui.success(`Removed doc ${ui.bold(doc.docId)} from source ${ui.bold(doc.source)}`);
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

const updateCmd: Command = {
  name: "update",
  summary: "Update a doc's metadata or body.",
  description:
    "Patches selected fields on an existing doc entry. Body is read from\n" +
    "the file at --body-file when present; passing it always refreshes\n" +
    "lastFetched and contentHash.",
  positionals: ["source", "docId"],
  options: {
    title: { type: "string", short: "t" },
    summary: { type: "string" },
    classification: { type: "string", short: "c" },
    url: { type: "string", short: "u" },
    "body-file": { type: "string" },
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
        `Invalid classification "${classification}". Valid: ${DOC_CLASSIFICATIONS.join(", ")}.`
      );
      return 2;
    }

    let body: string | undefined;
    if (values["body-file"]) {
      try {
        body = await fs.readFile(values["body-file"] as string, "utf8");
      } catch (err) {
        ui.error(`Could not read --body-file: ${(err as Error).message}`);
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
      const doc = await updateDoc(workspaceRoot, source, docId, {
        title: values.title as string | undefined,
        summary: values.summary as string | undefined,
        classification:
          classification === undefined
            ? undefined
            : classification === ""
              ? null
              : (classification as DocClassification),
        url: values.url as string | undefined,
        body,
      });
      ui.success(`Updated doc ${ui.bold(doc.docId)} in source ${ui.bold(doc.source)}`);
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
    "The doc map is Atelier's index of every document a feature might\n" +
    "reference: PRDs, RFCs, runbooks, policies. Each entry lives at\n" +
    ".atelier/docs/<source>/<doc-id>.md with structured metadata and\n" +
    "the document body. Slice 8 will populate this automatically from\n" +
    "registered sources; today entries are added manually.",
  subcommands: [addCmd, listCmd, showCmd, updateCmd, removeCmd],
};
