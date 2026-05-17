import {
  requireWorkspaceRoot,
  syncWorkspace,
  NotInsideWorkspaceError,
  type SyncActionKind,
  type SyncReport,
} from "@atelier/core";
import type { Command } from "../command.js";
import { ui } from "../ui.js";

/**
 * `atelier sync` — pull every enabled source's doc index, diff
 * against the local doc map, and apply creates/updates (and deletes
 * with --remove-orphans).
 */

function actionGlyph(action: SyncActionKind): string {
  switch (action) {
    case "created":
      return ui.green("+");
    case "updated":
      return ui.cyan("~");
    case "unchanged":
      return ui.dim("=");
    case "orphaned":
      return ui.yellow("?");
    case "removed":
      return ui.red("-");
  }
}

function summarize(report: SyncReport): string {
  const counts = { created: 0, updated: 0, unchanged: 0, orphaned: 0, removed: 0 };
  for (const s of report.sources) {
    for (const a of s.actions) counts[a.action]++;
  }
  return `+${counts.created}  ~${counts.updated}  =${counts.unchanged}  ?${counts.orphaned}  -${counts.removed}`;
}

export const syncCommand: Command = {
  name: "sync",
  summary: "Pull docs from registered sources into the doc map.",
  description:
    "For each enabled source, asks the source adapter for its doc list,\n" +
    "diffs against the local doc map, and applies the changes. Sources\n" +
    "of kind `local-folder` work end-to-end. MCP-backed sources are\n" +
    "scaffolded — their transport will be wired up in a focused\n" +
    "follow-up.\n\n" +
    "Orphans (docs locally present but missing from the source) are\n" +
    "preserved by default. Pass --remove-orphans to delete them.",
  options: {
    source: { type: "string", short: "s" },
    "remove-orphans": { type: "boolean" },
    "dry-run": { type: "boolean" },
    verbose: { type: "boolean", short: "v" },
  },
  async run({ values, cwd }) {
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

    const dryRun = values["dry-run"] === true;
    const removeOrphans = values["remove-orphans"] === true;

    if (dryRun) {
      ui.info("Dry run — no changes will be written.");
      ui.blank();
    }

    const report = await syncWorkspace(workspaceRoot, {
      source: values.source as string | undefined,
      dryRun,
      removeOrphans,
    });

    if (report.sources.length === 0 && report.skipped.length === 0) {
      ui.info("No enabled sources to sync.");
      ui.print(
        `  ${ui.dim('Register one with `atelier source add <kind> --name "..."` first.')}`
      );
      return 0;
    }

    for (const s of report.sources) {
      ui.print(ui.bold(`Source: ${s.source}`));
      ui.print(
        `  ${ui.dim("remote:")} ${s.remoteCount}  ${ui.dim("local before:")} ${s.localBefore}  ${ui.dim("local after:")} ${s.localAfter}`
      );
      if (values.verbose === true) {
        for (const a of s.actions) {
          ui.print(`  ${actionGlyph(a.action)} ${a.docId.padEnd(40)}  ${ui.dim(a.title)}`);
        }
      } else {
        // Compact summary per action kind.
        const buckets: Record<SyncActionKind, number> = {
          created: 0,
          updated: 0,
          unchanged: 0,
          orphaned: 0,
          removed: 0,
        };
        for (const a of s.actions) buckets[a.action]++;
        ui.print(
          `  ${actionGlyph("created")} ${buckets.created} created   ${actionGlyph("updated")} ${buckets.updated} updated   ${actionGlyph("unchanged")} ${buckets.unchanged} unchanged   ${actionGlyph("orphaned")} ${buckets.orphaned} orphaned   ${actionGlyph("removed")} ${buckets.removed} removed`
        );
      }
      if (s.errors.length > 0) {
        ui.warn(`${s.errors.length} error(s) during sync:`);
        for (const e of s.errors) {
          ui.print(`    ${ui.red("✗")} ${e.docId ?? "(general)"}: ${e.error.message}`);
        }
      }
      ui.blank();
    }

    if (report.skipped.length > 0) {
      ui.print(ui.dim("Skipped:"));
      for (const s of report.skipped) {
        ui.print(`  · ${s.sourceId}: ${ui.dim(s.reason)}`);
      }
      ui.blank();
    }

    ui.print(`${ui.bold("Total:")} ${summarize(report)}`);
    return 0;
  },
};
