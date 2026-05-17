import { spawn } from "node:child_process";

/**
 * CLI transport — shells out to a CLI tool the user has installed
 * (e.g. `gh`, `acli`, `m365`) and parses its stdout.
 *
 * Why a shared utility?
 *   - Every CLI-backed adapter needs the same plumbing: subprocess
 *     spawn, stdin/stdout/stderr capture, exit-code handling, JSON
 *     parsing with a useful error when the output isn't JSON.
 *   - The `spawn` impl is injectable so tests can stub without running
 *     real binaries.
 *
 * Design note: we deliberately don't shell-interpret the command;
 * args are passed verbatim. That keeps adapters free of escaping
 * concerns and avoids shell-injection footguns.
 */

export interface CliRunnerOptions {
  /** Path or name of the binary to invoke (e.g. `gh`). */
  command: string;
  /** Default arguments prepended to every call (e.g. `["--no-color"]`). */
  defaultArgs?: string[];
  /** Default environment variables (merged with `process.env`). */
  env?: Record<string, string>;
  /** Working directory for the subprocess. Defaults to inherited. */
  cwd?: string;
  /**
   * Injected spawn function. Tests pass a stub returning canned
   * stdout/stderr. Production passes nothing.
   */
  spawnImpl?: SpawnLike;
  /** Per-invocation timeout in ms. Defaults to 30s. */
  timeoutMs?: number;
}

export type SpawnLike = (
  command: string,
  args: string[],
  opts: { env?: Record<string, string>; cwd?: string }
) => Promise<{ stdout: string; stderr: string; code: number }>;

export class CliError extends Error {
  constructor(
    public readonly command: string,
    public readonly args: string[],
    public readonly code: number,
    public readonly stderr: string
  ) {
    const cmd = [command, ...args].join(" ");
    const tail = stderr.trim().split("\n").slice(-3).join("\n");
    super(`\`${cmd}\` exited with code ${code}${tail ? `\n${tail}` : ""}`);
    this.name = "CliError";
  }
}

const defaultSpawn: SpawnLike = (command, args, opts) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: opts.env,
      cwd: opts.cwd,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({
          stdout: "",
          stderr: `command not found: ${command}`,
          code: 127,
        });
      } else {
        reject(err);
      }
    });
    child.on("close", (code) => resolve({ stdout, stderr, code: code ?? 0 }));
  });

export interface CliRunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export class CliRunner {
  private readonly spawnImpl: SpawnLike;

  constructor(private readonly opts: CliRunnerOptions) {
    this.spawnImpl = opts.spawnImpl ?? defaultSpawn;
  }

  /**
   * Run the binary, returning the raw stdout/stderr/code. Non-zero
   * exit throws `CliError`.
   */
  async run(args: string[]): Promise<CliRunResult> {
    const finalArgs = [...(this.opts.defaultArgs ?? []), ...args];
    const env = { ...process.env, ...(this.opts.env ?? {}) } as Record<string, string>;
    const result = await this.spawnImpl(this.opts.command, finalArgs, {
      env,
      cwd: this.opts.cwd,
    });
    if (result.code !== 0) {
      throw new CliError(this.opts.command, finalArgs, result.code, result.stderr);
    }
    return result;
  }

  /** Run + parse stdout as JSON. Throws if the output isn't JSON. */
  async json<T = unknown>(args: string[]): Promise<T> {
    const result = await this.run(args);
    try {
      return JSON.parse(result.stdout) as T;
    } catch (err) {
      throw new Error(
        `\`${this.opts.command} ${args.join(" ")}\` stdout was not valid JSON: ${(err as Error).message}`
      );
    }
  }

  /** Probe `command --version`. Used by adapter availability checks. */
  async checkAvailable(): Promise<{ available: true } | { available: false; reason: string }> {
    try {
      await this.run(["--version"]);
      return { available: true };
    } catch (err) {
      return { available: false, reason: (err as Error).message };
    }
  }
}
