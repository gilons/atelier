import {
  requireWorkspaceRoot,
  addProject,
  removeProject,
  listProjects,
  loadProject,
  getActiveProject,
  setActiveProject,
  ProjectAlreadyExistsError,
  ProjectNotFoundError,
  NotInsideWorkspaceError,
  type Project,
} from "@atelier/core";
import type { Command } from "../command.js";
import { hint } from "../command.js";
import { ui } from "../ui.js";

/** Resolve the workspace root or print a friendly error. Returns null on failure. */
async function resolveRoot(cwd: string): Promise<string | null> {
  try {
    return await requireWorkspaceRoot(cwd);
  } catch (err) {
    if (err instanceof NotInsideWorkspaceError) {
      ui.error(err.message);
      return null;
    }
    throw err;
  }
}

const listCmd: Command = {
  name: "list",
  summary: "List the projects registered in this workspace.",
  description:
    "Projects scope a workspace into separate realities (e.g. an agency's\n" +
    "clients). Each project owns its own sources, repos, features, designs,\n" +
    "and specs; entries with no project are global (shared across all).\n\n" +
    "The active project (pinned locally with `atelier project use`) is\n" +
    "marked. New entries default to the active project unless you pass\n" +
    "`--project`.",
  async run({ cwd, mode }) {
    const root = await resolveRoot(cwd);
    if (!root) return 1;

    const projects = await listProjects(root);
    const active = await getActiveProject(root);

    if (projects.length === 0) {
      ui.info("No projects registered. Everything is global (shared).");
      ui.print(`  ${ui.dim(`Add one with \`${hint({ cwd, mode, values: {}, positionals: [] }, "project add \"Acme Corp\"")}\`.`)}`);
      return 0;
    }

    const idWidth = Math.max("ID".length, ...projects.map((p) => p.id.length));
    const nameWidth = Math.max("NAME".length, ...projects.map((p) => p.name.length));
    ui.print(
      `    ${ui.dim("ID".padEnd(idWidth))}  ${ui.dim("NAME".padEnd(nameWidth))}  ${ui.dim("CLIENT")}`
    );
    for (const p of projects) {
      const isActive = p.id === active;
      const marker = isActive ? ui.green("●") : ui.dim("·");
      const client = p.client ? ui.dim(p.client) : "";
      const status = p.status ? ui.dim(` [${p.status}]`) : "";
      ui.print(
        `  ${marker} ${p.id.padEnd(idWidth)}  ${p.name.padEnd(nameWidth)}  ${client}${status}`
      );
    }
    ui.blank();
    if (active) {
      ui.print(`  ${ui.dim("Active project:")} ${ui.bold(active)} ${ui.dim("(+ global entries)")}`);
    } else {
      ui.print(`  ${ui.dim("No active project pinned. Showing everything; new entries are global.")}`);
      ui.print(`  ${ui.dim(`Pin one with \`${hint({ cwd, mode, values: {}, positionals: [] }, "project use <id>")}\`.`)}`);
    }
    ui.blank();
    return 0;
  },
};

const addCmd: Command = {
  name: "add",
  summary: "Register a new project in this workspace.",
  description:
    "Creates a project entry in .atelier/projects.yaml. The id is derived\n" +
    "from the name unless you pass --id. After adding the first project,\n" +
    "pin it as active with `atelier project use <id>` so new sources,\n" +
    "specs, and designs default into it.",
  positionals: ["name"],
  options: {
    id: { type: "string" },
    client: { type: "string", short: "c" },
    status: { type: "string", short: "s" },
    use: { type: "boolean" },
  },
  prompts: [
    {
      key: "name",
      question: "Project name (e.g. Acme Corp)",
      help: "A human label. The id is slugified from this unless you pass --id.",
      positionalIndex: 0,
      validate: /\S/,
    },
  ],
  async run({ values, positionals, cwd, mode }) {
    const name = positionals[0];
    if (!name) {
      ui.error("Missing <name> argument.");
      ui.print(`  ${ui.dim('Usage: atelier project add "Acme Corp" [--id acme] [--client "Acme"] [--use]')}`);
      return 2;
    }
    const root = await resolveRoot(cwd);
    if (!root) return 1;

    try {
      const project = await addProject(root, {
        name,
        id: values.id as string | undefined,
        client: values.client as string | undefined,
        status: values.status as string | undefined,
      });
      ui.success(`Registered project ${ui.bold(project.name)} (${ui.cyan(project.id)})`);
      if (project.client) ui.print(`  ${ui.dim("Client:")} ${project.client}`);

      const active = await getActiveProject(root);
      if (values.use === true) {
        await setActiveProject(root, project.id);
        ui.blank();
        ui.info(`Pinned ${ui.bold(project.id)} as the active project.`);
      } else if (!active) {
        ui.blank();
        ui.print(`  ${ui.dim("Pin it as active so new entries default into it:")}`);
        ui.print(`  ${ui.cyan(hint({ cwd, mode, values: {}, positionals: [] }, `project use ${project.id}`))}`);
      }
      ui.blank();
      return 0;
    } catch (err) {
      if (err instanceof ProjectAlreadyExistsError) {
        ui.error(err.message);
        return 1;
      }
      if (err instanceof Error && /Invalid project id|reserved keyword/.test(err.message)) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

const useCmd: Command = {
  name: "use",
  summary: "Pin the active project for this workspace (local, not committed).",
  description:
    "Sets which project you're working in. Commands and agents then scope\n" +
    "to this project plus the global (shared) entries. New entries default\n" +
    "into it. The pin lives in .atelier/.active-project, which is gitignored:\n" +
    "which project a developer is working in is personal, not shared.\n\n" +
    "Pass `--clear` (or the id `none`) to unpin and go back to seeing\n" +
    "everything.",
  positionals: ["id?"],
  options: {
    clear: { type: "boolean" },
  },
  async run({ values, positionals, cwd }) {
    const root = await resolveRoot(cwd);
    if (!root) return 1;

    const id = positionals[0];
    if (values.clear === true || id === "none") {
      await setActiveProject(root, null);
      ui.success("Cleared the active project. Showing everything; new entries are global.");
      return 0;
    }
    if (!id) {
      ui.error("Missing <id> argument.");
      ui.print(`  ${ui.dim("Usage: atelier project use <id>   (or --clear to unpin)")}`);
      return 2;
    }
    try {
      const project = await loadProject(root, id);
      await setActiveProject(root, project.id);
      ui.success(`Active project: ${ui.bold(project.name)} (${ui.cyan(project.id)})`);
      ui.print(`  ${ui.dim("Commands and agents now scope to this project plus global entries.")}`);
      return 0;
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        ui.error(err.message);
        ui.print(`  ${ui.dim("List registered projects with `atelier project list`.")}`);
        return 1;
      }
      throw err;
    }
  },
};

const showCmd: Command = {
  name: "show",
  summary: "Show one project (defaults to the active one).",
  description:
    "Prints a project's details. With no id, shows the currently active\n" +
    "project. Useful for confirming what scope new entries will land in.",
  positionals: ["id?"],
  async run({ positionals, cwd }) {
    const root = await resolveRoot(cwd);
    if (!root) return 1;

    let id = positionals[0];
    if (!id) {
      const active = await getActiveProject(root);
      if (!active) {
        ui.info("No active project pinned. Showing everything; new entries are global.");
        ui.print(`  ${ui.dim("Pin one with `atelier project use <id>`.")}`);
        return 0;
      }
      id = active;
    }
    try {
      const project = await loadProject(root, id);
      const active = await getActiveProject(root);
      ui.print(ui.bold(project.name) + (project.id === active ? ui.green("  ● active") : ""));
      ui.print(`  ${ui.dim("Id:")}       ${project.id}`);
      if (project.client) ui.print(`  ${ui.dim("Client:")}   ${project.client}`);
      if (project.status) ui.print(`  ${ui.dim("Status:")}   ${project.status}`);
      ui.print(`  ${ui.dim("Created:")}  ${project.createdAt}`);
      ui.print(`  ${ui.dim("Updated:")}  ${project.updatedAt}`);
      ui.blank();
      return 0;
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

const removeCmd: Command = {
  name: "remove",
  summary: "Unregister a project (does not delete its entries).",
  description:
    "Removes the project from .atelier/projects.yaml. Entries tagged with\n" +
    "this project are NOT deleted or retagged; they simply point at an\n" +
    "unregistered project until you retag or re-add it. If the removed\n" +
    "project was the active pin, the pin is cleared.",
  positionals: ["id"],
  async run({ positionals, cwd }) {
    const id = positionals[0];
    if (!id) {
      ui.error("Missing <id> argument.");
      ui.print(`  ${ui.dim("Usage: atelier project remove <id>")}`);
      return 2;
    }
    const root = await resolveRoot(cwd);
    if (!root) return 1;
    try {
      const removed: Project = await removeProject(root, id);
      ui.success(`Unregistered project ${ui.bold(removed.name)} (${removed.id})`);
      return 0;
    } catch (err) {
      if (err instanceof ProjectNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

export const projectCommand: Command = {
  name: "project",
  summary: "Scope this workspace into multiple projects (agencies, clients).",
  description:
    "One workspace can hold several projects, each with its own sources,\n" +
    "repos, features, designs, and specs. Entries with no project are\n" +
    "global (shared). Pin an active project with `atelier project use`;\n" +
    "commands and agents then scope to it plus the global entries, and\n" +
    "new entries default into it. Override per-command with `--project`.",
  subcommands: [listCmd, addCmd, useCmd, showCmd, removeCmd],
};
