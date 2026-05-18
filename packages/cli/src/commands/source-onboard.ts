import {
  requireWorkspaceRoot,
  getAdapter,
  listAdapters,
  addSource,
  updateSource,
  upsertMcpServer,
  githubOrgFromRemote,
  listRepos,
  listSources,
  SecretStore,
  NotInsideWorkspaceError,
  SourceAlreadyRegisteredError,
  type OnboardingFlow,
  type OnboardingAnswers,
  type OnboardingContext,
  type OnboardingResult,
  type OnboardingStep,
  type Source,
  type TransportOption,
} from "@atelier/core";
import type { Command } from "../command.js";
import { ui } from "../ui.js";
import { PromptSession } from "../prompt.js";
import {
  pickMany as interactivePickMany,
  pickOne as interactivePickOne,
} from "../picker.js";

/**
 * Interactive (and non-interactive) onboarding for a documentation
 * source. Modeled on the EAS / Expo CLI flows:
 *
 *   1. Print a short intro for the source kind.
 *   2. Detect available transports (with a spinner).
 *   3. Let the user pick one (or use --transport for non-interactive).
 *   4. Ask the flow's questions one at a time, with defaults shown
 *      and secret fields masked.
 *   5. Verify the connection live (spinner).
 *   6. Show a summary of what's about to change; confirm.
 *   7. Apply: write sources.yaml and (if needed) mcp-servers.json.
 *   8. Print clear "Next steps" with copy-pasteable commands.
 *
 * Non-interactive mode (`--non-interactive` plus per-question flags
 * via `--answer key=value`) makes the same flow scriptable for CI.
 */

interface ParsedAnswers {
  byKey: Map<string, string>;
}

function parseAnswerFlags(raw: unknown): ParsedAnswers {
  const byKey = new Map<string, string>();
  if (raw === undefined) return { byKey };
  const values = Array.isArray(raw) ? (raw as string[]) : [raw as string];
  for (const v of values) {
    const eq = v.indexOf("=");
    if (eq === -1) {
      throw new Error(`--answer must be in the form key=value (got: ${v})`);
    }
    byKey.set(v.slice(0, eq), v.slice(eq + 1));
  }
  return { byKey };
}

/**
 * Drive a dynamic-choice step: shows a multi- or single-select
 * picker (depending on `step.multiSelect`) and returns the user's
 * chosen `value` strings. `null` means the user cancelled (Esc /
 * Ctrl-C); `[]` means they confirmed without selecting anything
 * (the caller falls back to manual entry).
 *
 * We suspend the session's readline.Interface for the picker's
 * lifetime — otherwise readline's stdin handlers eat keystrokes
 * the raw-mode picker is waiting for. (Symptom of the bug: picker
 * submits empty immediately because readline forwarded a stale
 * newline before the picker ever rendered.)
 */
async function runChoicePicker(
  step: OnboardingStep,
  choices: { label: string; value: string; note?: string; disabled?: boolean }[],
  session: PromptSession
): Promise<string[] | null> {
  if (step.help) ui.print(`  ${ui.dim(step.help)}`);
  session.suspend();
  try {
    if (step.multiSelect) {
      return await interactivePickMany(
        `  ${step.prompt}`,
        choices.map((c) => ({
          label: c.label,
          value: c.value,
          note: c.note,
          disabled: c.disabled,
        })),
        session
      );
    }
    const one = await interactivePickOne(
      `  ${step.prompt}`,
      // SingleSelectOption doesn't model `disabled`, so we just
      // drop those entries here. Single-select callers (e.g. the
      // transport picker) don't currently surface linked items.
      choices
        .filter((c) => !c.disabled)
        .map((c) => ({ label: c.label, value: c.value, note: c.note })),
      session
    );
    if (one === null) return null;
    return [one];
  } finally {
    drainStdinResidue();
    session.resume();
  }
}

/**
 * Discard any stdin bytes the picker's raw-mode handoff leaked
 * back into the kernel tty buffer.
 *
 * On macOS / tmux setups, an Enter pressed inside the raw-mode
 * picker is sometimes re-delivered as a stray `\n` once raw mode
 * turns off — which then shows up as an empty `'line'` event in
 * readline, making the next `session.ask()` resolve to `""`
 * before the user can type anything. Symptom in /source onboard:
 * "✗ This answer can't be empty" fires once (or twice, after two
 * pickers) before the actual prompt is reached.
 *
 * Pausing stdin briefly + calling `.read()` until null drains
 * whatever Node's internal buffer holds. We resume via the
 * caller's `session.resume()` immediately after.
 */
function drainStdinResidue(): void {
  const stdin = process.stdin as NodeJS.ReadStream;
  if (!stdin.isTTY) return;
  stdin.pause();
  // Loop is bounded by Node's internal buffer size — `read()`
  // returns null as soon as nothing's pending.
  // eslint-disable-next-line no-empty
  while (stdin.read() !== null) {}
}

/** Ask a single onboarding step. Honors `secret`, `default`, `validate`. */
async function askStep(session: PromptSession, step: OnboardingStep): Promise<string> {
  if (step.help) ui.print(`  ${ui.dim(step.help)}`);
  while (true) {
    const value = step.secret
      ? await session.askSecret(`  ${step.prompt}`)
      : await session.ask(`  ${step.prompt}`, { default: step.default });
    if (value.length === 0 && step.default === undefined && !step.secret) {
      ui.print(`  ${ui.red("✗")} This answer can't be empty.`);
      continue;
    }
    if (step.validate && !step.validate.test(value)) {
      ui.print(`  ${ui.red("✗")} Doesn't match the expected format. Try again.`);
      continue;
    }
    return value;
  }
}

interface OnboardOptions {
  flow: OnboardingFlow;
  /** Non-interactive flag values, keyed by step.key. */
  prefilled: Map<string, string>;
  /** Explicit transport choice (skips the picker). */
  transportOverride?: string;
  /** Skip the confirm-summary step. */
  yes: boolean;
  /** Skip the live verify step. */
  skipVerify: boolean;
  /** Skip writing — print what would happen instead. */
  dryRun: boolean;
  /**
   * Force non-interactive mode. Without this we drive the prompts
   * normally and rely on stdin being either a TTY or a pipe with
   * scripted answers — `readline.question()` works for both.
   */
  nonInteractive: boolean;
  /** REPL vs. shell — controls the form of next-steps hints. */
  mode: "cli" | "repl";
  /** User's cwd when the command was invoked — for sibling-dir scans. */
  cwd: string;
}

/**
 * Build the context handed to adapter steps' `discoverChoices`.
 *
 * Orgs come ONLY from what the user has actually registered with
 * Atelier — the workspace's `organization` field plus the owner
 * parsed from each registered repo's remote. We deliberately don't
 * fall back to sibling-directory scans here: discovery should
 * follow the user's explicit registrations, not surface unrelated
 * GitHub accounts that happen to share a parent directory with
 * the workspace.
 *
 * No spinner here; the call is cheap (no network IO) and gets
 * wrapped in one by the caller when a step actually consumes it.
 */
async function buildOnboardingContext(
  workspaceRoot: string,
  cwd: string
): Promise<OnboardingContext> {
  const [{ organization, repos }, existingSources] = await Promise.all([
    listRepos(workspaceRoot),
    listSources(workspaceRoot),
  ]);
  const orgs: string[] = [];
  const seen = new Set<string>();
  // Workspace-registered org goes first — it's the strongest signal.
  if (organization && !seen.has(organization)) {
    orgs.push(organization);
    seen.add(organization);
  }
  // Then any org we can derive from a registered repo's remote.
  // Same parser the local-discovery + welcome-banner paths use,
  // so the names line up exactly with what the user sees in the
  // REPL banner.
  for (const listing of repos) {
    const org = githubOrgFromRemote(listing.repo.remote);
    if (org && !seen.has(org)) {
      orgs.push(org);
      seen.add(org);
    }
  }
  return { workspaceRoot, cwd, orgs, existingSources };
}

async function runOnboarding(
  workspaceRoot: string,
  opts: OnboardOptions
): Promise<number> {
  const { flow, prefilled } = opts;
  // The deciding signal for "do we prompt the user?" is the explicit
  // --non-interactive flag. Piped stdin is still interactive — we
  // just won't mask secret input.
  const interactive = !opts.nonInteractive;
  const session = interactive ? new PromptSession() : null;
  try {
    return await runOnboardingInner(workspaceRoot, opts, session);
  } finally {
    session?.close();
  }
}

async function runOnboardingInner(
  workspaceRoot: string,
  opts: OnboardOptions,
  session: PromptSession | null
): Promise<number> {
  const { flow, prefilled } = opts;
  const interactive = session !== null;

  ui.heading(`📚 Onboarding a ${flow.displayName} source`);
  ui.print("");
  for (const line of flow.description.split("\n")) {
    ui.print(`  ${line}`);
  }
  ui.print("");

  // ---- Phase 1: detect transports ----
  const detected = await ui.spinner("Detecting available transports", () =>
    flow.availableTransports()
  );
  ui.blank();
  for (const t of detected) {
    const marker = t.ready ? ui.green("✓") : ui.dim("·");
    const rec = t.recommended ? ` ${ui.cyan("(recommended)")}` : "";
    ui.print(`  ${marker} ${t.transport.padEnd(8)} ${t.label}${rec}`);
    if (t.note) ui.print(`      ${ui.dim(t.note)}`);
  }
  ui.blank();

  // ---- Phase 2: pick a transport ----
  let chosen: TransportOption;
  if (opts.transportOverride) {
    const match = detected.find((d) => d.transport === opts.transportOverride);
    if (!match) {
      ui.error(
        `--transport "${opts.transportOverride}" not available for ${flow.displayName}. Available: ${detected.map((d) => d.transport).join(", ")}.`
      );
      return 2;
    }
    chosen = match;
    ui.print(`  ${ui.dim("→ Transport:")} ${ui.bold(chosen.transport)} (from --transport)`);
    ui.blank();
  } else if (interactive) {
    // Raw-mode picker on a TTY, line-based fallback otherwise.
    // session.suspend() pauses readline so the picker has stdin to
    // itself; otherwise readline keeps eating keystrokes the
    // picker is waiting for.
    session!.suspend();
    let picked: TransportOption | null;
    try {
      picked = await interactivePickOne(
        "How would you like to connect?",
        detected.map((t) => ({
          label: t.label,
          value: t,
          note: t.note,
          recommended: t.recommended,
        })),
        session
      );
    } finally {
      session!.resume();
    }
    if (!picked) {
      ui.print(`  ${ui.dim("Aborted.")}`);
      return 0;
    }
    chosen = picked;
    ui.blank();
  } else {
    // Non-interactive without --transport — pick the recommended.
    const rec = detected.find((d) => d.recommended) ?? detected[0];
    if (!rec) {
      ui.error(`No transports available for ${flow.displayName}.`);
      return 1;
    }
    chosen = rec;
    ui.print(`  ${ui.dim("→ Transport:")} ${ui.bold(chosen.transport)} (auto-selected)`);
    ui.blank();
  }

  // ---- Phase 3: collect answers ----
  const answers: OnboardingAnswers = { transport: chosen.transport, values: {} };
  const steps = flow.steps(chosen.transport);
  // Built lazily — only steps that declare `discoverChoices` need it,
  // and building it scans the filesystem so we don't pay the cost up
  // front for adapters that don't use discovery.
  let onboardingCtx: OnboardingContext | null = null;
  const getCtx = async (): Promise<OnboardingContext> => {
    if (!onboardingCtx) {
      onboardingCtx = await buildOnboardingContext(workspaceRoot, opts.cwd);
    }
    return onboardingCtx;
  };
  ui.heading("Configure");
  for (const step of steps) {
    if (step.applies && !step.applies(answers)) continue;
    const fromFlag = prefilled.get(step.key);
    if (fromFlag !== undefined) {
      if (step.validate && !step.validate.test(fromFlag)) {
        ui.error(`--answer ${step.key}=… doesn't match the expected format.`);
        return 2;
      }
      answers.values[step.key] = fromFlag;
      ui.print(
        `  ${ui.dim("·")} ${step.prompt}: ${step.secret ? ui.dim("(from --answer, masked)") : ui.bold(fromFlag)}`
      );
      continue;
    }
    // Steps flagged `auto` apply their default silently — the
    // onboarding flow uses this for fields where the default is
    // virtually always right (id, display name). Show what was
    // applied so the user can spot it in the transcript, but
    // don't ask.
    if (step.auto && step.default !== undefined) {
      answers.values[step.key] = step.default;
      ui.print(
        `  ${ui.dim("·")} ${step.prompt}: ${ui.bold(step.default)} ${ui.dim("(default)")}`
      );
      continue;
    }
    if (!interactive) {
      if (step.default !== undefined) {
        answers.values[step.key] = step.default;
        ui.print(
          `  ${ui.dim("·")} ${step.prompt}: ${ui.bold(step.default)} ${ui.dim("(default)")}`
        );
        continue;
      }
      ui.error(
        `Non-interactive mode and no value for "${step.key}". Pass --answer ${step.key}=<value>.`
      );
      return 2;
    }
    // Dynamic-choice path: ask the adapter for candidates and show a
    // multi- or single-select picker. On empty/failed discovery we
    // fall through to the regular text prompt so the user can still
    // type the value manually.
    if (step.discoverChoices) {
      const ctx = await getCtx();
      let choices = [] as Awaited<ReturnType<NonNullable<OnboardingStep["discoverChoices"]>>>;
      try {
        choices = await ui.spinner("Loading options", () =>
          step.discoverChoices!(ctx, answers)
        );
      } catch {
        choices = [];
      }
      if (choices.length > 0) {
        const picked = await runChoicePicker(step, choices, session!);
        if (picked === null) {
          ui.print(`  ${ui.dim("Aborted.")}`);
          return 0;
        }
        if (picked.length === 0) {
          // Optional step: if the adapter declared a default (even
          // empty string), respect it instead of forcing manual
          // entry. The discussionIds drill-down uses this so an
          // empty selection means "sync everything".
          if (step.default !== undefined) {
            answers.values[step.key] = step.default;
            ui.print(
              step.default.length > 0
                ? `  ${ui.dim("·")} ${step.prompt}: ${ui.bold(step.default)} ${ui.dim("(default)")}`
                : `  ${ui.dim("(no selection — using default)")}`
            );
            continue;
          }
          // Required step with no default: the user saw the
          // picker, declined to choose anything, and we have no
          // sensible fallback. Forcing them into a text prompt
          // that won't accept empty just traps them in a loop —
          // bail out cleanly instead. They can re-run /source
          // onboard, or pre-fill via --answer to skip the picker
          // altogether.
          ui.blank();
          ui.print(
            `  ${ui.dim(`Aborted — nothing was selected for "${step.key}".`)}`
          );
          ui.print(
            `  ${ui.dim(`Re-run \`/source onboard ${flow.kind}\` and pick at least one, or pass --answer ${step.key}=<value>.`)}`
          );
          return 0;
        }
        const joined = picked.join(",");
        if (step.validate && !step.validate.test(joined)) {
          ui.error(
            `Selection "${joined}" doesn't match the expected format for "${step.key}".`
          );
          return 2;
        }
        answers.values[step.key] = joined;
        continue;
      }
      // No choices — explain why so the manual prompt isn't surprising.
      if (ctx.orgs.length === 0) {
        ui.print(
          `  ${ui.dim("(no workspace orgs detected — falling back to manual entry)")}`
        );
      } else {
        ui.print(
          `  ${ui.dim(`(no matching repos in ${ctx.orgs.join(", ")} — enter manually)`)}`
        );
      }
      answers.values[step.key] = await askStep(session!, step);
      continue;
    }
    answers.values[step.key] = await askStep(session!, step);
  }
  ui.blank();

  // ---- Phase 4: verify ----
  if (!opts.skipVerify) {
    try {
      const result = await ui.spinner("Verifying connection", () => flow.verify(answers));
      if (!result.ok) {
        ui.blank();
        ui.error(`Verification failed: ${result.error ?? "(no detail)"}`);
        ui.print(`  ${ui.dim("Re-run with --skip-verify if you want to save the config anyway.")}`);
        return 1;
      }
      if (result.message) ui.print(`  ${ui.dim(result.message)}`);
      ui.blank();
    } catch (err) {
      ui.blank();
      ui.error(`Verification crashed: ${(err as Error).message}`);
      return 1;
    }
  }

  // ---- Phase 5: summary + confirm ----
  let entry = flow.toRegistryEntry(answers);

  // If a source with the same id already exists, offer to MERGE
  // the new selections into it instead of failing on duplicate.
  // Common case: the user re-runs /source onboard to add more
  // discussions to a source they already created.
  let mergeIntoId: string | null = null;
  const targetId = entry.source.id;
  if (targetId) {
    // Re-read sources here rather than reuse onboardingCtx.existingSources:
    // the user may have edited sources.yaml externally between the start
    // of onboarding and now, and we want the merge decision based on
    // the latest state.
    const existingSources = await listSources(workspaceRoot);
    const existing = existingSources.find((s) => s.id === targetId);
    if (existing) {
      if (existing.kind !== entry.source.kind) {
        ui.error(
          `Source id "${targetId}" is already registered as kind "${existing.kind}". Choose a different id.`
        );
        return 1;
      }
      if (!flow.merge) {
        ui.error(
          `Source "${targetId}" already exists and the ${flow.displayName} adapter doesn't support merging. Pick a different id or remove the existing one first.`
        );
        return 1;
      }
      // Build the merge candidate so the summary the user
      // confirms reflects the final, combined entry — not what
      // they just picked alone.
      const merged = flow.merge(existing as Source, answers);
      entry = merged;
      mergeIntoId = targetId;
      ui.print(
        `  ${ui.cyan("ℹ")} A source with id ${ui.bold(targetId)} already exists — new selections will be ${ui.bold("merged")} into it.`
      );
      ui.blank();
    }
  }

  printSummary(entry);

  if (!opts.yes && interactive) {
    const question = mergeIntoId
      ? `Merge into source "${mergeIntoId}"?`
      : "Apply these changes?";
    const ok = await session!.confirm(question, { default: true });
    if (!ok) {
      ui.print(`  ${ui.dim("Aborted. Nothing was written.")}`);
      return 0;
    }
    ui.blank();
  }

  if (opts.dryRun) {
    ui.print(`  ${ui.dim("--dry-run: skipping writes.")}`);
    printNextSteps(entry, true, opts.mode);
    return 0;
  }

  // ---- Phase 6: apply ----
  try {
    if (mergeIntoId) {
      await ui.spinner(`Updating "${mergeIntoId}" in sources.yaml`, () =>
        applyMergedEntry(workspaceRoot, mergeIntoId, entry)
      );
      // Deliberately skip the MCP-server upsert on merge: a merge
      // never adds a new transport, only widens scope.
    } else {
      await ui.spinner("Writing sources.yaml", () => applyToRegistry(workspaceRoot, entry));
      if (entry.mcpServer) {
        await ui.spinner(`Adding "${entry.mcpServer.id}" to ~/.atelier/mcp-servers.json`, () =>
          upsertMcpServer(entry.mcpServer!.id, {
            command: entry.mcpServer!.command,
            args: entry.mcpServer!.args,
            env: entry.mcpServer!.env,
            tools: entry.mcpServer!.tools,
            description: entry.mcpServer!.description,
          })
        );
      }
    }
    // Persist any envVarsToSet into the workspace-local secret store
    // (.atelier/.env) AND into the live process.env so the
    // immediately-following verify / sync runs see them. The
    // SecretStore guarantees the file is in .gitignore — secrets
    // never leak into the tracked tree.
    if (entry.envVarsToSet && entry.envVarsToSet.length > 0) {
      const store = new SecretStore(workspaceRoot);
      await ui.spinner(
        `Saving ${entry.envVarsToSet.length} secret(s) to .atelier/.env`,
        () => store.writeMany(entry.envVarsToSet!.map((e) => ({ name: e.name, value: e.value })))
      );
      for (const v of entry.envVarsToSet) {
        process.env[v.name] = v.value;
      }
    }
  } catch (err) {
    if (err instanceof SourceAlreadyRegisteredError) {
      ui.error(`A source with that id already exists: ${err.message}`);
      ui.print(`  ${ui.dim("Choose a different id (run again) or `atelier source remove <id>` first.")}`);
      return 1;
    }
    ui.error((err as Error).message);
    return 1;
  }
  ui.blank();

  ui.success(`Source registered.`);
  ui.blank();
  printNextSteps(entry, false, opts.mode);
  return 0;
}

async function applyToRegistry(
  workspaceRoot: string,
  entry: OnboardingResult
): Promise<void> {
  const s = entry.source;
  await addSource(workspaceRoot, {
    kind: s.kind,
    id: s.id,
    name: s.name,
    transport: s.transport,
    mcpServer: s.mcpServer,
    credentials: s.credentials,
    adapterModule: s.adapterModule,
    scope: s.scope,
    enabled: true,
  });
}

/**
 * Replace the registry entry at `id` with the merged result.
 * Re-uses the existing entry's `enabled` flag if the adapter
 * didn't surface one — by convention onboarding produces enabled
 * entries, but merge shouldn't accidentally re-enable a source
 * the user explicitly disabled.
 */
async function applyMergedEntry(
  workspaceRoot: string,
  id: string,
  entry: OnboardingResult
): Promise<void> {
  const s = entry.source;
  const next: Source = {
    id,
    kind: s.kind,
    name: s.name,
    enabled: true,
  };
  if (s.transport !== undefined) next.transport = s.transport;
  if (s.mcpServer !== undefined) next.mcpServer = s.mcpServer;
  if (s.credentials !== undefined) next.credentials = s.credentials;
  if (s.adapterModule !== undefined) next.adapterModule = s.adapterModule;
  if (s.scope !== undefined) next.scope = s.scope;
  await updateSource(workspaceRoot, id, next);
}

function printSummary(entry: OnboardingResult): void {
  ui.heading("📋 About to register");
  ui.blank();
  const s = entry.source;
  ui.field("id", s.id ?? "(auto)", 14);
  ui.field("name", s.name, 14);
  ui.field("kind", s.kind, 14);
  if (s.transport) ui.field("transport", s.transport, 14);
  if (s.mcpServer) ui.field("mcpServer", s.mcpServer, 14);
  if (s.credentials) {
    // Two shapes: `{envVar}` (bearer) or `{kind: "azureClientCredentials", ...}`.
    // Render the env-var reference for the bearer case and the
    // structural summary for the azure case — never the secret itself.
    if ("envVar" in s.credentials) {
      ui.field("credentials", `$${s.credentials.envVar}`, 14);
    } else {
      ui.field(
        "credentials",
        `azure app ${s.credentials.clientId} (secret in $${s.credentials.clientSecretEnvVar})`,
        14
      );
    }
  }
  if (s.adapterModule) ui.field("adapterModule", s.adapterModule, 14);
  if (s.scope && Object.keys(s.scope).length > 0) {
    ui.field("scope", JSON.stringify(s.scope), 14);
  }
  if (entry.mcpServer) {
    ui.blank();
    ui.print(`  ${ui.dim("MCP server to register:")}`);
    ui.field("id", entry.mcpServer.id, 14);
    ui.field("command", entry.mcpServer.command, 14);
    if (entry.mcpServer.args) ui.field("args", entry.mcpServer.args.join(" "), 14);
  }
  ui.blank();
}

function printNextSteps(
  entry: OnboardingResult,
  isDryRun: boolean,
  mode: "cli" | "repl"
): void {
  const sourceId = entry.source.id ?? "<source-id>";
  const prefix = mode === "repl" ? "/" : "atelier ";
  ui.heading("Next steps");
  ui.blank();
  let stepNum = 1;

  if (entry.envVarsToSet && entry.envVarsToSet.length > 0) {
    ui.print(`  ${stepNum++}. Secrets saved to ${ui.cyan(".atelier/.env")} (gitignored):`);
    ui.blank();
    for (const v of entry.envVarsToSet) {
      ui.print(`       ${ui.cyan(v.name)}${ui.dim(" = (set)")}`);
      if (v.description) ui.print(`       ${ui.dim(v.description)}`);
    }
    ui.print(
      `     ${ui.dim("Atelier loads this file into env at startup. Override with `export ${NAME}=…` in your shell when you need to.")}`
    );
    ui.blank();
  }

  if (!isDryRun) {
    ui.print(`  ${stepNum++}. Try a sync:`);
    ui.blank();
    ui.print(`       ${ui.cyan(`${prefix}sync --source ${sourceId} --dry-run`)}`);
    ui.print(`       ${ui.cyan(`${prefix}sync --source ${sourceId}`)}`);
    ui.blank();
    ui.print(`  ${stepNum++}. Inspect what landed:`);
    ui.blank();
    ui.print(`       ${ui.cyan(`${prefix}doc list --source ${sourceId}`)}`);
    ui.blank();
  }
}

// ============================================================
// Command definition
// ============================================================

export const sourceOnboardCommand: Command = {
  name: "onboard",
  summary: "Interactively register a documentation source.",
  description:
    "Walks through transport detection, configuration, live verification,\n" +
    "and registration in one flow. Non-interactive mode: pass\n" +
    "--non-interactive plus --transport and --answer key=value for each\n" +
    "step (use `atelier source onboard <kind> --help` to see step keys).",
  positionals: ["kind"],
  options: {
    transport: { type: "string" },
    answer: { type: "string", multiple: true },
    "non-interactive": { type: "boolean" },
    yes: { type: "boolean", short: "y" },
    "skip-verify": { type: "boolean" },
    "dry-run": { type: "boolean" },
    "list-kinds": { type: "boolean" },
  },
  /**
   * The first positional is <kind>. Enumerate every registered
   * adapter with its human display name so the REPL dropdown shows
   *
   *     › notion             — Notion
   *       sharepoint         — SharePoint / OneDrive (Microsoft Graph)
   *       github-discussions — GitHub Discussions
   *
   * Once <kind> is supplied, positionals are exhausted and the
   * completer falls through to option flags (`--transport`,
   * `--non-interactive`, …).
   */
  complete(priorArgs: string[], partial: string) {
    if (priorArgs.length === 0) {
      return listAdapters()
        .filter((a) => a.kind.toLowerCase().startsWith(partial.toLowerCase()))
        .map((a) => ({
          value: a.kind + " ",
          display: a.kind,
          description: a.onboarding.displayName,
        }));
    }
    return [];
  },
  /**
   * Wizard: if the user just types `/source onboard` in the REPL,
   * prompt for the kind via a menu of registered adapters. The
   * adapter's own onboarding flow (transports, auth, scope) runs
   * from `run()` once the kind is picked.
   */
  prompts: [
    {
      key: "kind",
      question: "Source kind",
      help: "Which kind of documentation source are you connecting?",
      positionalIndex: 0,
      choices: () =>
        listAdapters().map((a) => ({
          label: a.kind,
          value: a.kind,
          description: a.onboarding.displayName,
        })),
    },
  ],
  async run({ positionals, values, cwd, mode }) {
    if (values["list-kinds"] === true) {
      ui.heading("Supported source kinds");
      ui.blank();
      const all = listAdapters();
      if (all.length === 0) {
        ui.print(`  ${ui.dim("(no adapters registered)")}`);
      } else {
        for (const a of all) {
          ui.print(`  · ${ui.bold(a.kind.padEnd(20))} ${a.onboarding.displayName}`);
        }
      }
      ui.blank();
      ui.print(
        `  ${ui.dim("Power users: pass --transport external --answer adapterModule=@pkg/name to use a 3rd-party adapter.")}`
      );
      return 0;
    }

    const [kind] = positionals;
    if (!kind) {
      ui.error("Missing <kind> argument.");
      ui.print(`  ${ui.dim("Usage: atelier source onboard <kind>")}`);
      ui.print(`  ${ui.dim("       atelier source onboard --list-kinds")}`);
      return 2;
    }
    const reg = getAdapter(kind as never);
    if (!reg) {
      ui.error(`Unknown source kind: "${kind}".`);
      ui.print(`  ${ui.dim("Run `atelier source onboard --list-kinds` to see what's available.")}`);
      return 1;
    }

    let prefilled: Map<string, string>;
    try {
      prefilled = parseAnswerFlags(values.answer).byKey;
    } catch (err) {
      ui.error((err as Error).message);
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

    return runOnboarding(workspaceRoot, {
      flow: reg.onboarding,
      prefilled,
      transportOverride: values.transport as string | undefined,
      yes: values.yes === true || values["non-interactive"] === true,
      skipVerify: values["skip-verify"] === true,
      dryRun: values["dry-run"] === true,
      nonInteractive: values["non-interactive"] === true,
      mode,
      cwd,
    });
  },
};
