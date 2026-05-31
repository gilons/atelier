import * as path from "node:path";
import {
  requireWorkspaceRoot,
  addRepo,
  removeRepo,
  listRepos,
  loadReposConfig,
  discoverRepos,
  discoverManyOrgs,
  discoverLocal,
  inspectProjects,
  suggestedAddCommand,
  GhAdapter,
  RepoAlreadyRegisteredError,
  RepoNameNotFoundError,
  NotAGitRepoError,
  MissingRemoteError,
  NotInsideWorkspaceError,
  type GitHostAdapter,
} from "@atelier/core";
import type { Command } from "../command.js";
import { ui } from "../ui.js";

const addCmd: Command = {
  name: "add",
  summary: "Register a sibling repository with this workspace.",
  description:
    "Reads the .git/config of <path>, extracts its origin remote URL,\n" +
    "and adds it to .planning/repos.yaml. Path must be inside the\n" +
    "workspace root (a sibling of the planning directory).\n\n" +
    "If this is the first repo registered and its remote is on GitHub,\n" +
    "the workspace's organization is auto-detected and stored.",
  options: {
    name: { type: "string", short: "n" },
    description: { type: "string", short: "d" },
  },
  positionals: ["path"],
  prompts: [
    {
      key: "path",
      question: "Path to the repo (e.g. ../api)",
      help: "Must be a sibling of the workspace, with a .git directory.",
      positionalIndex: 0,
      validate: /\S/,
    },
  ],
  async run({ values, positionals, cwd }) {
    const [target] = positionals;
    if (!target) {
      ui.error("Missing <path> argument.");
      ui.print(`  ${ui.dim("Usage: atelier repo add <path> [--name <name>] [--description <desc>]")}`);
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
      const result = await addRepo(workspaceRoot, {
        pathInput: target,
        cwd,
        name: values.name as string | undefined,
        description: values.description as string | undefined,
      });
      ui.success(`Registered ${ui.bold(result.repo.name)}`);
      ui.blank();
      ui.print(`  ${ui.dim("Remote:")}   ${result.repo.remote}`);
      ui.print(`  ${ui.dim("Path:")}     ${result.repo.localPath}`);
      if (result.repo.description) {
        ui.print(`  ${ui.dim("Desc:")}     ${result.repo.description}`);
      }
      if (result.organizationSet) {
        ui.blank();
        ui.info(`Detected GitHub organization: ${ui.bold(result.organizationSet)}`);
        ui.print(`  ${ui.dim("Saved to workspace. Use `atelier repo discover` later to find sibling repos.")}`);
      }
      ui.blank();
      return 0;
    } catch (err) {
      if (err instanceof NotAGitRepoError) {
        ui.error(err.message);
        return 1;
      }
      if (err instanceof MissingRemoteError) {
        ui.error(err.message);
        ui.print(`  ${ui.dim("Add a remote in the target repo first, then retry.")}`);
        return 1;
      }
      if (err instanceof RepoAlreadyRegisteredError) {
        ui.error(err.message);
        return 1;
      }
      if (err instanceof Error && /does not exist|is not a directory/.test(err.message)) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

const listCmd: Command = {
  name: "list",
  summary: "List repositories registered with this workspace.",
  description:
    "Shows every entry in .planning/repos.yaml. Repos whose local\n" +
    "directories don't currently exist are flagged — useful after\n" +
    "cloning the planning repo onto a new machine.",
  async run({ cwd, mode }) {
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
    const { organization, repos } = await listRepos(workspaceRoot);

    if (repos.length === 0) {
      ui.info("No repositories registered yet.");
      ui.print(`  ${ui.dim(`Use \`${mode === "repl" ? "/" : "atelier "}repo add <path>\` to register one.`)}`);
      return 0;
    }

    if (organization) {
      ui.print(`  ${ui.dim("Organization:")} ${ui.bold(organization)}`);
      ui.blank();
    }

    const nameWidth = Math.max(
      "NAME".length,
      ...repos.map((r) => r.repo.name.length)
    );
    const pathWidth = Math.max(
      "PATH".length,
      ...repos.map((r) => (r.repo.localPath ?? "").length)
    );

    // Data rows have a 2-char marker prefix ("✓ " / "· "). The header
    // gets a 2-space prefix instead so columns line up regardless of
    // name lengths.
    ui.print(
      `    ${ui.dim("NAME".padEnd(nameWidth))}  ${ui.dim("PATH".padEnd(pathWidth))}  ${ui.dim("REMOTE")}`
    );
    for (const { repo, exists } of repos) {
      const marker = exists ? ui.green("✓") : ui.yellow("·");
      const status = exists ? "" : ui.yellow(" (not cloned locally)");
      ui.print(
        `  ${marker} ${repo.name.padEnd(nameWidth)}  ${(repo.localPath ?? "").padEnd(pathWidth)}  ${repo.remote}${status}`
      );
    }
    ui.blank();
    return 0;
  },
};

const removeCmd: Command = {
  name: "remove",
  summary: "Unregister a repository from this workspace.",
  description:
    "Removes the named entry from .planning/repos.yaml. Does NOT\n" +
    "delete the actual repository directory — only updates the registry.",
  positionals: ["name"],
  async run({ positionals, cwd }) {
    const [name] = positionals;
    if (!name) {
      ui.error("Missing <name> argument.");
      ui.print(`  ${ui.dim("Usage: atelier repo remove <name>")}`);
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
      const removed = await removeRepo(workspaceRoot, name);
      ui.success(`Unregistered ${ui.bold(removed.name)} (${removed.remote})`);
      return 0;
    } catch (err) {
      if (err instanceof RepoNameNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

/**
 * Factory for the host adapter used by `discover`. Injectable to keep
 * tests isolated from the real `gh` binary.
 */
let _hostAdapter: GitHostAdapter | null = null;
export function setGitHostAdapterForTesting(adapter: GitHostAdapter | null): void {
  _hostAdapter = adapter;
}
function getGitHostAdapter(): GitHostAdapter {
  return _hostAdapter ?? new GhAdapter();
}

const discoverCmd: Command = {
  name: "discover",
  summary: "Find repos in your organization that aren't yet registered.",
  description:
    "Queries your git host (currently GitHub via the `gh` CLI) for every\n" +
    "repository in your organization, then diffs against what's already\n" +
    "in repos.yaml. Lists what's available, what's locally cloned but\n" +
    "unregistered, and what's registered but missing locally.\n\n" +
    "With --add-cloned, automatically registers every discovered repo\n" +
    "that already has a local clone (skipping those that don't).",
  options: {
    org: { type: "string", short: "o" },
    "add-cloned": { type: "boolean" },
  },
  async run({ values, cwd, mode }) {
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

    // Determine which orgs to query, in priority order:
    //   1. --org flag (single org).
    //   2. Workspace-configured org from repos.yaml (single org).
    //   3. Inferred from local sibling repos on disk (may be many).
    //
    // A brand-new workspace has no configured org, but sibling
    // directories often contain git repos whose remotes point at the
    // user's GitHub org. Falling back to that scan turns the
    // first-run experience from "error: no org" into "we found these
    // candidates around you".
    const orgFlag = values.org as string | undefined;
    let orgs: string[] = [];
    if (orgFlag) {
      orgs = [orgFlag];
    } else {
      const cfg = await loadReposConfig(workspaceRoot);
      if (cfg.organization) {
        orgs = [cfg.organization];
      } else {
        const local = await discoverLocal(cwd, workspaceRoot);
        orgs = local.orgs;
      }
    }

    if (orgs.length === 0) {
      ui.error(
        "No organization to discover from."
      );
      ui.print(
        `  ${ui.dim("Either pass --org <name>, register a GitHub-hosted repo first")}`
      );
      const addHint = mode === "repl" ? "/repo" : "atelier repo add ../<repo>";
      ui.print(
        `  ${ui.dim(`(try`)} ${ui.cyan(addHint)}${ui.dim(")")}, or run this command from a directory that has sibling git repos whose remotes are on GitHub.`
      );
      return 1;
    }

    const host = getGitHostAdapter();
    const availability = await host.checkAvailability();
    if (!availability.available) {
      ui.error(availability.reason);
      return 1;
    }

    ui.info(
      `Querying ${host.displayName} for ${orgs.length} org(s): ${orgs.map((o) => ui.bold(o)).join(", ")}…`
    );
    ui.blank();

    const { byOrg, errors } = await discoverManyOrgs(workspaceRoot, orgs, host);
    for (const [org, msg] of errors) {
      ui.warn(`gh listing for ${org} failed: ${msg}`);
    }
    if (byOrg.size === 0) {
      ui.error("No org returned any results.");
      return 1;
    }

    // Aggregate counts across orgs for the summary header.
    let totalAll = 0;
    let regAll = 0;
    let missingAll = 0;
    let unregAll = 0;
    for (const r of byOrg.values()) {
      totalAll += r.repos.length;
      regAll += r.repos.length - r.unregistered.length;
      missingAll += r.missingLocally.length;
      unregAll += r.unregistered.length;
    }
    const orgLabel = byOrg.size === 1 ? [...byOrg.keys()][0] : `${byOrg.size} orgs`;
    ui.print(`  ${ui.dim("Found:")}        ${totalAll} repos in ${orgLabel}`);
    ui.print(`  ${ui.dim("Registered:")}   ${regAll}`);
    ui.print(`  ${ui.dim("Unregistered:")} ${unregAll}`);
    ui.print(`  ${ui.dim("Missing local:")} ${missingAll}`);
    ui.blank();

    // Group output by org so the picture is clear when there are
    // many. (For a single org the heading is still useful.)
    for (const [org, result] of byOrg) {
      if (byOrg.size > 1) {
        ui.print(ui.bold(`  ${org}:`));
      }
      // Unregistered candidates
      if (result.unregistered.length > 0) {
        ui.print(`  ${byOrg.size > 1 ? "  " : ""}${ui.bold("Unregistered:")}`);
        for (const r of result.unregistered) {
          const cloneStatus = r.localPath
            ? ui.green(" (cloned locally)")
            : ui.yellow(" (not cloned)");
          ui.print(
            `  ${byOrg.size > 1 ? "  " : ""}  ${ui.dim("·")} ${r.remote.name}${cloneStatus}`
          );
          if (r.remote.description) {
            ui.print(
              `  ${byOrg.size > 1 ? "  " : ""}    ${ui.dim(r.remote.description)}`
            );
          }
          ui.print(
            `  ${byOrg.size > 1 ? "  " : ""}    ${ui.dim("→")} ${ui.cyan(suggestedAddCommand(r, workspaceRoot))}`
          );
        }
      }
      // Missing locally
      if (result.missingLocally.length > 0) {
        ui.print(
          `  ${byOrg.size > 1 ? "  " : ""}${ui.bold("Registered but not cloned locally:")}`
        );
        for (const r of result.missingLocally) {
          ui.print(
            `  ${byOrg.size > 1 ? "  " : ""}  ${ui.yellow("·")} ${r.remote.name}`
          );
          ui.print(
            `  ${byOrg.size > 1 ? "  " : ""}    ${ui.dim("→")} ${ui.cyan(`gh repo clone ${org}/${r.remote.name}`)}`
          );
        }
      }
      ui.blank();
    }

    // Build a flattened DiscoveryResult-ish view for the --add-cloned
    // path below. Combines all orgs' results.
    const result = {
      organization: orgLabel,
      repos: [...byOrg.values()].flatMap((r) => r.repos),
      unregistered: [...byOrg.values()].flatMap((r) => r.unregistered),
      missingLocally: [...byOrg.values()].flatMap((r) => r.missingLocally),
    };

    // Auto-add cloned repos if requested.
    if (values["add-cloned"] === true) {
      const candidates = result.unregistered.filter((r) => r.localPath !== null);
      if (candidates.length === 0) {
        ui.info("No locally-cloned unregistered repos to add.");
        return 0;
      }
      ui.print(ui.bold(`  Adding ${candidates.length} locally-cloned repos:`));
      let added = 0;
      let failed = 0;
      for (const c of candidates) {
        try {
          const rel = path.relative(workspaceRoot, c.localPath!);
          const display = rel === "" ? "." : rel.split(path.sep).join("/");
          await addRepo(workspaceRoot, {
            pathInput: display,
            cwd: workspaceRoot,
            description: c.remote.description ?? undefined,
          });
          ui.print(`    ${ui.green("✓")} ${c.remote.name}`);
          added++;
        } catch (err) {
          ui.print(`    ${ui.red("✗")} ${c.remote.name}: ${(err as Error).message}`);
          failed++;
        }
      }
      ui.blank();
      ui.print(`  ${ui.dim("Added:")} ${added}  ${ui.dim("Failed:")} ${failed}`);
    }

    return 0;
  },
};

const inspectCmd: Command = {
  name: "inspect",
  summary: "Detect each repo's ecosystems, packages, and service boundaries.",
  description:
    "Deterministic structural fingerprint of the registered repos — the\n" +
    "projects / subsystems / microservices the workspace is made of, by\n" +
    "manifest files (package.json, go.mod, pyproject.toml, …), monorepo\n" +
    "packages (workspaces, apps/, services/, cmd/), and container hints.\n\n" +
    "No analysis, no LLM — just the structural facts the system-design\n" +
    "agent builds its workspace design on. Pass a repo name to inspect\n" +
    "just one; --json for machine consumption.",
  positionals: ["name?"],
  options: {
    json: { type: "boolean" },
  },
  async run({ values, positionals, cwd }) {
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

    const result = await inspectProjects(workspaceRoot, {
      repo: positionals[0],
    });

    if (values.json === true) {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return 0;
    }

    if (result.repos.length === 0) {
      ui.info("No repositories registered.");
      ui.print(`  ${ui.dim("Register one with `atelier repo add ../<dir>`.")}`);
      return 0;
    }

    for (const r of result.repos) {
      if (!r.exists) {
        ui.print(`${ui.bold(r.repo)}  ${ui.dim("(not cloned locally)")}`);
        ui.blank();
        continue;
      }
      const tags: string[] = [];
      if (r.monorepo) tags.push("monorepo");
      if (r.containerized) tags.push("containerized");
      const eco = r.ecosystems.length > 0 ? r.ecosystems.join(", ") : ui.dim("no manifest found");
      ui.print(
        `${ui.bold(r.repo)}  ${ui.dim("[" + eco + "]")}${tags.length ? "  " + ui.dim(tags.join(" · ")) : ""}`
      );
      const members = r.packages.filter((p) => p.path !== ".");
      if (members.length > 0) {
        for (const p of members) {
          ui.print(`  ${ui.green("·")} ${p.path}  ${ui.dim(p.name + " (" + p.ecosystems.join(",") + ")")}`);
        }
      }
      ui.blank();
    }
    ui.print(
      `  ${ui.dim("→ Feed this to the system-design agent: `atelier agent install system-design`.")}`
    );
    ui.blank();
    return 0;
  },
};

export const repoCommand: Command = {
  name: "repo",
  summary: "Manage code repositories registered with this workspace.",
  description:
    "Repositories represent the code your product lives in. They are\n" +
    "sibling directories under the workspace root. Atelier reads from\n" +
    "them and writes specs that reference paths inside them.",
  subcommands: [addCmd, listCmd, removeCmd, discoverCmd, inspectCmd],
};
