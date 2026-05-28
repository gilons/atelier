import {
  requireWorkspaceRoot,
  addStakeholder,
  listStakeholders,
  loadStakeholder,
  removeStakeholder,
  renameStakeholder,
  updateStakeholder,
  addStakeholderOwnership,
  removeStakeholderOwnership,
  setStakeholderHandle,
  appendPrivateNote,
  appendProfileNote,
  slugifyStakeholderId,
  StakeholderAlreadyExistsError,
  StakeholderNotFoundError,
  StakeholderFileError,
  NotInsideWorkspaceError,
} from "@atelier/core";
import type { Command } from "../command.js";
import { ui } from "../ui.js";

/**
 * `atelier stakeholder` — manage the workspace's people map.
 *
 * A stakeholder is anyone the team wants to keep context on: a PM, a
 * lead engineer, a customer contact, an exec sponsor. Each lives at
 * `.atelier/stakeholders/<id>/profile.md` (shared via git) with an
 * optional `private.md` (gitignored) for personal notes.
 *
 * Two layers:
 *   profile.md   — name, role, organization, handles, ownerships,
 *                  shared narrative. Visible to everyone with the
 *                  workspace.
 *   private.md   — "Sarah doesn't like long meetings", "she reports
 *                  to Dan", … Personal observations. Never committed.
 *
 * Default command flow:
 *   /stakeholder add "Sarah Chen" --role "PM" --org "Acme"
 *   /stakeholder note sarah-chen "Owns the checkout migration"
 *   /stakeholder note sarah-chen --private "Prefers async updates"
 *   /stakeholder handle sarah-chen slack @sarah
 *   /stakeholder own sarah-chen checkout
 *   /stakeholder show sarah-chen [--private]
 *   /stakeholder list [--org Acme]
 */

// ============================================================
// Shared flag parsers
// ============================================================

/**
 * `--handle slack=@sarah` → `{ slack: "@sarah" }`. Repeatable. Used
 * by `add` and `update` when the agent already knows the handles.
 * Standalone `handle` subcommand exists for the one-off case.
 */
function parseHandleFlags(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  const values = Array.isArray(raw) ? (raw as string[]) : [raw as string];
  const out: Record<string, string> = {};
  for (const v of values) {
    if (typeof v !== "string" || v.length === 0) {
      throw new Error("--handle values must be in the form kind=value (e.g. slack=@sarah)");
    }
    const eq = v.indexOf("=");
    if (eq <= 0 || eq === v.length - 1) {
      throw new Error(`--handle "${v}" must be in the form kind=value`);
    }
    const kind = v.slice(0, eq).trim();
    const val = v.slice(eq + 1).trim();
    if (!kind || !val) {
      throw new Error(`--handle "${v}" must be in the form kind=value`);
    }
    out[kind] = val;
  }
  return out;
}

function parseRepeatableString(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  const values = Array.isArray(raw) ? (raw as string[]) : [raw as string];
  return values.filter((v) => typeof v === "string" && v.length > 0);
}

// ============================================================
// add
// ============================================================

const addCmd: Command = {
  name: "add",
  summary: "Register a new stakeholder.",
  description:
    "Creates `.atelier/stakeholders/<id>/profile.md`. The id is derived\n" +
    "from the name (\"Sarah Chen\" → sarah-chen) unless --id is given.\n\n" +
    "Use --handle kind=value (repeatable) to attach handles like\n" +
    "slack=@sarah github=schen. Use --own <ref> (repeatable) to record\n" +
    "what this person owns — feature ids, source:itemId pairs, repo\n" +
    "names — anything atelier can later cross-reference.",
  options: {
    name: { type: "string", short: "n" },
    id: { type: "string" },
    role: { type: "string", short: "r" },
    org: { type: "string", short: "o" },
    email: { type: "string", short: "e" },
    handle: { type: "string", multiple: true },
    own: { type: "string", multiple: true },
    summary: { type: "string", short: "s" },
    "from-session": { type: "string" },
  },
  positionals: ["name?"],
  prompts: [
    {
      key: "name",
      question: 'Name (e.g. "Sarah Chen")',
      help: "Free-form display name. Slug is derived from this unless --id is given.",
      positionalIndex: 0,
      validate: /\S/,
    },
  ],
  async run({ values, positionals, cwd }) {
    const name = (values.name as string | undefined) ?? positionals[0];
    if (!name) {
      ui.error("Missing stakeholder name.");
      ui.print(
        `  ${ui.dim('Usage: atelier stakeholder add "Sarah Chen" [--id sarah-chen] [--role PM]')}`
      );
      return 2;
    }

    let handles: Record<string, string> | undefined;
    try {
      handles = parseHandleFlags(values.handle);
    } catch (err) {
      ui.error((err as Error).message);
      return 2;
    }

    let workspaceRoot: string;
    try {
      workspaceRoot = await requireWorkspaceRoot(cwd);
    } catch (err) {
      if (err instanceof NotInsideWorkspaceError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }

    try {
      const fromSession = values["from-session"] as string | undefined;
      const stakeholder = await addStakeholder(workspaceRoot, {
        id: values.id as string | undefined,
        name,
        role: values.role as string | undefined,
        organization: values.org as string | undefined,
        email: values.email as string | undefined,
        handles,
        ownerships: parseRepeatableString(values.own),
        summary: values.summary as string | undefined,
        fromSessions: fromSession ? [fromSession] : undefined,
      });
      ui.success(`Added stakeholder ${ui.bold(stakeholder.id)}`);
      ui.blank();
      ui.print(`  ${ui.dim("Name:")}         ${stakeholder.name}`);
      if (stakeholder.role) ui.print(`  ${ui.dim("Role:")}         ${stakeholder.role}`);
      if (stakeholder.organization) {
        ui.print(`  ${ui.dim("Organization:")} ${stakeholder.organization}`);
      }
      if (stakeholder.email) ui.print(`  ${ui.dim("Email:")}        ${stakeholder.email}`);
      if (stakeholder.handles && Object.keys(stakeholder.handles).length > 0) {
        ui.print(`  ${ui.dim("Handles:")}`);
        for (const [k, v] of Object.entries(stakeholder.handles)) {
          ui.print(`    ${ui.dim("·")} ${k} ${ui.dim("=")} ${v}`);
        }
      }
      if (stakeholder.ownerships && stakeholder.ownerships.length > 0) {
        ui.print(`  ${ui.dim("Owns:")}`);
        for (const o of stakeholder.ownerships) {
          ui.print(`    ${ui.dim("·")} ${o}`);
        }
      }
      ui.blank();
      ui.print(
        `  ${ui.dim("→ Open .atelier/stakeholders/" + stakeholder.id + "/profile.md to flesh out the body.")}`
      );
      ui.print(
        `  ${ui.dim('→ Add a personal note (gitignored) with `stakeholder note ' + stakeholder.id + ' --private "..."`')}`
      );
      ui.blank();
      return 0;
    } catch (err) {
      if (err instanceof StakeholderAlreadyExistsError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

// ============================================================
// list
// ============================================================

const listCmd: Command = {
  name: "list",
  summary: "List every stakeholder in the workspace.",
  options: {
    org: { type: "string", short: "o" },
    role: { type: "string", short: "r" },
  },
  async run({ values, cwd, mode }) {
    let workspaceRoot: string;
    try {
      workspaceRoot = await requireWorkspaceRoot(cwd);
    } catch (err) {
      if (err instanceof NotInsideWorkspaceError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }

    const orgFilter = (values.org as string | undefined)?.trim().toLowerCase();
    const roleFilter = (values.role as string | undefined)?.trim().toLowerCase();

    const { stakeholders, errors } = await listStakeholders(workspaceRoot);
    if (stakeholders.length === 0 && errors.length === 0) {
      const addHint =
        mode === "repl" ? "/stakeholder add" : "atelier stakeholder add";
      ui.info("No stakeholders yet.");
      ui.print(`  ${ui.dim(`Use \`${addHint} "Name"\` to register one.`)}`);
      return 0;
    }

    const shown = stakeholders.filter(({ stakeholder }) => {
      if (orgFilter && (stakeholder.organization ?? "").toLowerCase() !== orgFilter) {
        return false;
      }
      if (roleFilter && (stakeholder.role ?? "").toLowerCase() !== roleFilter) {
        return false;
      }
      return true;
    });

    if (shown.length === 0) {
      const filterLabel = [
        orgFilter ? `org="${values.org}"` : "",
        roleFilter ? `role="${values.role}"` : "",
      ]
        .filter(Boolean)
        .join(", ");
      ui.info(`No stakeholders matching ${filterLabel}.`);
    } else {
      const idWidth = Math.max("ID".length, ...shown.map((s) => s.stakeholder.id.length));
      const nameWidth = Math.max(
        "NAME".length,
        ...shown.map((s) => s.stakeholder.name.length)
      );
      ui.print(
        `    ${ui.dim("ID".padEnd(idWidth))}  ${ui.dim("NAME".padEnd(nameWidth))}  ${ui.dim("ROLE")}  ${ui.dim("ORG")}`
      );
      for (const { stakeholder, hasPrivate } of shown) {
        const flag = hasPrivate ? ui.dim(" [private]") : "";
        ui.print(
          `  ${ui.green("·")} ${stakeholder.id.padEnd(idWidth)}  ${stakeholder.name.padEnd(nameWidth)}  ${stakeholder.role ?? ui.dim("—")}  ${stakeholder.organization ?? ui.dim("—")}${flag}`
        );
      }
      ui.blank();
    }

    if (errors.length > 0) {
      ui.warn(`${errors.length} stakeholder file(s) failed to parse:`);
      for (const e of errors) {
        ui.print(`    ${ui.red("✗")} ${e.filePath}`);
        ui.print(`      ${ui.dim(e.error.message.split("\n")[0])}`);
      }
      ui.blank();
    }
    return 0;
  },
};

// ============================================================
// show
// ============================================================

const showCmd: Command = {
  name: "show",
  summary: "Show a stakeholder's profile (and optionally private notes).",
  description:
    "Prints the stakeholder's front-matter, profile body, and — when\n" +
    "--private is set — the gitignored private.md. The private layer\n" +
    "is opt-in by construction so the file stays personal unless the\n" +
    "user explicitly asks for it.",
  positionals: ["id"],
  options: {
    private: { type: "boolean", short: "p" },
  },
  async run({ values, positionals, cwd }) {
    const [id] = positionals;
    if (!id) {
      ui.error("Missing <id> argument.");
      ui.print(`  ${ui.dim("Usage: atelier stakeholder show <id> [--private]")}`);
      return 2;
    }

    let workspaceRoot: string;
    try {
      workspaceRoot = await requireWorkspaceRoot(cwd);
    } catch (err) {
      if (err instanceof NotInsideWorkspaceError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }

    try {
      const includePrivate = values.private === true;
      const s = await loadStakeholder(workspaceRoot, id, { includePrivate });
      ui.print(ui.bold(s.name));
      ui.print(`  ${ui.dim("id:")}           ${s.id}`);
      if (s.role) ui.print(`  ${ui.dim("role:")}         ${s.role}`);
      if (s.organization) ui.print(`  ${ui.dim("organization:")} ${s.organization}`);
      if (s.email) ui.print(`  ${ui.dim("email:")}        ${s.email}`);
      if (s.handles && Object.keys(s.handles).length > 0) {
        ui.print(`  ${ui.dim("handles:")}`);
        for (const [k, v] of Object.entries(s.handles)) {
          ui.print(`    ${ui.dim("·")} ${k} ${ui.dim("=")} ${v}`);
        }
      }
      if (s.ownerships && s.ownerships.length > 0) {
        ui.print(`  ${ui.dim("owns:")}`);
        for (const o of s.ownerships) {
          ui.print(`    ${ui.dim("·")} ${o}`);
        }
      }
      if (s.fromSessions && s.fromSessions.length > 0) {
        ui.print(`  ${ui.dim("from sessions:")}`);
        for (const sid of s.fromSessions) {
          ui.print(`    ${ui.dim("·")} ${sid}`);
        }
      }
      if (s.summary) ui.print(`  ${ui.dim("summary:")}     ${s.summary}`);
      ui.print(`  ${ui.dim("created:")}     ${s.createdAt}`);
      ui.print(`  ${ui.dim("updated:")}     ${s.updatedAt}`);
      ui.blank();
      if (s.profileBody.trim().length > 0) {
        process.stdout.write(s.profileBody);
        if (!s.profileBody.endsWith("\n")) ui.blank();
      }
      if (includePrivate) {
        if (s.privateBody !== undefined && s.privateBody.length > 0) {
          ui.blank();
          ui.print(ui.dim("─── private.md (local-only, gitignored) ───"));
          ui.blank();
          process.stdout.write(s.privateBody);
          if (!s.privateBody.endsWith("\n")) ui.blank();
        } else {
          ui.blank();
          ui.print(ui.dim("(no private notes yet)"));
        }
      }
      return 0;
    } catch (err) {
      if (err instanceof StakeholderNotFoundError || err instanceof StakeholderFileError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

// ============================================================
// update — change front-matter fields
// ============================================================

const updateCmd: Command = {
  name: "update",
  summary: "Update one or more fields on a stakeholder.",
  description:
    "Use --clear-<field> to remove an optional field (role, org, email,\n" +
    "summary). --handle replaces the entire handle map; use the `handle`\n" +
    "subcommand to add/remove one handle at a time.",
  positionals: ["id"],
  options: {
    name: { type: "string", short: "n" },
    role: { type: "string", short: "r" },
    "clear-role": { type: "boolean" },
    org: { type: "string", short: "o" },
    "clear-org": { type: "boolean" },
    email: { type: "string", short: "e" },
    "clear-email": { type: "boolean" },
    handle: { type: "string", multiple: true },
    summary: { type: "string", short: "s" },
    "clear-summary": { type: "boolean" },
  },
  async run({ values, positionals, cwd }) {
    const [id] = positionals;
    if (!id) {
      ui.error("Missing <id> argument.");
      ui.print(`  ${ui.dim("Usage: atelier stakeholder update <id> --role ... --org ...")}`);
      return 2;
    }

    let workspaceRoot: string;
    try {
      workspaceRoot = await requireWorkspaceRoot(cwd);
    } catch (err) {
      if (err instanceof NotInsideWorkspaceError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }

    let handles: Record<string, string> | undefined;
    try {
      handles = parseHandleFlags(values.handle);
    } catch (err) {
      ui.error((err as Error).message);
      return 2;
    }

    try {
      const next = await updateStakeholder(workspaceRoot, id, {
        name: values.name as string | undefined,
        role: values["clear-role"] === true ? null : (values.role as string | undefined),
        organization:
          values["clear-org"] === true ? null : (values.org as string | undefined),
        email:
          values["clear-email"] === true ? null : (values.email as string | undefined),
        handles,
        summary:
          values["clear-summary"] === true ? "" : (values.summary as string | undefined),
      });
      ui.success(`Updated ${ui.bold(next.id)}`);
      return 0;
    } catch (err) {
      if (err instanceof StakeholderNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

// ============================================================
// handle — set / clear one handle at a time
// ============================================================

const handleCmd: Command = {
  name: "handle",
  summary: "Set or clear one handle for a stakeholder.",
  description:
    "`stakeholder handle <id> <kind> <value>` upserts the handle.\n" +
    "Pass `--clear` to remove it instead.\n\n" +
    "Example:\n" +
    "  atelier stakeholder handle sarah-chen slack @sarah\n" +
    "  atelier stakeholder handle sarah-chen github --clear",
  positionals: ["id", "kind", "value?"],
  options: {
    clear: { type: "boolean" },
  },
  async run({ values, positionals, cwd }) {
    const [id, kind, value] = positionals;
    if (!id || !kind) {
      ui.error("Missing arguments.");
      ui.print(
        `  ${ui.dim("Usage: atelier stakeholder handle <id> <kind> <value>  |  --clear")}`
      );
      return 2;
    }
    const clearing = values.clear === true;
    if (!clearing && !value) {
      ui.error("Missing <value> (or pass --clear to remove).");
      return 2;
    }

    let workspaceRoot: string;
    try {
      workspaceRoot = await requireWorkspaceRoot(cwd);
    } catch (err) {
      if (err instanceof NotInsideWorkspaceError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }

    try {
      const next = await setStakeholderHandle(workspaceRoot, id, kind, clearing ? null : value!);
      if (clearing) ui.success(`Cleared ${ui.bold(kind)} on ${next.id}`);
      else ui.success(`Set ${ui.bold(kind)} = ${value} on ${next.id}`);
      return 0;
    } catch (err) {
      if (err instanceof StakeholderNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

// ============================================================
// own / disown — ownership list management
// ============================================================

const ownCmd: Command = {
  name: "own",
  summary: "Record that a stakeholder owns something (feature, item, repo, …).",
  description:
    "Appends an entry to the stakeholder's `ownerships` list (deduped).\n" +
    "The format is free-form — pass whatever id makes sense to refer\n" +
    "back to later: a feature id (`checkout`), a source:itemId pair\n" +
    "(`notion:abc-123`), a repo name (`api`).",
  positionals: ["id", "ownership"],
  async run({ positionals, cwd }) {
    const [id, ownership] = positionals;
    if (!id || !ownership) {
      ui.error("Missing arguments.");
      ui.print(`  ${ui.dim("Usage: atelier stakeholder own <id> <ownership-ref>")}`);
      return 2;
    }

    let workspaceRoot: string;
    try {
      workspaceRoot = await requireWorkspaceRoot(cwd);
    } catch (err) {
      if (err instanceof NotInsideWorkspaceError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }

    try {
      const next = await addStakeholderOwnership(workspaceRoot, id, ownership);
      ui.success(`${next.id} now owns ${ui.bold(ownership)}`);
      return 0;
    } catch (err) {
      if (err instanceof StakeholderNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

const disownCmd: Command = {
  name: "disown",
  summary: "Remove an ownership entry from a stakeholder.",
  positionals: ["id", "ownership"],
  async run({ positionals, cwd }) {
    const [id, ownership] = positionals;
    if (!id || !ownership) {
      ui.error("Missing arguments.");
      ui.print(`  ${ui.dim("Usage: atelier stakeholder disown <id> <ownership-ref>")}`);
      return 2;
    }

    let workspaceRoot: string;
    try {
      workspaceRoot = await requireWorkspaceRoot(cwd);
    } catch (err) {
      if (err instanceof NotInsideWorkspaceError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }

    try {
      const next = await removeStakeholderOwnership(workspaceRoot, id, ownership);
      ui.success(`${next.id} no longer owns ${ownership}`);
      return 0;
    } catch (err) {
      if (err instanceof StakeholderNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

// ============================================================
// note — append a free-form note (shared or private)
// ============================================================

const noteCmd: Command = {
  name: "note",
  summary: "Append a note to a stakeholder's profile (or private layer).",
  description:
    "Without --private, the note appends to profile.md (shared via git).\n" +
    "With --private, the note appends to private.md (gitignored — your\n" +
    "personal layer). Use this to capture observations without polluting\n" +
    "the team-shared view.",
  positionals: ["id", "body?"],
  options: {
    private: { type: "boolean", short: "p" },
    header: { type: "string", short: "H" },
  },
  async run({ values, positionals, cwd }) {
    const [id, body] = positionals;
    if (!id || !body) {
      ui.error("Missing arguments.");
      ui.print(
        `  ${ui.dim('Usage: atelier stakeholder note <id> "free-form text" [--private] [--header "..."]')}`
      );
      return 2;
    }

    let workspaceRoot: string;
    try {
      workspaceRoot = await requireWorkspaceRoot(cwd);
    } catch (err) {
      if (err instanceof NotInsideWorkspaceError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }

    try {
      const header = values.header as string | undefined;
      if (values.private === true) {
        const file = await appendPrivateNote(workspaceRoot, id, body, { header });
        ui.success(`Appended to ${ui.dim(file)} (private, gitignored)`);
      } else {
        const next = await appendProfileNote(workspaceRoot, id, body, { header });
        ui.success(`Appended to ${ui.bold(next.id)}'s profile.md`);
      }
      return 0;
    } catch (err) {
      if (err instanceof StakeholderNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

// ============================================================
// rename
// ============================================================

const renameCmd: Command = {
  name: "rename",
  summary: "Rename a stakeholder (change their slug id).",
  positionals: ["old-id", "new-id"],
  async run({ positionals, cwd }) {
    const [oldId, newIdRaw] = positionals;
    if (!oldId || !newIdRaw) {
      ui.error("Missing arguments.");
      ui.print(`  ${ui.dim("Usage: atelier stakeholder rename <old-id> <new-id>")}`);
      return 2;
    }
    // Be lenient — if the user types a name, slug it.
    const newId = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(newIdRaw)
      ? newIdRaw
      : slugifyStakeholderId(newIdRaw);
    if (!newId) {
      ui.error(`Could not derive a slug from "${newIdRaw}".`);
      return 2;
    }

    let workspaceRoot: string;
    try {
      workspaceRoot = await requireWorkspaceRoot(cwd);
    } catch (err) {
      if (err instanceof NotInsideWorkspaceError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }

    try {
      const next = await renameStakeholder(workspaceRoot, oldId, newId);
      ui.success(`Renamed to ${ui.bold(next.id)}`);
      return 0;
    } catch (err) {
      if (
        err instanceof StakeholderNotFoundError ||
        err instanceof StakeholderAlreadyExistsError
      ) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

// ============================================================
// remove
// ============================================================

const removeCmd: Command = {
  name: "remove",
  summary: "Delete a stakeholder (folder + private notes).",
  positionals: ["id"],
  async run({ positionals, cwd }) {
    const [id] = positionals;
    if (!id) {
      ui.error("Missing <id> argument.");
      ui.print(`  ${ui.dim("Usage: atelier stakeholder remove <id>")}`);
      return 2;
    }

    let workspaceRoot: string;
    try {
      workspaceRoot = await requireWorkspaceRoot(cwd);
    } catch (err) {
      if (err instanceof NotInsideWorkspaceError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }

    try {
      const removed = await removeStakeholder(workspaceRoot, id);
      ui.success(`Removed stakeholder ${ui.bold(removed.id)}`);
      return 0;
    } catch (err) {
      if (err instanceof StakeholderNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

// ============================================================
// Top-level group
// ============================================================

export const stakeholderCommand: Command = {
  name: "stakeholder",
  summary: "Manage the workspace's people map (PMs, engineers, customers, …).",
  description:
    "Stakeholders live under .atelier/stakeholders/<id>/. Each has a\n" +
    "shared profile.md (tracked in git) and an optional private.md\n" +
    "(gitignored — personal notes). atelier never crosses the layers\n" +
    "implicitly: private notes only surface when --private is passed\n" +
    "explicitly.",
  subcommands: [
    addCmd,
    listCmd,
    showCmd,
    updateCmd,
    handleCmd,
    ownCmd,
    disownCmd,
    noteCmd,
    renameCmd,
    removeCmd,
  ],
};
