import { parseArgs, type ParseArgsConfig } from "node:util";

/**
 * Minimal command framework with nested subcommands.
 *
 * A Command is either a "leaf" (has a `run` handler) or a "group"
 * (has `subcommands` and no `run`). Mixing is permitted but typically
 * not useful — keep commands at one or the other end.
 *
 * Dispatch walks down the tree by matching positional args against
 * subcommand names. Help is generated automatically at every level.
 */

export type Exitable = void | number | Promise<void | number>;

export interface Command {
  /** Command name as the user types it ("init", "add", ...). */
  name: string;
  /** One-line summary for parent-level help listings. */
  summary: string;
  /** Multi-line detail for `<cmd> --help`. */
  description?: string;
  /** Node parseArgs option definitions. Leaf commands only. */
  options?: ParseArgsConfig["options"];
  /** Positional argument names for help rendering. Leaf commands only. */
  positionals?: string[];
  /** Nested subcommands. Group commands only. */
  subcommands?: Command[];
  /** Handler. Leaf commands only. */
  run?(ctx: CommandContext): Exitable;
  /**
   * Optional tab-completion hook for the REPL. Called when the user
   * has reached this command and is typing a positional argument.
   *
   * @param priorArgs  Positional arguments already supplied to this command.
   * @param partial    The token currently being typed (may be empty).
   * @returns          Candidate completion strings (full token forms).
   *
   * Example: `source onboard <kind>` enumerates registered adapter
   * kinds so the user gets `notion`, `sharepoint`,
   * `github-discussions` on tab.
   */
  complete?(priorArgs: string[], partial: string): string[];
}

export interface CommandContext {
  values: Record<string, unknown>;
  positionals: string[];
  cwd: string;
}

export interface CommandRegistry {
  commands: Command[];
}

/** Dispatch argv against the top-level registry. Returns exit code. */
export async function dispatch(
  registry: CommandRegistry,
  argv: string[],
  cwd: string,
  versionString: string
): Promise<number> {
  const [first, ...rest] = argv;

  if (!first || first === "--help" || first === "-h" || first === "help") {
    renderTopLevelHelp(registry, versionString);
    return 0;
  }
  if (first === "--version" || first === "-v") {
    process.stdout.write(`${versionString}\n`);
    return 0;
  }

  const cmd = registry.commands.find((c) => c.name === first);
  if (!cmd) {
    process.stderr.write(`Unknown command: ${first}\n`);
    renderTopLevelHelp(registry, versionString);
    return 1;
  }

  return dispatchCommand(cmd, rest, cwd, [first]);
}

/** Recursively walk into subcommands until reaching a leaf, then run it. */
async function dispatchCommand(
  cmd: Command,
  args: string[],
  cwd: string,
  trail: string[]
): Promise<number> {
  // Help short-circuits — at any level.
  if (args[0] === "--help" || args[0] === "-h") {
    renderCommandHelp(cmd, trail);
    return 0;
  }

  // Group command: descend into subcommands.
  if (cmd.subcommands && cmd.subcommands.length > 0) {
    const sub = args[0] ? cmd.subcommands.find((s) => s.name === args[0]) : undefined;
    if (sub) {
      return dispatchCommand(sub, args.slice(1), cwd, [...trail, sub.name]);
    }
    if (args[0]) {
      process.stderr.write(`Unknown subcommand: ${args[0]}\n`);
    } else if (!cmd.run) {
      process.stderr.write(`${trail.join(" ")} requires a subcommand.\n`);
    }
    renderCommandHelp(cmd, trail);
    return args[0] ? 1 : 0;
  }

  // Leaf command: parse options and run.
  if (!cmd.run) {
    process.stderr.write(`Command "${trail.join(" ")}" has no implementation.\n`);
    return 2;
  }

  let parsed: { values: Record<string, unknown>; positionals: string[] };
  try {
    const result = parseArgs({
      args,
      options: cmd.options ?? {},
      allowPositionals: true,
      strict: true,
    });
    parsed = { values: result.values, positionals: result.positionals };
  } catch (err) {
    process.stderr.write(`Error parsing arguments for "${trail.join(" ")}": ${(err as Error).message}\n`);
    renderCommandHelp(cmd, trail);
    return 2;
  }

  try {
    const code = await cmd.run({
      values: parsed.values,
      positionals: parsed.positionals,
      cwd,
    });
    return typeof code === "number" ? code : 0;
  } catch (err) {
    process.stderr.write(`${(err as Error).message}\n`);
    return 1;
  }
}

function renderTopLevelHelp(registry: CommandRegistry, versionString: string): void {
  const lines: string[] = [];
  lines.push("");
  lines.push("  atelier — a planning companion for the spec-driven era");
  lines.push("");
  lines.push("  Usage:");
  lines.push("    atelier <command> [options]");
  lines.push("");
  lines.push("  Commands:");
  const maxName = registry.commands.reduce((m, c) => Math.max(m, c.name.length), 0);
  for (const c of registry.commands) {
    lines.push(`    ${c.name.padEnd(maxName + 4)}${c.summary}`);
  }
  lines.push("");
  lines.push("  Run `atelier <command> --help` for command-specific help.");
  lines.push("");
  lines.push(`  Version: ${versionString}`);
  lines.push("");
  process.stdout.write(lines.join("\n"));
}

function renderCommandHelp(cmd: Command, trail: string[]): void {
  const path = `atelier ${trail.join(" ")}`;
  const lines: string[] = [];
  lines.push("");
  lines.push(`  ${path} — ${cmd.summary}`);
  lines.push("");

  // Usage line
  let usage: string;
  if (cmd.subcommands && cmd.subcommands.length > 0) {
    usage = `${path} <subcommand> [options]`;
  } else {
    const positionals =
      cmd.positionals && cmd.positionals.length > 0
        ? cmd.positionals.map((p) => `<${p}>`).join(" ") + " "
        : "";
    usage = `${path} ${positionals}[options]`;
  }
  lines.push("  Usage:");
  lines.push(`    ${usage}`);
  lines.push("");

  if (cmd.description) {
    lines.push(`  ${cmd.description.split("\n").join("\n  ")}`);
    lines.push("");
  }

  // Subcommands
  if (cmd.subcommands && cmd.subcommands.length > 0) {
    lines.push("  Subcommands:");
    const maxName = cmd.subcommands.reduce((m, s) => Math.max(m, s.name.length), 0);
    for (const s of cmd.subcommands) {
      lines.push(`    ${s.name.padEnd(maxName + 4)}${s.summary}`);
    }
    lines.push("");
  }

  // Options
  if (cmd.options && Object.keys(cmd.options).length > 0) {
    lines.push("  Options:");
    for (const [name, def] of Object.entries(cmd.options)) {
      const short = def.short ? `-${def.short}, ` : "    ";
      const type = def.type === "string" ? " <value>" : "";
      lines.push(`    ${short}--${name}${type}`);
    }
    lines.push("");
  }
  process.stdout.write(lines.join("\n"));
}
