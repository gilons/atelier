import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import {
  requireWorkspaceRoot,
  addDoc,
  listDocs,
  loadDoc,
  removeDoc,
  renameDoc,
  updateDoc,
  encodeDocFilenameStem,
  DOC_CLASSIFICATIONS,
  DocAlreadyExistsError,
  DocNotFoundError,
  DocFileError,
  DocReferenceValidationError,
  NotInsideWorkspaceError,
  resolveDocUrlCandidates,
  addDocByUrl,
  NoMatchingSourceError,
  UnsupportedDocUrlError,
  type DocClassification,
  type Source,
  type SyncReport,
} from "@atelier/core";
import type { Command, InvocationMode } from "../command.js";
import { ui } from "../ui.js";
import { pickSourceOrAll } from "../source-picker.js";
import { pickOne } from "../picker.js";
import { PromptSession } from "../prompt.js";

function validClassification(s: string): s is DocClassification {
  return (DOC_CLASSIFICATIONS as readonly string[]).includes(s);
}

/**
 * Decide whether the first positional looks like a URL the
 * URL-based add flow should handle. We accept https / http; the
 * classifier rejects anything else anyway, but bailing out early
 * here keeps the manual `--source / --doc-id / --title` path
 * unchanged for everyone who's still typing those.
 */
function looksLikeUrl(s: string | undefined): boolean {
  if (!s) return false;
  return /^https?:\/\//i.test(s);
}

const addCmd: Command = {
  name: "add",
  summary: "Track a document — paste its URL, or pass --source / --doc-id manually.",
  description:
    "Two ways to use this:\n\n" +
    "  `/doc add <url>`                       URL form (recommended).\n" +
    "                                          Atelier classifies the URL, picks the\n" +
    "                                          matching registered source, pins the\n" +
    "                                          document there, and syncs it.\n\n" +
    "  `/doc add --source <id> --doc-id <id>` Manual form.\n" +
    "  `--title <t> [--body-file <f>]`         Useful for scripted tests or for\n" +
    "                                          documents you want to author by hand.\n\n" +
    "The URL form is the everyday path: onboarding only captures credentials, then\n" +
    "documents are tracked one URL at a time. Supported URL shapes today:\n" +
    "  - SharePoint files, folders, and `/:b:/s/...` opaque share links\n" +
    "  - GitHub Discussions: github.com/<owner>/<repo>/discussions/<n>",
  positionals: ["url"],
  options: {
    source: { type: "string", short: "s" },
    "doc-id": { type: "string" },
    title: { type: "string", short: "t" },
    summary: { type: "string" },
    classification: { type: "string", short: "c" },
    url: { type: "string", short: "u" },
    "body-file": { type: "string" },
    "no-validate-source": { type: "boolean" },
    /**
     * Skip the post-add sync — pin the URL but don't fetch the doc
     * body yet. Mainly for tests + for power users batching multiple
     * /doc add calls who'll run /sync once at the end.
     */
    "no-sync": { type: "boolean" },
  },
  async run({ values, positionals, cwd, mode }) {
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

    // URL form takes precedence — if the first positional starts
    // with http(s)://, route to the URL flow regardless of which
    // other flags are present. This is the recommended path now,
    // so we want a URL paste to "just work" without the user
    // remembering which flags to drop.
    if (looksLikeUrl(positionals[0])) {
      return await runAddByUrl(workspaceRoot, positionals[0], {
        sourceHint: values.source as string | undefined,
        runSync: values["no-sync"] !== true,
        mode,
      });
    }

    return await runManualAdd(workspaceRoot, values, mode);
  },
};

/**
 * URL-driven add flow.
 *
 *   1. Classify the URL and find candidate sources.
 *   2. If 0: print a clear "no source for this kind/host" error.
 *   3. If 1: use it (or honor --source when it matches).
 *   4. If 2+: prompt the user to pick one.
 *   5. Append the pin, run sync filtered to that source, show what
 *      changed (or "already pinned" when this URL was a dup).
 */
async function runAddByUrl(
  workspaceRoot: string,
  url: string,
  opts: { sourceHint?: string; runSync: boolean; mode: "cli" | "repl" }
): Promise<number> {
  let candidates: Awaited<ReturnType<typeof resolveDocUrlCandidates>>;
  try {
    candidates = await resolveDocUrlCandidates(workspaceRoot, url);
  } catch (err) {
    if (err instanceof UnsupportedDocUrlError) {
      ui.error(err.message);
      return 1;
    }
    if (err instanceof NoMatchingSourceError) {
      ui.error(err.message);
      return 1;
    }
    throw err;
  }

  // Honor --source <id> when it points at one of the candidates.
  // (We don't override the classifier — passing --source for an
  // ID that doesn't match the URL's kind is a user mistake worth
  // surfacing.)
  let chosen: Source | null = null;
  if (opts.sourceHint) {
    const match = candidates.candidates.find((s) => s.id === opts.sourceHint);
    if (!match) {
      ui.error(
        `--source "${opts.sourceHint}" doesn't match any registered source compatible with this URL. ` +
          `Candidates: ${candidates.candidates.map((c) => c.id).join(", ") || "(none)"}.`
      );
      return 1;
    }
    chosen = match;
  } else if (candidates.candidates.length === 1) {
    chosen = candidates.candidates[0];
  } else {
    // 2+ candidates — interactive picker. Falls back to "first one"
    // in non-TTY mode so scripted runs (e.g. tests) still work; we
    // print a hint so the user understands what happened.
    if (opts.mode !== "repl" && !process.stdin.isTTY) {
      chosen = candidates.candidates[0];
      ui.warn(
        `Multiple sources match this URL; picked "${chosen.id}". ` +
          `Pass --source <id> to choose explicitly.`
      );
    } else {
      const picked = await pickOne(
        `  Multiple sources match this URL — which one should own it?`,
        candidates.candidates.map((s) => ({
          label: s.id,
          value: s.id,
          note: `${s.kind}${s.name && s.name !== s.id ? ` · ${s.name}` : ""}`,
        })),
        null
      );
      if (picked === null) {
        ui.print(`  ${ui.dim("Aborted.")}`);
        return 0;
      }
      chosen = candidates.candidates.find((s) => s.id === picked) ?? null;
      if (!chosen) {
        ui.error("Picker returned an unknown source id — please retry.");
        return 1;
      }
    }
  }

  // Mutate + (optionally) sync.
  let result: Awaited<ReturnType<typeof addDocByUrl>>;
  try {
    if (opts.runSync) {
      result = await ui.spinner(
        `Adding to ${chosen.id} and syncing`,
        async () =>
          await addDocByUrl(workspaceRoot, url, {
            source: chosen as Source,
            runSync: true,
          })
      );
    } else {
      result = await addDocByUrl(workspaceRoot, url, {
        source: chosen,
        runSync: false,
      });
    }
  } catch (err) {
    ui.error(`Failed to add: ${(err as Error).message}`);
    return 1;
  }

  if (result.alreadyPinned) {
    ui.info(
      `URL was already pinned in source ${ui.bold(result.source.id)} — refreshed.`
    );
  } else {
    ui.success(`Added to source ${ui.bold(result.source.id)}.`);
  }

  if (result.sync) {
    printSyncSummaryForSource(result.sync, result.source.id);
  } else {
    ui.print(
      `  ${ui.dim("Sync skipped — run `/sync` to fetch the document body.")}`
    );
  }

  // Follow-up instructions for the AI agent reading this terminal.
  // The agent should ingest the newly-added doc and write a
  // summary.md sibling that future agents can use for keyword-
  // based discovery without re-reading the full body.
  if (!result.alreadyPinned) {
    printSummaryRequestForAgent(result.source.id, result.docId);
  }
  return 0;
}

/**
 * Print a clearly-delimited "next step for the assistant" block
 * after a successful `/doc add`. The agent reading the terminal
 * scrollback sees an unambiguous instruction with a specific
 * output path — no need to guess where summary.md should land
 * or what it should contain.
 *
 * Why phrase the instruction this way (with section headers
 * and bullet points)? Two reasons:
 *   - LLM-readable: the structure makes it trivial for an agent
 *     to extract the action items (path, fields to include).
 *   - Human-readable: a developer scrolling through the
 *     transcript can see what the agent is supposed to do next,
 *     and can intervene if it doesn't.
 */
function printSummaryRequestForAgent(
  sourceId: string,
  docId: string,
  opts: { manual?: boolean } = {}
): void {
  const folder = `.atelier/docs/${sourceId}/${encodeDocFilenameStem(docId)}`;
  // The docId is opaque (often a Graph ID with `::` separators);
  // when suggesting `--doc source:docId` we have to escape any
  // existing colons in the docId. parseDocRefs in feature/spec
  // handles `source:docId` cleanly because it splits at the FIRST
  // colon only. So `gh:my-org/repo#42` works; SharePoint IDs with
  // `::` inside also work because the split is single-colon.
  const docRef = `${sourceId}:${docId}`;
  ui.blank();
  ui.print(ui.bold("Next step for the assistant"));
  let step = 1;
  // Step 1 (manual docs only): suggest a more descriptive filename
  // based on the body. Manually-typed names tend to be placeholders
  // ("notes", "draft", "untitled-1"); the agent can read the body
  // and propose a slug that reflects the content. The rename has
  // to happen BEFORE summary.md is written, since summary.md goes
  // into the renamed folder.
  if (opts.manual) {
    ui.print(
      `  ${step}. Read the doc body. If the filename ${ui.cyan(`"${docId}"`)} looks generic`
    );
    ui.print(
      "     or doesn't reflect the content, propose a more descriptive slug:"
    );
    ui.print(
      `       ${ui.cyan(`/doc rename ${sourceId} ${docId} <better-slug>`)}`
    );
    ui.print(
      "     Use lowercase letters, digits, and hyphens. Confirm with the user"
    );
    ui.print(
      "     before running. If you rename, continue the remaining steps with"
    );
    ui.print("     the new docId in the paths below.");
    ui.blank();
    step++;
  }
  ui.print(
    `  ${step}. Read the doc and write a summary at:  ${ui.cyan(`${folder}/summary.md`)}`
  );
  ui.blank();
  ui.print("     The summary should include:");
  ui.print("       - A 1–2 sentence overview of what the document is about.");
  ui.print(
    "       - 5–10 keywords for future agent discovery — topics, dates,"
  );
  ui.print(
    "         project names, people, decisions made. One per line under"
  );
  ui.print("         a `## Keywords` heading.");
  ui.print(
    "       - The doc's anchor points: section titles or key data the"
  );
  ui.print("         body covers, under a `## Anchors` heading.");
  ui.blank();
  ui.print("     Inputs available in the same folder:");
  ui.print(`       ${ui.dim(folder + "/parsed.md")}      — markdown body (read this)`);
  ui.print(
    `       ${ui.dim(folder + "/original.<ext>")} — original source file (only consult if parsed.md is incomplete)`
  );
  ui.blank();
  step++;
  ui.print(
    `  ${step}. Suggest how this doc maps to the workspace's features and specs.`
  );
  ui.print(
    `     Skim the keywords + anchors from step 1 against existing entries:`
  );
  ui.print(`       ${ui.dim("/feature list")}     — see what's tracked`);
  ui.print(`       ${ui.dim("/spec list")}        — see active specs`);
  ui.blank();
  ui.print(
    "     If the doc describes work that's NOT yet tracked, propose creating"
  );
  ui.print("     a new entry with this doc already attached:");
  ui.print(
    `       ${ui.cyan(`/feature add "<name>" --doc ${docRef}`)}`
  );
  ui.print(
    `       ${ui.cyan(`/spec new "<title>" --doc ${docRef}`)}`
  );
  ui.blank();
  ui.print(
    "     If the doc informs an EXISTING feature/spec, append the doc ref"
  );
  ui.print(
    `     to its YAML directly — there's no \`update --doc\` subcommand yet.`
  );
  ui.print("     For a feature at `.atelier/features/<id>.yaml`, add under");
  ui.print(
    `     \`docRefs:\` a new entry: \`- {source: ${sourceId}, docId: "${docId}"}\``
  );
  ui.print("     (specs follow the same shape under `.atelier/specs/<id>/`).");
  ui.blank();
  ui.print(
    "     Always confirm the mapping with the user before running or editing."
  );
  ui.blank();
}

/**
 * Unified `/doc add` prompt: ask for a filename OR a URL.
 *
 *   - URL → run it through the same classify/retrieve pipeline
 *     as the positional URL form. If classification or source
 *     matching fails (unsupported URL shape, no source onboarded
 *     for the kind/tenant), gracefully fall back to the editor
 *     flow with the URL preserved in front-matter so the doc is
 *     still tracked even when we can't auto-fetch.
 *   - Anything else → treat as a filename and open the editor.
 *
 * One prompt covers both paths. The user doesn't need to remember
 * which subcommand fits — paste a URL or type a name, atelier
 * figures it out.
 */
async function runUnifiedPrompt(
  workspaceRoot: string,
  mode: InvocationMode
): Promise<number> {
  const session = new PromptSession();
  let input: string;
  try {
    input = (await session.ask("Filename or URL")).trim();
  } finally {
    session.close();
  }
  if (!input) {
    ui.error("Filename or URL is required.");
    return 2;
  }
  if (looksLikeUrl(input)) {
    return await runUrlOrFallbackToEditor(workspaceRoot, input, mode);
  }
  return await runEditorAdd(workspaceRoot, mode, { filename: input });
}

/**
 * URL path with editor fallback. We pre-flight the URL through
 * `resolveDocUrlCandidates` (the same classifier the positional
 * form uses). If the URL can't be classified — or it can be, but
 * no compatible source is registered — fall back to the editor
 * with the URL pre-filled on the resulting manual doc.
 *
 * Failures BEYOND classification (Graph 401 at sync time, network
 * errors, etc.) are NOT caught here: those mean credentials are
 * broken or the source is mid-degradation, and the user wants to
 * see the real error so they can fix it. The fallback is reserved
 * for "we can't even attempt to fetch" cases.
 */
async function runUrlOrFallbackToEditor(
  workspaceRoot: string,
  url: string,
  mode: InvocationMode
): Promise<number> {
  try {
    await resolveDocUrlCandidates(workspaceRoot, url);
  } catch (err) {
    if (
      err instanceof UnsupportedDocUrlError ||
      err instanceof NoMatchingSourceError
    ) {
      ui.warn(`Auto-fetch unavailable: ${(err as Error).message}`);
      ui.print(
        `  ${ui.dim("Falling back to manual entry — the URL will be saved on the doc.")}`
      );
      ui.blank();
      return await runEditorAdd(workspaceRoot, mode, { url });
    }
    throw err;
  }
  // Pre-flight passed → proceed with the normal URL flow.
  return await runAddByUrl(workspaceRoot, url, {
    sourceHint: undefined,
    runSync: true,
    mode,
  });
}

/**
 * Editor-driven manual add. Like `git commit` without `-m`:
 *
 *   1. Prompt for the filename (required) and an optional title —
 *      or accept them via `opts` when called from the unified
 *      prompt that already collected the filename.
 *   2. Drop a markdown scaffold (`# <title>\n\n`) into a temp file,
 *      including the URL as a "Source:" link when present so the
 *      user has context while editing.
 *   3. Spawn `$EDITOR` (or $VISUAL, falling back to `vi` / `notepad`)
 *      on the temp file with `stdio: "inherit"` — the editor owns
 *      the terminal until the user saves and quits.
 *   4. Read the result, write it as `.atelier/docs/manual/<docId>/
 *      parsed.md` via the normal addDoc path. The URL (when
 *      provided) lands in front-matter so the doc remembers where
 *      it came from. Empty / unchanged content gets a friendly
 *      "did your editor exit before saving?" hint (common when
 *      `$EDITOR=code` without `-w`).
 *
 * Why source = "manual" hard-coded:
 *   These docs aren't sync'd from anywhere — they're authored in
 *   the workspace itself. We bypass sources.yaml validation so the
 *   user doesn't need to register a synthetic "manual" source to
 *   use the editor. The `manual/` folder under `.atelier/docs/`
 *   gets created on first save and is picked up by `/doc list`
 *   naturally (listDocs scans every source folder it finds).
 *
 * Why terminal-native over a GUI editor: terminals can't actually
 * render rich text, AND pasting from Word into a terminal strips
 * formatting at the OS level (only `text/plain` reaches the app —
 * the `text/html` clipboard variant never gets there). Whatever
 * editor the user has set up — vim, nano, code -w, helix — handles
 * paste and markdown editing far better than we could roll ourselves,
 * and it works in SSH / headless sessions where a GUI can't.
 */
async function runEditorAdd(
  workspaceRoot: string,
  mode: InvocationMode,
  opts: { filename?: string; url?: string } = {}
): Promise<number> {
  // Filename + title prompts. Skip the filename prompt when the
  // caller (unified prompt) already collected it. Title is always
  // optional and defaults to the filename.
  const session = new PromptSession();
  let filename: string;
  let title: string;
  try {
    filename = opts.filename?.trim() ?? "";
    if (!filename) {
      filename = (await session.ask("Filename")).trim();
      if (!filename) {
        ui.error("Filename is required.");
        return 2;
      }
    }
    title = (await session.ask("Title (optional)", { default: filename })).trim();
  } finally {
    session.close();
  }

  const docId = normalizeFilenameToDocId(filename);
  if (!docId) {
    ui.error(`Filename "${filename}" doesn't produce a usable docId.`);
    return 2;
  }

  // Temp file pre-seeded with a markdown scaffold so the user
  // starts with structure, not a blank page. Lives under tmpdir
  // so unsaved drafts don't litter the workspace. When a URL is
  // attached (fallback path from a failed auto-fetch), include it
  // as a quoted source line so the user has context while editing —
  // they can leave it as-is or trim it; the URL is also persisted
  // in front-matter by addDoc below regardless.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "atelier-edit-"));
  const tmpFile = path.join(tmpDir, docId + ".md");
  const sourceLine = opts.url ? `> Source: ${opts.url}\n\n` : "";
  const scaffold = `# ${title}\n\n${sourceLine}`;
  await fs.writeFile(tmpFile, scaffold, "utf8");

  ui.print(`  ${ui.dim(`Opening ${editorCommandHint()} on ${tmpFile}…`)}`);
  try {
    await runEditorOnFile(tmpFile);
  } catch (err) {
    await fs.rm(tmpDir, { recursive: true, force: true });
    ui.error(`Editor failed: ${(err as Error).message}`);
    return 1;
  }

  const content = await fs.readFile(tmpFile, "utf8");
  await fs.rm(tmpDir, { recursive: true, force: true });

  // Distinguish "user closed the editor with no edits" from
  // "user genuinely typed nothing". If the content equals the
  // scaffold, they didn't edit. If it's empty entirely, the editor
  // probably exited before saving (e.g. `code` without `-w`).
  if (content === scaffold || content.trim().length === 0) {
    ui.info("Nothing saved.");
    if (!hasWaitingEditor()) {
      ui.print(
        `  ${ui.dim("Hint: if your editor opens but returns immediately (VS Code, Sublime),")}`
      );
      ui.print(
        `  ${ui.dim('set EDITOR="code -w" or "subl -w" so atelier waits for you to save and close.')}`
      );
    }
    return 0;
  }

  try {
    await addDoc(workspaceRoot, {
      source: "manual",
      docId,
      title,
      body: content,
      url: opts.url,
      fetchedAt: new Date().toISOString(),
      skipSourceValidation: true,
    });
  } catch (err) {
    if (err instanceof DocAlreadyExistsError) {
      ui.error(
        `A manual doc with id "${docId}" already exists. ` +
          `Use a different filename, or remove the existing one with ` +
          `\`/doc remove manual ${docId}\` first.`
      );
      return 1;
    }
    if (err instanceof DocReferenceValidationError) {
      ui.error(err.message);
      return 1;
    }
    throw err;
  }
  ui.success(`Added manual doc ${ui.bold(docId)}.`);
  printSummaryRequestForAgent("manual", docId, { manual: true });
  void mode; // parity with runAddByUrl; may use later for next-step hints
  return 0;
}

/**
 * Spawn `$EDITOR` (or $VISUAL) on `file` with `stdio: "inherit"`.
 * Resolves when the editor exits with status 0; rejects on any
 * other exit code or spawn error.
 *
 * Tokenizing the env var with a simple `split` covers the common
 * cases (`code -w`, `subl -w`, `nvim --noplugin`). Embedded
 * quoted args won't survive the naive split — users with exotic
 * setups can wrap their editor in a shell script if they need
 * more complex argv.
 */
function runEditorOnFile(file: string): Promise<void> {
  const editorCmd = pickEditor();
  const [cmd, ...args] = editorCmd.split(/\s+/).filter(Boolean);
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, [...args, file], { stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0 || code === null) resolve();
      else
        reject(
          new Error(
            `editor "${editorCmd}" exited with ${signal ? "signal " + signal : "code " + code}`
          )
        );
    });
  });
}

/** Resolve which editor command to run. Honors $VISUAL → $EDITOR
 *  → platform default. Returns the command-line string verbatim
 *  so callers can split + spawn. */
function pickEditor(): string {
  // `||` (not `??`) so an empty string in either env var falls
  // through to the next option. That matches what every other
  // tool that respects $EDITOR does — a literal `EDITOR=""` is
  // treated the same as not setting it.
  const fromEnv = ((process.env.VISUAL || process.env.EDITOR) ?? "").trim();
  if (fromEnv) return fromEnv;
  return process.platform === "win32" ? "notepad" : "vi";
}

/** Friendly label for the status line printed before the editor opens. */
function editorCommandHint(): string {
  const e = pickEditor();
  return e === "vi" || e === "notepad" ? `the default editor (${e})` : `\`${e}\``;
}

/** Best-effort detection of editors that we know wait for the
 *  file to close before exiting. Used to decide whether to print
 *  the "set EDITOR=code -w" hint when nothing was saved. */
function hasWaitingEditor(): boolean {
  const e = pickEditor();
  // vi/vim/nvim/nano/emacs/pico/helix all block by default.
  if (/^(vi|vim|nvim|nano|emacs|pico|hx|helix|micro|notepad)/.test(e)) return true;
  // VS Code / Sublime / Atom variants need -w or --wait.
  if (/\b(-w|--wait)\b/.test(e)) return true;
  return false;
}

/**
 * Convert a user-typed filename into a docId. We normalize
 * spaces → hyphens and strip any trailing extension so an entry
 * the user types as "Onboarding PRD" lands as `onboarding-prd`
 * rather than `Onboarding%20PRD`. Letters/digits/hyphens/dots/
 * underscores survive; everything else is discarded.
 */
function normalizeFilenameToDocId(raw: string): string {
  const trimmed = raw.trim();
  // Drop a single trailing extension (`onboarding.md` → `onboarding`).
  const withoutExt = trimmed.replace(/\.(md|txt)$/i, "");
  const slug = withoutExt
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return slug;
}

/** Compact post-add summary — focuses on the single source we touched. */
function printSyncSummaryForSource(report: SyncReport, sourceId: string): void {
  const ours = report.sources.find((s) => s.source === sourceId);
  if (!ours) {
    const skip = report.skipped.find((s) => s.sourceId === sourceId);
    if (skip) {
      ui.warn(`Sync skipped this source: ${skip.reason}`);
    }
    return;
  }
  const counts = { created: 0, updated: 0, unchanged: 0, orphaned: 0, removed: 0 };
  for (const a of ours.actions) counts[a.action]++;
  ui.print(
    `  ${ui.dim("synced:")} +${counts.created} created · ~${counts.updated} updated · =${counts.unchanged} unchanged`
  );
  if (ours.errors.length > 0) {
    ui.warn(`${ours.errors.length} error(s) while fetching:`);
    for (const e of ours.errors) {
      ui.print(`    ${ui.red("✗")} ${e.docId ?? "(general)"}: ${e.error.message}`);
    }
  }
}

/**
 * Manual / "no URL" path.
 *
 * Two sub-modes, depending on what the user supplied:
 *
 *   - **Editor mode** (the human path). Triggered when the user
 *     runs `/doc add` with NO URL and NO flags. Atelier spawns a
 *     localhost HTTP server hosting a chromeless rich-text editor
 *     and waits for the user to type/paste their content and hit
 *     save. The resulting markdown lands in `.atelier/docs/manual/
 *     <filename>/parsed.md` and the same agent follow-up block
 *     prints as for the URL flow.
 *
 *   - **Scripted mode**. Triggered when the user passes
 *     `--source / --doc-id / --title` explicitly. Useful for tests
 *     and tooling that wants to pre-create entries; bypasses the
 *     editor entirely.
 */
async function runManualAdd(
  workspaceRoot: string,
  values: Record<string, unknown>,
  mode: InvocationMode
): Promise<number> {
  const source = values.source as string | undefined;
  const docId = values["doc-id"] as string | undefined;
  const title = values.title as string | undefined;
  // No flags at all → unified prompt: ask the user for a filename
  // OR a URL, and route based on what they typed. URL goes through
  // the same classify/retrieve pipeline as the positional form;
  // anything else goes to the editor.
  if (!source && !docId && !title) {
    return await runUnifiedPrompt(workspaceRoot, mode);
  }
  // Partial flags are a user error — we don't want to half-fill
  // a doc with editor output AND ignored CLI flags.
  if (!source || !docId || !title) {
    ui.error("Missing required option(s).");
    ui.print(
      `  ${ui.dim("Tip: paste a URL — `/doc add <url>` — or run `/doc add` with no args for the editor.")}`
    );
    ui.print(
      `  ${ui.dim("Scripted form: /doc add --source <id> --doc-id <id> --title <title> [options]")}`
    );
    return 2;
  }
  const classification = values.classification as string | undefined;
  if (classification !== undefined && !validClassification(classification)) {
    ui.error(
      `Invalid classification "${classification}". Valid: ${DOC_CLASSIFICATIONS.join(", ")}.`
    );
    return 2;
  }

  let body: string | undefined;
  if (values["body-file"]) {
    try {
      body = await fs.readFile(values["body-file"] as string, "utf8");
    } catch (err) {
      ui.error(`Could not read --body-file: ${(err as Error).message}`);
      return 1;
    }
  }

  try {
    const doc = await addDoc(workspaceRoot, {
      source,
      docId,
      title,
      summary: values.summary as string | undefined,
      classification: classification as DocClassification | undefined,
      url: values.url as string | undefined,
      body,
      fetchedAt: body !== undefined ? new Date().toISOString() : undefined,
      skipSourceValidation: values["no-validate-source"] === true,
    });
    ui.success(`Indexed doc ${ui.bold(doc.docId)} in source ${ui.bold(doc.source)}`);
    ui.blank();
    ui.print(`  ${ui.dim("Title:")}          ${doc.title}`);
    if (doc.summary) ui.print(`  ${ui.dim("Summary:")}        ${doc.summary}`);
    if (doc.classification) {
      ui.print(`  ${ui.dim("Classification:")} ${doc.classification}`);
    }
    if (doc.url) ui.print(`  ${ui.dim("URL:")}            ${doc.url}`);
    ui.blank();
    return 0;
  } catch (err) {
    if (err instanceof DocAlreadyExistsError || err instanceof DocReferenceValidationError) {
      ui.error(err.message);
      return 1;
    }
    throw err;
  }
}

const listCmd: Command = {
  name: "list",
  summary: "List indexed documents.",
  options: {
    source: { type: "string", short: "s" },
    classification: { type: "string", short: "c" },
  },
  async run({ values, cwd, mode }) {
    let sourceFilter = values.source as string | undefined;
    const classFilter = values.classification as string | undefined;
    if (classFilter !== undefined && !validClassification(classFilter)) {
      ui.error(
        `Invalid --classification "${classFilter}". Valid: ${DOC_CLASSIFICATIONS.join(", ")}.`
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

    // Interactive picker when run from the REPL without an
    // explicit --source: lets the user pick a source (or
    // "All sources") instead of having to remember the id.
    if (sourceFilter === undefined && mode === "repl") {
      const picked = await pickSourceOrAll(workspaceRoot, {
        question: "Filter to which source?",
        help: "Pick a source to narrow the list, or leave on 'All sources' for everything.",
      });
      if (picked === null) {
        ui.print(`  ${ui.dim("Aborted.")}`);
        return 0;
      }
      sourceFilter = picked;
    }

    const { docs, errors } = await listDocs(workspaceRoot, sourceFilter);
    const filtered = classFilter
      ? docs.filter((d) => d.doc.classification === classFilter)
      : docs;

    if (filtered.length === 0 && errors.length === 0) {
      if (sourceFilter || classFilter) {
        ui.info("No docs match the filter.");
      } else {
        const addHint = mode === "repl" ? "/doc add <url>" : "atelier doc add <url>";
        ui.info("No docs indexed yet.");
        ui.print(
          `  ${ui.dim(`Paste a URL with \`${addHint}\` to start tracking documents.`)}`
        );
      }
      return 0;
    }

    if (filtered.length > 0) {
      const sourceWidth = Math.max(
        "SOURCE".length,
        ...filtered.map((d) => d.doc.source.length)
      );
      const docIdWidth = Math.max(
        "DOC-ID".length,
        ...filtered.map((d) => d.doc.docId.length)
      );
      const classWidth = Math.max(
        "CLASS".length,
        ...filtered.map((d) => (d.doc.classification ?? "-").length)
      );
      ui.print(
        `    ${ui.dim("SOURCE".padEnd(sourceWidth))}  ${ui.dim("DOC-ID".padEnd(docIdWidth))}  ${ui.dim("CLASS".padEnd(classWidth))}  ${ui.dim("TITLE")}`
      );
      for (const { doc } of filtered) {
        const cls = doc.classification ?? "-";
        ui.print(
          `  ${ui.green("·")} ${doc.source.padEnd(sourceWidth)}  ${doc.docId.padEnd(docIdWidth)}  ${cls.padEnd(classWidth)}  ${doc.title}`
        );
      }
      ui.blank();
    }

    if (errors.length > 0) {
      ui.warn(`${errors.length} doc file(s) failed to parse:`);
      for (const e of errors) {
        ui.print(`    ${ui.red("✗")} ${e.filePath}`);
        ui.print(`      ${ui.dim(e.error.message.split("\n")[0])}`);
      }
      ui.blank();
    }
    return 0;
  },
};

const showCmd: Command = {
  name: "show",
  summary: "Show a doc's metadata and body.",
  positionals: ["source", "docId"],
  async run({ positionals, cwd }) {
    const [source, docId] = positionals;
    if (!source || !docId) {
      ui.error("Usage: atelier doc show <source> <docId>");
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
      const doc = await loadDoc(workspaceRoot, source, docId);
      ui.print(ui.bold(doc.title));
      ui.print(`  ${ui.dim("source:")}         ${doc.source}`);
      ui.print(`  ${ui.dim("docId:")}          ${doc.docId}`);
      if (doc.classification) {
        ui.print(`  ${ui.dim("classification:")} ${doc.classification}`);
      }
      if (doc.summary) ui.print(`  ${ui.dim("summary:")}        ${doc.summary}`);
      if (doc.url) ui.print(`  ${ui.dim("url:")}            ${doc.url}`);
      if (doc.lastFetched) {
        ui.print(`  ${ui.dim("lastFetched:")}    ${doc.lastFetched}`);
      }
      if (doc.contentHash) {
        ui.print(`  ${ui.dim("contentHash:")}    ${doc.contentHash}`);
      }
      ui.print(`  ${ui.dim("created:")}        ${doc.createdAt}`);
      ui.print(`  ${ui.dim("updated:")}        ${doc.updatedAt}`);
      ui.blank();
      if (doc.body) {
        process.stdout.write(doc.body);
        if (!doc.body.endsWith("\n")) ui.blank();
      } else {
        ui.print(ui.dim("(empty body)"));
      }
      return 0;
    } catch (err) {
      if (err instanceof DocNotFoundError || err instanceof DocFileError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

const removeCmd: Command = {
  name: "remove",
  summary: "Remove a doc from the index.",
  positionals: ["source", "docId"],
  async run({ positionals, cwd }) {
    const [source, docId] = positionals;
    if (!source || !docId) {
      ui.error("Usage: atelier doc remove <source> <docId>");
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
      const doc = await removeDoc(workspaceRoot, source, docId);
      ui.success(`Removed doc ${ui.bold(doc.docId)} from source ${ui.bold(doc.source)}`);
      return 0;
    } catch (err) {
      if (err instanceof DocNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

const renameCmd: Command = {
  name: "rename",
  summary: "Rename a doc (change its docId / filename).",
  description:
    "Moves the doc's folder under .atelier/docs/<source>/ and rewrites the\n" +
    "parsed.md front-matter so docId matches the new name. Most useful for\n" +
    "manual docs where the initial filename was a placeholder — atelier's\n" +
    "/doc add flow prints an agent follow-up that suggests calling this\n" +
    "after the doc body has been written.",
  positionals: ["source", "oldDocId", "newDocId"],
  async run({ positionals, cwd }) {
    const [source, oldDocId, newDocId] = positionals;
    if (!source || !oldDocId || !newDocId) {
      ui.error("Usage: atelier doc rename <source> <oldDocId> <newDocId>");
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
      const doc = await renameDoc(workspaceRoot, source, oldDocId, newDocId);
      ui.success(
        `Renamed ${ui.bold(oldDocId)} → ${ui.bold(doc.docId)} in source ${ui.bold(doc.source)}`
      );
      return 0;
    } catch (err) {
      if (err instanceof DocNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      if (err instanceof DocAlreadyExistsError) {
        ui.error(
          `Can't rename: a doc with id "${newDocId}" already exists in source "${source}".`
        );
        return 1;
      }
      throw err;
    }
  },
};

const updateCmd: Command = {
  name: "update",
  summary: "Update a doc's metadata or body.",
  description:
    "Patches selected fields on an existing doc entry. Body is read from\n" +
    "the file at --body-file when present; passing it always refreshes\n" +
    "lastFetched and contentHash.",
  positionals: ["source", "docId"],
  options: {
    title: { type: "string", short: "t" },
    summary: { type: "string" },
    classification: { type: "string", short: "c" },
    url: { type: "string", short: "u" },
    "body-file": { type: "string" },
  },
  async run({ positionals, values, cwd }) {
    const [source, docId] = positionals;
    if (!source || !docId) {
      ui.error("Usage: atelier doc update <source> <docId> [options]");
      return 2;
    }
    const classification = values.classification as string | undefined;
    if (classification !== undefined && classification !== "" && !validClassification(classification)) {
      ui.error(
        `Invalid classification "${classification}". Valid: ${DOC_CLASSIFICATIONS.join(", ")}.`
      );
      return 2;
    }

    let body: string | undefined;
    if (values["body-file"]) {
      try {
        body = await fs.readFile(values["body-file"] as string, "utf8");
      } catch (err) {
        ui.error(`Could not read --body-file: ${(err as Error).message}`);
        return 1;
      }
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
      const doc = await updateDoc(workspaceRoot, source, docId, {
        title: values.title as string | undefined,
        summary: values.summary as string | undefined,
        classification:
          classification === undefined
            ? undefined
            : classification === ""
              ? null
              : (classification as DocClassification),
        url: values.url as string | undefined,
        body,
      });
      ui.success(`Updated doc ${ui.bold(doc.docId)} in source ${ui.bold(doc.source)}`);
      return 0;
    } catch (err) {
      if (err instanceof DocNotFoundError) {
        ui.error(err.message);
        return 1;
      }
      throw err;
    }
  },
};

export const docCommand: Command = {
  name: "doc",
  summary: "Manage the doc map.",
  description:
    "The doc map is Atelier's index of every document a feature might\n" +
    "reference: PRDs, RFCs, runbooks, meeting transcripts. Each entry lives\n" +
    "at .atelier/docs/<source>/<doc-id>.md with structured metadata and the\n" +
    "document body. The recommended workflow is to onboard a source once\n" +
    "(`/source onboard <kind>`) and then add documents one at a time by\n" +
    "pasting their URLs (`/doc add <url>`).",
  subcommands: [addCmd, listCmd, showCmd, updateCmd, renameCmd, removeCmd],
};
