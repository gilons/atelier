#!/usr/bin/env node

import { ATELIER_VERSION } from "@atelier/core";
import { dispatch, type CommandRegistry } from "./command.js";
import { initCommand } from "./commands/init.js";
import { repoCommand } from "./commands/repo.js";
import { sourceCommand } from "./commands/source.js";
import { featureCommand } from "./commands/feature.js";
import { docCommand } from "./commands/doc.js";
import { discrepancyCommand } from "./commands/discrepancy.js";
import { syncCommand } from "./commands/sync.js";
import { specCommand } from "./commands/spec.js";

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

dispatch(registry, argv, process.cwd(), ATELIER_VERSION)
  .then((code) => {
    process.exit(code);
  })
  .catch((err) => {
    process.stderr.write(`Fatal: ${(err as Error).stack ?? String(err)}\n`);
    process.exit(1);
  });
