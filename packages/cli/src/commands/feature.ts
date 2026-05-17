import {
  requireWorkspaceRoot,
  addFeature,
  listFeatures,
  loadFeature,
  removeFeature,
  FEATURE_STATUSES,
  FeatureAlreadyExistsError,
  FeatureNotFoundError,
  FeatureFileError,
  FeatureReferenceValidationError,
  NotInsideWorkspaceError,
  type FeatureCodeRef,
  type FeatureDocRef,
  type FeatureStatus,
} from "@atelier/core";
import type { Command } from "../command.js";
import { ui } from "../ui.js";

/**
 * `--code` flag: `repo[:path]` — referenced repo, optionally a path
 * within it. Repeatable.
 */
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

/**
 * `--doc` flag: `source:docId[:title]` — pointer to an entry in the
 * doc map. Repeatable. Title is optional.
 */
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
        `--doc value ${idx + 1} must be in the form "source:docId" or "source:docId:title"`
      );
    }
    const [source, docId, ...rest] = parts;
    const title = rest.length > 0 ? rest.join(":") : undefined;
    return { source, docId, title };
  });
}

const addCmd: Command = {
  name: "add",
  summary: "Add a new feature to the feature map.",
  description:
    "Creates `.planning/features/<id>.md` with a YAML front-matter block\n" +
    "and a stub body. The id is derived from the name unless --id is given.\n\n" +
    "Code refs (--code) must point at registered repos; doc refs (--doc)\n" +
    "must point at registered sources. Pass --no-validate-refs to skip\n" +
    "those cross-checks (useful when bootstrapping).",
  options: {
    name: { type: "string", short: "n" },
    id: { type: "string" },
    status: { type: "string", short: "s" },
    description: { type: "string", short: "d" },
    code: { type: "string", multiple: true },
    doc: { type: "string", multiple: true },
    "no-validate-refs": { type: "boolean" },
  },
  positionals: ["name?"],
  prompts: [
    {
      key: "name",
      question: 'Feature name (e.g. "CSV Export")',
      help: "Becomes the H1 in the feature file. Slug is derived from this.",
      positionalIndex: 0,
      validate: /\S/,
    },
  ],
  async run({ values, positionals, cwd }) {
    const name = (values.name as string | undefined) ?? positionals[0];
    if (!name) {
      ui.error("Missing feature name.");
      ui.print(
        `  ${ui.dim('Usage: atelier feature add "Feature Name" [--id <slug>] [--status <s>]')}`
      );
      ui.print(`  ${ui.dim("Statuses: " + FEATURE_STATUSES.join(", "))}`);
      return 2;
    }

    const status = values.status as FeatureStatus | undefined;
    if (status !== undefined && !FEATURE_STATUSES.includes(status)) {
      ui.error(
        `Invalid status "${status}". Valid: ${FEATURE_STATUSES.join(", ")}.`
      );
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

    try {
      const feature = await addFeature(workspaceRoot, {
        name,
        id: values.id as string | undefined,
        status,
        description: values.description as string | undefined,
        codeRefs,
        docRefs,
        skipReferenceValidation: values["no-validate-refs"] === true,
      });
      ui.success(`Added feature ${ui.bold(feature.id)}`);
      ui.blank();
      ui.print(`  ${ui.dim("Name:")}        ${feature.name}`);
      ui.print(`  ${ui.dim("Status:")}      ${feature.status}`);
      if (feature.description) {
        ui.print(`  ${ui.dim("Description:")} ${feature.description}`);
      }
      if (feature.codeRefs.length > 0) {
        ui.print(`  ${ui.dim("Code refs:")}`);
        for (const r of feature.codeRefs) {
          const tail = r.path ? `:${r.path}` : "";
          ui.print(`    ${ui.dim("·")} ${r.repo}${tail}`);
        }
      }
      if (feature.docRefs.length > 0) {
        ui.print(`  ${ui.dim("Doc refs:")}`);
        for (const r of feature.docRefs) {
          const tail = r.title ? `  ${ui.dim(r.title)}` : "";
          ui.print(`    ${ui.dim("·")} ${r.source}:${r.docId}${tail}`);
        }
      }
      ui.blank();
      ui.print(
        `  ${ui.dim("→ Open .planning/features/" + feature.id + ".md to flesh out the body.")}`
      );
      ui.blank();
      return 0;
    } catch (err) {
      if (
        err instanceof FeatureAlreadyExistsError ||
        err instanceof FeatureReferenceValidationError
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
  summary: "List all features in the workspace.",
  options: {
    status: { type: "string", short: "s" },
  },
  async run({ values, cwd }) {
    const filter = values.status as FeatureStatus | undefined;
    if (filter !== undefined && !FEATURE_STATUSES.includes(filter)) {
      ui.error(`Invalid --status "${filter}". Valid: ${FEATURE_STATUSES.join(", ")}.`);
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

    const { features, errors } = await listFeatures(workspaceRoot);
    if (features.length === 0 && errors.length === 0) {
      ui.info("No features yet.");
      ui.print(`  ${ui.dim('Use `atelier feature add "<name>"` to create one.')}`);
      return 0;
    }

    const shown = filter ? features.filter((f) => f.feature.status === filter) : features;
    if (shown.length === 0) {
      ui.info(`No features with status "${filter}".`);
    } else {
      const idWidth = Math.max("ID".length, ...shown.map((f) => f.feature.id.length));
      const statusWidth = Math.max(
        "STATUS".length,
        ...shown.map((f) => f.feature.status.length)
      );
      ui.print(
        `    ${ui.dim("ID".padEnd(idWidth))}  ${ui.dim("STATUS".padEnd(statusWidth))}  ${ui.dim("NAME")}`
      );
      for (const { feature } of shown) {
        ui.print(
          `  ${ui.green("·")} ${feature.id.padEnd(idWidth)}  ${feature.status.padEnd(statusWidth)}  ${feature.name}`
        );
      }
      ui.blank();
    }

    if (errors.length > 0) {
      ui.warn(`${errors.length} feature file(s) failed to parse:`);
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
  summary: "Show a feature's details and body.",
  positionals: ["id"],
  async run({ positionals, cwd }) {
    const [id] = positionals;
    if (!id) {
      ui.error("Missing <id> argument.");
      ui.print(`  ${ui.dim("Usage: atelier feature show <id>")}`);
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
      const feature = await loadFeature(workspaceRoot, id);
      ui.print(ui.bold(feature.name));
      ui.print(`  ${ui.dim("id:")}        ${feature.id}`);
      ui.print(`  ${ui.dim("status:")}    ${feature.status}`);
      if (feature.description) {
        ui.print(`  ${ui.dim("summary:")}   ${feature.description}`);
      }
      ui.print(`  ${ui.dim("created:")}   ${feature.createdAt}`);
      ui.print(`  ${ui.dim("updated:")}   ${feature.updatedAt}`);
      if (feature.codeRefs.length > 0) {
        ui.print(`  ${ui.dim("code refs:")}`);
        for (const r of feature.codeRefs) {
          const tail = r.path ? `:${r.path}` : "";
          ui.print(`    ${ui.dim("·")} ${r.repo}${tail}`);
        }
      }
      if (feature.docRefs.length > 0) {
        ui.print(`  ${ui.dim("doc refs:")}`);
        for (const r of feature.docRefs) {
          const tail = r.title ? `  ${ui.dim(r.title)}` : "";
          ui.print(`    ${ui.dim("·")} ${r.source}:${r.docId}${tail}`);
        }
      }
      ui.blank();
      // Body is markdown — print verbatim.
      process.stdout.write(feature.body);
      if (!feature.body.endsWith("\n")) ui.blank();
      return 0;
    } catch (err) {
      if (err instanceof FeatureNotFoundError || err instanceof FeatureFileError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

const removeCmd: Command = {
  name: "remove",
  summary: "Delete a feature file.",
  positionals: ["id"],
  async run({ positionals, cwd }) {
    const [id] = positionals;
    if (!id) {
      ui.error("Missing <id> argument.");
      ui.print(`  ${ui.dim("Usage: atelier feature remove <id>")}`);
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
      const removed = await removeFeature(workspaceRoot, id);
      ui.success(`Removed feature ${ui.bold(removed.id)}`);
      return 0;
    } catch (err) {
      if (err instanceof FeatureNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

export const featureCommand: Command = {
  name: "feature",
  summary: "Manage the feature map.",
  description:
    "Features describe what the product does, conceptually. Each feature\n" +
    "is one markdown file under .planning/features/, with structured\n" +
    "fields in front-matter (status, code refs, doc refs) and free-form\n" +
    "prose below for journeys, states, edge cases.",
  subcommands: [addCmd, listCmd, showCmd, removeCmd],
};
