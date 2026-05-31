import {
  requireWorkspaceRoot,
  buildWorkspaceMap,
  refreshWorkspaceIndex,
  NotInsideWorkspaceError,
  type MapNode,
} from "@atelier/core";
import type { Command } from "../command.js";
import { ui } from "../ui.js";

/**
 * `atelier map` — progressive discovery over the workspace.
 *
 * Atelier's content is a recursive tree of folders, each carrying a
 * lightweight index (name + kind + brief description). `map` walks
 * that tree and prints one level's worth of summaries at a time, so
 * an agent (or human) can see what's in the workspace without loading
 * everything, then drill into the branch it needs:
 *
 *   atelier map                  # the whole workspace, 2 levels deep
 *   atelier map agents           # just the agents section
 *   atelier map agents/discovery # one agent's parts
 *   atelier map --depth 3        # go deeper
 *   atelier map --json           # machine-readable, for agents
 *   atelier map --rebuild        # (re)write the index.yaml sidecars
 *
 * Reads index.yaml sidecars where present; derives from content where
 * not, so it works even before `--rebuild` has materialized anything.
 */

function renderTree(node: MapNode, lines: string[], prefix: string, isLast: boolean, isRoot: boolean): void {
  if (isRoot) {
    const desc = node.description ? `  ${ui.dim(node.description)}` : "";
    lines.push(`${ui.bold(node.name)} ${ui.dim("(" + node.kind + ")")}${desc}`);
  } else {
    const connector = isLast ? "└─ " : "├─ ";
    const kind = ui.dim(`[${node.kind}]`);
    const desc = node.description ? `  ${ui.dim("— " + node.description)}` : "";
    lines.push(`${prefix}${connector}${ui.cyan(node.name)} ${kind}${desc}`);
  }
  const children = node.children ?? [];
  const childPrefix = isRoot ? "" : prefix + (isLast ? "   " : "│  ");
  children.forEach((child, i) => {
    renderTree(child, lines, childPrefix, i === children.length - 1, false);
  });
}

export const mapCommand: Command = {
  name: "map",
  summary: "Navigate the workspace as a progressive tree of summaries.",
  description:
    "Walks atelier's recursive index — each folder declares its name,\n" +
    "kind, and a brief description, and lists its children. Prints a\n" +
    "bounded-depth tree so you (or an agent) can see what's in the\n" +
    "workspace and drill into a branch without loading everything.\n\n" +
    "Reads .atelier/**/index.yaml where present, derives from content\n" +
    "where not. `--rebuild` materializes the index.yaml sidecars from\n" +
    "current content first.",
  positionals: ["path?"],
  options: {
    depth: { type: "string", short: "d" },
    json: { type: "boolean" },
    rebuild: { type: "boolean" },
  },
  async run({ values, positionals, cwd }) {
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

    let depth = 2;
    if (values.depth !== undefined) {
      const parsed = Number(values.depth);
      if (!Number.isInteger(parsed) || parsed < 1) {
        ui.error("--depth must be a positive integer.");
        return 2;
      }
      depth = parsed;
    }

    if (values.rebuild === true) {
      const { written } = await refreshWorkspaceIndex(workspaceRoot);
      if (values.json !== true) {
        ui.success(`Wrote ${written.length} index.yaml file(s).`);
        ui.blank();
      }
    }

    const startPath = positionals[0];
    const node = await buildWorkspaceMap(workspaceRoot, { path: startPath, depth });

    if (values.json === true) {
      process.stdout.write(JSON.stringify(node, null, 2) + "\n");
      return 0;
    }

    const lines: string[] = [];
    renderTree(node, lines, "", true, true);
    for (const line of lines) ui.print(line);
    ui.blank();
    if (!node.children || node.children.length === 0) {
      ui.print(`  ${ui.dim("(nothing to show here yet)")}`);
      ui.blank();
    } else {
      const tail = startPath ? `${startPath}/<child>` : "<section>";
      ui.print(`  ${ui.dim(`Drill in with \`atelier map ${tail}\` · deeper with \`--depth N\`.`)}`);
      ui.blank();
    }
    return 0;
  },
};
