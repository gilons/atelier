import * as fs from "node:fs/promises";
import {
  requireWorkspaceRoot,
  addTicket,
  listTickets,
  loadTicket,
  removeTicket,
  updateTicket,
  TicketAlreadyExistsError,
  TicketNotFoundError,
  TicketFileError,
  TicketReferenceValidationError,
  NotInsideWorkspaceError,
} from "@atelier/core";
import type { Command } from "../command.js";
import { ui } from "../ui.js";

/**
 * `atelier ticket` — the planning surface.
 *
 * Issues / epics / initiatives / stories indexed from a planning tool
 * (Linear, Jira, GitHub Issues). Lightweight on purpose: a summary +
 * link + light status, NOT a tracker reimplementation. The tracker
 * stays the source of truth; atelier indexes enough to cross-reference
 * tickets with code, docs, and design.
 *
 *   atelier ticket add <source>:<ticketId> --title "..." [--status open]
 *     [--assignee sarah-chen] [--link <url>] [--parent <id>]
 */

function parseRef(ref: string): { source: string; ticketId: string } | null {
  const i = ref.indexOf(":");
  if (i <= 0 || i === ref.length - 1) return null;
  return { source: ref.slice(0, i), ticketId: ref.slice(i + 1) };
}

async function resolveRoot(cwd: string): Promise<string | number> {
  try {
    return await requireWorkspaceRoot(cwd);
  } catch (err) {
    if (err instanceof NotInsideWorkspaceError) {
      ui.error(err.message);
      return 1;
    }
    throw err;
  }
}

const addCmd: Command = {
  name: "add",
  summary: "Index a ticket (summary + link + light status).",
  description:
    "Creates .atelier/tickets/<source>/<ticketId>/summary.md. atelier\n" +
    "indexes the ticket — it doesn't replace the tracker; --link points\n" +
    "back to it. --status mirrors the tracker (free-form).",
  positionals: ["ref"],
  options: {
    title: { type: "string", short: "t" },
    overview: { type: "string", short: "o" },
    status: { type: "string", short: "s" },
    assignee: { type: "string", short: "a" },
    link: { type: "string", short: "l" },
    parent: { type: "string", short: "p" },
    "from-session": { type: "string" },
    "body-text": { type: "string" },
    "body-file": { type: "string" },
    "no-validate-source": { type: "boolean" },
  },
  async run({ values, positionals, cwd }) {
    const ref = parseRef(positionals[0] ?? "");
    if (!ref) {
      ui.error("Missing or malformed <source>:<ticketId>.");
      ui.print(`  ${ui.dim('Usage: atelier ticket add linear:ENG-1421 --title "..." --status in-progress')}`);
      return 2;
    }
    const title = values.title as string | undefined;
    if (!title) {
      ui.error("Missing --title.");
      return 2;
    }
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;

    let body = (values["body-text"] as string | undefined) ?? "";
    const bodyFile = values["body-file"] as string | undefined;
    if (bodyFile) {
      try {
        body = await fs.readFile(bodyFile, "utf8");
      } catch (err) {
        ui.error(`Couldn't read --body-file: ${(err as Error).message}`);
        return 2;
      }
    }

    try {
      const t = await addTicket(root, {
        source: ref.source,
        ticketId: ref.ticketId,
        title,
        overview: values.overview as string | undefined,
        status: values.status as string | undefined,
        assignee: values.assignee as string | undefined,
        link: values.link as string | undefined,
        parent: values.parent as string | undefined,
        fromSession: values["from-session"] as string | undefined,
        body,
        skipSourceValidation: values["no-validate-source"] === true,
      });
      ui.success(`Indexed ticket ${ui.bold(`${t.source}:${t.ticketId}`)}`);
      ui.print(`  ${ui.dim("title:")}  ${t.title}`);
      if (t.status) ui.print(`  ${ui.dim("status:")} ${t.status}`);
      if (t.assignee) ui.print(`  ${ui.dim("owner:")}  ${t.assignee}`);
      return 0;
    } catch (err) {
      if (err instanceof TicketAlreadyExistsError || err instanceof TicketReferenceValidationError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

const listCmd: Command = {
  name: "list",
  summary: "List indexed tickets.",
  options: { source: { type: "string", short: "s" }, status: { type: "string" } },
  async run({ values, cwd, mode }) {
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;
    const { tickets, errors } = await listTickets(root, values.source as string | undefined);
    const statusFilter = values.status as string | undefined;
    const shown = statusFilter ? tickets.filter((t) => t.ticket.status === statusFilter) : tickets;

    if (shown.length === 0 && errors.length === 0) {
      const hint = mode === "repl" ? "/ticket add" : "atelier ticket add";
      ui.info("No tickets indexed.");
      ui.print(`  ${ui.dim(`Use \`${hint} <source>:<id> --title "..."\`.`)}`);
      return 0;
    }
    for (const { ticket } of shown) {
      const st = ticket.status ? ` ${ui.dim("[" + ticket.status + "]")}` : "";
      const who = ticket.assignee ? `  ${ui.dim("@" + ticket.assignee)}` : "";
      ui.print(`  ${ui.green("·")} ${ticket.source}:${ticket.ticketId}${st}  ${ticket.title}${who}`);
    }
    ui.blank();
    if (errors.length > 0) {
      ui.warn(`${errors.length} ticket file(s) failed to parse:`);
      for (const e of errors) ui.print(`    ${ui.red("✗")} ${e.filePath}`);
    }
    return 0;
  },
};

const showCmd: Command = {
  name: "show",
  summary: "Show a ticket's summary.",
  positionals: ["ref"],
  async run({ positionals, cwd }) {
    const ref = parseRef(positionals[0] ?? "");
    if (!ref) {
      ui.error("Usage: atelier ticket show <source>:<ticketId>");
      return 2;
    }
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;
    try {
      const t = await loadTicket(root, ref.source, ref.ticketId);
      ui.print(ui.bold(t.title));
      ui.print(`  ${ui.dim("ref:")}      ${t.source}:${t.ticketId}`);
      if (t.status) ui.print(`  ${ui.dim("status:")}   ${t.status}`);
      if (t.assignee) ui.print(`  ${ui.dim("owner:")}    ${t.assignee}`);
      if (t.parent) ui.print(`  ${ui.dim("parent:")}   ${t.parent}`);
      if (t.link) ui.print(`  ${ui.dim("link:")}     ${t.link}`);
      if (t.fromSession) ui.print(`  ${ui.dim("session:")}  ${t.fromSession}`);
      ui.print(`  ${ui.dim("updated:")}  ${t.updatedAt}`);
      ui.blank();
      process.stdout.write(t.body);
      if (!t.body.endsWith("\n")) ui.blank();
      return 0;
    } catch (err) {
      if (err instanceof TicketNotFoundError || err instanceof TicketFileError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

const updateCmd: Command = {
  name: "update",
  summary: "Update a ticket's fields (e.g. status, assignee).",
  positionals: ["ref"],
  options: {
    title: { type: "string", short: "t" },
    overview: { type: "string", short: "o" },
    status: { type: "string", short: "s" },
    "clear-status": { type: "boolean" },
    assignee: { type: "string", short: "a" },
    "clear-assignee": { type: "boolean" },
    link: { type: "string", short: "l" },
    parent: { type: "string", short: "p" },
    "clear-parent": { type: "boolean" },
  },
  async run({ values, positionals, cwd }) {
    const ref = parseRef(positionals[0] ?? "");
    if (!ref) {
      ui.error("Usage: atelier ticket update <source>:<ticketId> [--status done]");
      return 2;
    }
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;
    try {
      const next = await updateTicket(root, ref.source, ref.ticketId, {
        title: values.title as string | undefined,
        overview: values.overview as string | undefined,
        status: values["clear-status"] === true ? null : (values.status as string | undefined),
        assignee: values["clear-assignee"] === true ? null : (values.assignee as string | undefined),
        link: values.link as string | undefined,
        parent: values["clear-parent"] === true ? null : (values.parent as string | undefined),
      });
      ui.success(`Updated ${ui.bold(`${next.source}:${next.ticketId}`)}${next.status ? ` ${ui.dim("[" + next.status + "]")}` : ""}`);
      return 0;
    } catch (err) {
      if (err instanceof TicketNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

const removeCmd: Command = {
  name: "remove",
  summary: "Delete an indexed ticket.",
  positionals: ["ref"],
  async run({ positionals, cwd }) {
    const ref = parseRef(positionals[0] ?? "");
    if (!ref) {
      ui.error("Usage: atelier ticket remove <source>:<ticketId>");
      return 2;
    }
    const root = await resolveRoot(cwd);
    if (typeof root === "number") return root;
    try {
      const removed = await removeTicket(root, ref.source, ref.ticketId);
      ui.success(`Removed ${ui.bold(`${removed.source}:${removed.ticketId}`)}`);
      return 0;
    } catch (err) {
      if (err instanceof TicketNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

export const ticketCommand: Command = {
  name: "ticket",
  summary: "Index tickets — issues, epics, initiatives from the planning tool.",
  description:
    "The planning surface. Lightweight: a summary + link + light status,\n" +
    "not a tracker reimplementation. One of the typed surfaces replacing\n" +
    "the generic item; cross-references tickets with code, docs, design.",
  subcommands: [addCmd, listCmd, showCmd, updateCmd, removeCmd],
};
