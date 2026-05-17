import { spawn } from "node:child_process";

/**
 * Git-host adapter layer.
 *
 * Atelier needs to discover what repos exist in a user's organization
 * so it can suggest registrations. We delegate that to whichever host
 * the user is already authenticated against — initially GitHub via the
 * `gh` CLI, later GitLab via `glab`, etc.
 *
 * Each adapter is a thin wrapper around an exec function. The exec
 * function is parameterized so tests can inject a fake without touching
 * the host's auth or network.
 */

export interface RemoteRepoInfo {
  /** The repo's short name (e.g., "api"). */
  name: string;
  /** SSH clone URL (e.g., "git@github.com:org/api.git"). */
  sshUrl: string;
  /** HTTPS clone URL (e.g., "https://github.com/org/api.git"). */
  httpsUrl: string;
  /** Optional human description from the host. */
  description: string | null;
  /** Whether the repo is private. */
  isPrivate: boolean;
}

export type AvailabilityResult =
  | { available: true }
  | { available: false; reason: string };

export interface GitHostAdapter {
  /** Stable identifier for help/error messages. */
  readonly id: string;
  /** Display name for the host (e.g., "GitHub"). */
  readonly displayName: string;
  /** Confirm the adapter's binary is installed and the user is auth'd. */
  checkAvailability(): Promise<AvailabilityResult>;
  /** List all repos in the org the user can see. */
  listOrgRepos(org: string): Promise<RemoteRepoInfo[]>;
}

// ============================================================
// Default child_process-based exec
// ============================================================

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type ExecFn = (command: string, args: string[]) => Promise<ExecResult>;

/**
 * Default exec: spawns a child process, captures stdout/stderr,
 * returns when it exits. No shell interpretation — args are passed verbatim.
 */
export const defaultExec: ExecFn = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      // Most common: ENOENT when the binary isn't installed.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ stdout: "", stderr: err.message, code: 127 });
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => {
      resolve({ stdout, stderr, code: code ?? 0 });
    });
  });

// ============================================================
// GitHub adapter (via the `gh` CLI)
// ============================================================

/**
 * GitHub adapter. Shells out to the user's `gh` CLI, inheriting whatever
 * auth they already set up. This is deliberate — we never see tokens.
 */
export class GhAdapter implements GitHostAdapter {
  readonly id = "gh";
  readonly displayName = "GitHub";

  constructor(private exec: ExecFn = defaultExec) {}

  async checkAvailability(): Promise<AvailabilityResult> {
    const version = await this.exec("gh", ["--version"]);
    if (version.code !== 0) {
      return {
        available: false,
        reason:
          "`gh` CLI not found. Install from https://cli.github.com/ to enable repo discovery.",
      };
    }
    const auth = await this.exec("gh", ["auth", "status"]);
    if (auth.code !== 0) {
      return {
        available: false,
        reason: "`gh` is installed but not authenticated. Run `gh auth login` first.",
      };
    }
    return { available: true };
  }

  async listOrgRepos(org: string): Promise<RemoteRepoInfo[]> {
    // --limit 1000 covers all but the largest orgs; tune if needed.
    const args = [
      "repo",
      "list",
      org,
      "--json",
      "name,description,sshUrl,url,isPrivate",
      "--limit",
      "1000",
    ];
    const result = await this.exec("gh", args);
    if (result.code !== 0) {
      throw new Error(
        `\`gh repo list ${org}\` failed (exit ${result.code}): ${result.stderr.trim()}`
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (err) {
      throw new Error(`Could not parse gh output as JSON: ${(err as Error).message}`);
    }
    if (!Array.isArray(parsed)) {
      throw new Error("Unexpected gh output: expected a JSON array.");
    }
    return parsed.map((entry, idx) => {
      if (typeof entry !== "object" || entry === null) {
        throw new Error(`Unexpected gh output: entry ${idx} is not an object.`);
      }
      const e = entry as Record<string, unknown>;
      const name = typeof e.name === "string" ? e.name : "";
      const sshUrl = typeof e.sshUrl === "string" ? e.sshUrl : "";
      const httpsUrl = typeof e.url === "string" ? e.url : "";
      const description =
        typeof e.description === "string" && e.description.length > 0
          ? e.description
          : null;
      const isPrivate = e.isPrivate === true;
      if (!name) throw new Error(`Unexpected gh output: entry ${idx} missing name.`);
      return { name, sshUrl, httpsUrl, description, isPrivate };
    });
  }
}
