import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolveSharePointLink,
  encodeShareUrlForGraph,
  InvalidSharePointUrlError,
} from "../dist/index.js";

// ============================================================
// Each URL shape that's documented in sharepoint-resolve.ts gets
// a dedicated test. If SharePoint adds a new variant, add a case
// here and watch this suite go red until the resolver knows it.
// ============================================================

test("resolveSharePointLink: tenant root site", () => {
  const r = resolveSharePointLink("https://contoso.sharepoint.com/");
  assert.deepEqual(r, {
    kind: "site",
    hostname: "contoso.sharepoint.com",
    sitePath: "/",
  });
});

test("resolveSharePointLink: team site", () => {
  const r = resolveSharePointLink(
    "https://contoso.sharepoint.com/sites/Marketing"
  );
  assert.deepEqual(r, {
    kind: "site",
    hostname: "contoso.sharepoint.com",
    sitePath: "/sites/Marketing",
  });
});

test("resolveSharePointLink: team site with trailing slash", () => {
  const r = resolveSharePointLink(
    "https://contoso.sharepoint.com/sites/Marketing/"
  );
  assert.equal(r.kind, "site");
  assert.equal(r.sitePath, "/sites/Marketing");
});

test("resolveSharePointLink: Teams-channel-backed site (/teams/)", () => {
  const r = resolveSharePointLink(
    "https://contoso.sharepoint.com/teams/Engineering"
  );
  assert.equal(r.kind, "site");
  assert.equal(r.sitePath, "/teams/Engineering");
});

test("resolveSharePointLink: default library normalizes to undefined driveName", () => {
  const r = resolveSharePointLink(
    "https://contoso.sharepoint.com/sites/Marketing/Shared%20Documents"
  );
  assert.equal(r.kind, "library");
  assert.equal(r.driveName, undefined);
  assert.equal(r.sitePath, "/sites/Marketing");
});

test("resolveSharePointLink: custom library keeps its name", () => {
  const r = resolveSharePointLink(
    "https://contoso.sharepoint.com/sites/Marketing/SitePages"
  );
  assert.equal(r.kind, "library");
  assert.equal(r.driveName, "SitePages");
});

test("resolveSharePointLink: folder in default library", () => {
  const r = resolveSharePointLink(
    "https://contoso.sharepoint.com/sites/Marketing/Shared%20Documents/Q3-Plans"
  );
  assert.equal(r.kind, "folder");
  assert.equal(r.hostname, "contoso.sharepoint.com");
  assert.equal(r.sitePath, "/sites/Marketing");
  assert.equal(r.driveName, undefined);
  assert.equal(r.folderPath, "/Q3-Plans");
});

test("resolveSharePointLink: nested folder", () => {
  const r = resolveSharePointLink(
    "https://contoso.sharepoint.com/sites/Marketing/Shared%20Documents/Plans/Q3/Drafts"
  );
  assert.equal(r.kind, "folder");
  assert.equal(r.folderPath, "/Plans/Q3/Drafts");
});

test("resolveSharePointLink: single file", () => {
  const r = resolveSharePointLink(
    "https://contoso.sharepoint.com/sites/Marketing/Shared%20Documents/Q3-Plans/spec.docx"
  );
  assert.equal(r.kind, "file");
  assert.equal(r.sitePath, "/sites/Marketing");
  assert.equal(r.driveName, undefined);
  assert.equal(r.itemPath, "/Q3-Plans/spec.docx");
});

test("resolveSharePointLink: personal OneDrive site", () => {
  const r = resolveSharePointLink(
    "https://contoso-my.sharepoint.com/personal/giles_contoso_io"
  );
  assert.equal(r.kind, "site");
  assert.equal(r.hostname, "contoso-my.sharepoint.com");
  assert.equal(r.sitePath, "/personal/giles_contoso_io");
});

test("resolveSharePointLink: personal OneDrive file", () => {
  const r = resolveSharePointLink(
    "https://contoso-my.sharepoint.com/personal/giles_contoso_io/Documents/Specs/spec.docx"
  );
  assert.equal(r.kind, "file");
  assert.equal(r.sitePath, "/personal/giles_contoso_io");
  // "Documents" is the personal OneDrive default library.
  assert.equal(r.driveName, undefined);
  assert.equal(r.itemPath, "/Specs/spec.docx");
});

test("resolveSharePointLink: transparent /r/ share link unwraps to the same canonical pin", () => {
  // Both forms point at the same underlying folder.
  const direct = resolveSharePointLink(
    "https://contoso.sharepoint.com/sites/Marketing/Shared%20Documents/Q3-Plans"
  );
  const sharedR = resolveSharePointLink(
    "https://contoso.sharepoint.com/:f:/r/sites/Marketing/Shared%20Documents/Q3-Plans?csf=1&web=1"
  );
  assert.deepEqual(sharedR, direct);
});

test("resolveSharePointLink: opaque /s/ tokenized share is surfaced as opaqueShare", () => {
  const url =
    "https://contoso.sharepoint.com/:f:/s/Marketing/Eabc123def456?e=xyz";
  const r = resolveSharePointLink(url);
  assert.equal(r.kind, "opaqueShare");
  assert.equal(r.hostname, "contoso.sharepoint.com");
  assert.equal(r.url, url);
});

test("resolveSharePointLink: non-SharePoint URL throws", () => {
  assert.throws(
    () => resolveSharePointLink("https://example.com/Shared%20Documents/spec"),
    InvalidSharePointUrlError
  );
});

test("resolveSharePointLink: garbage input throws InvalidSharePointUrlError", () => {
  assert.throws(
    () => resolveSharePointLink("not a url"),
    InvalidSharePointUrlError
  );
});

test("resolveSharePointLink: querystring and fragment are stripped", () => {
  const r = resolveSharePointLink(
    "https://contoso.sharepoint.com/sites/Marketing/Shared%20Documents/Q3?csf=1&web=1#section"
  );
  assert.equal(r.kind, "folder");
  assert.equal(r.folderPath, "/Q3");
});

test("resolveSharePointLink: Doc.aspx viewer URL routes through opaqueShare", () => {
  // Word/Excel/PowerPoint Online generates URLs of the form
  // .../_layouts/15/Doc.aspx?sourcedoc={GUID}&file=... when the
  // user copies a "share / get link" from inside the editor. The
  // path points at the viewer shim, not at the actual document;
  // the file identity is in the `sourcedoc` query param. Graph's
  // /shares endpoint can resolve the whole URL into a real
  // driveItem — so we surface it as opaqueShare and let the
  // caller take that route.
  const url =
    "https://dinolabgmbh-my.sharepoint.com/:w:/r/personal/stephan_dino-lab_io/" +
    "_layouts/15/Doc.aspx?sourcedoc=%7BAAAA89C6-5728-42FE-AE9A-1C6F5F3EC960%7D" +
    "&file=Cloud%20Services%20Vertrag%20(SaaS)%202.0.docx";
  const r = resolveSharePointLink(url);
  assert.equal(r.kind, "opaqueShare");
  assert.equal(r.hostname, "dinolabgmbh-my.sharepoint.com");
  assert.equal(r.url, url);
});

test("resolveSharePointLink: bare _layouts URL routes through opaqueShare", () => {
  const url =
    "https://contoso.sharepoint.com/sites/Marketing/_layouts/15/start.aspx";
  const r = resolveSharePointLink(url);
  assert.equal(r.kind, "opaqueShare");
});

// ============================================================
// encodeShareUrlForGraph — Microsoft's `u!{b64url}` share-url
// encoding. Spec: https://learn.microsoft.com/graph/api/shares-get
// ============================================================

test("encodeShareUrlForGraph: produces u!{b64url} form", () => {
  // Example from Microsoft Learn docs.
  const url =
    "https://contoso.sharepoint.com/:f:/g/personal/giles/EXAMPLE_SHARED_LINK";
  const encoded = encodeShareUrlForGraph(url);
  assert.match(encoded, /^u!/);
  // No padding, no `/`, no `+`.
  assert.doesNotMatch(encoded, /[=/+]/);
});

test("encodeShareUrlForGraph: round-trips for a basic ASCII URL", () => {
  const url = "https://example.com/path/to/something";
  const encoded = encodeShareUrlForGraph(url);
  const b64 = encoded.slice(2).replace(/-/g, "+").replace(/_/g, "/");
  // Re-pad to a multiple of 4
  const pad = b64.length % 4 === 0 ? "" : "=".repeat(4 - (b64.length % 4));
  const decoded = Buffer.from(b64 + pad, "base64").toString("utf8");
  assert.equal(decoded, url);
});
