import type { Command, CommandRegistry } from "./command.js";
import type { CompleterFn } from "./prompt.js";

/**
 * Tab-completion for the REPL prompt.
 *
 * Behavior, in priority order:
 *
 *   1. Empty input  → suggest the slash prefix so the user knows
 *      commands start with `/`.
 *   2. Non-slash input → no suggestions (we don't autocomplete
 *      arbitrary text; the REPL responds with a hint message
 *      instead).
 *   3. `/<partial>` → match against built-in REPL commands
 *      (`help`, `quit`, …) plus every top-level CLI command.
 *   4. `/<cmd> <sub-partial>` → walk into the command tree; suggest
 *      matching subcommand names.
 *   5. `/<cmd> [...args] <partial>` after a leaf command was
 *      reached → first try the command's `complete()` hook (e.g.
 *      `source onboard` enumerates registered source kinds), then
 *      fall back to option flag completion (`--transport`,
 *      `--non-interactive`, …).
 *   6. `/<cmd> [...args] ` (trailing space) → show every possible
 *      next thing (subcommands and/or options and/or positional
 *      completions).
 *
 * The completer is pure-function (no side effects) and easy to
 * unit-test. The REPL passes the result to readline.
 */

/** REPL-only commands that aren't in the CommandRegistry. */
export const REPL_BUILTINS = ["help", "status", "clear", "quit", "exit"];

export function buildReplCompleter(registry: CommandRegistry): CompleterFn {
  return (line: string) => {
    return completeLine(registry, line);
  };
}

/** Exported for unit tests — pure function, no side effects. */
export function completeLine(
  registry: CommandRegistry,
  line: string
): [string[], string] {
  // The user hasn't typed anything yet — suggest "/" so they know
  // commands start with a slash.
  if (line.trim() === "") return [["/"], line];

  // Non-slash input → no completions. The REPL will print a hint
  // when the user hits enter, which is the better cue than tab.
  if (!line.startsWith("/")) return [[], line];

  // Tokenize the post-slash portion. Treat trailing whitespace as
  // meaningful — it means "I've finished a token and want the next
  // thing", which changes the suggestion shape (no partial match).
  const body = line.slice(1);
  const endsWithSpace = /\s$/.test(body) || body === "";
  const tokens = body.split(/\s+/).filter((t) => t.length > 0);

  // Phase 1: still typing the top-level command name.
  if (tokens.length === 0 || (tokens.length === 1 && !endsWithSpace)) {
    const partial = (tokens[0] ?? "").toLowerCase();
    const all = uniqueSorted([
      ...REPL_BUILTINS,
      ...registry.commands.map((c) => c.name),
    ]);
    const matches = all.filter((name) => name.startsWith(partial));
    // Return matches as `/<name>` so readline replaces the typed
    // `/<partial>` correctly. The trailing space hint is left off
    // because some matches are exit verbs (`/quit`) that don't take
    // arguments — readline will still allow the user to type a space
    // afterward.
    return [matches.map((n) => `/${n}`), `/${tokens[0] ?? ""}`];
  }

  // Phase 2: top-level command is known. Walk into it.
  const cmdName = tokens[0];
  const cmd = registry.commands.find((c) => c.name === cmdName);
  if (!cmd) return [[], ""];

  return completeWithinCommand(cmd, tokens.slice(1), endsWithSpace);
}

/**
 * Recursive helper: given a command and the tokens that follow it,
 * decide what the user is typing and return completions.
 *
 * - If the command has subcommands and the next token matches one,
 *   descend.
 * - Otherwise either complete the subcommand name (partial), the
 *   command's positional via its `complete()` hook, or an option.
 */
function completeWithinCommand(
  cmd: Command,
  args: string[],
  endsWithSpace: boolean
): [string[], string] {
  // If this is a group command (has subcommands), the next token is
  // a subcommand name. Walk in if it matches one.
  if (cmd.subcommands && cmd.subcommands.length > 0) {
    if (args.length > 0 && !endsWithSpace && args.length === 1) {
      // User is typing a partial subcommand name.
      const partial = args[0].toLowerCase();
      const subs = cmd.subcommands
        .map((s) => s.name)
        .filter((n) => n.startsWith(partial));
      return [subs, args[0]];
    }
    if (args.length === 0) {
      // Right after the group command — list all subcommands.
      return [cmd.subcommands.map((s) => s.name), ""];
    }
    const match = cmd.subcommands.find((s) => s.name === args[0]);
    if (match) {
      return completeWithinCommand(match, args.slice(1), endsWithSpace);
    }
    // Unknown subcommand and we're past it — no further completion.
    return [[], ""];
  }

  // Leaf command. The user is either:
  //   (a) typing an option flag (token starts with `--`)
  //   (b) typing a positional, which the command's `complete()` hook
  //       enumerates if it cares to
  //   (c) at a trailing space, expecting "what's next?"
  const optionNames = cmd.options
    ? Object.keys(cmd.options).map((o) => `--${o}`)
    : [];

  if (args.length === 0 || (endsWithSpace && (args.length === 0 || lastNonOption(args) === null))) {
    // Right after the leaf command or after consuming options/positionals
    // with a trailing space — offer both positional completions and options.
    const positional =
      cmd.complete?.(positionalsOnly(args), "") ?? [];
    return [[...positional, ...optionNames], ""];
  }

  const last = args[args.length - 1];

  if (endsWithSpace) {
    // The previous token was completed; we're between args.
    // Are we still in positional territory or in flags-only mode?
    const positional = cmd.complete?.(positionalsOnly(args), "") ?? [];
    return [[...positional, ...optionNames], ""];
  }

  // Typing a partial last token.
  if (last.startsWith("--")) {
    const matches = optionNames.filter((o) => o.startsWith(last));
    return [matches, last];
  }
  // Otherwise treat as a partial positional. The command's hook
  // decides what's valid; if it has none, we just return empty.
  const positional =
    cmd.complete?.(positionalsOnly(args.slice(0, -1)), last) ?? [];
  return [positional, last];
}

/** Filter out option tokens (`--foo`, `-x`) when counting positionals. */
function positionalsOnly(args: string[]): string[] {
  return args.filter((a) => !a.startsWith("-"));
}

/** Find the last non-option token, if any. */
function lastNonOption(args: string[]): string | null {
  for (let i = args.length - 1; i >= 0; i--) {
    if (!args[i].startsWith("-")) return args[i];
  }
  return null;
}

function uniqueSorted(items: string[]): string[] {
  return [...new Set(items)].sort();
}
