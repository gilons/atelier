#!/usr/bin/env node
/**
 * Test fixture used as $EDITOR in REPL tests.
 *
 * Real editors block until the user saves and quits. We simulate
 * that by reading a payload from $ATELIER_FAKE_EDITOR_CONTENT (or
 * a default), writing it into the file path passed as argv[2],
 * and exiting 0. atelier reads the file when we exit.
 *
 * The path comes in as the last positional argument — matches
 * how vim / nano / code -w all receive it.
 */
import * as fs from "node:fs/promises";

const target = process.argv[process.argv.length - 1];
if (!target) {
  console.error("fake-editor: no target file passed");
  process.exit(2);
}
const content =
  process.env.ATELIER_FAKE_EDITOR_CONTENT ??
  "# Test Doc\n\nManual content written by the fake editor.\n";
await fs.writeFile(target, content, "utf8");
process.exit(0);
