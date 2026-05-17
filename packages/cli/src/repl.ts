import * as path from "node:path";
import {
  ATELIER_VERSION,
  loadWorkspace,
  listRepos,
  listSources,
  listFeatures,
  listDocs,
  scanSiblings,
  scanChildren,
  inferRepoContext,
  inferOrg,
  findNearbyWorkspace,
  addRepo,
  GhAdapter,
  discoverRepos,
  type LocalRepoCandidate,
  type DiscoveredRepo,
} from "@atelier/core";
import { ui } from "./ui.js";
import { PromptSession } from "./prompt.js";
import { dispatch, type CommandRegistry } from "./command.js";
import { renderBanner } from "./banner.js";
import { buildReplCompleter } from "./repl-completer.js";

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
  session: PromptSession;
  workspaceRoot: string | null;
}

export async function runRepl(
  cwd: string,
  registry: CommandRegistry
): Promise<number> {
  const session = new PromptSession({
    completer: buildReplCompleter(registry),
  });
  const ctx: ReplContext = {
    cwd,
    registry,
    session,
    // Use the sideways-aware lookup so a user inside `api/` next to
    // `planning/` still gets a workspace context. Falls back to null
    // when nothing nearby exists.
    workspaceRoot: await findNearbyWorkspace(cwd),
  };

  try {
    await renderWelcome(ctx);

    while (true) {
      const line = await session.ask(ui.cyan("atelier ❯"));
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
    session.close();
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

  if (ctx.workspaceRoot) {
    await renderWorkspaceStatus(ctx);
    await maybeOfferAutoRegister(ctx);
  } else {
    await renderNoWorkspaceContext(ctx);
  }

  ui.blank();
  ui.print(
    `  ${ui.dim("Type")} ${ui.cyan("/help")} ${ui.dim("for commands, or")} ${ui.cyan("/quit")} ${ui.dim("to leave.")}`
  );
  ui.blank();
}

async function renderWorkspaceStatus(ctx: ReplContext): Promise<void> {
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
  } catch (err) {
    ui.warn(`Workspace at ${ctx.workspaceRoot} is malformed: ${(err as Error).message}`);
  }
}

async function renderNoWorkspaceContext(ctx: ReplContext): Promise<void> {
  ui.print(`  ${ui.dim("No workspace found at")} ${ctx.cwd}`);
  // Look for a nearby workspace (ancestor or sibling).
  const nearby = await findNearbyWorkspace(ctx.cwd);
  if (nearby && nearby !== ctx.cwd) {
    ui.print(`  ${ui.dim("Nearby workspace:")} ${nearby}`);
    ui.print(
      `  ${ui.dim("→ cd into it and re-run, or type")} ${ui.cyan("/init")} ${ui.dim("to start a new one here.")}`
    );
    return;
  }
  // No workspace anywhere — show repo candidates so the user knows
  // what they'd be working with.
  const siblings = await scanChildren(ctx.cwd);
  if (siblings.length > 0) {
    const org = inferOrg(siblings);
    ui.print(
      `  ${ui.dim("Detected")} ${siblings.length} git repo(s) ${ui.dim("in this directory")}` +
        (org ? ` ${ui.dim("(org:")} ${ui.bold(org)}${ui.dim(")")}` : "")
    );
    for (const s of siblings.slice(0, 5)) {
      ui.print(`    ${ui.dim("·")} ${s.dirName}`);
    }
    if (siblings.length > 5) ui.print(`    ${ui.dim(`… and ${siblings.length - 5} more`)}`);
    ui.print(`  ${ui.dim("→ Type")} ${ui.cyan("/init")} ${ui.dim("to scaffold a workspace here.")}`);
    return;
  }
  ui.print(`  ${ui.dim("→ Type")} ${ui.cyan("/init")} ${ui.dim("to start a new workspace.")}`);
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
  const ok = await ctx.session.confirm(
    `    Register it with workspace ${path.basename(ctx.workspaceRoot)}?`,
    { default: true }
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
  if (lower === "repo" && rest.length === 0) {
    return interactiveRepoFlow(ctx);
  }

  // Bridge to the underlying CLI dispatcher. The same code path that
  // powers `atelier <verb> …` from the shell.
  await dispatch(ctx.registry, [cmd, ...rest], ctx.cwd, ATELIER_VERSION);
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
  await renderWorkspaceStatus(ctx);
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

async function interactiveRepoFlow(ctx: ReplContext): Promise<void> {
  if (!ctx.workspaceRoot) {
    ui.error("No workspace here. Run /init first.");
    return;
  }
  ui.heading("Repo registration");
  ui.blank();

  // 1. Gather candidates from local disk.
  const local = await ui.spinner("Scanning sibling directories", () =>
    scanSiblings(ctx.workspaceRoot!)
  );

  // 2. Try gh discovery if an org is configured (or can be inferred).
  let remoteRepos: DiscoveredRepo[] = [];
  const { organization } = await listRepos(ctx.workspaceRoot);
  const org = organization ?? inferOrg(local);
  if (org) {
    const gh = new GhAdapter();
    const avail = await gh.checkAvailability();
    if (avail.available) {
      try {
        const discovery = await ui.spinner(`Querying GitHub for repos in ${org}`, () =>
          discoverRepos(ctx.workspaceRoot!, org, gh)
        );
        remoteRepos = discovery.repos;
      } catch (err) {
        ui.warn(`GitHub discovery failed: ${(err as Error).message}`);
      }
    } else {
      ui.print(`  ${ui.dim(avail.reason)}`);
    }
  } else {
    ui.print(
      `  ${ui.dim("No GitHub org yet — registering the first repo will set one automatically.")}`
    );
  }

  // 3. Merge local + remote into one list keyed by repo name.
  const merged = mergeCandidates(local, remoteRepos);
  if (merged.length === 0) {
    ui.print(`  ${ui.dim("No candidates found near")} ${ctx.workspaceRoot}.`);
    return;
  }

  // 4. Show summary, then multi-select.
  ui.print(
    `  Found ${ui.bold(String(merged.length))} candidate(s)` +
      (org ? ` ${ui.dim(`(org: ${org})`)}` : "")
  );
  ui.blank();

  const choice = await ctx.session.pickMany(
    "Pick repos to register (registered ones are marked with —):",
    merged.map((c) => ({
      label: c.label,
      value: c,
      note: c.note,
      preselected: false,
      disabled: c.registered,
    }))
  );
  if (!choice || choice.length === 0) {
    ui.print(`  ${ui.dim("Nothing selected.")}`);
    return;
  }

  // 5. Register each.
  ui.blank();
  let added = 0;
  let failed = 0;
  for (const c of choice) {
    try {
      if (c.localPath) {
        const rel = path.relative(ctx.workspaceRoot, c.localPath);
        await addRepo(ctx.workspaceRoot, {
          pathInput: rel === "" ? "." : rel.split(path.sep).join("/"),
          cwd: ctx.workspaceRoot,
        });
        ui.success(`Registered ${c.label}`);
        added++;
      } else {
        // Remote-only — can't register without a clone.
        ui.warn(
          `${c.label}: not cloned locally. Run \`gh repo clone ${c.remote?.name}\` first, then retry.`
        );
      }
    } catch (err) {
      ui.error(`${c.label}: ${(err as Error).message}`);
      failed++;
    }
  }
  ui.blank();
  ui.print(`  ${ui.dim("Added:")} ${added}  ${ui.dim("Failed:")} ${failed}`);
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
