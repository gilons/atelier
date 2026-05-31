import {
  requireWorkspaceRoot,
  buildDesignPalette,
  paletteSize,
  loadDesignConfig,
  setLiveConfig,
  DesignConfigError,
  NotInsideWorkspaceError,
  type DesignPalette,
} from "@atelier/core";
import type { Command } from "../command.js";
import { ui } from "../ui.js";

/** The agent's built-in default when no stability gate is configured. */
const DEFAULT_STABILITY_CHUNKS = 2;

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

// ============================================================
// design live — tune the live companion's two-track cadence
// ============================================================

const liveShowCmd: Command = {
  name: "show",
  summary: "Show the live-companion tuning (stability gate, live STT model).",
  async run({ cwd }) {
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
    const cfg = await loadDesignConfig(workspaceRoot);
    const live = cfg?.live;
    const chunks = live?.stabilityChunks ?? DEFAULT_STABILITY_CHUNKS;
    ui.print(
      `  ${ui.dim("stability gate:")} ${chunks} chunk(s)${live?.stabilityChunks === undefined ? ui.dim(" (default)") : ""}`
    );
    ui.print(
      `  ${ui.dim("live STT model:")} ${live?.model ?? ui.dim("(agent default — fast model)")}`
    );
    return 0;
  },
};

const liveSetCmd: Command = {
  name: "set",
  summary: "Tune the live companion (stability gate / live STT model).",
  description:
    "The slow track renders only after a topic is stable for\n" +
    "--stability-chunks chunks (higher = calmer on volatile calls).\n" +
    "--model picks the fast STT model used live. The system-design\n" +
    "agent reads these at the start of a live session.",
  options: {
    "stability-chunks": { type: "string" },
    model: { type: "string", short: "m" },
  },
  async run({ values, cwd }) {
    if (values["stability-chunks"] === undefined && values.model === undefined) {
      ui.error("Nothing to set. Pass --stability-chunks <n> and/or --model <name>.");
      return 2;
    }
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

    let stabilityChunks: number | undefined;
    if (values["stability-chunks"] !== undefined) {
      const n = Number(values["stability-chunks"]);
      if (!Number.isInteger(n) || n < 1) {
        ui.error("--stability-chunks must be a positive integer.");
        return 2;
      }
      stabilityChunks = n;
    }

    try {
      const cfg = await setLiveConfig(workspaceRoot, {
        stabilityChunks,
        model: values.model as string | undefined,
      });
      ui.success("Updated live-companion tuning.");
      ui.print(`  ${ui.dim("stability gate:")} ${cfg.live?.stabilityChunks ?? DEFAULT_STABILITY_CHUNKS} chunk(s)`);
      if (cfg.live?.model) ui.print(`  ${ui.dim("live STT model:")} ${cfg.live.model}`);
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

const liveCmd: Command = {
  name: "live",
  summary: "Tune the live companion's cadence (stability gate, live STT model).",
  description:
    "The live companion uses a two-track design: a cheap fast track\n" +
    "every chunk + a gated slow track that renders only once a topic is\n" +
    "stable. These knobs calibrate that gate to your calls.",
  subcommands: [liveShowCmd, liveSetCmd],
};

export const designCommand: Command = {
  name: "design",
  summary: "Design-engine helpers (palette + live-companion tuning).",
  description:
    "Helpers for the system-design agent. `palette` emits the reusable\n" +
    "vocabulary the agent composes from during live companion mode;\n" +
    "`live` tunes the live two-track cadence.\n" +
    "(To declare which design tool drives the work, see `design-tool`.)",
  subcommands: [paletteCmd, liveCmd],
};
