import {
  requireWorkspaceRoot,
  buildDesignPalette,
  paletteSize,
  NotInsideWorkspaceError,
  type DesignPalette,
} from "@atelier/core";
import type { Command } from "../command.js";
import { ui } from "../ui.js";

/**
 * `atelier design` — design-engine helpers.
 *
 * Today: `palette`, the reusable vocabulary the system-design agent's
 * live companion mode loads once at the start of a call so every live
 * update is a cheap reference ("derive, don't generate") instead of an
 * expensive from-scratch generation.
 */

const SECTION_LABELS: Record<keyof DesignPalette, string> = {
  subsystems: "Subsystems",
  features: "Features",
  designs: "Existing designs",
  owners: "Owners",
};

const paletteCmd: Command = {
  name: "palette",
  summary: "The reusable design vocabulary (subsystems, features, designs, owners).",
  description:
    "Derives — deterministically — the building blocks the system-design\n" +
    "agent can reference by `ref` when sketching live: subsystems (from\n" +
    "`repo inspect`), capabilities (features), existing system-design\n" +
    "items, and owners (stakeholders). The live companion loads this once\n" +
    "at the start of a call and composes from it, so updates stay fast\n" +
    "and consistent with the real system. --json for the agent.",
  options: {
    json: { type: "boolean" },
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

    const palette = await buildDesignPalette(workspaceRoot);

    if (values.json === true) {
      process.stdout.write(JSON.stringify(palette, null, 2) + "\n");
      return 0;
    }

    if (paletteSize(palette) === 0) {
      ui.info("The design palette is empty.");
      ui.print(
        `  ${ui.dim("Register repos (`atelier repo add`), add features, or run the")}`
      );
      ui.print(
        `  ${ui.dim("system-design agent's workspace-design pass to populate it.")}`
      );
      return 0;
    }

    for (const key of ["subsystems", "features", "designs", "owners"] as (keyof DesignPalette)[]) {
      const entries = palette[key];
      if (entries.length === 0) continue;
      ui.print(ui.bold(`${SECTION_LABELS[key]} (${entries.length})`));
      for (const e of entries) {
        const desc = e.description ? `  ${ui.dim("— " + e.description)}` : "";
        ui.print(`  ${ui.green("·")} ${ui.cyan(e.ref)}  ${e.name}${desc}`);
      }
      ui.blank();
    }
    ui.print(
      `  ${ui.dim("The system-design agent references these by `ref` during live mode.")}`
    );
    ui.blank();
    return 0;
  },
};

export const designCommand: Command = {
  name: "design",
  summary: "Design-engine helpers (the reusable palette the live agent derives from).",
  description:
    "Helpers for the system-design agent. `palette` emits the reusable\n" +
    "vocabulary the agent composes from during live companion mode.\n" +
    "(To declare which design tool drives the work, see `design-tool`.)",
  subcommands: [paletteCmd],
};
