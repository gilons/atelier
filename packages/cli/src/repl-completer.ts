import type { Command, CommandRegistry } from "./command.js";
import type { Completer, CompletionResult, Suggestion } from "./suggestion.js";

/**
 * As-you-type completer for the REPL prompt.
 *
 * Returns `{ span, items }` where:
 *   - `span` is the substring of the current line that the chosen
 *     suggestion would replace (computed from the cursor position
 *     and the last token boundary).
 *   - `items` is an ordered list of suggestion rows. Each row has
 *     a `value` to insert, an optional `display` label, and a
 *     `description` (typically the underlying command's `summary`).
 *
 * Behavior:
 *   1. Empty input  → list every top-level command (including REPL
 *      built-ins) so the user can see what's possible.
 *   2. `/<partial>` → match against built-ins + registry commands.
 *   3. `/<cmd> <sub-partial>` → walk into the subcommand tree.
 *   4. `/<cmd> <subs...> <partial>` → first try the leaf command's
 *      `complete()` hook (e.g. `source onboard` enumerates source
 *      kinds with descriptions); then fall back to option flags.
 *   5. Non-slash input → no suggestions. The REPL handles the line
 *      with a hint message at submit time.
 *
 * Pure function; the REPL passes us through `InputReader.completer`.
 */

interface BuiltinDef {
  name: string;
  summary: string;
}

const REPL_BUILTIN_DEFS: BuiltinDef[] = [
  { name: "help", summary: "Show available commands" },
  { name: "status", summary: "Show workspace overview" },
  { name: "clear", summary: "Clear the screen" },
  { name: "quit", summary: "Leave the REPL" },
  { name: "exit", summary: "Leave the REPL" },
];

/** Re-exported for tests that want to verify built-in coverage. */
export const REPL_BUILTINS = REPL_BUILTIN_DEFS.map((d) => d.name);

export function buildReplCompleter(registry: CommandRegistry): Completer {
  return (line: string, cursor: number) => completeLine(registry, line, cursor);
}

/** Exported for tests — pure function. */
export function completeLine(
  registry: CommandRegistry,
  line: string,
  _cursor: number = line.length
): CompletionResult {
  // Non-slash, non-empty input → no suggestions. (Empty input still
  // shows everything so the user discovers what's available.)
  if (line.length > 0 && !line.startsWith("/")) {
    return { span: line, items: [] };
  }

  // Pre-split into tokens. We treat trailing whitespace as
  // "advance to the next slot", which changes the suggestion shape.
  const body = line.startsWith("/") ? line.slice(1) : line;
  const endsWithSpace = body.length > 0 && /\s$/.test(body);
  const tokens = body.split(/\s+/).filter((t) => t.length > 0);

  // ---- Phase 1: top-level command name ----
  if (tokens.length === 0 || (tokens.length === 1 && !endsWithSpace)) {
    const partial = (tokens[0] ?? "").toLowerCase();
    const candidates: Suggestion[] = [
      ...REPL_BUILTIN_DEFS.map<Suggestion>((d) => ({
        value: `/${d.name}`,
        display: `/${d.name}`,
        description: d.summary,
      })),
      ...registry.commands.map<Suggestion>((c) => ({
        value: `/${c.name} `,
        display: `/${c.name}`,
        description: c.summary,
      })),
    ];
    const matches = candidates.filter((s) =>
      (s.display ?? s.value).slice(1).toLowerCase().startsWith(partial)
    );
    matches.sort((a, b) => (a.display ?? a.value).localeCompare(b.display ?? b.value));
    return { span: `/${tokens[0] ?? ""}`, items: matches };
  }

  // ---- Phase 2: walk into the command tree ----
  const cmdName = tokens[0];
  const cmd = registry.commands.find((c) => c.name === cmdName);
  if (!cmd) return { span: "", items: [] };

  return completeWithinCommand(cmd, tokens.slice(1), endsWithSpace);
}

function completeWithinCommand(
  cmd: Command,
  args: string[],
  endsWithSpace: boolean
): CompletionResult {
  // Group command: next token is a subcommand.
  if (cmd.subcommands && cmd.subcommands.length > 0) {
    if (args.length === 0) {
      // Right after the group name with a trailing space — list every subcommand.
      return {
        span: "",
        items: cmd.subcommands.map<Suggestion>((s) => ({
          value: s.name + " ",
          display: s.name,
          description: s.summary,
        })),
      };
    }
    if (args.length === 1 && !endsWithSpace) {
      const partial = args[0].toLowerCase();
      const matches = cmd.subcommands.filter((s) =>
        s.name.toLowerCase().startsWith(partial)
      );
      return {
        span: args[0],
        items: matches.map<Suggestion>((s) => ({
          value: s.name + " ",
          display: s.name,
          description: s.summary,
        })),
      };
    }
    // Descend.
    const match = cmd.subcommands.find((s) => s.name === args[0]);
    if (match) {
      return completeWithinCommand(match, args.slice(1), endsWithSpace);
    }
    return { span: "", items: [] };
  }

  // Leaf command. Mix positional completions (from the hook) with
  // option flags.
  const optionItems = optionSuggestions(cmd);
  const positionalsBefore = positionalsOnly(
    endsWithSpace ? args : args.slice(0, -1)
  );
  const partial = endsWithSpace ? "" : args[args.length - 1] ?? "";

  if (partial.startsWith("--")) {
    const matches = optionItems.filter((s) => s.value.startsWith(partial));
    return { span: partial, items: matches };
  }

  // Positional + option suggestions, filtered by partial.
  const positional = cmd.complete?.(positionalsBefore, partial) ?? [];
  const positionalSuggestions = toSuggestions(positional);
  const allItems = [...positionalSuggestions, ...optionItems];
  if (partial.length === 0) {
    return { span: "", items: allItems };
  }
  return {
    span: partial,
    items: allItems.filter((s) =>
      (s.display ?? s.value).toLowerCase().startsWith(partial.toLowerCase())
    ),
  };
}

/**
 * Normalize a complete-hook return value into Suggestions.
 *
 * Hooks may return:
 *   - `string[]`           — bare values, no descriptions
 *   - `Suggestion[]`       — structured suggestions
 *
 * The string[] form is kept for hook implementers that don't need
 * descriptions; the REPL renders them with just the value.
 */
function toSuggestions(items: Array<string | Suggestion>): Suggestion[] {
  return items.map((item) =>
    typeof item === "string" ? { value: item } : item
  );
}

function optionSuggestions(cmd: Command): Suggestion[] {
  if (!cmd.options) return [];
  return Object.keys(cmd.options).map<Suggestion>((name) => ({
    value: `--${name} `,
    display: `--${name}`,
    description: optionTypeHint(cmd.options![name]),
  }));
}

function optionTypeHint(def: { type?: string }): string {
  if (def.type === "string") return "<value>";
  if (def.type === "boolean") return "flag";
  return "";
}

function positionalsOnly(args: string[]): string[] {
  return args.filter((a) => !a.startsWith("-"));
}
