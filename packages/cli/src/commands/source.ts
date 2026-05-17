import {
  requireWorkspaceRoot,
  addSource,
  removeSource,
  listSources,
  setSourceEnabled,
  SOURCE_KINDS_LIST,
  SourceAlreadyRegisteredError,
  SourceNotFoundError,
  InvalidSourceKindError,
  NotInsideWorkspaceError,
} from "@atelier/core";
import type { Command } from "../command.js";
import { ui } from "../ui.js";

/** Parse a --scope-json string into an object. Throws on invalid JSON. */
function parseScopeJson(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`--scope-json must be valid JSON: ${(err as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("--scope-json must be a JSON object (e.g. '{\"spaceId\":\"abc\"}').");
  }
  return parsed as Record<string, unknown>;
}

const addCmd: Command = {
  name: "add",
  summary: "Register a documentation source.",
  description:
    "Registers a source Atelier will read from when building the doc map.\n" +
    "Atelier does NOT fetch from sources here — Phase 2's sync layer does\n" +
    "that. This command just records the connection details.\n\n" +
    "Valid kinds: " + SOURCE_KINDS_LIST.join(", "),
  options: {
    name: { type: "string", short: "n" },
    id: { type: "string" },
    mcp: { type: "string", short: "m" },
    "scope-json": { type: "string" },
    disabled: { type: "boolean" },
  },
  positionals: ["kind"],
  async run({ values, positionals, cwd }) {
    const [kind] = positionals;
    if (!kind) {
      ui.error("Missing <kind> argument.");
      ui.print(`  ${ui.dim("Usage: atelier source add <kind> --name <name> [--mcp <server>] [--scope-json '<json>']")}`);
      ui.print(`  ${ui.dim("Valid kinds: " + SOURCE_KINDS_LIST.join(", "))}`);
      return 2;
    }
    const name = values.name as string | undefined;
    if (!name) {
      ui.error("Missing --name option (the human-readable display name).");
      return 2;
    }

    let scope: Record<string, unknown> | undefined;
    if (values["scope-json"]) {
      try {
        scope = parseScopeJson(values["scope-json"] as string);
      } catch (err) {
        ui.error((err as Error).message);
        return 2;
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
      const source = await addSource(workspaceRoot, {
        kind,
        id: values.id as string | undefined,
        name,
        mcpServer: values.mcp as string | undefined,
        scope,
        enabled: values.disabled !== true,
      });
      ui.success(`Registered source ${ui.bold(source.id)}`);
      ui.blank();
      ui.print(`  ${ui.dim("Kind:")}      ${source.kind}`);
      ui.print(`  ${ui.dim("Name:")}      ${source.name}`);
      if (source.mcpServer) {
        ui.print(`  ${ui.dim("MCP:")}       ${source.mcpServer}`);
      }
      if (source.scope) {
        ui.print(`  ${ui.dim("Scope:")}     ${JSON.stringify(source.scope)}`);
      }
      if (!source.enabled) {
        ui.print(`  ${ui.dim("Status:")}    ${ui.yellow("disabled")}`);
      }
      ui.blank();
      return 0;
    } catch (err) {
      if (err instanceof InvalidSourceKindError) {
        ui.error(err.message);
        return 1;
      }
      if (err instanceof SourceAlreadyRegisteredError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

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
      ui.info("No documentation sources registered yet.");
      ui.print(`  ${ui.dim("Use `atelier source add <kind> --name \"...\"` to register one.")}`);
      ui.print(`  ${ui.dim("Valid kinds: " + SOURCE_KINDS_LIST.join(", "))}`);
      return 0;
    }
    const idWidth = Math.max("ID".length, ...sources.map((s) => s.id.length));
    const kindWidth = Math.max("KIND".length, ...sources.map((s) => s.kind.length));
    const nameWidth = Math.max("NAME".length, ...sources.map((s) => s.name.length));
    ui.print(
      `    ${ui.dim("ID".padEnd(idWidth))}  ${ui.dim("KIND".padEnd(kindWidth))}  ${ui.dim("NAME".padEnd(nameWidth))}  ${ui.dim("MCP")}`
    );
    for (const s of sources) {
      const marker = s.enabled ? ui.green("✓") : ui.yellow("·");
      const mcp = s.mcpServer ?? ui.dim("(none)");
      const status = s.enabled ? "" : ui.yellow(" (disabled)");
      ui.print(
        `  ${marker} ${s.id.padEnd(idWidth)}  ${s.kind.padEnd(kindWidth)}  ${s.name.padEnd(nameWidth)}  ${mcp}${status}`
      );
    }
    ui.blank();
    return 0;
  },
};

const removeCmd: Command = {
  name: "remove",
  summary: "Unregister a documentation source by id.",
  positionals: ["id"],
  async run({ positionals, cwd }) {
    const [id] = positionals;
    if (!id) {
      ui.error("Missing <id> argument.");
      ui.print(`  ${ui.dim("Usage: atelier source remove <id>")}`);
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
      ui.success(`Unregistered source ${ui.bold(removed.id)}`);
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

function buildToggleCmd(target: boolean, name: string, verb: string): Command {
  return {
    name,
    summary: `${verb} a documentation source.`,
    positionals: ["id"],
    async run({ positionals, cwd }) {
      const [id] = positionals;
      if (!id) {
        ui.error("Missing <id> argument.");
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
        const source = await setSourceEnabled(workspaceRoot, id, target);
        ui.success(
          `${target ? "Enabled" : "Disabled"} source ${ui.bold(source.id)}`
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
}

import { sourceOnboardCommand } from "./source-onboard.js";

export const sourceCommand: Command = {
  name: "source",
  summary: "Manage documentation sources Atelier reads from.",
  description:
    "Sources represent documentation lives the user has access to: Notion\n" +
    "workspaces, Confluence spaces, Google Drive folders, Jira projects.\n" +
    "Atelier reads from registered sources to build the product's doc map.\n\n" +
    "Most users should start with `atelier source onboard <kind>` — it\n" +
    "walks through transport detection, auth, verification, and registration.\n" +
    "`atelier source add` is the lower-level command for scripted/CI use.",
  subcommands: [
    sourceOnboardCommand,
    addCmd,
    listCmd,
    removeCmd,
    buildToggleCmd(true, "enable", "Enable"),
    buildToggleCmd(false, "disable", "Disable"),
  ],
};
