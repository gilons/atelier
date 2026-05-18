import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  addSource,
  loadSourcesConfig,
  resolveDocUrlCandidates,
  addDocByUrl,
  NoMatchingSourceError,
  UnsupportedDocUrlError,
} from "../dist/index.js";

/**
 * Tests for the URL-driven `/doc add <url>` flow. We're verifying the
 * core helper (`addDocByUrl` + `resolveDocUrlCandidates`) here — pure
 * unit tests over the scope-mutation logic. The opaque-share branch
 * is the only one that needs network; for that case we'd need to
 * inject a fetch override into resolveOpaqueShareUrl, which the
 * current public API doesn't expose, so we cover the easy cases
 * (direct file/folder URLs and GitHub discussion URLs) here and
 * leave opaque-share to a future integration test.
 */

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-docadd-test-"));
  await initWorkspace(root, { name: "Test" });
  return root;
}

// ============================================================
// classification / candidates
// ============================================================

test("resolveDocUrlCandidates rejects an empty URL", async () => {
  const root = await workspace();
  await assert.rejects(
    () => resolveDocUrlCandidates(root, "   "),
    UnsupportedDocUrlError
  );
});

test("resolveDocUrlCandidates rejects an unknown URL shape", async () => {
  const root = await workspace();
  await assert.rejects(
    () => resolveDocUrlCandidates(root, "https://example.com/whatever"),
    /Couldn't classify/
  );
});

test("resolveDocUrlCandidates: SharePoint URL with no matching source raises NoMatchingSourceError", async () => {
  const root = await workspace();
  await assert.rejects(
    () =>
      resolveDocUrlCandidates(
        root,
        "https://contoso.sharepoint.com/sites/Marketing/Shared%20Documents/spec.docx"
      ),
    NoMatchingSourceError
  );
});

test("resolveDocUrlCandidates: -my.sharepoint.com URL matches a source registered for the base tenant hostname", async () => {
  // SharePoint splits one Azure tenant across two hostnames:
  //   <tenant>.sharepoint.com     → team / org sites
  //   <tenant>-my.sharepoint.com  → personal OneDrive
  // Both use the same Azure AD tenant and the same Graph
  // credentials, so a user who onboarded the org host should be
  // able to /doc add a OneDrive URL without re-onboarding.
  const root = await workspace();
  await addSource(root, {
    kind: "sharepoint",
    id: "org",
    name: "Org SP",
    credentials: { envVar: "TOK" },
    scope: { hostname: "contoso.sharepoint.com", pins: [] },
  });
  const r = await resolveDocUrlCandidates(
    root,
    "https://contoso-my.sharepoint.com/personal/alice_contoso/Documents/spec.docx"
  );
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].id, "org");
});

test("resolveDocUrlCandidates: base hostname URL matches a source registered for -my", async () => {
  // The same equivalence in reverse — a user who happened to
  // onboard their OneDrive host first should still be able to
  // /doc add an org-site URL.
  const root = await workspace();
  await addSource(root, {
    kind: "sharepoint",
    id: "personal",
    name: "Personal OneDrive",
    credentials: { envVar: "TOK" },
    scope: { hostname: "contoso-my.sharepoint.com", pins: [] },
  });
  const r = await resolveDocUrlCandidates(
    root,
    "https://contoso.sharepoint.com/sites/Marketing/Shared%20Documents/spec.docx"
  );
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].id, "personal");
});

test("resolveDocUrlCandidates: different tenant hostnames do NOT cross-match", async () => {
  // Tenant-equivalence should NOT make "contoso" match "acme" —
  // those are real different organizations with different
  // credentials, even though both end in .sharepoint.com.
  const root = await workspace();
  await addSource(root, {
    kind: "sharepoint",
    id: "contoso",
    name: "Contoso",
    credentials: { envVar: "TOK" },
    scope: { hostname: "contoso.sharepoint.com", pins: [] },
  });
  await assert.rejects(
    () =>
      resolveDocUrlCandidates(
        root,
        "https://acme.sharepoint.com/sites/Marketing/Shared%20Documents/spec.docx"
      ),
    NoMatchingSourceError
  );
});

test("resolveDocUrlCandidates: SharePoint URL matches the right tenant by hostname", async () => {
  const root = await workspace();
  // Two SP sources on different tenants — only the hostname-matching one wins.
  await addSource(root, {
    kind: "sharepoint",
    id: "contoso-sp",
    name: "Contoso",
    credentials: { envVar: "TOK" },
    scope: { hostname: "contoso.sharepoint.com", pins: [] },
  });
  await addSource(root, {
    kind: "sharepoint",
    id: "acme-sp",
    name: "Acme",
    credentials: { envVar: "TOK2" },
    scope: { hostname: "acme.sharepoint.com", pins: [] },
  });
  const r = await resolveDocUrlCandidates(
    root,
    "https://contoso.sharepoint.com/sites/Marketing/Shared%20Documents/spec.docx"
  );
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].id, "contoso-sp");
  assert.equal(r.classified.kind, "sharepoint");
});

test("resolveDocUrlCandidates rejects a SharePoint site root URL", async () => {
  const root = await workspace();
  await addSource(root, {
    kind: "sharepoint",
    id: "sp",
    name: "SP",
    credentials: { envVar: "TOK" },
    scope: { hostname: "contoso.sharepoint.com", pins: [] },
  });
  await assert.rejects(
    () =>
      resolveDocUrlCandidates(root, "https://contoso.sharepoint.com/sites/Marketing"),
    /points at a SharePoint site/
  );
});

test("resolveDocUrlCandidates rejects a SharePoint library root URL", async () => {
  const root = await workspace();
  await addSource(root, {
    kind: "sharepoint",
    id: "sp",
    name: "SP",
    credentials: { envVar: "TOK" },
    scope: { hostname: "contoso.sharepoint.com", pins: [] },
  });
  await assert.rejects(
    () =>
      resolveDocUrlCandidates(
        root,
        "https://contoso.sharepoint.com/sites/Marketing/Shared%20Documents"
      ),
    /library root/
  );
});

test("resolveDocUrlCandidates: GitHub Discussion URL prefers a source whose scope.repos already includes the repo", async () => {
  const root = await workspace();
  await addSource(root, {
    kind: "github-discussions",
    id: "company",
    name: "Company GH",
    transport: "cli",
    scope: { repos: ["other-org/repo"] },
  });
  await addSource(root, {
    kind: "github-discussions",
    id: "personal",
    name: "Personal GH",
    transport: "cli",
    scope: { repos: ["my-org/my-repo"] },
  });
  const r = await resolveDocUrlCandidates(
    root,
    "https://github.com/my-org/my-repo/discussions/42"
  );
  assert.equal(r.candidates.length, 1);
  assert.equal(r.candidates[0].id, "personal");
});

// ============================================================
// addDocByUrl — SharePoint file URL
// ============================================================

test("addDocByUrl: SharePoint file URL appends a file pin", async () => {
  const root = await workspace();
  const source = await addSource(root, {
    kind: "sharepoint",
    id: "sp",
    name: "SP",
    credentials: { envVar: "TOK" },
    scope: { hostname: "contoso.sharepoint.com", pins: [] },
  });
  const result = await addDocByUrl(
    root,
    "https://contoso.sharepoint.com/sites/Marketing/Shared%20Documents/Q3/spec.docx",
    { source, runSync: false }
  );
  assert.equal(result.alreadyPinned, false);

  // Re-load from disk to verify persistence.
  const cfg = await loadSourcesConfig(root);
  const persisted = cfg.sources[0];
  assert.equal(persisted.scope.pins.length, 1);
  const pin = persisted.scope.pins[0];
  assert.equal(pin.kind, "file");
  assert.equal(pin.sitePath, "/sites/Marketing");
  assert.equal(pin.driveName, undefined); // "Shared Documents" normalizes to default
  assert.equal(pin.itemPath, "/Q3/spec.docx");
});

test("addDocByUrl: SharePoint folder URL appends a recursive folder pin", async () => {
  const root = await workspace();
  const source = await addSource(root, {
    kind: "sharepoint",
    id: "sp",
    name: "SP",
    credentials: { envVar: "TOK" },
    scope: { hostname: "contoso.sharepoint.com", pins: [] },
  });
  await addDocByUrl(
    root,
    "https://contoso.sharepoint.com/sites/Marketing/Shared%20Documents/Q3-Plans",
    { source, runSync: false }
  );
  const cfg = await loadSourcesConfig(root);
  const pin = cfg.sources[0].scope.pins[0];
  assert.equal(pin.kind, "folder");
  assert.equal(pin.folderPath, "/Q3-Plans");
  assert.equal(pin.recursive, true);
});

test("addDocByUrl: duplicate SharePoint file URL is detected and skipped", async () => {
  const root = await workspace();
  const source = await addSource(root, {
    kind: "sharepoint",
    id: "sp",
    name: "SP",
    credentials: { envVar: "TOK" },
    scope: { hostname: "contoso.sharepoint.com", pins: [] },
  });
  const url =
    "https://contoso.sharepoint.com/sites/Marketing/Shared%20Documents/Q3/spec.docx";
  const first = await addDocByUrl(root, url, { source, runSync: false });
  assert.equal(first.alreadyPinned, false);
  // Need to re-read the source — `source` is the now-stale snapshot.
  const cfg1 = await loadSourcesConfig(root);
  const second = await addDocByUrl(root, url, {
    source: cfg1.sources[0],
    runSync: false,
  });
  assert.equal(second.alreadyPinned, true);
  const cfg = await loadSourcesConfig(root);
  assert.equal(cfg.sources[0].scope.pins.length, 1);
});

// ============================================================
// addDocByUrl — GitHub Discussions
// ============================================================

test("addDocByUrl: GitHub Discussion URL appends to scope.discussionIds + scope.repos", async () => {
  const root = await workspace();
  const source = await addSource(root, {
    kind: "github-discussions",
    id: "gh",
    name: "GH",
    transport: "cli",
    scope: { repos: ["other-org/other-repo"] },
  });
  const result = await addDocByUrl(
    root,
    "https://github.com/my-org/my-repo/discussions/42",
    { source, runSync: false }
  );
  assert.equal(result.alreadyPinned, false);
  assert.equal(result.docId, "my-org/my-repo#42");

  const cfg = await loadSourcesConfig(root);
  const scope = cfg.sources[0].scope;
  assert.deepEqual(scope.repos, ["other-org/other-repo", "my-org/my-repo"]);
  assert.deepEqual(scope.discussionIds, ["my-org/my-repo#42"]);
});

test("addDocByUrl: GitHub Discussion already covered by a full-repo source is a no-op", async () => {
  const root = await workspace();
  // Source covers the entire my-org/my-repo (no discussionIds whitelist).
  const source = await addSource(root, {
    kind: "github-discussions",
    id: "gh",
    name: "GH",
    transport: "cli",
    scope: { repos: ["my-org/my-repo"] },
  });
  const result = await addDocByUrl(
    root,
    "https://github.com/my-org/my-repo/discussions/42",
    { source, runSync: false }
  );
  // Not "already pinned" (the docId wasn't whitelisted), but adding
  // it would NARROW the source's subscription — so we leave the
  // scope alone. The discussion will land on the next sync because
  // the repo is already in scope.
  const cfg = await loadSourcesConfig(root);
  assert.equal(cfg.sources[0].scope.discussionIds, undefined);
  assert.equal(result.docId, "my-org/my-repo#42");
});
