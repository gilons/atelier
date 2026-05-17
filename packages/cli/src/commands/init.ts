import * as path from "node:path";
import {
  initWorkspace,
  WorkspaceAlreadyInitializedError,
  PLANNING_DIR,
} from "@atelier/core";
import type { Command } from "../command.js";
import { ui } from "../ui.js";

export const initCommand: Command = {
  name: "init",
  summary: "Initialize a new planning workspace in the current directory.",
  description:
    "Creates a .planning/ directory with starter configuration files\n" +
    "(workspace.yaml, sources.yaml, repos.yaml), the canonical folder\n" +
    "structure (features/, ui/, issues/, cache/), and a README explaining\n" +
    "the layout.\n\n" +
    "Refuses to overwrite an existing workspace unless --force is given.",
  options: {
    name: { type: "string", short: "n" },
    description: { type: "string", short: "d" },
    force: { type: "boolean", short: "f" },
  },
  async run({ values, cwd }) {
    const name = (values.name as string | undefined) ?? path.basename(cwd);
    const description = values.description as string | undefined;
    const force = (values.force as boolean | undefined) ?? false;

    try {
      const result = await initWorkspace(cwd, { name, description, force });
      ui.success(`Initialized planning workspace in ${PLANNING_DIR}/`);
      ui.blank();
      ui.print(`  ${ui.dim("Name:")}     ${name}`);
      if (description) {
        ui.print(`  ${ui.dim("Desc:")}     ${description}`);
      }
      ui.print(`  ${ui.dim("Location:")} ${result.paths.planning}`);
      ui.blank();
      ui.print("  Created:");
      for (const f of result.createdFiles) {
        ui.print(`    ${ui.gray("·")} ${path.relative(cwd, f)}`);
      }
      ui.blank();
      ui.print("  Next:");
      ui.print(`    ${ui.gray("→")} register sibling repos:  ${ui.cyan("atelier repo add ../<repo>")}`);
      ui.print(`    ${ui.gray("→")} add a doc source:        ${ui.cyan("atelier source add notion")}`);
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
