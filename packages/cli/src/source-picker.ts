import { listSources, type Source } from "@atelier/core";
import { pickOne as interactivePickOne } from "./picker.js";
import { ui } from "./ui.js";

/**
 * Interactive helper: prompt the user to pick a registered source
 * (or "all sources"). Used by `/sync` and `/doc list` when the
 * user didn't pass `--source <id>` and we don't want to make them
 * remember IDs.
 *
 * Return contract:
 *
 *   - `undefined` → user picked **All sources** (or there are no
 *     sources to filter — nothing to do anyway). Caller should
 *     treat as "no source filter", which is the default behavior
 *     of every command that takes `--source`.
 *
 *   - `string`    → the chosen source id.
 *
 *   - `null`      → user cancelled (Esc/Ctrl-C). Caller should
 *     abort the command without writing anything.
 *
 * The picker only fires when there are 2+ sources. With one
 * source, "all" and "that source" are the same thing, so we
 * skip the prompt. With zero, we return `undefined` and let
 * the command print its own "no sources" message.
 */
export async function pickSourceOrAll(
  workspaceRoot: string,
  opts: {
    /** Prompt text shown above the picker. */
    question: string;
    /** Short hint shown above the options. Optional. */
    help?: string;
    /** Skip the picker when there are this-many-or-fewer sources. Default 1. */
    skipBelow?: number;
  }
): Promise<string | undefined | null> {
  const skipBelow = opts.skipBelow ?? 1;
  const sources = await listSources(workspaceRoot);
  if (sources.length <= skipBelow) {
    // 0 or 1 source — picker would be theater. Treat as "all".
    return undefined;
  }
  if (opts.help) ui.print(`  ${ui.dim(opts.help)}`);
  const picked = await interactivePickOne(
    `  ${opts.question}`,
    [
      // Synthetic option at the top: a sentinel string that the
      // caller maps to "no filter". The pickOne API requires a
      // string value, so we use an empty string and document it.
      {
        label: "All sources",
        value: "",
        note: `sync/list across all ${sources.length} sources`,
        recommended: true,
      },
      ...sources.map(sourceToChoice),
    ],
    null
  );
  if (picked === null) return null; // cancelled
  if (picked === "") return undefined; // "all"
  return picked;
}

function sourceToChoice(s: Source): {
  label: string;
  value: string;
  note?: string;
} {
  // The id is what the user wants to *act on*. The kind + name is
  // what helps them recognize which source it is. Showing both
  // covers "I remember it was the github one" and "I remember the
  // id" cases.
  return {
    label: s.id,
    value: s.id,
    note: `${s.kind}${s.name && s.name !== s.id ? ` · ${s.name}` : ""}`,
  };
}
