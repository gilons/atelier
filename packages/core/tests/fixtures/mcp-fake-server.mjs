#!/usr/bin/env node
// A minimal MCP server used as a test fixture. Implements just enough
// of the protocol for StdioMcpClient to talk to:
//   - initialize  → returns capabilities
//   - tools/call(atelier_list_docs)  → fake doc index
//   - tools/call(atelier_fetch_doc)  → fake doc body
//
// Scenarios are toggled via env vars so a single fixture covers the
// happy path AND the error cases we want to exercise:
//   FIXTURE_SCENARIO=
//     happy            (default) — list returns two docs, fetch returns bodies
//     tool-error      — every tool call returns { isError: true }
//     text-content    — return body as a JSON-stringified text content
//                       block instead of structuredContent (legacy shape)
//     bad-init        — return a JSON-RPC error to initialize
//     crash-after-init — initialize succeeds, then exit(1) on next request
//     hang            — never respond to anything (test timeouts)

import * as readline from "node:readline";

const SCENARIO = process.env.FIXTURE_SCENARIO ?? "happy";
const rl = readline.createInterface({ input: process.stdin });
let crashOnNext = false;

const docs = [
  {
    docId: "intro",
    title: "Intro",
    summary: "Welcome page",
    classification: "reference",
    url: "https://example.com/intro",
  },
  {
    docId: "spec",
    title: "Product Spec",
    summary: "What we're building",
    classification: "prd",
    url: "https://example.com/spec",
  },
];

const bodies = {
  intro: "# Intro\n\nWelcome to the test fixture.\n",
  spec: "# Product Spec\n\nThis is the product spec.\n",
};

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function respondError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

rl.on("line", (line) => {
  if (SCENARIO === "hang") return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (!msg || typeof msg !== "object") return;

  if (crashOnNext) {
    process.stderr.write("fixture: crash-after-init scenario, exiting\n");
    process.exit(1);
  }

  // Notifications (no id) — only "initialized" matters; ignore others.
  if (!("id" in msg)) return;

  if (msg.method === "initialize") {
    if (SCENARIO === "bad-init") {
      respondError(msg.id, -32603, "Fixture refused initialize");
      return;
    }
    respond(msg.id, {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      serverInfo: { name: "atelier-fake", version: "0.0.0" },
    });
    if (SCENARIO === "crash-after-init") crashOnNext = true;
    return;
  }

  if (msg.method === "tools/call") {
    const name = msg.params?.name;
    const args = msg.params?.arguments ?? {};

    if (SCENARIO === "tool-error") {
      respond(msg.id, {
        isError: true,
        content: [{ type: "text", text: "Fixture failure for testing" }],
      });
      return;
    }

    if (name === "atelier_list_docs") {
      if (SCENARIO === "text-content") {
        respond(msg.id, {
          content: [{ type: "text", text: JSON.stringify({ docs }) }],
        });
      } else {
        respond(msg.id, { structuredContent: { docs } });
      }
      return;
    }
    if (name === "atelier_fetch_doc") {
      const docId = args.docId;
      const body = bodies[docId];
      if (body === undefined) {
        respond(msg.id, {
          isError: true,
          content: [{ type: "text", text: `Unknown doc: ${docId}` }],
        });
        return;
      }
      const payload = {
        docId,
        title: docs.find((d) => d.docId === docId).title,
        body,
        summary: docs.find((d) => d.docId === docId).summary,
      };
      if (SCENARIO === "text-content") {
        respond(msg.id, {
          content: [{ type: "text", text: JSON.stringify(payload) }],
        });
      } else {
        respond(msg.id, { structuredContent: payload });
      }
      return;
    }
    respondError(msg.id, -32601, `Method not found: ${name}`);
    return;
  }

  respondError(msg.id, -32601, `Method not found: ${msg.method}`);
});
