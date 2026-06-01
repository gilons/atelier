import * as path from "node:path";
import {
  initWorkspace,
  installAllBuiltinAgents,
  WorkspaceAlreadyInitializedError,
  ATELIER_DIR,
} from "@atelier/core";
import type { Command } from "../command.js";
import { hint } from "../command.js";
import { ui } from "../ui.js";

export const initCommand: Command = {
  name: "init",
  summary: "Initialize a workspace and install the atelier agents in one step.",
  description:
    "Creates a .atelier/ workspace (workspace.yaml, sources.yaml,\n" +
    "repos.yaml + the canonical folders) AND installs the built-in\n" +
    "agents (discovery, system-design, ui-design) into .claude/ so they\n" +
    "work in Claude Code immediately. That's the whole setup in one\n" +
    "command.\n\n" +
    "Pass --no-agents to skip the agent install (workspace only). Refuses\n" +
    "to overwrite an existing workspace unless --force is given.",
  options: {
    name: { type: "string", short: "n" },
    description: { type: "string", short: "d" },
    force: { type: "boolean", short: "f" },
    "no-agents": { type: "boolean" },
  },
  /**
   * REPL wizard prompts. When the user types `/init` in the REPL,
   * we ask for the workspace name inline instead of erroring on a
   * missing flag. From a non-REPL shell, `atelier init --name X`
   * still works and skips the prompt entirely.
   */
  prompts: [
    {
      key: "name",
      question: "Workspace name",
      help: "Shown on the welcome banner. Usually your org/team name.",
      validate: /\S/,
    },
  ],
  async run(ctx) {
    const { values, cwd } = ctx;
    const name = (values.name as string | undefined) ?? path.basename(cwd);
    const description = values.description as string | undefined;
    const force = (values.force as boolean | undefined) ?? false;
    const skipAgents = (values["no-agents"] as boolean | undefined) ?? false;

    try {
      const result = await initWorkspace(cwd, { name, description, force });
      ui.success(`Initialized planning workspace in ${ATELIER_DIR}/`);
      ui.blank();
      ui.print(`  ${ui.dim("Name:")}     ${name}`);
      if (description) {
        ui.print(`  ${ui.dim("Desc:")}     ${description}`);
      }
      ui.print(`  ${ui.dim("Location:")} ${result.paths.atelier}`);
      ui.blank();

      // Install all built-in agents into .claude/ so the workspace is
      // immediately drivable from Claude Code — one command, full setup.
      if (!skipAgents) {
        const installed = await installAllBuiltinAgents(cwd);
        ui.print(`  ${ui.dim("Agents installed")} ${ui.dim("(.claude/):")}`);
        for (const r of installed) {
          ui.print(`    ${ui.green("·")} ${ui.cyan(r.invocation)} ${ui.dim("→ " + r.agent.name)}`);
        }
        ui.blank();
        ui.print("  Next:");
        ui.print(
          `    ${ui.gray("→")} In Claude Code, run ${ui.cyan("/atelier:discovery")} to map your workspace.`
        );
        ui.print(
          `    ${ui.gray("→")} Or register repos first: ${ui.cyan(hint(ctx, "repo"))}`
        );
      } else {
        ui.print("  Next:");
        ui.print(
          `    ${ui.gray("→")} install the agents: ${ui.cyan(hint(ctx, "agent install --all"))}`
        );
        ui.print(
          `    ${ui.gray("→")} register repos:     ${ui.cyan(hint(ctx, "repo"))}`
        );
      }
      ui.blank();
      return 0;
    } catch (err) {
      if (err instanceof WorkspaceAlreadyInitializedError) {
        ui.error(`A planning workspace already exists at ${err.planningDir}`);
        ui.print(`  ${ui.dim("Use --force to overwrite, or run other commands against the existing workspace.")}`);
        return 1;
      }
      throw err;
    }
  },
};
