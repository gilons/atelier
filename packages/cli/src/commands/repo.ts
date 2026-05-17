import * as path from "node:path";
import {
  requireWorkspaceRoot,
  addRepo,
  removeRepo,
  listRepos,
  loadReposConfig,
  discoverRepos,
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
  async run({ values, cwd }) {
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

    // Determine the org: --org flag wins, else repos.yaml.
    let org = values.org as string | undefined;
    if (!org) {
      const cfg = await loadReposConfig(workspaceRoot);
      org = cfg.organization;
    }
    if (!org) {
      ui.error("No organization to discover. Register a GitHub-hosted repo first, or pass --org.");
      return 1;
    }

    const host = getGitHostAdapter();
    const availability = await host.checkAvailability();
    if (!availability.available) {
      ui.error(availability.reason);
      return 1;
    }

    ui.info(`Querying ${host.displayName} for repos in ${ui.bold(org)}…`);
    ui.blank();

    let result;
    try {
      result = await discoverRepos(workspaceRoot, org, host);
    } catch (err) {
      ui.error((err as Error).message);
      return 1;
    }

    // Summary
    const total = result.repos.length;
    const reg = total - result.unregistered.length;
    ui.print(
      `  ${ui.dim("Found:")}        ${total} repos in ${org}`
    );
    ui.print(`  ${ui.dim("Registered:")}   ${reg}`);
    ui.print(`  ${ui.dim("Unregistered:")} ${result.unregistered.length}`);
    ui.print(`  ${ui.dim("Missing local:")} ${result.missingLocally.length}`);
    ui.blank();

    // Unregistered candidates
    if (result.unregistered.length > 0) {
      ui.print(ui.bold("  Unregistered:"));
      for (const r of result.unregistered) {
        const cloneStatus = r.localPath
          ? ui.green(" (cloned locally)")
          : ui.yellow(" (not cloned)");
        ui.print(`    ${ui.dim("·")} ${r.remote.name}${cloneStatus}`);
        if (r.remote.description) {
          ui.print(`      ${ui.dim(r.remote.description)}`);
        }
        ui.print(`      ${ui.dim("→")} ${ui.cyan(suggestedAddCommand(r, workspaceRoot))}`);
      }
      ui.blank();
    }

    // Missing locally
    if (result.missingLocally.length > 0) {
      ui.print(ui.bold("  Registered but not cloned locally:"));
      for (const r of result.missingLocally) {
        ui.print(`    ${ui.yellow("·")} ${r.remote.name}`);
        ui.print(`      ${ui.dim("→")} ${ui.cyan(`gh repo clone ${org}/${r.remote.name}`)}`);
      }
      ui.blank();
    }

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

export const repoCommand: Command = {
  name: "repo",
  summary: "Manage code repositories registered with this workspace.",
  description:
    "Repositories represent the code your product lives in. They are\n" +
    "sibling directories under the workspace root. Atelier reads from\n" +
    "them and writes specs that reference paths inside them.",
  subcommands: [addCmd, listCmd, removeCmd, discoverCmd],
};
