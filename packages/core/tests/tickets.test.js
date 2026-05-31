import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  initWorkspace,
  addTicket,
  loadTicket,
  listTickets,
  updateTicket,
  removeTicket,
  parseTicketFile,
  serializeTicketFile,
  validateTicketFrontMatter,
  TicketAlreadyExistsError,
  TicketNotFoundError,
  TicketReferenceValidationError,
  workspacePaths,
} from "../dist/index.js";

async function workspace() {
  const umbrella = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-ticket-"));
  const workspaceRoot = path.join(umbrella, "planning");
  await fs.mkdir(workspaceRoot);
  await initWorkspace(workspaceRoot, { name: "Test" });
  return { umbrella, workspaceRoot };
}

test("validateTicketFrontMatter requires source/ticketId/title", () => {
  const r = validateTicketFrontMatter({ source: "linear", ticketId: "", title: "T", createdAt: "t", updatedAt: "t" });
  assert.equal(r.ok, false);
  assert.ok(r.issues.some((i) => i.path === "$.ticketId"));
});

test("serialize → parse round-trips incl. status/assignee/parent", () => {
  const now = "2026-05-31T00:00:00.000Z";
  const text = serializeTicketFile({
    source: "linear",
    ticketId: "ENG-1421",
    title: "Add SSO",
    status: "in-progress",
    assignee: "sarah-chen",
    parent: "ENG-1400",
    link: "https://linear.app/x",
    createdAt: now,
    updatedAt: now,
    body: "Scope: …\n",
  });
  const t = parseTicketFile(text, "/x.md");
  assert.equal(t.status, "in-progress");
  assert.equal(t.assignee, "sarah-chen");
  assert.equal(t.parent, "ENG-1400");
});

test("addTicket writes summary.md under tickets/<source>/", async () => {
  const { workspaceRoot } = await workspace();
  const t = await addTicket(workspaceRoot, {
    source: "linear",
    ticketId: "ENG-1421",
    title: "Add SSO",
    status: "open",
    skipSourceValidation: true,
  });
  assert.equal(t.ticketId, "ENG-1421");
  const paths = workspacePaths(workspaceRoot);
  const file = path.join(paths.tickets, "linear", "ENG-1421", "summary.md");
  assert.match(await fs.readFile(file, "utf8"), /status: open/);
});

test("addTicket validates source unless skipped; rejects duplicates", async () => {
  const { workspaceRoot } = await workspace();
  await assert.rejects(
    () => addTicket(workspaceRoot, { source: "ghost", ticketId: "x", title: "T" }),
    TicketReferenceValidationError
  );
  await addTicket(workspaceRoot, { source: "linear", ticketId: "x", title: "T", skipSourceValidation: true });
  await assert.rejects(
    () => addTicket(workspaceRoot, { source: "linear", ticketId: "x", title: "T", skipSourceValidation: true }),
    TicketAlreadyExistsError
  );
});

test("listTickets + filter; updateTicket status; removeTicket", async () => {
  const { workspaceRoot } = await workspace();
  await addTicket(workspaceRoot, { source: "linear", ticketId: "a", title: "A", status: "open", skipSourceValidation: true });
  await addTicket(workspaceRoot, { source: "linear", ticketId: "b", title: "B", status: "done", skipSourceValidation: true });
  const { tickets } = await listTickets(workspaceRoot);
  assert.equal(tickets.length, 2);

  const up = await updateTicket(workspaceRoot, "linear", "a", { status: "in-progress", assignee: "sarah" });
  assert.equal(up.status, "in-progress");
  assert.equal(up.assignee, "sarah");

  await removeTicket(workspaceRoot, "linear", "b");
  await assert.rejects(() => loadTicket(workspaceRoot, "linear", "b"), TicketNotFoundError);
});

test("initWorkspace creates the tickets folder", async () => {
  const { workspaceRoot } = await workspace();
  const paths = workspacePaths(workspaceRoot);
  assert.ok((await fs.stat(paths.tickets)).isDirectory());
});
