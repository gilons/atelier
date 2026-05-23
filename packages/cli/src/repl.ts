import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  ATELIER_VERSION,
  loadWorkspace,
  listRepos,
  listSources,
  listFeatures,
  listDocs,
  inferRepoContext,
  findNearbyWorkspace,
  discoverLocal,
  discoverManyOrgs,
  addRepo,
  GhAdapter,
  type LocalRepoCandidate,
  type DiscoveredRepo,
  type DiscoveryResult,
  type LocalDiscovery,
} from "@atelier/core";
import { ui } from "./ui.js";
import { PromptSession } from "./prompt.js";
import { dispatch, type CommandRegistry } from "./command.js";
import { renderBanner } from "./banner.js";
import { buildReplCompleter } from "./repl-completer.js";
import { InputReader } from "./input-reader.js";
import { resolveLeaf, runCommandPrompts } from "./wizard.js";
import { pickMany as interactivePickMany } from "./picker.js";

/**
 * Atelier REPL — `atelier` with no args drops the user into a
 * persistent slash-command session.
 *
 * Why a REPL?
 *   - Source onboarding, repo registration, spec drafting are all
 *     multi-step; spinning up a new Node process for each step burns
 *     ~150ms and loses warm caches.
 *   - The user can fluidly chain commands — `/repo`, then `/source`,
 *     then `/sync` — without re-resolving the workspace each time.
 *   - Slash commands match the modern tool-chat idiom (Claude Code,
 *     GitHub Copilot CLI, etc.) without committing us to a full
 *     fullscreen TUI rewrite.
 *
 * The one-shot mode is preserved: `atelier <verb> [args]` still
 * works exactly as today. Scripts and CI use it; humans use the REPL.
 */

interface ReplContext {
  cwd: string;
  registry: CommandRegistry;
  workspaceRoot: string | null;
  /**
   * Non-TTY fallback session. NULL in TTY mode (where the
   * InputReader handles raw input and any wizard/sub-flow creates
   * its own short-lived session). NON-NULL in piped/non-TTY mode,
   * where the same readline interface is the only one reading
   * stdin — sub-flows must reuse it so they don't steal each
   * other's lines, and so a fresh session doesn't see an already-
   * consumed (and therefore "closed") stdin.
   */
  fallbackSession: PromptSession | null;
}

/**
 * Run a function that needs a {@link PromptSession}.
 *
 *   - In TTY mode (`existing` is null), we create a short-lived
 *     session, run the function, and close the session at the end.
 *     This is safe because the InputReader doesn't keep any
 *     readline interface around — there's no contention for stdin.
 *
 *   - In piped/non-TTY mode (`existing` is non-null), we reuse the
 *     caller's session. Creating a fresh one would attach a second
 *     readline interface to the same stdin; whichever fires first
 *     wins the next line of input, and the other ends up either
 *     stealing or missing data. Concretely: the REPL loop's fallback
 *     session would consume both the command line AND its wizard
 *     answers before a freshly-made wizard session got a chance to
 *     listen, leaving the wizard with a dead stream.
 *
 * Why on-demand at all (vs. a long-lived session in TTY mode)?
 * Because the REPL's InputReader puts stdin in raw mode, and a
 * long-lived PromptSession's readline interface would silently
 * buffer every byte typed during InputReader's reign as a "line" —
 * causing the wizard to resolve its first `ask()` with the user's
 * just-typed command instead of waiting for the real answer.
 */
export async function withSession<T>(
  existing: PromptSession | null,
  fn: (session: PromptSession) => Promise<T>
): Promise<T> {
  if (existing) {
    return await fn(existing);
  }
  const session = new PromptSession();
  try {
    return await fn(session);
  } finally {
    session.close();
  }
}

export async function runRepl(
  cwd: string,
  registry: CommandRegistry
): Promise<number> {
  const ctx: ReplContext = {
    cwd,
    registry,
    // Use the sideways-aware lookup so a user inside `api/` next to
    // `planning/` still gets a workspace context. Falls back to null
    // when nothing nearby exists.
    workspaceRoot: await findNearbyWorkspace(cwd),
    fallbackSession: null,
  };
  const stdinIsTty = (process.stdin as NodeJS.ReadStream).isTTY === true;
  const stdoutIsTty = (process.stdout as NodeJS.WriteStream).isTTY === true;
  // The inline-suggestion InputReader needs raw mode + cursor moves;
  // both require real TTYs on stdin and stdout. Otherwise (piped
  // input from CI, scripted tests) we fall back to the line-based
  // PromptSession.ask().
  const useInlineReader = stdinIsTty && stdoutIsTty;
  const completer = useInlineReader ? buildReplCompleter(registry) : null;
  const history: string[] = [];
  // Only used on the non-TTY fallback path. In TTY mode this stays
  // null so no readline interface contends with the InputReader.
  let fallbackSession: PromptSession | null = null;

  try {
    await renderWelcome(ctx);

    while (true) {
      let line: string;
      if (useInlineReader && completer) {
        const reader = new InputReader({
          input: process.stdin as NodeJS.ReadStream,
          output: process.stdout as NodeJS.WriteStream,
          prompt: `${ui.cyan("atelier ❯")} `,
          completer,
          history,
        });
        const result = await reader.read();
        if (result.type === "aborted") {
          ui.print(`  ${ui.dim("Bye.")}`);
          return 0;
        }
        line = result.line;
        if (line.trim().length > 0) history.push(line);
      } else {
        if (!fallbackSession) {
          fallbackSession = new PromptSession();
          ctx.fallbackSession = fallbackSession;
        }
        line = await fallbackSession.ask(ui.cyan("atelier ❯"));
      }

      const trimmed = line.trim();
      if (!trimmed) continue;
      if (isExitCommand(trimmed)) {
        ui.print(`  ${ui.dim("Bye.")}`);
        return 0;
      }
      try {
        await handleLine(trimmed, ctx);
      } catch (err) {
        ui.error((err as Error).message);
      }
      // Refresh workspaceRoot in case the command (e.g. /init) created
      // or moved into one.
      ctx.workspaceRoot = await findNearbyWorkspace(ctx.cwd);
    }
  } catch (err) {
    if ((err as Error).message === "input stream ended before answering") {
      // Piped input ran out — clean exit, just like Ctrl-D.
      return 0;
    }
    throw err;
  } finally {
    fallbackSession?.close();
  }
}

function isExitCommand(line: string): boolean {
  const lower = line.toLowerCase();
  return (
    lower === "/quit" ||
    lower === "/exit" ||
    lower === "quit" ||
    lower === "exit" ||
    lower === ":q"
  );
}

// ============================================================
// Welcome screen
// ============================================================

async function renderWelcome(ctx: ReplContext): Promise<void> {
  renderBanner(ATELIER_VERSION, "a planning companion for the spec-driven era");

  // Local scan is cheap (no network) so we always do it eagerly. The
  // gh-org listing is run lazily — synchronously when there's no
  // workspace yet (so the first impression is rich), deferred to
  // /repo otherwise (so opening atelier in a known workspace doesn't
  // block for 1-2s of gh calls).
  const local = await discoverLocal(ctx.cwd, ctx.workspaceRoot);

  if (ctx.workspaceRoot) {
    await renderWorkspaceStatus(ctx, local);
    await maybeOfferAutoRegister(ctx);
  } else {
    await renderNoWorkspaceContext(ctx, local);
  }

  ui.blank();
  ui.print(
    `  ${ui.dim("Type")} ${ui.cyan("/help")} ${ui.dim("for commands, or")} ${ui.cyan("/quit")} ${ui.dim("to leave.")}`
  );
  ui.blank();
}

async function renderWorkspaceStatus(
  ctx: ReplContext,
  local: LocalDiscovery
): Promise<void> {
  try {
    const { workspace } = await loadWorkspace(ctx.workspaceRoot!);
    const [{ organization, repos }, sources, { features }, { docs }] = await Promise.all([
      listRepos(ctx.workspaceRoot!),
      listSources(ctx.workspaceRoot!),
      listFeatures(ctx.workspaceRoot!),
      listDocs(ctx.workspaceRoot!),
    ]);
    ui.print(`  ${ui.dim("Workspace:")} ${ui.bold(workspace.name)}`);
    ui.print(`  ${ui.dim("Location:")}  ${ctx.workspaceRoot}`);
    if (organization) ui.print(`  ${ui.dim("Org:")}       ${organization}`);
    ui.print(
      `  ${ui.dim("Inventory:")} ${repos.length} repo(s) · ${sources.length} source(s) · ${features.length} feature(s) · ${docs.length} doc(s)`
    );

    // Discovery hint: how many local-but-unregistered candidates do
    // we see near here? The answer is cheap (no gh call) and tells
    // the user there's something to do with /repo.
    const registeredRemotes = new Set(
      repos.map((r) => normalizeRemoteForCompare(r.repo.remote))
    );
    const unregisteredLocal = local.localRepos.filter(
      (r) => r.remote && !registeredRemotes.has(normalizeRemoteForCompare(r.remote))
    );
    const extraOrgs = local.orgs.filter((o) => o !== organization);

    if (unregisteredLocal.length > 0 || extraOrgs.length > 0) {
      ui.blank();
      ui.print(`  ${ui.dim("Discovered nearby:")}`);
      if (unregisteredLocal.length > 0) {
        ui.print(
          `    ${ui.green("·")} ${unregisteredLocal.length} local repo(s) not yet registered: ${ui.dim(unregisteredLocal.slice(0, 4).map((r) => r.dirName).join(", "))}${unregisteredLocal.length > 4 ? ui.dim(`, …`) : ""}`
        );
      }
      if (extraOrgs.length > 0) {
        ui.print(
          `    ${ui.green("·")} repos from other org(s): ${ui.dim(extraOrgs.join(", "))}`
        );
      }
      ui.print(`    ${ui.dim("→ Type")} ${ui.cyan("/repo")} ${ui.dim("to register them.")}`);
    }
  } catch (err) {
    ui.warn(`Workspace at ${ctx.workspaceRoot} is malformed: ${(err as Error).message}`);
  }
}

async function renderNoWorkspaceContext(
  ctx: ReplContext,
  local: LocalDiscovery
): Promise<void> {
  ui.print(`  ${ui.dim("No workspace found at")} ${ctx.cwd}`);

  // Nothing local either — the simplest "go init" hint.
  if (local.localRepos.length === 0) {
    ui.blank();
    ui.print(`  ${ui.dim("→ Type")} ${ui.cyan("/init")} ${ui.dim("to start a workspace, or cd into a directory of repos.")}`);
    return;
  }

  // We found local repos. Show what's here, infer orgs, then try
  // gh (best-effort, soft-fail) for a richer picture.
  const orgsLabel =
    local.orgs.length === 0
      ? "(no GitHub orgs inferred)"
      : local.orgs.length === 1
        ? `org: ${ui.bold(local.orgs[0])}`
        : `${local.orgs.length} orgs: ${local.orgs.map((o) => ui.bold(o)).join(", ")}`;
  ui.print(
    `  ${ui.dim("Detected")} ${ui.bold(String(local.localRepos.length))} ${ui.dim("git repo(s) — ")}${orgsLabel}`
  );
  for (const repo of local.localRepos.slice(0, 5)) {
    const tail = repo.org ? ui.dim(`  (${repo.org})`) : "";
    ui.print(`    ${ui.dim("·")} ${repo.dirName}${tail}`);
  }
  if (local.localRepos.length > 5) {
    ui.print(`    ${ui.dim(`… and ${local.localRepos.length - 5} more`)}`);
  }

  // gh discovery (multi-org). Wrapped in a spinner because each call
  // is ~1s. We do this on a no-workspace start because the user
  // hasn't told us anything yet — they need to see the full picture
  // to make the first decision (/init here, cd elsewhere, etc.).
  if (local.orgs.length > 0) {
    const gh = new GhAdapter();
    const availability = await gh.checkAvailability();
    if (availability.available) {
      // We need a "fake" workspaceRoot for discoverRepos's signature
      // (it diffs against registered repos). With no workspace, we
      // pass the cwd; the registered set will be empty.
      const { byOrg, errors } = await ui.spinner(
        `Querying GitHub for ${local.orgs.length} org(s)`,
        () => discoverManyOrgs(ctx.cwd, local.orgs, gh)
      );
      const totals = [...byOrg.entries()].map(
        ([org, r]) => `${org}: ${r.repos.length}`
      );
      ui.blank();
      if (totals.length > 0) {
        ui.print(`  ${ui.dim("Found on GitHub:")} ${totals.join(", ")}`);
      }
      for (const [org, msg] of errors) {
        ui.warn(`  gh listing for ${org} failed: ${msg}`);
      }
    } else {
      ui.blank();
      ui.print(`  ${ui.dim(availability.reason)}`);
    }
  }

  ui.blank();
  ui.print(
    `  ${ui.dim("→ Type")} ${ui.cyan("/init")} ${ui.dim("to scaffold a workspace here, then")} ${ui.cyan("/repo")} ${ui.dim("to register repos.")}`
  );
}

/**
 * Normalize a remote URL the same way `discovery.ts` does — strip
 * trailing `.git` and `/` — so comparisons match across ssh / https
 * variants and the `gh` API's no-`.git` form.
 */
function normalizeRemoteForCompare(url: string): string {
  let s = url.trim();
  if (s.endsWith("/")) s = s.slice(0, -1);
  if (s.endsWith(".git")) s = s.slice(0, -4);
  return s;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

/**
 * If we started in a code repo with a nearby workspace, offer to
 * register the repo without making the user type it out.
 */
async function maybeOfferAutoRegister(ctx: ReplContext): Promise<void> {
  // Only relevant when there IS a workspace nearby.
  if (!ctx.workspaceRoot) return;
  // Are we inside a git repo distinct from the workspace?
  const repoCtx = await inferRepoContext(ctx.cwd);
  if (!repoCtx) return;
  if (repoCtx.absPath === ctx.workspaceRoot) return;
  // Is it already registered?
  const { repos } = await listRepos(ctx.workspaceRoot);
  if (repoCtx.remote && repos.some((r) => r.repo.remote === repoCtx.remote)) return;
  if (repos.some((r) => r.absPath === repoCtx.absPath)) return;

  ui.blank();
  ui.print(
    `  ${ui.yellow("·")} You're inside a git repo at ${ui.bold(repoCtx.dirName)} that isn't registered.`
  );
  if (repoCtx.remote) ui.print(`    ${ui.dim("remote:")} ${repoCtx.remote}`);
  const ok = await withSession(ctx.fallbackSession, (session) =>
    session.confirm(
      `    Register it with workspace ${path.basename(ctx.workspaceRoot!)}?`,
      { default: true }
    )
  );
  if (!ok) return;
  try {
    const result = await addRepo(ctx.workspaceRoot, {
      pathInput: repoCtx.absPath,
      cwd: ctx.cwd,
    });
    ui.success(`Registered ${ui.bold(result.repo.name)}`);
    if (result.organizationSet) {
      ui.print(`  ${ui.dim("Detected org:")} ${result.organizationSet}`);
    }
  } catch (err) {
    ui.error((err as Error).message);
  }
}

// ============================================================
// Line handling
// ============================================================

async function handleLine(line: string, ctx: ReplContext): Promise<void> {
  if (!line.startsWith("/")) {
    ui.print(`  ${ui.dim("Commands start with")} ${ui.cyan("/")}${ui.dim(". Type")} ${ui.cyan("/help")} ${ui.dim("to see what's available.")}`);
    return;
  }
  // Tokenize: respect double-quoted strings so "Add CSV export" stays one arg.
  const tokens = tokenize(line.slice(1));
  if (tokens.length === 0) return;
  const [cmd, ...rest] = tokens;
  const lower = cmd.toLowerCase();

  if (lower === "help" || lower === "?") return showHelp();
  if (lower === "status") return showStatus(ctx);
  if (lower === "clear") {
    process.stdout.write("\x1b[2J\x1b[H");
    return;
  }
  // `/repo` (no args) and `/repo discover` both route to the
  // interactive wizard in REPL mode. The non-REPL `atelier repo
  // discover` keeps its old wall-of-text listing because that form
  // is grep-friendly for scripts.
  if (
    lower === "repo" &&
    (rest.length === 0 || (rest.length === 1 && rest[0] === "discover"))
  ) {
    return interactiveRepoFlow(ctx);
  }

  // If the leaf command declares wizard prompts, run them first.
  // The wizard fills in any missing args interactively, then we
  // dispatch with the full argv exactly as if the user had typed
  // every value as flags. Commands that don't declare prompts
  // dispatch unchanged.
  const leaf = resolveLeaf(ctx.registry, [cmd, ...rest]);
  if (leaf && leaf.command.prompts && leaf.command.prompts.length > 0) {
    const argv = await withSession(ctx.fallbackSession, (session) =>
      runCommandPrompts(leaf, session)
    );
    if (argv === null) {
      ui.print(`  ${ui.dim("Aborted.")}`);
      return;
    }
    await dispatch(ctx.registry, argv, ctx.cwd, ATELIER_VERSION, "repl");
    return;
  }

  // Bridge to the underlying CLI dispatcher. The same code path that
  // powers `atelier <verb> …` from the shell. Pass mode="repl" so
  // commands can render hints in slash-command form.
  await dispatch(ctx.registry, [cmd, ...rest], ctx.cwd, ATELIER_VERSION, "repl");
}

function tokenize(s: string): string[] {
  const out: string[] = [];
  let buf = "";
  let quote: '"' | "'" | null = null;
  for (const ch of s) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        buf += ch;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (buf) {
        out.push(buf);
        buf = "";
      }
      continue;
    }
    buf += ch;
  }
  if (buf) out.push(buf);
  return out;
}

// ============================================================
// /help
// ============================================================

function showHelp(): void {
  ui.heading("Commands");
  const groups: Array<{ heading: string; items: Array<[string, string]> }> = [
    {
      heading: "Session",
      items: [
        ["/help", "show this help"],
        ["/status", "show workspace overview"],
        ["/clear", "clear the screen"],
        ["/quit", "leave the REPL (also: /exit)"],
      ],
    },
    {
      heading: "Workspace",
      items: [
        ["/init <name>", "scaffold a new planning workspace here"],
        ["/repo", "interactive repo registration"],
        ["/repo list|add|remove|discover", "scriptable subcommands"],
      ],
    },
    {
      heading: "Sources & docs",
      items: [
        ["/source onboard <kind>", "interactive source onboarding"],
        ["/source list|enable|disable", "scriptable subcommands"],
        ["/sync", "pull docs from every enabled source"],
        ["/doc list|show <src> <id>", "inspect indexed docs"],
      ],
    },
    {
      heading: "Planning",
      items: [
        ["/feature add|list|show", "feature map"],
        ["/spec new|list|show", "spec / issue folders"],
        ["/discrepancy add|list|resolve", "doc-vs-code mismatches"],
      ],
    },
  ];
  for (const g of groups) {
    ui.print("");
    ui.print(`  ${ui.bold(g.heading)}`);
    for (const [cmd, desc] of g.items) {
      ui.print(`    ${ui.cyan(cmd.padEnd(34))} ${ui.dim(desc)}`);
    }
  }
  ui.print("");
  ui.print(
    `  ${ui.dim("Anything that works as")} ${ui.cyan("atelier <verb>")} ${ui.dim("from the shell also works as")} ${ui.cyan("/<verb>")} ${ui.dim("here.")}`
  );
  ui.blank();
}

// ============================================================
// /status
// ============================================================

async function showStatus(ctx: ReplContext): Promise<void> {
  if (!ctx.workspaceRoot) {
    ui.print(`  ${ui.dim("No workspace at")} ${ctx.cwd}.`);
    return;
  }
  const local = await discoverLocal(ctx.cwd, ctx.workspaceRoot);
  await renderWorkspaceStatus(ctx, local);
}

// ============================================================
// /repo (interactive)
// ============================================================

interface CombinedCandidate {
  /** Stable key for dedup. */
  key: string;
  label: string;
  /** Human note (path on disk, GitHub clone hint). */
  note: string;
  /** Source of the candidate. */
  source: "local" | "remote" | "both";
  localPath?: string;
  remote?: { name: string; sshUrl: string; httpsUrl: string };
  registered: boolean;
}

/**
 * Per-org bucket the wizard works through: which repos in this org
 * are locally cloned but unregistered, which are only on GitHub.
 */
interface OrgGroup {
  org: string;
  /** Cloned-but-unregistered candidates. The wizard's primary target. */
  cloned: CombinedCandidate[];
  /** Live on GitHub, not cloned anywhere locally. */
  remoteOnly: CombinedCandidate[];
  /** Cloned + already registered. Just for the summary. */
  registered: CombinedCandidate[];
}

async function interactiveRepoFlow(ctx: ReplContext): Promise<void> {
  if (!ctx.workspaceRoot) {
    ui.error("No workspace here. Run /init first.");
    return;
  }
  ui.heading("Repo discovery");
  ui.blank();

  // ---- 1. Scan local + query gh in parallel-ish ----
  const local = await ui.spinner("Scanning local directories", () =>
    discoverLocal(ctx.cwd, ctx.workspaceRoot)
  );
  const { organization } = await listRepos(ctx.workspaceRoot);
  const allOrgs = unique([
    ...(organization ? [organization] : []),
    ...local.orgs,
  ]);

  let remoteByOrg: Map<string, DiscoveryResult> = new Map();
  if (allOrgs.length > 0) {
    const gh = new GhAdapter();
    const avail = await gh.checkAvailability();
    if (avail.available) {
      try {
        const result = await ui.spinner(
          `Querying GitHub for ${allOrgs.length} org(s): ${allOrgs.join(", ")}`,
          () => discoverManyOrgs(ctx.workspaceRoot!, allOrgs, gh)
        );
        remoteByOrg = result.byOrg;
        for (const [org, msg] of result.errors) {
          ui.warn(`gh listing for ${org} failed: ${msg}`);
        }
      } catch (err) {
        ui.warn(`GitHub discovery failed: ${(err as Error).message}`);
      }
    } else {
      ui.print(`  ${ui.dim(avail.reason)}`);
    }
  }

  // ---- 2. Bucket candidates by org ----
  const groups = bucketByOrg(local.localRepos, remoteByOrg);
  const interesting = groups.filter(
    (g) => g.cloned.length > 0 || g.remoteOnly.length > 0
  );
  if (interesting.length === 0) {
    ui.print(`  ${ui.dim("Nothing new to register — everything nearby is already in the workspace.")}`);
    return;
  }

  // ---- 3. Render the summary ----
  ui.blank();
  ui.print(`  ${ui.bold("Found:")}`);
  for (const g of interesting) {
    const parts: string[] = [];
    if (g.registered.length > 0) parts.push(`${g.registered.length} already registered`);
    if (g.cloned.length > 0) parts.push(`${g.cloned.length} cloned, not registered`);
    if (g.remoteOnly.length > 0) parts.push(`${g.remoteOnly.length} on GitHub, not cloned`);
    ui.print(`    ${ui.green("·")} ${ui.bold(g.org).padEnd(20)} ${ui.dim(parts.join("  ·  "))}`);
  }
  ui.blank();

  // ---- 4. Which orgs to engage with? ----
  let chosenOrgs: OrgGroup[];
  if (interesting.length === 1) {
    chosenOrgs = interesting;
  } else {
    const picked = await interactivePickMany(
      "Which orgs are relevant to this workspace?",
      interesting.map((g) => ({
        label: g.org,
        value: g,
        note: orgNote(g),
      })),
      ctx.fallbackSession
    );
    if (!picked || picked.length === 0) {
      ui.print(`  ${ui.dim("Nothing selected. Skipping.")}`);
      return;
    }
    chosenOrgs = picked;
  }

  // ---- 5. Per-org wizard ----
  let totalAdded = 0;
  let totalFailed = 0;
  let totalCloned = 0;
  for (const group of chosenOrgs) {
    const result = await runOrgWizard(ctx, group);
    totalAdded += result.added;
    totalFailed += result.failed;
    totalCloned += result.cloned;
  }

  // ---- 6. Recap ----
  ui.blank();
  ui.heading("Summary");
  ui.print(`  ${ui.dim("Registered:")} ${totalAdded}`);
  if (totalCloned > 0) ui.print(`  ${ui.dim("Cloned:")}     ${totalCloned}`);
  if (totalFailed > 0) ui.print(`  ${ui.dim("Failed:")}     ${totalFailed}`);
  ui.blank();
}

function orgNote(g: OrgGroup): string {
  const parts: string[] = [];
  if (g.cloned.length > 0) parts.push(`${g.cloned.length} cloned`);
  if (g.remoteOnly.length > 0) parts.push(`${g.remoteOnly.length} on GitHub`);
  return parts.join(" · ");
}

interface OrgWizardResult {
  added: number;
  failed: number;
  cloned: number;
}

async function runOrgWizard(
  ctx: ReplContext,
  group: OrgGroup
): Promise<OrgWizardResult> {
  ui.blank();
  ui.print(`${ui.bold(group.org)}`);
  ui.blank();

  let added = 0;
  let failed = 0;
  let cloned = 0;

  // ---- A. Register the locally-cloned repos ----
  if (group.cloned.length > 0) {
    const result = await registerClonedRepos(ctx, group);
    added += result.added;
    failed += result.failed;
  }

  // ---- B. Optionally clone + register remote-only repos ----
  if (group.remoteOnly.length > 0) {
    const wantsMore = await withSession(ctx.fallbackSession, (session) =>
      session.confirm(
        `  Pull more from ${group.org} on GitHub? (${group.remoteOnly.length} available)`,
        { default: false }
      )
    );
    if (wantsMore) {
      const result = await cloneAndRegisterRemoteRepos(ctx, group);
      added += result.added;
      failed += result.failed;
      cloned += result.cloned;
    }
  }

  return { added, failed, cloned };
}

async function registerClonedRepos(
  ctx: ReplContext,
  group: OrgGroup
): Promise<{ added: number; failed: number }> {
  // For ≤ 3 cloned repos, ask a single yes/no. For more, give a
  // multi-select so the user can drop noise (e.g. an experimental
  // repo they don't want indexed).
  let toRegister: CombinedCandidate[] = [];
  if (group.cloned.length <= 3) {
    const names = group.cloned.map((c) => c.label).join(", ");
    const ok = await withSession(ctx.fallbackSession, (session) =>
      session.confirm(
        `  Register ${group.cloned.length} locally-cloned repo(s) — ${names}?`,
        { default: true }
      )
    );
    if (ok) toRegister = group.cloned;
  } else {
    const picked = await interactivePickMany(
      `Locally cloned in ${group.org}`,
      group.cloned.map((c) => ({
        label: c.label,
        value: c,
        note: c.note,
      })),
      ctx.fallbackSession
    );
    if (picked) toRegister = picked;
  }

  let added = 0;
  let failed = 0;
  for (const c of toRegister) {
    try {
      const rel = path.relative(ctx.workspaceRoot!, c.localPath!);
      await addRepo(ctx.workspaceRoot!, {
        pathInput: rel === "" ? "." : rel.split(path.sep).join("/"),
        cwd: ctx.workspaceRoot!,
      });
      ui.success(`  Registered ${c.label}`);
      added++;
    } catch (err) {
      ui.error(`  ${c.label}: ${(err as Error).message}`);
      failed++;
    }
  }
  return { added, failed };
}

async function cloneAndRegisterRemoteRepos(
  ctx: ReplContext,
  group: OrgGroup
): Promise<{ added: number; failed: number; cloned: number }> {
  // For long lists, the multi-select with filter is the right tool —
  // 56 gilons repos shouldn't all be in the user's face. The picker's
  // `/` filter mode is the natural way to narrow it down.
  const picked = await interactivePickMany(
    `${group.org} on GitHub — pick repos to clone & register`,
    group.remoteOnly.map((c) => ({
      label: c.label,
      value: c,
      note: c.note,
    })),
    ctx.fallbackSession
  );
  if (!picked || picked.length === 0) return { added: 0, failed: 0, cloned: 0 };

  // Clone into the workspace's parent so repos land alongside it
  // (the canonical sibling layout). If the user's workspace is at
  // the umbrella level (atypical), they'll land as workspace children.
  const cloneInto = path.dirname(ctx.workspaceRoot!);
  let added = 0;
  let failed = 0;
  let cloned = 0;
  for (const c of picked) {
    const fullName = `${group.org}/${c.label}`;
    const dest = path.join(cloneInto, c.label);
    try {
      await ui.spinner(`Cloning ${fullName}`, () =>
        runGhClone(fullName, dest)
      );
      cloned++;
    } catch (err) {
      ui.error(`  ${fullName}: ${(err as Error).message}`);
      failed++;
      continue;
    }
    try {
      const rel = path.relative(ctx.workspaceRoot!, dest);
      await addRepo(ctx.workspaceRoot!, {
        pathInput: rel === "" ? "." : rel.split(path.sep).join("/"),
        cwd: ctx.workspaceRoot!,
      });
      ui.success(`  Registered ${c.label}`);
      added++;
    } catch (err) {
      ui.error(`  ${c.label}: ${(err as Error).message}`);
      failed++;
    }
  }
  return { added, failed, cloned };
}

/**
 * Shell out to `gh repo clone <full-name> <dest>`. We don't reuse
 * the existing `gh` adapter because that's wrapped around `gh repo
 * list` JSON output; the clone call is plain.
 */
function runGhClone(fullName: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("gh", ["repo", "clone", fullName, dest], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        reject(new Error("`gh` not installed (https://cli.github.com/)"));
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr.trim() || `gh repo clone exited with code ${code}`));
    });
  });
}

/**
 * Reshape the merged candidate list into per-org buckets, tagging
 * each candidate as already-registered / cloned-not-registered /
 * remote-only.
 */
function bucketByOrg(
  local: LocalRepoCandidate[],
  remoteByOrg: Map<string, DiscoveryResult>
): OrgGroup[] {
  const groups = new Map<string, OrgGroup>();
  const ensure = (org: string): OrgGroup => {
    let g = groups.get(org);
    if (!g) {
      g = { org, cloned: [], remoteOnly: [], registered: [] };
      groups.set(org, g);
    }
    return g;
  };

  // Start from gh's view (org → its repos) so we have a definitive
  // list per org, then layer local-only candidates on top.
  for (const [org, result] of remoteByOrg) {
    for (const r of result.repos) {
      const candidate: CombinedCandidate = {
        key: r.remote.name,
        label: r.remote.name,
        note: r.remote.httpsUrl || r.remote.sshUrl,
        source: r.localPath ? "both" : "remote",
        localPath: r.localPath ?? undefined,
        remote: {
          name: r.remote.name,
          sshUrl: r.remote.sshUrl,
          httpsUrl: r.remote.httpsUrl,
        },
        registered: r.registered,
      };
      const g = ensure(org);
      if (candidate.registered) g.registered.push(candidate);
      else if (candidate.localPath) g.cloned.push(candidate);
      else g.remoteOnly.push(candidate);
    }
  }

  // Local repos whose org isn't in remoteByOrg (gh unavailable, or
  // org not queried) still belong somewhere — group them under
  // their inferred org or "(unknown)".
  const orgsWithRemotes = new Set(remoteByOrg.keys());
  for (const l of local) {
    const orgKey = l.org ?? "(unknown)";
    if (orgsWithRemotes.has(orgKey)) continue; // already accounted for via gh
    const candidate: CombinedCandidate = {
      key: l.repoName,
      label: l.dirName,
      note: l.remote ?? l.absPath,
      source: "local",
      localPath: l.absPath,
      registered: false,
    };
    ensure(orgKey).cloned.push(candidate);
  }

  return [...groups.values()].sort((a, b) => a.org.localeCompare(b.org));
}

function mergeCandidates(
  local: LocalRepoCandidate[],
  remote: DiscoveredRepo[]
): CombinedCandidate[] {
  const byName = new Map<string, CombinedCandidate>();
  for (const l of local) {
    byName.set(l.repoName, {
      key: l.repoName,
      label: l.dirName,
      note: l.remote ? l.remote : l.absPath,
      source: "local",
      localPath: l.absPath,
      registered: false,
    });
  }
  for (const r of remote) {
    const existing = byName.get(r.remote.name);
    if (existing) {
      existing.source = "both";
      existing.note = r.remote.httpsUrl || r.remote.sshUrl || existing.note;
      existing.remote = {
        name: r.remote.name,
        sshUrl: r.remote.sshUrl,
        httpsUrl: r.remote.httpsUrl,
      };
      existing.registered = r.registered;
      if (r.localPath) existing.localPath = r.localPath;
    } else {
      byName.set(r.remote.name, {
        key: r.remote.name,
        label: r.remote.name,
        note: r.localPath ? `${r.remote.httpsUrl}  (cloned locally)` : `${r.remote.httpsUrl}  (not cloned)`,
        source: "remote",
        localPath: r.localPath ?? undefined,
        remote: {
          name: r.remote.name,
          sshUrl: r.remote.sshUrl,
          httpsUrl: r.remote.httpsUrl,
        },
        registered: r.registered,
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.label.localeCompare(b.label));
}
