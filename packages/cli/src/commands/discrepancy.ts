import {
  requireWorkspaceRoot,
  addDiscrepancy,
  listDiscrepancies,
  loadDiscrepancy,
  updateDiscrepancy,
  removeDiscrepancy,
  DISCREPANCY_SEVERITIES,
  DISCREPANCY_STATUSES,
  DiscrepancyAlreadyExistsError,
  DiscrepancyNotFoundError,
  NotInsideWorkspaceError,
  type DiscrepancySeverity,
  type DiscrepancyStatus,
} from "@atelier/core";
import type { Command } from "../command.js";
import { ui } from "../ui.js";

function validSeverity(s: string): s is DiscrepancySeverity {
  return (DISCREPANCY_SEVERITIES as readonly string[]).includes(s);
}
function validStatus(s: string): s is DiscrepancyStatus {
  return (DISCREPANCY_STATUSES as readonly string[]).includes(s);
}

/** Parse `source:docId` into a DiscrepancyDocRef. */
function parseDocRef(v: string) {
  const idx = v.indexOf(":");
  if (idx === -1) throw new Error("--doc-ref must be in the form 'source:docId'");
  return { source: v.slice(0, idx), docId: v.slice(idx + 1) };
}

/** Parse `repo[:path]` into a DiscrepancyCodeRef. */
function parseCodeRef(v: string) {
  const idx = v.indexOf(":");
  if (idx === -1) return { repo: v };
  return { repo: v.slice(0, idx), path: v.slice(idx + 1) || undefined };
}

const addCmd: Command = {
  name: "add",
  summary: "Log a new discrepancy.",
  description:
    "Records a mismatch between what a doc claims and what the code does.\n" +
    "Today these are added manually; Phase 3 detection will write entries\n" +
    "automatically once doc + code maps are populated.",
  options: {
    id: { type: "string" },
    feature: { type: "string", short: "f" },
    claim: { type: "string", short: "c" },
    observed: { type: "string", short: "o" },
    severity: { type: "string", short: "s" },
    status: { type: "string" },
    "doc-ref": { type: "string" },
    "code-ref": { type: "string" },
    notes: { type: "string" },
  },
  async run({ values, cwd }) {
    const claim = values.claim as string | undefined;
    const observed = values.observed as string | undefined;
    if (!claim || !observed) {
      ui.error("Both --claim and --observed are required.");
      ui.print(
        `  ${ui.dim('Usage: atelier discrepancy add --claim "..." --observed "..." [options]')}`
      );
      return 2;
    }
    const severity = values.severity as string | undefined;
    if (severity !== undefined && !validSeverity(severity)) {
      ui.error(
        `Invalid --severity "${severity}". Valid: ${DISCREPANCY_SEVERITIES.join(", ")}.`
      );
      return 2;
    }
    const status = values.status as string | undefined;
    if (status !== undefined && !validStatus(status)) {
      ui.error(
        `Invalid --status "${status}". Valid: ${DISCREPANCY_STATUSES.join(", ")}.`
      );
      return 2;
    }
    let docRef, codeRef;
    try {
      if (values["doc-ref"]) docRef = parseDocRef(values["doc-ref"] as string);
      if (values["code-ref"]) codeRef = parseCodeRef(values["code-ref"] as string);
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
      const entry = await addDiscrepancy(workspaceRoot, {
        id: values.id as string | undefined,
        feature: values.feature as string | undefined,
        claim,
        observed,
        severity: severity as DiscrepancySeverity | undefined,
        status: status as DiscrepancyStatus | undefined,
        docRef,
        codeRef,
        notes: values.notes as string | undefined,
      });
      ui.success(`Logged discrepancy ${ui.bold(entry.id)}`);
      ui.blank();
      ui.print(`  ${ui.dim("Severity:")} ${entry.severity}`);
      ui.print(`  ${ui.dim("Status:")}   ${entry.status}`);
      if (entry.feature) ui.print(`  ${ui.dim("Feature:")}  ${entry.feature}`);
      ui.print(`  ${ui.dim("Claim:")}    ${entry.claim}`);
      ui.print(`  ${ui.dim("Observed:")} ${entry.observed}`);
      ui.blank();
      return 0;
    } catch (err) {
      if (err instanceof DiscrepancyAlreadyExistsError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

const listCmd: Command = {
  name: "list",
  summary: "List discrepancies, optionally filtered.",
  options: {
    status: { type: "string" },
    severity: { type: "string", short: "s" },
    feature: { type: "string", short: "f" },
  },
  async run({ values, cwd }) {
    const status = values.status as string | undefined;
    if (status !== undefined && !validStatus(status)) {
      ui.error(
        `Invalid --status "${status}". Valid: ${DISCREPANCY_STATUSES.join(", ")}.`
      );
      return 2;
    }
    const severity = values.severity as string | undefined;
    if (severity !== undefined && !validSeverity(severity)) {
      ui.error(
        `Invalid --severity "${severity}". Valid: ${DISCREPANCY_SEVERITIES.join(", ")}.`
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

    const entries = await listDiscrepancies(workspaceRoot, {
      status: status as DiscrepancyStatus | undefined,
      severity: severity as DiscrepancySeverity | undefined,
      feature: values.feature as string | undefined,
    });
    if (entries.length === 0) {
      ui.info("No discrepancies match the filter.");
      return 0;
    }
    const idWidth = Math.max("ID".length, ...entries.map((e) => e.id.length));
    const sevWidth = Math.max("SEV".length, ...entries.map((e) => e.severity.length));
    const statusWidth = Math.max(
      "STATUS".length,
      ...entries.map((e) => e.status.length)
    );
    ui.print(
      `    ${ui.dim("ID".padEnd(idWidth))}  ${ui.dim("SEV".padEnd(sevWidth))}  ${ui.dim("STATUS".padEnd(statusWidth))}  ${ui.dim("CLAIM → OBSERVED")}`
    );
    for (const e of entries) {
      const sevColor = severityColor(e.severity);
      ui.print(
        `  ${ui.green("·")} ${e.id.padEnd(idWidth)}  ${sevColor(e.severity.padEnd(sevWidth))}  ${e.status.padEnd(statusWidth)}  ${e.claim} ${ui.dim("→")} ${e.observed}`
      );
    }
    ui.blank();
    return 0;
  },
};

function severityColor(s: DiscrepancySeverity): (txt: string) => string {
  switch (s) {
    case "critical":
      return ui.red;
    case "high":
      return ui.yellow;
    case "medium":
      return ui.cyan;
    case "low":
      return ui.dim;
  }
}

const showCmd: Command = {
  name: "show",
  summary: "Show a discrepancy's full record.",
  positionals: ["id"],
  async run({ positionals, cwd }) {
    const [id] = positionals;
    if (!id) {
      ui.error("Usage: atelier discrepancy show <id>");
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
      const e = await loadDiscrepancy(workspaceRoot, id);
      ui.print(ui.bold(e.id));
      ui.print(`  ${ui.dim("severity:")}  ${e.severity}`);
      ui.print(`  ${ui.dim("status:")}    ${e.status}`);
      if (e.feature) ui.print(`  ${ui.dim("feature:")}   ${e.feature}`);
      ui.print(`  ${ui.dim("claim:")}     ${e.claim}`);
      ui.print(`  ${ui.dim("observed:")}  ${e.observed}`);
      if (e.docRef) {
        ui.print(`  ${ui.dim("doc ref:")}   ${e.docRef.source}:${e.docRef.docId}`);
      }
      if (e.codeRef) {
        const tail = e.codeRef.path ? `:${e.codeRef.path}` : "";
        ui.print(`  ${ui.dim("code ref:")}  ${e.codeRef.repo}${tail}`);
      }
      ui.print(`  ${ui.dim("created:")}   ${e.createdAt}`);
      ui.print(`  ${ui.dim("updated:")}   ${e.updatedAt}`);
      if (e.notes) {
        ui.blank();
        ui.print(`  ${ui.dim("Notes:")}`);
        for (const line of e.notes.split("\n")) ui.print(`    ${line}`);
      }
      ui.blank();
      return 0;
    } catch (err) {
      if (err instanceof DiscrepancyNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

const resolveCmd: Command = {
  name: "resolve",
  summary: "Mark a discrepancy as resolved (with optional note).",
  positionals: ["id"],
  options: {
    note: { type: "string", short: "n" },
    status: { type: "string" },
  },
  async run({ positionals, values, cwd }) {
    const [id] = positionals;
    if (!id) {
      ui.error("Usage: atelier discrepancy resolve <id> [--note '...'] [--status resolved|wontfix]");
      return 2;
    }
    const target = (values.status as string | undefined) ?? "resolved";
    if (!validStatus(target)) {
      ui.error(`Invalid --status "${target}".`);
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
      const entry = await updateDiscrepancy(workspaceRoot, id, {
        status: target as DiscrepancyStatus,
        appendNotes: values.note as string | undefined,
      });
      ui.success(`Marked ${ui.bold(entry.id)} as ${entry.status}`);
      return 0;
    } catch (err) {
      if (err instanceof DiscrepancyNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

const removeCmd: Command = {
  name: "remove",
  summary: "Delete a discrepancy entry.",
  positionals: ["id"],
  async run({ positionals, cwd }) {
    const [id] = positionals;
    if (!id) {
      ui.error("Usage: atelier discrepancy remove <id>");
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
      const e = await removeDiscrepancy(workspaceRoot, id);
      ui.success(`Removed discrepancy ${ui.bold(e.id)}`);
      return 0;
    } catch (err) {
      if (err instanceof DiscrepancyNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

export const discrepancyCommand: Command = {
  name: "discrepancy",
  summary: "Manage the doc-vs-code discrepancy log.",
  description:
    "Discrepancies are recorded mismatches between what your documentation\n" +
    "claims and what the code actually does. The log lives at\n" +
    ".planning/discrepancies.yaml. Today entries are added manually;\n" +
    "Phase 3 will populate them automatically as part of sync.",
  subcommands: [addCmd, listCmd, showCmd, resolveCmd, removeCmd],
};
