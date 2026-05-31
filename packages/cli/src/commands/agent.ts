import * as fs from "node:fs/promises";
import {
  requireWorkspaceRoot,
  addAgent,
  loadAgent,
  listAgents,
  removeAgent,
  installAgent,
  uninstallAgent,
  appendLearning,
  slugifyAgentId,
  findBuiltinAgent,
  listInstructionUnits,
  addInstructionUnit,
  AgentAlreadyExistsError,
  AgentNotFoundError,
  AgentFileError,
  NotInsideWorkspaceError,
} from "@atelier/core";
import type { Command } from "../command.js";
import { ui } from "../ui.js";

/**
 * `atelier agent` — author and manage the agents atelier produces
 * for AI tools (Claude Code) to discover and run.
 *
 * Atelier never calls an LLM. It's the author + registry: each agent
 * is a canonical def under `.atelier/agents/<id>/` (agent.yaml +
 * instructions.md + learnings.md). `atelier agent install <id>`
 * renders it into `.claude/` so Claude Code discovers it as a slash
 * command (/atelier:<id>) + a delegatable subagent.
 *
 * Self-improvement: `atelier agent learn <id> "fact"` appends a
 * durable workspace fact to learnings.md and re-renders the `.claude/`
 * files, so each run carries accumulated context.
 *
 * Atelier ships built-in agents (discovery, …); `install`
 * materializes them into the workspace on first use.
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

// ============================================================
// list
// ============================================================

const listCmd: Command = {
  name: "list",
  summary: "List installed agents + built-ins available to install.",
  async run({ cwd, mode }) {
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;

    const { agents, available, errors } = await listAgents(root);

    if (agents.length === 0 && available.length === 0 && errors.length === 0) {
      ui.info("No agents.");
      return 0;
    }

    if (agents.length > 0) {
      const idWidth = Math.max("ID".length, ...agents.map((a) => a.agent.id.length));
      ui.print(
        `    ${ui.dim("ID".padEnd(idWidth))}  ${ui.dim("INSTALLED")}  ${ui.dim("PURPOSE")}`
      );
      for (const { agent, installed } of agents) {
        const mark = installed ? ui.green("yes") : ui.dim("no ");
        const badge = agent.builtin ? ui.dim(" [built-in]") : "";
        ui.print(
          `  ${ui.green("·")} ${agent.id.padEnd(idWidth)}  ${mark}        ${agent.purpose}${badge}`
        );
      }
      ui.blank();
    }

    if (available.length > 0) {
      ui.print(ui.bold("Available built-ins (not yet installed)"));
      for (const b of available) {
        ui.print(`  ${ui.dim("·")} ${b.id} — ${b.purpose}`);
      }
      const hint = mode === "repl" ? "/agent install <id>" : "atelier agent install <id>";
      ui.print(`  ${ui.dim(`Install with \`${hint}\`.`)}`);
      ui.blank();
    }

    if (errors.length > 0) {
      ui.warn(`${errors.length} agent file(s) failed to parse:`);
      for (const e of errors) {
        ui.print(`    ${ui.red("✗")} ${e.filePath}`);
        ui.print(`      ${ui.dim(e.error.message.split("\n")[0])}`);
      }
      ui.blank();
    }
    return 0;
  },
};

// ============================================================
// show
// ============================================================

const showCmd: Command = {
  name: "show",
  summary: "Show an agent's metadata, instructions, and learnings.",
  positionals: ["id"],
  options: {
    "instructions-only": { type: "boolean" },
  },
  async run({ values, positionals, cwd }) {
    const [id] = positionals;
    if (!id) {
      ui.error("Missing <id> argument.");
      ui.print(`  ${ui.dim("Usage: atelier agent show <id>")}`);
      return 2;
    }
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;

    try {
      const a = await loadAgent(root, id);
      if (values["instructions-only"] === true) {
        process.stdout.write(a.instructions);
        if (!a.instructions.endsWith("\n")) ui.blank();
        return 0;
      }
      ui.print(ui.bold(a.name));
      ui.print(`  ${ui.dim("id:")}        ${a.id}`);
      if (a.kind) ui.print(`  ${ui.dim("kind:")}      ${a.kind}`);
      ui.print(`  ${ui.dim("purpose:")}   ${a.purpose}`);
      if (a.description) ui.print(`  ${ui.dim("delegate:")}  ${a.description}`);
      if (a.tools && a.tools.length > 0) {
        ui.print(`  ${ui.dim("tools:")}     ${a.tools.join(", ")}`);
      }
      if (a.model) ui.print(`  ${ui.dim("model:")}     ${a.model}`);
      ui.print(`  ${ui.dim("builtin:")}   ${a.builtin ? "yes" : "no"}`);
      ui.print(`  ${ui.dim("version:")}   ${a.version}`);
      ui.print(`  ${ui.dim("updated:")}   ${a.updatedAt}`);
      ui.blank();
      ui.print(ui.dim("─── instructions.md ───"));
      ui.blank();
      process.stdout.write(a.instructions.trimEnd() + "\n");
      if (a.learnings.trim().length > 0) {
        ui.blank();
        ui.print(ui.dim("─── learnings.md ───"));
        ui.blank();
        process.stdout.write(a.learnings.trimEnd() + "\n");
      }
      return 0;
    } catch (err) {
      if (err instanceof AgentNotFoundError || err instanceof AgentFileError) {
        ui.error(err.message);
        if (err instanceof AgentNotFoundError && findBuiltinAgent(id)) {
          ui.print(
            `  ${ui.dim(`"${id}" is a built-in — install it with \`atelier agent install ${id}\`.`)}`
          );
        }
        return 1;
      }
      throw err;
    }
  },
};

// ============================================================
// install
// ============================================================

const installCmd: Command = {
  name: "install",
  summary: "Render an agent into .claude/ so Claude Code can discover it.",
  description:
    "Writes .claude/commands/atelier/<id>.md (slash command) and\n" +
    ".claude/agents/atelier-<id>.md (subagent). Materializes a built-in\n" +
    "template into .atelier/agents/ first if it isn't there yet. Safe to\n" +
    "re-run — the .claude/ files are generated artifacts, always rewritten\n" +
    "from the canonical def.",
  positionals: ["id"],
  async run({ positionals, cwd, mode }) {
    const [id] = positionals;
    if (!id) {
      ui.error("Missing <id> argument.");
      ui.print(`  ${ui.dim("Usage: atelier agent install <id>")}`);
      ui.print(`  ${ui.dim("Run `atelier agent list` to see what's available.")}`);
      return 2;
    }
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;

    try {
      const result = await installAgent(root, id);
      ui.success(`Installed agent ${ui.bold(result.agent.id)}`);
      ui.blank();
      ui.print(`  ${ui.dim("Slash command:")} ${result.commandPath}`);
      ui.print(`  ${ui.dim("Subagent:")}      ${result.subagentPath}`);
      ui.blank();
      ui.print(
        `  ${ui.dim("In Claude Code, run")} ${ui.cyan(result.invocation)} ${ui.dim("or let Claude delegate to")} ${ui.cyan("atelier-" + result.agent.id)}${ui.dim(".")}`
      );
      ui.print(
        `  ${ui.dim("(New files may need a Claude Code session reload to appear.)")}`
      );
      ui.blank();
      return 0;
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        ui.error(`No agent or built-in named "${id}".`);
        const hint = mode === "repl" ? "/agent list" : "atelier agent list";
        ui.print(`  ${ui.dim(`Run \`${hint}\` to see what's available.`)}`);
        return 1;
      }
      throw err;
    }
  },
};

// ============================================================
// uninstall
// ============================================================

const uninstallCmd: Command = {
  name: "uninstall",
  summary: "Remove an agent's rendered .claude/ files (keeps the canonical def).",
  positionals: ["id"],
  async run({ positionals, cwd }) {
    const [id] = positionals;
    if (!id) {
      ui.error("Missing <id> argument.");
      ui.print(`  ${ui.dim("Usage: atelier agent uninstall <id>")}`);
      return 2;
    }
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;

    await uninstallAgent(root, id);
    ui.success(`Uninstalled ${ui.bold(id)} from .claude/ (canonical def kept).`);
    return 0;
  },
};

// ============================================================
// learn — append a durable workspace fact, then re-render
// ============================================================

const learnCmd: Command = {
  name: "learn",
  summary: "Teach an agent a durable fact about this workspace (self-improve).",
  description:
    "Appends a timestamped note to the agent's learnings.md and re-renders\n" +
    "the .claude/ files (if the agent is installed) so the learning is\n" +
    "carried into future runs. This is how atelier's agents accumulate\n" +
    "context about the workspace over time.",
  positionals: ["id", "note?"],
  options: {
    header: { type: "string", short: "H" },
    "no-reinstall": { type: "boolean" },
  },
  async run({ values, positionals, cwd }) {
    const [id, note] = positionals;
    if (!id || !note) {
      ui.error("Missing arguments.");
      ui.print(
        `  ${ui.dim('Usage: atelier agent learn <id> "durable fact" [--header "..."]')}`
      );
      return 2;
    }
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;

    try {
      const agent = await appendLearning(root, id, note, {
        header: values.header as string | undefined,
      });
      ui.success(`Recorded a learning for ${ui.bold(agent.id)}.`);

      // Re-render if the agent is currently installed, so .claude/
      // reflects the new learning without a manual re-install.
      if (values["no-reinstall"] !== true) {
        const { agents } = await listAgents(root);
        const installed = agents.find((a) => a.agent.id === id)?.installed;
        if (installed) {
          await installAgent(root, id);
          ui.print(`  ${ui.dim("Re-rendered .claude/ files with the new learning.")}`);
        } else {
          ui.print(
            `  ${ui.dim(`Install with \`atelier agent install ${id}\` to surface it to Claude.`)}`
          );
        }
      }
      return 0;
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

// ============================================================
// new — author a custom agent
// ============================================================

const newCmd: Command = {
  name: "new",
  summary: "Author a new custom agent.",
  description:
    "Creates .atelier/agents/<id>/ with agent.yaml + instructions.md.\n" +
    "Pass --instructions-file to seed the playbook body, or edit\n" +
    "instructions.md afterward. Run `atelier agent install <id>` to make\n" +
    "Claude Code discover it.",
  positionals: ["name?"],
  options: {
    name: { type: "string", short: "n" },
    id: { type: "string" },
    kind: { type: "string", short: "k" },
    purpose: { type: "string", short: "p" },
    description: { type: "string", short: "d" },
    "argument-hint": { type: "string" },
    tools: { type: "string" },
    model: { type: "string", short: "m" },
    "instructions-file": { type: "string" },
  },
  async run({ values, positionals, cwd }) {
    const name = (values.name as string | undefined) ?? positionals[0];
    if (!name) {
      ui.error("Missing agent name.");
      ui.print(`  ${ui.dim('Usage: atelier agent new "My Agent" --purpose "..."')}`);
      return 2;
    }
    const purpose = values.purpose as string | undefined;
    if (!purpose) {
      ui.error("Missing --purpose (one-line statement of what the agent is for).");
      return 2;
    }
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;

    let instructions: string | undefined;
    const instrFile = values["instructions-file"] as string | undefined;
    if (instrFile) {
      try {
        instructions = await fs.readFile(instrFile, "utf8");
      } catch (err) {
        ui.error(`Couldn't read --instructions-file: ${(err as Error).message}`);
        return 2;
      }
    }

    const tools = (values.tools as string | undefined)
      ?.split(",")
      .map((t) => t.trim())
      .filter(Boolean);

    try {
      const agent = await addAgent(root, {
        id: values.id as string | undefined,
        name,
        kind: values.kind as string | undefined,
        purpose,
        description: values.description as string | undefined,
        argumentHint: values["argument-hint"] as string | undefined,
        tools: tools && tools.length > 0 ? tools : undefined,
        model: values.model as string | undefined,
        instructions,
      });
      ui.success(`Created agent ${ui.bold(agent.id)}`);
      ui.blank();
      ui.print(`  ${ui.dim("→ Edit the playbook:")} .atelier/agents/${agent.id}/instructions.md`);
      ui.print(`  ${ui.dim("→ Make Claude discover it:")} atelier agent install ${agent.id}`);
      ui.blank();
      return 0;
    } catch (err) {
      if (err instanceof AgentAlreadyExistsError) {
        ui.error(err.message);
        return 1;
      }
      if (err instanceof Error && /slug id|required/.test(err.message)) {
        ui.error(err.message);
        return 2;
      }
      throw err;
    }
  },
};

// ============================================================
// remove
// ============================================================

const removeCmd: Command = {
  name: "remove",
  summary: "Delete an agent (canonical def + rendered .claude/ files).",
  positionals: ["id"],
  async run({ positionals, cwd }) {
    const [id] = positionals;
    if (!id) {
      ui.error("Missing <id> argument.");
      ui.print(`  ${ui.dim("Usage: atelier agent remove <id>")}`);
      return 2;
    }
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;

    try {
      const removed = await removeAgent(root, id);
      ui.success(`Removed agent ${ui.bold(removed.id)}`);
      return 0;
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

// ============================================================
// instruction — author/refine an agent's recursive playbook units
// ============================================================

const instructionListCmd: Command = {
  name: "list",
  summary: "List an agent's instruction units (the playbook tree).",
  positionals: ["agent"],
  async run({ positionals, cwd }) {
    const [agentId] = positionals;
    if (!agentId) {
      ui.error("Missing <agent> argument.");
      ui.print(`  ${ui.dim("Usage: atelier agent instruction list <agent>")}`);
      return 2;
    }
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;

    try {
      const units = await listInstructionUnits(root, agentId);
      if (units.length === 0) {
        ui.info(`Agent "${agentId}" has no instruction tree (flat instructions.md).`);
        ui.print(
          `  ${ui.dim(`Add the first unit with \`atelier agent instruction add ${agentId} <slug> --title "…"\` (migrates the flat playbook into an "overview" unit).`)}`
        );
        return 0;
      }
      ui.print(ui.bold(`${agentId} — instruction units`));
      for (const u of units) {
        const desc = u.description ? `  ${ui.dim("— " + u.description)}` : "";
        ui.print(`  ${ui.green("·")} ${u.slug.padEnd(14)} ${u.title}${desc}`);
      }
      ui.blank();
      ui.print(`  ${ui.dim(`Drill in with \`atelier map agents/${agentId}/instructions\`.`)}`);
      ui.blank();
      return 0;
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

const instructionAddCmd: Command = {
  name: "add",
  summary: "Add or replace one instruction unit on an agent.",
  description:
    "Writes instructions/<slug>/ (index.yaml + detail.md). If the agent\n" +
    "still uses a flat instructions.md, it's migrated into an 'overview'\n" +
    "unit first so nothing is lost. Re-renders the .claude/ files when the\n" +
    "agent is installed. Use --parent <slug> to nest under another unit.",
  positionals: ["agent", "slug"],
  options: {
    title: { type: "string", short: "t" },
    description: { type: "string", short: "d" },
    "detail-text": { type: "string" },
    "detail-file": { type: "string" },
    parent: { type: "string", short: "p" },
    "no-reinstall": { type: "boolean" },
  },
  async run({ values, positionals, cwd }) {
    const [agentId, slug] = positionals;
    if (!agentId || !slug) {
      ui.error("Missing arguments.");
      ui.print(
        `  ${ui.dim('Usage: atelier agent instruction add <agent> <slug> --title "…" [--detail-file PATH | --detail-text "…"]')}`
      );
      return 2;
    }
    const title = values.title as string | undefined;
    if (!title) {
      ui.error("Missing --title.");
      return 2;
    }
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;

    let detail = (values["detail-text"] as string | undefined) ?? "";
    const detailFile = values["detail-file"] as string | undefined;
    if (detailFile) {
      try {
        detail = await fs.readFile(detailFile, "utf8");
      } catch (err) {
        ui.error(`Couldn't read --detail-file: ${(err as Error).message}`);
        return 2;
      }
    }

    try {
      await addInstructionUnit(
        root,
        agentId,
        {
          slug,
          title,
          description: values.description as string | undefined,
          detail,
        },
        { parentSlug: values.parent as string | undefined }
      );
      ui.success(`Added instruction unit ${ui.bold(slug)} to ${agentId}.`);

      if (values["no-reinstall"] !== true) {
        const { agents } = await listAgents(root);
        if (agents.find((a) => a.agent.id === agentId)?.installed) {
          await installAgent(root, agentId);
          ui.print(`  ${ui.dim("Re-rendered .claude/ files with the updated playbook.")}`);
        }
      }
      ui.print(
        `  ${ui.dim(`Edit the detail at .atelier/agents/${agentId}/instructions/${slug}/detail.md`)}`
      );
      ui.blank();
      return 0;
    } catch (err) {
      if (err instanceof AgentNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      if (err instanceof Error && /to nest under/.test(err.message)) {
        ui.error(err.message);
        return 2;
      }
      throw err;
    }
  },
};

const instructionCmd: Command = {
  name: "instruction",
  summary: "Author an agent's recursive instruction tree (playbook units).",
  description:
    "An agent's playbook can be a recursive tree of instruction units —\n" +
    "each its own folder with an index (title + brief description) and a\n" +
    "detail.md. This is progressive disclosure: an agent reads the unit\n" +
    "summaries first and loads only the detail it needs. These commands\n" +
    "let you (or an agent) refine that tree structurally.",
  subcommands: [instructionListCmd, instructionAddCmd],
};

// ============================================================
// Top-level group
// ============================================================

export const agentCommand: Command = {
  name: "agent",
  summary: "Author agents atelier produces for AI tools to discover and run.",
  description:
    "Atelier never calls an LLM — it authors agents and renders them into\n" +
    ".claude/ so Claude Code can discover them as slash commands\n" +
    "(/atelier:<id>) + delegatable subagents. Canonical defs live under\n" +
    ".atelier/agents/<id>/ (agent.yaml + instructions.md + learnings.md).\n" +
    "Agents self-improve: `agent learn` appends durable workspace facts\n" +
    "that get folded into every future run.\n\n" +
    "Start with the built-in discovery agent:\n" +
    "  atelier agent install discovery",
  subcommands: [
    listCmd,
    showCmd,
    installCmd,
    uninstallCmd,
    learnCmd,
    instructionCmd,
    newCmd,
    removeCmd,
  ],
};
