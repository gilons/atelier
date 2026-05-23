import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  requireWorkspaceRoot,
  registerSource,
  removeSource,
  listSources,
  setSourceEnabled,
  readSourceSetup,
  updateSourceSetup,
  deriveSourceId,
  SourceAlreadyRegisteredError,
  SourceNotFoundError,
  NotInsideWorkspaceError,
  type Source,
} from "@atelier/core";
import type { Command } from "../command.js";
import { ui } from "../ui.js";

/**
 * `atelier source` — register and manage the workspace's documentation
 * sources.
 *
 * A source in atelier is a named bucket of agent-curated documents:
 *
 *   - An `id` agents reference when adding docs.
 *   - A `name` for humans.
 *   - A free-form `config` blob the agent reads at fetch time
 *     (workspace IDs, MCP server names, hostnames — whatever the
 *     agent's integration needs).
 *   - An optional `setup.md` runbook the agent reads when it needs
 *     to bring the source online (install browser ext, authorize a
 *     workspace, add an MCP server entry, etc.).
 *
 * Atelier does NOT talk to source systems. All fetching, auth, and
 * content extraction is the agent's responsibility — atelier is the
 * workspace-local index.
 */

function parseJsonObject(raw: string, flag: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${flag} must be valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${flag} must be a JSON object (e.g. '{"mcp_server":"notion-mcp"}').`);
  }
  return parsed as Record<string, unknown>;
}

async function readMaybeFile(p: string | undefined): Promise<string | undefined> {
  if (!p) return undefined;
  try {
    return await fs.readFile(p, "utf8");
  } catch (err) {
    throw new Error(`Couldn't read ${p}: ${(err as Error).message}`);
  }
}

// ============================================================
// register
// ============================================================

const registerCmd: Command = {
  name: "register",
  summary: "Register a documentation source (agent-driven).",
  description:
    "Atelier doesn't fetch from sources itself — agents do. This command\n" +
    "records (a) the agent-facing config the agent will read at fetch\n" +
    "time and (b) an optional connection runbook the agent follows to\n" +
    "set up access for the first time.\n\n" +
    "Example:\n" +
    '  atelier source register company-notion \\\n' +
    '    --name "Company Notion" \\\n' +
    '    --config \'{"mcp_server":"notion-mcp","workspace":"acme"}\' \\\n' +
    "    --setup-file ./notion-setup.md",
  positionals: ["id"],
  options: {
    name: { type: "string", short: "n" },
    config: { type: "string", short: "c" },
    "config-file": { type: "string" },
    "setup-file": { type: "string" },
    "setup-text": { type: "string" },
    disabled: { type: "boolean" },
  },
  async run({ positionals, values, cwd }) {
    const explicitId = positionals[0] as string | undefined;
    const name = values.name as string | undefined;
    if (!name) {
      ui.error("--name is required.");
      ui.print(
        `  ${ui.dim('Usage: atelier source register <id> --name "<name>" [--config <json>] [--setup-file <path>]')}`
      );
      return 2;
    }
    const id = (explicitId ?? deriveSourceId(name)).trim();
    if (!id) {
      ui.error("Could not derive an id from --name; pass an explicit positional id.");
      return 2;
    }

    let config: Record<string, unknown> | undefined;
    const configInline = values.config as string | undefined;
    const configFile = values["config-file"] as string | undefined;
    if (configInline && configFile) {
      ui.error("Pass either --config or --config-file, not both.");
      return 2;
    }
    if (configInline) {
      try {
        config = parseJsonObject(configInline, "--config");
      } catch (err) {
        ui.error((err as Error).message);
        return 2;
      }
    }
    if (configFile) {
      const text = await readMaybeFile(configFile);
      if (text !== undefined) {
        try {
          config = parseJsonObject(text, "--config-file");
        } catch (err) {
          ui.error((err as Error).message);
          return 2;
        }
      }
    }

    const setupInline = values["setup-text"] as string | undefined;
    const setupPath = values["setup-file"] as string | undefined;
    if (setupInline && setupPath) {
      ui.error("Pass either --setup-file or --setup-text, not both.");
      return 2;
    }
    let setupInstructions: string | undefined;
    if (setupInline) setupInstructions = setupInline;
    else if (setupPath) setupInstructions = await readMaybeFile(setupPath);

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

    try {
      const source = await registerSource(workspaceRoot, {
        id,
        name,
        config,
        setupInstructions,
        enabled: values.disabled === true ? false : true,
      });
      ui.success(`Registered source ${ui.bold(source.id)} (${source.name}).`);
      if (source.setupFile) {
        ui.print(
          `  ${ui.dim(`Setup runbook saved at .atelier/${source.setupFile}`)}`
        );
      } else {
        ui.print(
          `  ${ui.dim("No setup runbook attached — add one later with `atelier source update " + source.id + " --setup-file <path>`.")}`
        );
      }
      return 0;
    } catch (err) {
      if (err instanceof SourceAlreadyRegisteredError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

// ============================================================
// list
// ============================================================

const listCmd: Command = {
  name: "list",
  summary: "List registered documentation sources.",
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
    const sources = await listSources(workspaceRoot);
    if (sources.length === 0) {
      ui.info("No sources registered yet.");
      ui.print(
        `  ${ui.dim('Register one with `atelier source register <id> --name "..."` (config + setup runbook optional).')}`
      );
      return 0;
    }
    const idWidth = Math.max(
      "ID".length,
      ...sources.map((s) => s.id.length)
    );
    const nameWidth = Math.max(
      "NAME".length,
      ...sources.map((s) => s.name.length)
    );
    ui.print(
      `    ${ui.dim("ID".padEnd(idWidth))}  ${ui.dim("NAME".padEnd(nameWidth))}  ${ui.dim("STATE")}  ${ui.dim("SETUP")}`
    );
    for (const s of sources) {
      const state = s.enabled ? "enabled " : "disabled";
      const setup = s.setupFile ? "✓ runbook" : "no runbook";
      ui.print(
        `  ${ui.green("·")} ${s.id.padEnd(idWidth)}  ${s.name.padEnd(nameWidth)}  ${state}  ${setup}`
      );
    }
    return 0;
  },
};

// ============================================================
// show
// ============================================================

const showCmd: Command = {
  name: "show",
  summary: "Print a source's config + setup runbook (agent-readable).",
  description:
    "Use this to inspect a source's config + connection runbook. An\n" +
    "agent landing in the workspace runs `atelier source show <id>` to\n" +
    "read the steps it needs to follow to connect.",
  positionals: ["id"],
  async run({ positionals, cwd }) {
    const id = positionals[0];
    if (!id) {
      ui.error("Usage: atelier source show <id>");
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
    const sources = await listSources(workspaceRoot);
    const source = sources.find((s) => s.id === id);
    if (!source) {
      ui.error(`No source with id "${id}".`);
      return 1;
    }
    ui.print(ui.bold(source.name) + `  ${ui.dim("(id: " + source.id + ")")}`);
    ui.print(`  ${ui.dim("enabled:")}    ${source.enabled ? "yes" : "no"}`);
    if (source.config) {
      ui.print(`  ${ui.dim("config:")}`);
      const json = JSON.stringify(source.config, null, 2)
        .split("\n")
        .map((l) => "    " + l)
        .join("\n");
      ui.print(json);
    } else {
      ui.print(`  ${ui.dim("config:")}     ${ui.dim("(none)")}`);
    }
    ui.blank();
    const setup = await readSourceSetup(workspaceRoot, id);
    if (setup) {
      ui.print(ui.bold("Connection runbook"));
      ui.print(`  ${ui.dim("(.atelier/" + (source.setupFile ?? "") + ")")}`);
      ui.blank();
      // Indent two spaces so the runbook reads as a quoted block
      // when printed alongside other CLI output.
      for (const line of setup.split("\n")) {
        ui.print("  " + line);
      }
    } else {
      ui.print(`${ui.dim("No connection runbook attached.")}`);
    }
    return 0;
  },
};

// ============================================================
// update — replace the setup runbook
// ============================================================

const updateCmd: Command = {
  name: "update",
  summary: "Replace a source's setup runbook (or clear it).",
  positionals: ["id"],
  options: {
    "setup-file": { type: "string" },
    "setup-text": { type: "string" },
    clear: { type: "boolean" },
  },
  async run({ positionals, values, cwd }) {
    const id = positionals[0];
    if (!id) {
      ui.error("Usage: atelier source update <id> --setup-file <path>");
      return 2;
    }
    const clear = values.clear === true;
    const file = values["setup-file"] as string | undefined;
    const text = values["setup-text"] as string | undefined;
    if (clear && (file || text)) {
      ui.error("--clear can't be combined with --setup-file or --setup-text.");
      return 2;
    }
    if (!clear && !file && !text) {
      ui.error(
        "Pass --setup-file <path>, --setup-text <markdown>, or --clear."
      );
      return 2;
    }
    let next: string | null;
    if (clear) {
      next = null;
    } else if (text) {
      next = text;
    } else {
      try {
        next = await fs.readFile(file!, "utf8");
      } catch (err) {
        ui.error(`Couldn't read ${file}: ${(err as Error).message}`);
        return 1;
      }
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
    try {
      const source = await updateSourceSetup(workspaceRoot, id, next);
      ui.success(
        clear
          ? `Cleared setup runbook for ${ui.bold(source.id)}.`
          : `Updated setup runbook for ${ui.bold(source.id)}.`
      );
      return 0;
    } catch (err) {
      if (err instanceof SourceNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

// ============================================================
// remove / enable / disable
// ============================================================

const removeCmd: Command = {
  name: "remove",
  summary: "Remove a source from the registry.",
  positionals: ["id"],
  async run({ positionals, cwd }) {
    const id = positionals[0];
    if (!id) {
      ui.error("Usage: atelier source remove <id>");
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
    try {
      const removed = await removeSource(workspaceRoot, id);
      ui.success(`Removed source ${ui.bold(removed.id)} (${removed.name}).`);
      return 0;
    } catch (err) {
      if (err instanceof SourceNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

function toggleCmd(name: "enable" | "disable", enable: boolean): Command {
  return {
    name,
    summary: enable
      ? "Re-enable a previously disabled source."
      : "Disable a source without removing it.",
    positionals: ["id"],
    async run({ positionals, cwd }) {
      const id = positionals[0];
      if (!id) {
        ui.error(`Usage: atelier source ${name} <id>`);
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
      try {
        const source: Source = await setSourceEnabled(workspaceRoot, id, enable);
        ui.success(`${enable ? "Enabled" : "Disabled"} ${ui.bold(source.id)}.`);
        return 0;
      } catch (err) {
        if (err instanceof SourceNotFoundError) {
          ui.error(err.message);
          return 1;
        }
        throw err;
      }
    },
  };
}

// ============================================================
// bootstrap — print every source's setup runbook in one block
// ============================================================

const bootstrapCmd: Command = {
  name: "bootstrap",
  summary: "Print every registered source's connection runbook.",
  description:
    "An agent landing in this workspace runs `atelier source bootstrap`\n" +
    "to see what needs to be wired up. It walks through each source's\n" +
    "setup.md and follows the steps (possibly asking the user for help).\n" +
    "Disabled sources are skipped — they're paused intentionally.",
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
    const sources = (await listSources(workspaceRoot)).filter((s) => s.enabled);
    if (sources.length === 0) {
      ui.info("No enabled sources to bootstrap.");
      return 0;
    }
    ui.print(ui.bold(`Bootstrapping ${sources.length} source(s)`));
    ui.blank();
    for (const source of sources) {
      ui.print(ui.bold("─── " + source.id + " ───  ") + ui.dim(source.name));
      if (source.config) {
        ui.print(`  ${ui.dim("config:")}`);
        const json = JSON.stringify(source.config, null, 2)
          .split("\n")
          .map((l) => "    " + l)
          .join("\n");
        ui.print(json);
      }
      const setup = await readSourceSetup(workspaceRoot, source.id);
      if (setup) {
        ui.blank();
        ui.print(`  ${ui.dim("Setup runbook (.atelier/" + source.setupFile + ")")}`);
        ui.blank();
        for (const line of setup.split("\n")) {
          ui.print("  " + line);
        }
      } else {
        ui.print(`  ${ui.dim("(no setup runbook — already wired up or trivially-reachable)")}`);
      }
      ui.blank();
    }
    return 0;
  },
};

// Avoid "imported but never used" warnings until we expose path.
void path;

export const sourceCommand: Command = {
  name: "source",
  summary: "Register and manage documentation sources.",
  description:
    "Atelier doesn't fetch from sources directly — agents do, via MCP /\n" +
    "browser extensions / their own integrations. A source is just an\n" +
    "id + free-form config + an optional connection runbook the agent\n" +
    "follows to bring the source online.",
  subcommands: [
    registerCmd,
    listCmd,
    showCmd,
    updateCmd,
    removeCmd,
    toggleCmd("enable", true),
    toggleCmd("disable", false),
    bootstrapCmd,
  ],
};
