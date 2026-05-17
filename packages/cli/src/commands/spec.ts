import * as path from "node:path";
import {
  requireWorkspaceRoot,
  createSpec,
  listSpecs,
  loadSpec,
  updateSpec,
  removeSpec,
  SPEC_CHANGE_TYPES,
  SPEC_STATUSES,
  SpecAlreadyExistsError,
  SpecNotFoundError,
  SpecReferenceValidationError,
  SpecFileError,
  NotInsideWorkspaceError,
  type FeatureCodeRef,
  type FeatureDocRef,
  type SpecChangeType,
  type SpecStatus,
} from "@atelier/core";
import type { Command } from "../command.js";
import { ui } from "../ui.js";

/**
 * `atelier spec` — create the scaffolded issue folder for a change,
 * with an adaptive spec.md template, a curated context.md, and a
 * prompt.md ready to hand to a coding agent.
 */

function validType(s: string): s is SpecChangeType {
  return (SPEC_CHANGE_TYPES as readonly string[]).includes(s);
}
function validStatus(s: string): s is SpecStatus {
  return (SPEC_STATUSES as readonly string[]).includes(s);
}

function parseCodeRefs(raw: unknown): FeatureCodeRef[] {
  if (raw === undefined) return [];
  const values = Array.isArray(raw) ? (raw as string[]) : [raw as string];
  return values.map((v, idx) => {
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`--code value ${idx + 1} must be a non-empty string`);
    }
    const colon = v.indexOf(":");
    if (colon === -1) return { repo: v };
    return { repo: v.slice(0, colon), path: v.slice(colon + 1) || undefined };
  });
}

function parseDocRefs(raw: unknown): FeatureDocRef[] {
  if (raw === undefined) return [];
  const values = Array.isArray(raw) ? (raw as string[]) : [raw as string];
  return values.map((v, idx) => {
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`--doc value ${idx + 1} must be a non-empty string`);
    }
    const parts = v.split(":");
    if (parts.length < 2 || !parts[0] || !parts[1]) {
      throw new Error(
        `--doc value ${idx + 1} must be "source:docId[:title]"`
      );
    }
    const [source, docId, ...rest] = parts;
    const title = rest.length > 0 ? rest.join(":") : undefined;
    return { source, docId, title };
  });
}

const newCmd: Command = {
  name: "new",
  summary: "Scaffold a new spec / issue folder.",
  description:
    "Creates .planning/issues/<id>/ with README.md, spec.md, context.md\n" +
    "and prompt.md. The change --type controls which spec template is used:\n" +
    SPEC_CHANGE_TYPES.map((t) => `  · ${t}`).join("\n") +
    "\n\n--feature pulls in code/doc refs from a registered feature.\n" +
    "--code and --doc add ad-hoc references on top.",
  options: {
    title: { type: "string", short: "t" },
    type: { type: "string" },
    id: { type: "string" },
    status: { type: "string", short: "s" },
    feature: { type: "string", multiple: true, short: "f" },
    code: { type: "string", multiple: true },
    doc: { type: "string", multiple: true },
    "no-validate-refs": { type: "boolean" },
  },
  positionals: ["title?"],
  prompts: [
    {
      key: "title",
      question: 'One-line description of the change (e.g. "Add CSV export")',
      help: "Becomes the spec's title + the basis for the issue id.",
      positionalIndex: 0,
      validate: /\S/,
    },
    {
      key: "type",
      question: "Change type",
      help: "Picks the spec.md template.",
      choices: SPEC_CHANGE_TYPES.map((t) => ({ label: t, value: t })),
    },
  ],
  async run({ values, positionals, cwd }) {
    const title = (values.title as string | undefined) ?? positionals[0];
    if (!title) {
      ui.error("Missing spec title.");
      ui.print(
        `  ${ui.dim('Usage: atelier spec new "Add CSV export" --type new-feature [options]')}`
      );
      ui.print(`  ${ui.dim("Types: " + SPEC_CHANGE_TYPES.join(", "))}`);
      return 2;
    }
    const type = values.type as string | undefined;
    if (!type || !validType(type)) {
      ui.error(
        `Missing or invalid --type. Valid: ${SPEC_CHANGE_TYPES.join(", ")}.`
      );
      return 2;
    }
    const status = values.status as string | undefined;
    if (status !== undefined && !validStatus(status)) {
      ui.error(`Invalid --status "${status}". Valid: ${SPEC_STATUSES.join(", ")}.`);
      return 2;
    }
    let codeRefs: FeatureCodeRef[];
    let docRefs: FeatureDocRef[];
    try {
      codeRefs = parseCodeRefs(values.code);
      docRefs = parseDocRefs(values.doc);
    } catch (err) {
      ui.error((err as Error).message);
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

    const features = (values.feature as string[] | undefined) ?? [];

    try {
      const { manifest, paths } = await createSpec(workspaceRoot, {
        title,
        type,
        id: values.id as string | undefined,
        status: status as SpecStatus | undefined,
        features,
        codeRefs,
        docRefs,
        skipReferenceValidation: values["no-validate-refs"] === true,
      });
      ui.success(`Scaffolded spec ${ui.bold(manifest.id)}`);
      ui.blank();
      ui.print(`  ${ui.dim("Type:")}     ${manifest.type}`);
      ui.print(`  ${ui.dim("Status:")}   ${manifest.status}`);
      ui.print(
        `  ${ui.dim("Folder:")}   ${path.relative(workspaceRoot, paths.root)}/`
      );
      ui.blank();
      ui.print(`  ${ui.dim("Next:")} open these files to flesh out the plan.`);
      ui.print(`    ${ui.cyan(path.relative(workspaceRoot, paths.spec))}`);
      ui.print(`    ${ui.cyan(path.relative(workspaceRoot, paths.context))}`);
      ui.print(`    ${ui.cyan(path.relative(workspaceRoot, paths.prompt))}`);
      ui.blank();
      return 0;
    } catch (err) {
      if (
        err instanceof SpecAlreadyExistsError ||
        err instanceof SpecReferenceValidationError
      ) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

const listCmd: Command = {
  name: "list",
  summary: "List specs / issue folders.",
  options: {
    status: { type: "string", short: "s" },
    type: { type: "string" },
  },
  async run({ values, cwd, mode }) {
    const status = values.status as string | undefined;
    if (status !== undefined && !validStatus(status)) {
      ui.error(`Invalid --status "${status}".`);
      return 2;
    }
    const type = values.type as string | undefined;
    if (type !== undefined && !validType(type)) {
      ui.error(`Invalid --type "${type}".`);
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

    const { specs, errors } = await listSpecs(workspaceRoot);
    const filtered = specs
      .filter((s) => !status || s.manifest.status === status)
      .filter((s) => !type || s.manifest.type === type);

    if (filtered.length === 0 && errors.length === 0) {
      ui.info(specs.length === 0 ? "No specs yet." : "No specs match the filter.");
      if (specs.length === 0) {
        const newHint = mode === "repl" ? "/spec new" : "atelier spec new";
        ui.print(`  ${ui.dim(`Use \`${newHint}\` to scaffold the first one.`)}`);
      }
      return 0;
    }

    if (filtered.length > 0) {
      const idWidth = Math.max("ID".length, ...filtered.map((s) => s.manifest.id.length));
      const typeWidth = Math.max(
        "TYPE".length,
        ...filtered.map((s) => s.manifest.type.length)
      );
      const statusWidth = Math.max(
        "STATUS".length,
        ...filtered.map((s) => s.manifest.status.length)
      );
      ui.print(
        `    ${ui.dim("ID".padEnd(idWidth))}  ${ui.dim("TYPE".padEnd(typeWidth))}  ${ui.dim("STATUS".padEnd(statusWidth))}  ${ui.dim("TITLE")}`
      );
      for (const { manifest } of filtered) {
        ui.print(
          `  ${ui.green("·")} ${manifest.id.padEnd(idWidth)}  ${manifest.type.padEnd(typeWidth)}  ${manifest.status.padEnd(statusWidth)}  ${manifest.title}`
        );
      }
      ui.blank();
    }
    if (errors.length > 0) {
      ui.warn(`${errors.length} spec folder(s) failed to parse:`);
      for (const e of errors) {
        ui.print(`    ${ui.red("✗")} ${e.dir}`);
        ui.print(`      ${ui.dim(e.error.message.split("\n")[0])}`);
      }
    }
    return 0;
  },
};

const showCmd: Command = {
  name: "show",
  summary: "Show a spec's manifest.",
  positionals: ["id"],
  async run({ positionals, cwd }) {
    const [id] = positionals;
    if (!id) {
      ui.error("Usage: atelier spec show <id>");
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
      const m = await loadSpec(workspaceRoot, id);
      ui.print(ui.bold(m.title));
      ui.print(`  ${ui.dim("id:")}        ${m.id}`);
      ui.print(`  ${ui.dim("type:")}      ${m.type}`);
      ui.print(`  ${ui.dim("status:")}    ${m.status}`);
      if (m.features.length > 0) {
        ui.print(`  ${ui.dim("features:")}  ${m.features.join(", ")}`);
      }
      if (m.codeRefs.length > 0) {
        ui.print(`  ${ui.dim("code refs:")}`);
        for (const r of m.codeRefs) {
          const tail = r.path ? `:${r.path}` : "";
          ui.print(`    ${ui.dim("·")} ${r.repo}${tail}`);
        }
      }
      if (m.docRefs.length > 0) {
        ui.print(`  ${ui.dim("doc refs:")}`);
        for (const r of m.docRefs) {
          ui.print(`    ${ui.dim("·")} ${r.source}:${r.docId}`);
        }
      }
      ui.print(`  ${ui.dim("created:")}   ${m.createdAt}`);
      ui.print(`  ${ui.dim("updated:")}   ${m.updatedAt}`);
      ui.blank();
      return 0;
    } catch (err) {
      if (err instanceof SpecNotFoundError || err instanceof SpecFileError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

const setStatusCmd: Command = {
  name: "set-status",
  summary: "Change a spec's status.",
  positionals: ["id", "status"],
  async run({ positionals, cwd }) {
    const [id, status] = positionals;
    if (!id || !status) {
      ui.error(`Usage: atelier spec set-status <id> <${SPEC_STATUSES.join("|")}>`);
      return 2;
    }
    if (!validStatus(status)) {
      ui.error(`Invalid status "${status}". Valid: ${SPEC_STATUSES.join(", ")}.`);
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
      const m = await updateSpec(workspaceRoot, id, { status });
      ui.success(`Set ${ui.bold(m.id)} → ${m.status}`);
      return 0;
    } catch (err) {
      if (err instanceof SpecNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

const removeCmd: Command = {
  name: "remove",
  summary: "Delete a spec folder.",
  positionals: ["id"],
  async run({ positionals, cwd }) {
    const [id] = positionals;
    if (!id) {
      ui.error("Usage: atelier spec remove <id>");
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
      const m = await removeSpec(workspaceRoot, id);
      ui.success(`Removed spec ${ui.bold(m.id)}`);
      return 0;
    } catch (err) {
      if (err instanceof SpecNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

export const specCommand: Command = {
  name: "spec",
  summary: "Manage spec / issue folders for planned changes.",
  description:
    "A spec is a folder under .planning/issues/<id>/ that bundles a\n" +
    "templated plan, curated context (related features, doc refs, code\n" +
    "refs), and a handoff prompt ready to feed to a coding agent.",
  subcommands: [newCmd, listCmd, showCmd, setStatusCmd, removeCmd],
};
