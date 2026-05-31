// Bundle the CLI + @atelier/core (+ yaml) into one self-contained ESM
// file for publishing as a single npm package (@gilons/atelier).
//
// Dev keeps the clean two-package monorepo (core is a library, cli
// consumes it); only the *published* artifact is a single bundle with
// zero runtime dependencies. The createRequire banner lets any
// transitive CommonJS `require()` work inside the ESM output.
import { build } from "esbuild";
import { chmodSync } from "node:fs";

const OUT = "dist/atelier.js";

await build({
  entryPoints: ["dist/index.js"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: OUT,
  // node builtins (node:*) stay external automatically on platform:node.
  banner: {
    js: "import { createRequire as ___createRequire } from 'node:module'; const require = ___createRequire(import.meta.url);",
  },
  logLevel: "info",
});

chmodSync(OUT, 0o755);
console.log(`[bundle] ${OUT} built (single self-contained CLI)`);
