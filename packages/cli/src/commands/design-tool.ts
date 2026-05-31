import {
  requireWorkspaceRoot,
  loadDesignConfig,
  setDesignTool,
  clearDesignTool,
  listSources,
  DesignConfigError,
  NotInsideWorkspaceError,
} from "@atelier/core";
import type { Command } from "../command.js";
import { ui } from "../ui.js";

/**
 * `atelier design-tool` — declare the workspace's system-design tool.
 *
 * The system-design agent reads this to know what drives the design
 * work (Figma / Excalidraw / Lucidchart / … or "markdown"). It's an
 * explicit, queryable alternative to inferring from `design` sources +
 * the agent's learnings.
 */

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

const showCmd: Command = {
  name: "show",
  summary: "Show the workspace's configured system-design tool.",
  async run({ cwd, mode }) {
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;

    const cfg = await loadDesignConfig(root);
    if (!cfg) {
      const hint = mode === "repl" ? "/design-tool set <tool>" : "atelier design-tool set <tool>";
      ui.info("No system-design tool set.");
      ui.print(
        `  ${ui.dim(`The system-design agent will infer from \`design\` sources, else use Markdown.`)}`
      );
      ui.print(`  ${ui.dim(`Declare one explicitly with \`${hint}\`.`)}`);
      return 0;
    }
    ui.print(ui.bold(cfg.tool));
    if (cfg.sourceId) ui.print(`  ${ui.dim("source:")} ${cfg.sourceId}`);
    if (cfg.notes) ui.print(`  ${ui.dim("notes:")}  ${cfg.notes}`);
    ui.print(`  ${ui.dim("updated:")} ${cfg.updatedAt}`);
    return 0;
  },
};

const setCmd: Command = {
  name: "set",
  summary: "Set the workspace's system-design tool.",
  description:
    "Records which platform drives system design — figma / excalidraw /\n" +
    "lucidchart / markdown / any AI-drivable tool. Optionally link the\n" +
    "registered `design` source that backs it (--source) and a note on\n" +
    "how it's driven (--note).",
  positionals: ["tool"],
  options: {
    source: { type: "string", short: "s" },
    note: { type: "string", short: "n" },
  },
  async run({ values, positionals, cwd }) {
    const [tool] = positionals;
    if (!tool) {
      ui.error("Missing <tool> argument.");
      ui.print(`  ${ui.dim('Usage: atelier design-tool set figma [--source <id>] [--note "..."]')}`);
      return 2;
    }
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;

    const sourceId = values.source as string | undefined;
    // Soft-validate the backing source: warn (don't block) if it's not
    // a registered design source yet — the user may connect it later.
    if (sourceId) {
      const sources = await listSources(root);
      const match = sources.find((s) => s.id === sourceId);
      if (!match) {
        ui.warn(`No registered source "${sourceId}" — set anyway. Register it with \`atelier source register\`.`);
      } else if (match.category !== "design") {
        ui.warn(`Source "${sourceId}" is category "${match.category}", not "design".`);
      }
    }

    try {
      const cfg = await setDesignTool(root, {
        tool,
        sourceId,
        notes: values.note as string | undefined,
      });
      ui.success(`System-design tool set to ${ui.bold(cfg.tool)}.`);
      if (cfg.sourceId) ui.print(`  ${ui.dim("backed by source:")} ${cfg.sourceId}`);
      ui.print(
        `  ${ui.dim("The system-design agent will drive this tool (run `atelier agent install system-design`).")}`
      );
      return 0;
    } catch (err) {
      if (err instanceof DesignConfigError) {
        ui.error(err.message);
        return 2;
      }
      throw err;
    }
  },
};

const clearCmd: Command = {
  name: "clear",
  summary: "Unset the workspace's system-design tool.",
  async run({ cwd }) {
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;
    const removed = await clearDesignTool(root);
    if (removed) ui.success("Cleared the system-design tool setting.");
    else ui.info("No system-design tool was set.");
    return 0;
  },
};

export const designToolCommand: Command = {
  name: "design-tool",
  summary: "Declare the workspace's system-design tool (Figma / Excalidraw / …).",
  description:
    "The system-design agent reads this to know what drives the design\n" +
    "work. Optional — when unset, the agent infers from `design` sources\n" +
    "and falls back to Markdown.",
  subcommands: [showCmd, setCmd, clearCmd],
};
