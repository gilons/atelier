import {
  requireWorkspaceRoot,
  resolveDisciplineConfig,
  setDesignTool,
  clearDesignTool,
  listSources,
  findBuiltinDiscipline,
  DEFAULT_DISCIPLINE,
  DesignConfigError,
  ProjectNotFoundError,
  NotInsideWorkspaceError,
} from "@atelier/core";
import type { Command } from "../command.js";
import { ui } from "../ui.js";
import { PROJECT_OPTION, newEntryProject } from "../project-scope.js";

/** A short suffix naming the project scope, e.g. " for project acme" or "". */
function scopeLabel(project: string | undefined): string {
  return project ? ` for project ${ui.bold(project)}` : " (global)";
}

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
  summary: "Show a discipline's configured design tool (for the active project).",
  description:
    "Resolves the tool for the active project (or `--project <id>`),\n" +
    "falling back to the global default. `--project all` is not used here;\n" +
    "pass a specific project or rely on the pin.",
  options: { discipline: DISCIPLINE_OPT, ...PROJECT_OPTION },
  async run({ values, cwd, mode }) {
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;
    const discipline = disciplineOf(values);

    let project: string | undefined;
    try {
      project = await newEntryProject(root, values);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }

    const { config: cfg, scope } = await resolveDisciplineConfig(root, discipline, { project });
    if (!cfg || !cfg.tool) {
      const flag = discipline === DEFAULT_DISCIPLINE ? "" : ` --discipline ${discipline}`;
      const hint =
        (mode === "repl" ? "/design tool set <tool>" : "atelier design tool set <tool>") + flag;
      ui.info(`No tool set for ${ui.bold(discipline)}${scopeLabel(project)}.`);
      ui.print(
        `  ${ui.dim(`The ${discipline} agent will infer from \`design\` sources, else use Markdown.`)}`
      );
      ui.print(`  ${ui.dim(`Declare one explicitly with \`${hint}\`.`)}`);
      return 0;
    }
    // Label where the resolved config came from.
    const from =
      scope === "project"
        ? ui.dim(`(${project} · ${discipline})`)
        : project
          ? ui.dim(`(global default · ${discipline}; no ${project} override)`)
          : ui.dim("(" + discipline + ")");
    ui.print(`${ui.bold(cfg.tool)} ${from}`);
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
    "`design` source; --note records how it's driven.\n\n" +
    "Scopes to the active project (or `--project <id>`) so each client\n" +
    "can use a different tool; `--project global` sets the shared default.",
  positionals: ["tool"],
  options: {
    source: { type: "string", short: "s" },
    note: { type: "string", short: "n" },
    discipline: DISCIPLINE_OPT,
    ...PROJECT_OPTION,
  },
  async run({ values, positionals, cwd }) {
    const [tool] = positionals;
    if (!tool) {
      ui.error("Missing <tool> argument.");
      ui.print(`  ${ui.dim('Usage: atelier design tool set figma [--discipline ui-design] [--source <id>] [--project <id>]')}`);
      return 2;
    }
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;
    const discipline = disciplineOf(values);

    let project: string | undefined;
    try {
      project = await newEntryProject(root, values);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        ui.error(err.message);
        ui.print(`  ${ui.dim("List registered projects with `atelier project list`.")}`);
        return 1;
      }
      throw err;
    }

    const sourceId = values.source as string | undefined;
    if (sourceId) {
      const sources = await listSources(root);
      const match = sources.find((s) => s.id === sourceId);
      if (!match) {
        ui.warn(`No registered source "${sourceId}" — set anyway. Register it with \`atelier source register\`.`);
      }
    }

    try {
      const cfg = await setDesignTool(root, {
        tool,
        sourceId,
        notes: values.note as string | undefined,
        discipline,
        project,
      });
      ui.success(`${ui.bold(discipline)} tool set to ${ui.bold(cfg.tool ?? tool)}${scopeLabel(project)}.`);
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
  summary: "Unset a discipline's design tool (for the active project, or global).",
  description:
    "Clears the active project's override (or `--project <id>`), leaving\n" +
    "the global default in place. `--project global` clears the global one.",
  options: { discipline: DISCIPLINE_OPT, ...PROJECT_OPTION },
  async run({ values, cwd }) {
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;
    const discipline = disciplineOf(values);
    let project: string | undefined;
    try {
      project = await newEntryProject(root, values);
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
    const removed = await clearDesignTool(root, discipline, { project });
    if (removed) ui.success(`Cleared the ${discipline} design settings${scopeLabel(project)}.`);
    else ui.info(`No ${discipline} settings${scopeLabel(project)} to clear.`);
    return 0;
  },
};

export const toolCommand: Command = {
  name: "tool",
  summary: "Declare a discipline's design tool (Figma / Excalidraw / …).",
  description:
    "Per-discipline tool selection (--discipline, default system-design),\n" +
    "scoped per project: each client can drive a different tool, with a\n" +
    "shared global default underneath. Writes go to the active project\n" +
    "(or --project); reads resolve the active project then fall back to\n" +
    "global. The matching design agent reads this; when unset it infers\n" +
    "from `design` sources and falls back to Markdown.",
  subcommands: [showCmd, setCmd, clearCmd],
};

// re-exported so `design discipline` can validate ids if needed
export { findBuiltinDiscipline };
