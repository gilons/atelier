import { test } from "node:test";
import assert from "node:assert/strict";
import * as zlib from "node:zlib";
import {
  SharePointAdapter,
  sharepointOnboarding,
  renderVttAsMarkdown,
} from "../dist/index.js";

/** Build a one-entry ZIP (a minimal .docx) for adapter test fixtures. */
function buildMiniDocx(documentXml) {
  const name = "word/document.xml";
  const nameBuf = Buffer.from(name, "utf8");
  const uncompressed = Buffer.from(documentXml, "utf8");
  const compressed = zlib.deflateRawSync(uncompressed);
  const lfh = Buffer.alloc(30);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt16LE(0, 6);
  lfh.writeUInt16LE(8, 8); // deflate
  lfh.writeUInt16LE(0, 10);
  lfh.writeUInt16LE(0, 12);
  lfh.writeUInt32LE(0, 14);
  lfh.writeUInt32LE(compressed.length, 18);
  lfh.writeUInt32LE(uncompressed.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  lfh.writeUInt16LE(0, 28);
  return Buffer.concat([lfh, nameBuf, compressed]);
}

/**
 * Build a matcher-based fetch impl. Each matcher inspects the URL +
 * init and returns a Response when it claims the request; throws if
 * nothing matches (forces tests to be exhaustive).
 */
function spFetch(matchers) {
  return async (url, init) => {
    for (const m of matchers) {
      const resp = await m(url, init ?? {});
      if (resp !== undefined) return resp;
    }
    throw new Error(`No matcher for ${init?.method ?? "GET"} ${url}`);
  };
}

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function text(status, body, contentType = "text/plain") {
  return new Response(body, {
    status,
    headers: { "Content-Type": contentType },
  });
}

const SITE_ID = "contoso.sharepoint.com,site-guid,web-guid";
const DRIVE_ID = "drive-id-1";

function siteAndDriveMatchers() {
  return [
    async (url, init) => {
      // Site resolution by `hostname:path:`
      if (url.endsWith("/sites/contoso.sharepoint.com:/sites/marketing")) {
        assert.equal(init.headers?.Authorization, "Bearer test-token");
        return json(200, { id: SITE_ID, displayName: "Marketing" });
      }
    },
    async (url) => {
      if (url.endsWith(`/sites/${SITE_ID}/drive`)) {
        return json(200, { id: DRIVE_ID, name: "Documents" });
      }
    },
  ];
}

// ============================================================
// listDocs
// ============================================================

test("SharePointAdapter.listDocs walks the drive root and filters by extension", async () => {
  const fetchImpl = spFetch([
    ...siteAndDriveMatchers(),
    async (url) => {
      if (url.endsWith(`/drives/${DRIVE_ID}/root/children`)) {
        return json(200, {
          value: [
            {
              id: "item-vtt",
              name: "standup.vtt",
              webUrl: "https://contoso.sharepoint.com/standup.vtt",
              lastModifiedDateTime: "2026-05-17T12:00:00Z",
              file: { mimeType: "text/vtt" },
            },
            {
              id: "item-docx",
              name: "Strategy.docx",
              webUrl: "https://contoso.sharepoint.com/Strategy.docx",
              file: { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
            },
            {
              id: "item-jpg",
              name: "logo.jpg",
              file: { mimeType: "image/jpeg" },
            },
            {
              id: "folder-1",
              name: "Recordings",
              folder: { childCount: 0 },
            },
          ],
        });
      }
    },
    async (url) => {
      // The recursive walk into "Recordings" returns nothing in this test.
      if (url.includes(`/drives/${DRIVE_ID}/root:/Recordings:/children`)) {
        return json(200, { value: [] });
      }
    },
  ]);
  const adapter = new SharePointAdapter({
    token: "test-token",
    scope: { hostname: "contoso.sharepoint.com", sitePath: "/sites/marketing" },
    fetchImpl,
  });
  const docs = await adapter.listDocs();
  // .vtt and .docx kept; .jpg dropped (not in default extensions).
  assert.equal(docs.length, 2);
  // docId is now `${driveId}::${itemId}` so the adapter can fetch
  // by item even when a source spans multiple drives.
  const vtt = docs.find((d) => d.docId === `${DRIVE_ID}::item-vtt`);
  const docx = docs.find((d) => d.docId === `${DRIVE_ID}::item-docx`);
  assert.equal(vtt.title, "standup");
  assert.equal(vtt.classification, "transcript");
  assert.equal(docx.title, "Strategy");
});

test("SharePointAdapter.listDocs honors scope.folderPath", async () => {
  const fetchImpl = spFetch([
    ...siteAndDriveMatchers(),
    async (url) => {
      if (url.includes(`/drives/${DRIVE_ID}/root:/Recordings:/children`)) {
        return json(200, {
          value: [
            {
              id: "rec-1",
              name: "Monday-standup.vtt",
              file: { mimeType: "text/vtt" },
            },
          ],
        });
      }
    },
  ]);
  const adapter = new SharePointAdapter({
    token: "test-token",
    scope: {
      hostname: "contoso.sharepoint.com",
      sitePath: "/sites/marketing",
      folderPath: "/Recordings",
      recursive: false,
    },
    fetchImpl,
  });
  const docs = await adapter.listDocs();
  assert.equal(docs.length, 1);
  assert.equal(docs[0].docId, `${DRIVE_ID}::rec-1`);
});

test("SharePointAdapter.listDocs paginates via @odata.nextLink", async () => {
  let page = 0;
  const fetchImpl = spFetch([
    ...siteAndDriveMatchers(),
    async (url) => {
      if (url.endsWith(`/drives/${DRIVE_ID}/root/children`)) {
        page++;
        if (page === 1) {
          return json(200, {
            value: [
              {
                id: "a",
                name: "a.docx",
                file: { mimeType: "x" },
              },
            ],
            "@odata.nextLink": `https://graph.microsoft.com/v1.0/drives/${DRIVE_ID}/root/children?$skiptoken=abc`,
          });
        }
      }
      if (url.includes("$skiptoken=abc")) {
        return json(200, {
          value: [
            {
              id: "b",
              name: "b.docx",
              file: { mimeType: "x" },
            },
          ],
        });
      }
    },
  ]);
  const adapter = new SharePointAdapter({
    token: "test-token",
    scope: { hostname: "contoso.sharepoint.com", sitePath: "/sites/marketing" },
    fetchImpl,
  });
  const docs = await adapter.listDocs();
  assert.equal(docs.length, 2);
});

test("SharePointAdapter.listDocs respects maxItems cap", async () => {
  let calls = 0;
  const fetchImpl = spFetch([
    ...siteAndDriveMatchers(),
    async (url) => {
      if (url.includes("/children")) {
        calls++;
        const items = Array.from({ length: 5 }, (_, i) => ({
          id: `item-${calls}-${i}`,
          name: `${calls}-${i}.docx`,
          file: { mimeType: "x" },
        }));
        return json(200, { value: items });
      }
    },
  ]);
  const adapter = new SharePointAdapter({
    token: "test-token",
    scope: {
      hostname: "contoso.sharepoint.com",
      sitePath: "/sites/marketing",
      maxItems: 3,
    },
    fetchImpl,
  });
  const docs = await adapter.listDocs();
  assert.equal(docs.length, 3);
});

// ============================================================
// fetchDoc
// ============================================================

test("SharePointAdapter.fetchDoc decodes .vtt content into speaker-grouped markdown", async () => {
  const vttBody = [
    "WEBVTT",
    "",
    "00:00:01.000 --> 00:00:04.000",
    "<v Alice>Hi everyone, thanks for joining.</v>",
    "",
    "00:00:05.000 --> 00:00:09.000",
    "<v Alice>Today we'll talk about the roadmap.</v>",
    "",
    "00:00:10.000 --> 00:00:13.000",
    "<v Bob>Sounds great.</v>",
    "",
  ].join("\n");
  const fetchImpl = spFetch([
    ...siteAndDriveMatchers(),
    async (url) => {
      if (url.endsWith(`/drives/${DRIVE_ID}/items/item-vtt`)) {
        return json(200, {
          id: "item-vtt",
          name: "standup.vtt",
          webUrl: "https://contoso.sharepoint.com/standup.vtt",
          file: { mimeType: "text/vtt" },
        });
      }
      if (url.endsWith(`/drives/${DRIVE_ID}/items/item-vtt/content`)) {
        return text(200, vttBody);
      }
    },
  ]);
  const adapter = new SharePointAdapter({
    token: "test-token",
    scope: { hostname: "contoso.sharepoint.com", sitePath: "/sites/marketing" },
    fetchImpl,
  });
  const fetched = await adapter.fetchDoc(`${DRIVE_ID}::item-vtt`);
  assert.equal(fetched.title, "standup");
  assert.equal(fetched.classification, "transcript");
  assert.match(fetched.body, /^# standup/);
  // Speakers merged across consecutive cues.
  assert.match(fetched.body, /\*\*Alice:\*\* Hi everyone.*roadmap\./);
  assert.match(fetched.body, /\*\*Bob:\*\* Sounds great\./);
});

test("SharePointAdapter.fetchDoc extracts text from .docx binary (no Graph format-conversion)", async () => {
  // Graph's `?format=text/plain` returns 406 for everything we
  // tried it on, so we now download the raw .docx bytes and parse
  // them ourselves. This test asserts (a) we fetch the raw content
  // endpoint, NOT the deprecated format-convert one, and (b) the
  // extracted text matches the document's actual content.
  const documentXml = `<?xml version="1.0" encoding="UTF-8"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Cloud Services Contract</w:t></w:r></w:p>
    <w:p><w:r><w:t>Section 1 of the agreement.</w:t></w:r></w:p>
  </w:body>
</w:document>`;
  const docxBin = buildMiniDocx(documentXml);
  let rawFetchHit = false;
  let formatConvertHit = false;
  const fetchImpl = spFetch([
    ...siteAndDriveMatchers(),
    async (url) => {
      if (url.endsWith(`/drives/${DRIVE_ID}/items/item-docx`)) {
        return json(200, {
          id: "item-docx",
          name: "Strategy.docx",
          webUrl: "https://contoso.sharepoint.com/Strategy.docx",
        });
      }
      if (url.includes("format=text/plain")) {
        formatConvertHit = true;
        // Surface the bug if we ever regress back to this path.
        return new Response("nope", { status: 406, statusText: "Not Acceptable" });
      }
      if (url.endsWith(`/drives/${DRIVE_ID}/items/item-docx/content`)) {
        rawFetchHit = true;
        return new Response(docxBin, {
          status: 200,
          headers: { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
        });
      }
    },
  ]);
  const adapter = new SharePointAdapter({
    token: "test-token",
    scope: { hostname: "contoso.sharepoint.com", sitePath: "/sites/marketing" },
    fetchImpl,
  });
  const fetched = await adapter.fetchDoc(`${DRIVE_ID}::item-docx`);
  assert.equal(rawFetchHit, true, "should hit the raw binary content endpoint");
  assert.equal(formatConvertHit, false, "should NOT use ?format=text/plain anymore");
  assert.equal(
    fetched.body,
    "Cloud Services Contract\nSection 1 of the agreement."
  );
});

test("SharePointAdapter.fetchDoc falls back gracefully for unsupported extensions (.doc, .pdf, …)", async () => {
  // For legacy Office and PDF we don't have a text extractor yet.
  // The doc should still land in the doc map with a clear note
  // pointing the reader at the file URL.
  const fetchImpl = spFetch([
    ...siteAndDriveMatchers(),
    async (url) => {
      if (url.endsWith(`/drives/${DRIVE_ID}/items/item-pdf`)) {
        return json(200, {
          id: "item-pdf",
          name: "Whitepaper.pdf",
          webUrl: "https://contoso.sharepoint.com/Whitepaper.pdf",
        });
      }
    },
  ]);
  const adapter = new SharePointAdapter({
    token: "test-token",
    scope: { hostname: "contoso.sharepoint.com", sitePath: "/sites/marketing" },
    fetchImpl,
  });
  const fetched = await adapter.fetchDoc(`${DRIVE_ID}::item-pdf`);
  assert.match(fetched.body, /Whitepaper\.pdf/);
  assert.match(fetched.body, /Atelier doesn't extract text from this format/);
});

test("SharePointAdapter.fetchDoc reads .md raw without conversion", async () => {
  let convertHit = false;
  const fetchImpl = spFetch([
    ...siteAndDriveMatchers(),
    async (url) => {
      if (url.endsWith(`/drives/${DRIVE_ID}/items/item-md`)) {
        return json(200, { id: "item-md", name: "notes.md" });
      }
      if (url.includes("?format=text/plain")) {
        convertHit = true;
      }
      if (url.endsWith(`/drives/${DRIVE_ID}/items/item-md/content`)) {
        return text(200, "# Notes\n\nDirect markdown.");
      }
    },
  ]);
  const adapter = new SharePointAdapter({
    token: "test-token",
    scope: { hostname: "contoso.sharepoint.com", sitePath: "/sites/marketing" },
    fetchImpl,
  });
  const fetched = await adapter.fetchDoc(`${DRIVE_ID}::item-md`);
  assert.equal(fetched.body, "# Notes\n\nDirect markdown.");
  assert.equal(convertHit, false);
});

// ============================================================
// Availability
// ============================================================

test("SharePointAdapter.checkAvailability hits the tenant-root site", async () => {
  // The new credentials-only check probes /sites/{hostname} — proves
  // the token works against the tenant root rather than walking pins.
  // Pins get exercised at sync time instead.
  const fetchImpl = spFetch([
    async (url, init) => {
      if (url.endsWith("/sites/contoso.sharepoint.com")) {
        assert.equal(init.headers?.Authorization, "Bearer test-token");
        return json(200, { id: "contoso.sharepoint.com,root-guid,web-guid" });
      }
    },
  ]);
  const adapter = new SharePointAdapter({
    token: "test-token",
    scope: { hostname: "contoso.sharepoint.com", pins: [] },
    fetchImpl,
  });
  const a = await adapter.checkAvailability();
  assert.equal(a.available, true);
});

test("SharePointAdapter.checkAvailability surfaces 401 with a refresh hint", async () => {
  const fetchImpl = spFetch([
    async (url) => {
      if (url.endsWith("/sites/contoso.sharepoint.com")) {
        return json(401, { error: { message: "expired" } });
      }
    },
  ]);
  const adapter = new SharePointAdapter({
    token: "test-token",
    scope: { hostname: "contoso.sharepoint.com", pins: [] },
    fetchImpl,
  });
  const a = await adapter.checkAvailability();
  assert.equal(a.available, false);
  assert.match(a.reason, /admin consent/);
});

test("SharePointAdapter constructor rejects missing hostname", () => {
  assert.throws(
    () =>
      new SharePointAdapter({
        token: "t",
        scope: { hostname: "" },
      }),
    /scope\.hostname/
  );
});

test("SharePointAdapter accepts an empty pins[] (freshly-onboarded source)", () => {
  // Freshly-onboarded sources have no pins yet — documents land in
  // scope.pins later via `/doc add <url>`. The old "at least one pin"
  // guard prevented this credentials-first onboarding flow.
  const adapter = new SharePointAdapter({
    token: "t",
    scope: { hostname: "contoso.sharepoint.com", pins: [] },
  });
  assert.equal(adapter.kind, "sharepoint");
});

test("SharePointAdapter accepts the legacy single-target scope shape", () => {
  // Sources written by older versions of the wizard have
  // sitePath at the top level. They should still load: the
  // adapter normalizes them into a synthetic one-element pins[].
  const adapter = new SharePointAdapter({
    token: "t",
    scope: {
      hostname: "contoso.sharepoint.com",
      sitePath: "/sites/Old",
      folderPath: "/Things",
    },
  });
  // No throw → legacy form accepted.
  assert.equal(adapter.kind, "sharepoint");
});

// ============================================================
// .vtt rendering (pure function)
// ============================================================

test("renderVttAsMarkdown merges consecutive same-speaker cues", () => {
  const vtt = [
    "WEBVTT",
    "",
    "00:00:01.000 --> 00:00:04.000",
    "<v Alice>One.</v>",
    "",
    "00:00:05.000 --> 00:00:09.000",
    "<v Alice>Two.</v>",
    "",
    "00:00:10.000 --> 00:00:13.000",
    "<v Bob>Three.</v>",
    "",
  ].join("\n");
  const out = renderVttAsMarkdown(vtt, "Meeting.vtt");
  assert.match(out, /^# Meeting/);
  // Alice's two cues are merged into one line.
  assert.match(out, /\*\*Alice:\*\* One\. Two\./);
  assert.match(out, /\*\*Bob:\*\* Three\./);
});

test("renderVttAsMarkdown handles cues without <v> speaker tags", () => {
  const vtt = [
    "WEBVTT",
    "",
    "00:00:01.000 --> 00:00:04.000",
    "Hello world.",
    "",
  ].join("\n");
  const out = renderVttAsMarkdown(vtt, "anon.vtt");
  assert.match(out, /\*\*Speaker:\*\* Hello world\./);
});

// ============================================================
// Onboarding flow
// ============================================================

test("sharepointOnboarding lists rest + mcp transports", async () => {
  const opts = await sharepointOnboarding.availableTransports();
  const t = opts.map((o) => o.transport).sort();
  assert.deepEqual(t, ["mcp", "rest"]);
});

test("sharepointOnboarding.toRegistryEntry persists credentials + hostname with empty pins[]", () => {
  // Onboarding now asks for credentials + hostname only. Specific
  // documents are tracked one URL at a time via `/doc add <url>`,
  // which appends to `scope.pins`. So a freshly-onboarded source
  // starts with an empty pin list.
  const entry = sharepointOnboarding.toRegistryEntry({
    transport: "rest",
    values: {
      id: "marketing",
      name: "Marketing SP",
      authType: "bearer",
      hostname: "contoso.sharepoint.com",
      envVar: "SHAREPOINT_TOKEN",
      token: "eyJ...",
    },
  });
  assert.equal(entry.source.kind, "sharepoint");
  assert.equal(entry.source.transport, "rest");
  assert.deepEqual(entry.source.credentials, { envVar: "SHAREPOINT_TOKEN" });
  assert.deepEqual(entry.source.scope, {
    hostname: "contoso.sharepoint.com",
    pins: [],
  });
  assert.equal(entry.envVarsToSet[0].name, "SHAREPOINT_TOKEN");
});

test("sharepointOnboarding.toRegistryEntry (azure-app auth) produces the structured credentials shape", () => {
  const entry = sharepointOnboarding.toRegistryEntry({
    transport: "rest",
    values: {
      id: "sharepoint",
      name: "SharePoint",
      authType: "azure-app",
      azureTenantId: "11111111-1111-1111-1111-111111111111",
      azureClientId: "22222222-2222-2222-2222-222222222222",
      azureClientSecretEnvVar: "SHAREPOINT_CLIENT_SECRET",
      azureClientSecret: "supersecret",
      hostname: "contoso.sharepoint.com",
    },
  });
  assert.deepEqual(entry.source.credentials, {
    kind: "azureClientCredentials",
    tenantId: "11111111-1111-1111-1111-111111111111",
    clientId: "22222222-2222-2222-2222-222222222222",
    clientSecretEnvVar: "SHAREPOINT_CLIENT_SECRET",
  });
  assert.deepEqual(entry.source.scope, {
    hostname: "contoso.sharepoint.com",
    pins: [],
  });
  assert.equal(entry.envVarsToSet[0].name, "SHAREPOINT_CLIENT_SECRET");
});
