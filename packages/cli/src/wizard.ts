import type { PromptSession } from "./prompt.js";
import { ui } from "./ui.js";
import { pickOne as interactivePickOne } from "./picker.js";
import type { Command, CommandPrompt, CommandRegistry, PromptChoice } from "./command.js";

/**
 * REPL command wizard.
 *
 * Looks at the leaf command the user invoked and runs its declared
 * `prompts` for any args that weren't supplied on the command line.
 * Splices the answers into the argv so `dispatch()` can run the
 * command normally — the command code itself doesn't need to know
 * whether values came from the wizard or from typed flags.
 *
 * Design points:
 *
 *   - **Skip-already-supplied.** If the user typed `/init --name Foo`
 *     we don't ask for the name again. Same for positionals — if
 *     `/feature add "Bar"` was typed, the positional-0 slot is full
 *     and the prompt is skipped.
 *
 *   - **Fresh PromptSession per wizard.** The REPL's main loop uses
 *     a raw-mode InputReader that takes over stdin. A long-lived
 *     readline.Interface from a top-level PromptSession would
 *     conflict. Each wizard run constructs and closes its own
 *     session, leaving stdin clean for the next InputReader.
 *
 *   - **Positional ordering.** Positional answers are appended in
 *     `positionalIndex` order *after* whatever positionals the user
 *     already typed. Mixing typed and prompted positionals isn't
 *     supported yet (no command needs it). If we add a case where
 *     `/cmd typed1 <prompt2> <prompt3>` is meaningful, we'll need a
 *     two-pass merge.
 */

export interface LeafResolution {
  command: Command;
  /** Full path of names from the registry root down to the leaf. */
  trail: string[];
  /** Args supplied after the trail (positionals + options). */
  supplied: string[];
}

/**
 * Walk into the command tree following the user-supplied tokens
 * until a leaf command (one without subcommands, or one whose next
 * token doesn't match a subcommand) is reached. Returns the leaf
 * plus the args that follow.
 */
export function resolveLeaf(
  registry: CommandRegistry,
  argv: string[]
): LeafResolution | null {
  if (argv.length === 0) return null;
  const top = registry.commands.find((c) => c.name === argv[0]);
  if (!top) return null;
  let cmd: Command = top;
  const trail: string[] = [cmd.name];
  let i = 1;
  while (cmd.subcommands && cmd.subcommands.length > 0 && i < argv.length) {
    const next: Command | undefined = cmd.subcommands.find((s) => s.name === argv[i]);
    if (!next) break;
    cmd = next;
    trail.push(next.name);
    i++;
  }
  return { command: cmd, trail, supplied: argv.slice(i) };
}

/**
 * Run any wizard prompts the leaf command declares. Returns the
 * full argv (trail + supplied + prompt answers) ready for
 * `dispatch()`, or `null` if the user aborted (e.g. closed the
 * input stream).
 *
 * The caller passes its own PromptSession so we don't create a
 * second readline.Interface bound to the same stdin — that would
 * race the REPL's session-fallback mode and steal lines from each
 * other. The REPL owns the session's lifetime; the wizard just
 * borrows it.
 */
export async function runCommandPrompts(
  leaf: LeafResolution,
  session: PromptSession
): Promise<string[] | null> {
  const prompts = leaf.command.prompts ?? [];
  if (prompts.length === 0) {
    return [...leaf.trail, ...leaf.supplied];
  }

  // Detect what the user already typed so we don't re-ask for it.
  const suppliedOptions = new Set<string>();
  let suppliedPositionals = 0;
  for (const arg of leaf.supplied) {
    if (arg.startsWith("--")) {
      // Handle both `--key value` and `--key=value`.
      const key = arg.slice(2).split("=")[0];
      suppliedOptions.add(key);
    } else if (!arg.startsWith("-")) {
      suppliedPositionals++;
    }
  }

  const positionalAnswers: string[] = [];
  const optionAnswers: string[] = [];
  ui.blank();
  for (const prompt of prompts) {
    if (shouldSkip(prompt, suppliedOptions, suppliedPositionals)) continue;

    const answer = await askPrompt(session, prompt);
    if (answer === null) return null;
    if (prompt.validate && !prompt.validate.test(answer)) {
      ui.error(
        `Invalid value for "${prompt.key}" — doesn't match expected format.`
      );
      return null;
    }

    if (prompt.positionalIndex !== undefined) {
      positionalAnswers.push(answer);
      suppliedPositionals++;
    } else {
      optionAnswers.push(`--${prompt.key}`, answer);
    }
  }

  return [
    ...leaf.trail,
    ...leaf.supplied,
    ...positionalAnswers,
    ...optionAnswers,
  ];
}

/** Returns true when the prompt's value is already in the argv. */
function shouldSkip(
  prompt: CommandPrompt,
  suppliedOptions: Set<string>,
  suppliedPositionals: number
): boolean {
  if (suppliedOptions.has(prompt.key)) return true;
  if (
    prompt.positionalIndex !== undefined &&
    suppliedPositionals > prompt.positionalIndex
  ) {
    return true;
  }
  return false;
}

async function askPrompt(
  session: PromptSession,
  prompt: CommandPrompt
): Promise<string | null> {
  if (prompt.help) ui.print(`  ${ui.dim(prompt.help)}`);
  try {
    if (prompt.choices) {
      const choices = resolveChoices(prompt.choices);
      if (choices.length === 0) {
        ui.error(`No choices available for "${prompt.key}".`);
        return null;
      }
      // Use the raw-mode picker (arrow + Enter). In non-TTY mode it
      // falls back to PromptSession.pickOne — so the line-based test
      // flows still work, but humans get arrow-key navigation.
      const picked = await interactivePickOne(
        `  ${prompt.question}`,
        choices.map((c) => ({
          label: c.label,
          value: c.value,
          note: c.description,
        })),
        session
      );
      return picked;
    }
    return prompt.secret
      ? await session.askSecret(`  ${prompt.question}`)
      : await session.ask(`  ${prompt.question}`, { default: prompt.default });
  } catch (err) {
    // Input stream ended (Ctrl-D / pipe close): treat as cancel.
    if ((err as Error).message === "input stream ended before answering") {
      return null;
    }
    throw err;
  }
}

function resolveChoices(
  choices: PromptChoice[] | (() => PromptChoice[])
): PromptChoice[] {
  return typeof choices === "function" ? choices() : choices;
}
