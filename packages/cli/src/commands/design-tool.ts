import {
  requireWorkspaceRoot,
  loadDisciplineConfig,
  setDesignTool,
  clearDesignTool,
  listSources,
  findBuiltinDiscipline,
  DEFAULT_DISCIPLINE,
  DesignConfigError,
  NotInsideWorkspaceError,
} from "@atelier/core";
import type { Command } from "../command.js";
import { ui } from "../ui.js";

/**
 * `atelier design tool` — declare which platform drives a design
 * discipline.
 *
 * Per-discipline: pass --discipline to target ui-design, a custom
 * discipline, etc.; defaults to system-design. The matching design
 * agent reads this to know what drives the work (Figma / Excalidraw /
 * … or "markdown"), an explicit alternative to inferring from `design`
 * sources + learnings. Mounted as the `tool` subcommand of `design`.
 */

const DISCIPLINE_OPT = { type: "string" as const, short: "D" as const };

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

function disciplineOf(values: Record<string, unknown>): string {
  return (values.discipline as string | undefined)?.trim() || DEFAULT_DISCIPLINE;
}

const showCmd: Command = {
  name: "show",
  summary: "Show a discipline's configured design tool.",
  options: { discipline: DISCIPLINE_OPT },
  async run({ values, cwd, mode }) {
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;
    const discipline = disciplineOf(values);

    const cfg = await loadDisciplineConfig(root, discipline);
    if (!cfg || !cfg.tool) {
      const flag = discipline === DEFAULT_DISCIPLINE ? "" : ` --discipline ${discipline}`;
      const hint =
        (mode === "repl" ? "/design tool set <tool>" : "atelier design tool set <tool>") + flag;
      ui.info(`No tool set for ${ui.bold(discipline)}.`);
      ui.print(
        `  ${ui.dim(`The ${discipline} agent will infer from \`design\` sources, else use Markdown.`)}`
      );
      ui.print(`  ${ui.dim(`Declare one explicitly with \`${hint}\`.`)}`);
      return 0;
    }
    ui.print(`${ui.bold(cfg.tool)} ${ui.dim("(" + discipline + ")")}`);
    if (cfg.sourceId) ui.print(`  ${ui.dim("source:")} ${cfg.sourceId}`);
    if (cfg.notes) ui.print(`  ${ui.dim("notes:")}  ${cfg.notes}`);
    return 0;
  },
};

const setCmd: Command = {
  name: "set",
  summary: "Set a discipline's design tool.",
  description:
    "Records which platform drives the discipline (figma / excalidraw /\n" +
    "sketch / markdown / any AI-drivable tool). Pass --discipline to\n" +
    "target one (defaults to system-design); --source links the backing\n" +
    "`design` source; --note records how it's driven.",
  positionals: ["tool"],
  options: {
    source: { type: "string", short: "s" },
    note: { type: "string", short: "n" },
    discipline: DISCIPLINE_OPT,
  },
  async run({ values, positionals, cwd }) {
    const [tool] = positionals;
    if (!tool) {
      ui.error("Missing <tool> argument.");
      ui.print(`  ${ui.dim('Usage: atelier design tool set figma [--discipline ui-design] [--source <id>]')}`);
      return 2;
    }
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;
    const discipline = disciplineOf(values);

    const sourceId = values.source as string | undefined;
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
        discipline,
      });
      ui.success(`${ui.bold(discipline)} tool set to ${ui.bold(cfg.tool ?? tool)}.`);
      if (cfg.sourceId) ui.print(`  ${ui.dim("backed by source:")} ${cfg.sourceId}`);
      ui.print(
        `  ${ui.dim(`The ${discipline} agent will drive this tool (run \`atelier agent install ${discipline}\`).`)}`
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
  summary: "Unset a discipline's design tool.",
  options: { discipline: DISCIPLINE_OPT },
  async run({ values, cwd }) {
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;
    const discipline = disciplineOf(values);
    const removed = await clearDesignTool(root, discipline);
    if (removed) ui.success(`Cleared the ${discipline} design settings.`);
    else ui.info(`No settings for ${discipline}.`);
    return 0;
  },
};

export const toolCommand: Command = {
  name: "tool",
  summary: "Declare a discipline's design tool (Figma / Excalidraw / …).",
  description:
    "Per-discipline tool selection (--discipline, default system-design).\n" +
    "The matching design agent reads this; when unset it infers from\n" +
    "`design` sources and falls back to Markdown.",
  subcommands: [showCmd, setCmd, clearCmd],
};

// re-exported so `design discipline` can validate ids if needed
export { findBuiltinDiscipline };
