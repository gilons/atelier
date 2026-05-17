#!/usr/bin/env node
// Fake `gh` for CLI tests. Behavior controlled via env vars so each test
// can inject different responses without rewriting the binary.
//
//   ATELIER_FAKE_GH_AVAILABLE     "1" → version+auth succeed (default), "0" → version fails
//   ATELIER_FAKE_GH_AUTHED        "1" → auth status succeeds (default), "0" → fails
//   ATELIER_FAKE_GH_REPOS_JSON    JSON array string returned by `gh repo list`
//   ATELIER_FAKE_GH_LIST_FAIL     "1" → `gh repo list` exits non-zero

const args = process.argv.slice(2);
const available = (process.env.ATELIER_FAKE_GH_AVAILABLE ?? "1") === "1";
const authed = (process.env.ATELIER_FAKE_GH_AUTHED ?? "1") === "1";
const listFail = process.env.ATELIER_FAKE_GH_LIST_FAIL === "1";
const reposJson = process.env.ATELIER_FAKE_GH_REPOS_JSON ?? "[]";

if (args[0] === "--version") {
  if (!available) {
    process.stderr.write("fake-gh: not installed\n");
    process.exit(127);
  }
  process.stdout.write("gh version 2.40.0 (fake)\n");
  process.exit(0);
}

if (args[0] === "auth" && args[1] === "status") {
  if (!authed) {
    process.stderr.write("fake-gh: not authenticated\n");
    process.exit(1);
  }
  process.stdout.write("Logged in to github.com\n");
  process.exit(0);
}

if (args[0] === "repo" && args[1] === "list") {
  if (listFail) {
    process.stderr.write("fake-gh: API rate limit exceeded\n");
    process.exit(1);
  }
  process.stdout.write(reposJson);
  process.exit(0);
}

process.stderr.write(`fake-gh: unsupported args: ${args.join(" ")}\n`);
process.exit(2);
