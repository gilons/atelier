#!/usr/bin/env node

import {
  ATELIER_VERSION,
  SecretStore,
  findNearbyWorkspace,
} from "@atelier/core";
import { dispatch, type CommandRegistry } from "./command.js";
import { initCommand } from "./commands/init.js";
import { repoCommand } from "./commands/repo.js";
import { sourceCommand } from "./commands/source.js";
import { featureCommand } from "./commands/feature.js";
import { docCommand } from "./commands/doc.js";
import { discrepancyCommand } from "./commands/discrepancy.js";
import { syncCommand } from "./commands/sync.js";
import { specCommand } from "./commands/spec.js";
import { runRepl } from "./repl.js";

const registry: CommandRegistry = {
  commands: [
    initCommand,
    repoCommand,
    sourceCommand,
    featureCommand,
    docCommand,
    discrepancyCommand,
    syncCommand,
    specCommand,
  ],
};

const argv = process.argv.slice(2);

/**
 * Mode selection:
 *   - With args ("atelier sync", "atelier --help", …) → one-shot CLI
 *     dispatch. Same as before. Scripts + CI use this path.
 *   - No args + interactive stdin → REPL.
 *   - No args + non-interactive stdin (CI, `atelier < commands.txt`) →
 *     fall back to top-level help so we don't dead-air on a script.
 *     The user can still opt into REPL with `atelier --repl` if they
 *     actually want to drive the REPL from a piped script.
 */
const wantRepl =
  argv.length === 0
    ? Boolean(process.stdin.isTTY)
    : argv[0] === "--repl" || argv[0] === "repl";

/**
 * Pull workspace-local secrets out of `.planning/.env` into
 * process.env before dispatching. Explicit shell `export`s still
 * win (SecretStore.loadIntoProcessEnv only writes when the key
 * isn't already set). This makes secrets sticky across runs
 * without forcing the user to source a file in their shell rc —
 * the REPL does the same, this covers the one-shot CLI path.
 */
async function loadWorkspaceSecrets(): Promise<void> {
  try {
    const workspaceRoot = await findNearbyWorkspace(process.cwd());
    if (!workspaceRoot) return;
    await new SecretStore(workspaceRoot).loadIntoProcessEnv();
  } catch {
    /* Best-effort. A malformed .env shouldn't block `atelier --help`. */
  }
}

const startMode = loadWorkspaceSecrets().then(() =>
  wantRepl
    ? runRepl(process.cwd(), registry)
    : dispatch(registry, argv, process.cwd(), ATELIER_VERSION)
);

startMode
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    process.stderr.write(`Fatal: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  });
