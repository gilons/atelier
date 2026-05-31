#!/usr/bin/env node

import { ATELIER_VERSION } from "@atelier/core";
import { dispatch, type CommandRegistry } from "./command.js";
import { initCommand } from "./commands/init.js";
import { repoCommand } from "./commands/repo.js";
import { sourceCommand } from "./commands/source.js";
import { sessionCommand } from "./commands/session.js";
import { featureCommand } from "./commands/feature.js";
import { docCommand } from "./commands/doc.js";
import { ticketCommand } from "./commands/ticket.js";
import { stakeholderCommand } from "./commands/stakeholder.js";
import { agentCommand } from "./commands/agent.js";
import { mapCommand } from "./commands/map.js";
import { designCommand } from "./commands/design.js";
import { discrepancyCommand } from "./commands/discrepancy.js";
import { specCommand } from "./commands/spec.js";
import { runRepl } from "./repl.js";

const registry: CommandRegistry = {
  commands: [
    initCommand,
    repoCommand,
    sourceCommand,
    sessionCommand,
    featureCommand,
    docCommand,
    ticketCommand,
    stakeholderCommand,
    agentCommand,
    mapCommand,
    designCommand,
    discrepancyCommand,
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

// No secret loading anymore — atelier doesn't hold credentials.
// Agents own all source-system auth via MCP / their own integrations.
const startMode = wantRepl
  ? runRepl(process.cwd(), registry)
  : dispatch(registry, argv, process.cwd(), ATELIER_VERSION);

/**
 * Exit only after stdout/stderr have flushed to the OS. `process.exit()`
 * does NOT wait for buffered output on a pipe, so a large response (e.g.
 * `design adapters list --json`) can be truncated when piped to a
 * consumer that isn't draining fast enough. Writing a final empty chunk
 * with a callback resolves once all previously-queued writes flush.
 */
function exitAfterFlush(code: number): void {
  process.exitCode = code;
  let remaining = 2;
  const done = () => {
    if (--remaining === 0) process.exit(code);
  };
  process.stdout.write("", done);
  process.stderr.write("", done);
}

startMode
  .then((code) => {
    exitAfterFlush(code);
  })
  .catch((err) => {
    process.stderr.write(`Fatal: ${(err as Error).stack ?? String(err)}\n`);
    exitAfterFlush(1);
  });
