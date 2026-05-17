import type { DocClassification, SourceKind } from "./types.js";

/**
 * Best-effort heuristic classifier.
 *
 * Adapters use this to seed each doc's `classification`. The
 * synthesis layer (Phase 3) will refine these once we can ask the
 * user's coding agent. Until then, source-signal heuristics give us
 * a meaningful default without LLM cost — and a starting point the
 * user can override by hand.
 *
 * Decisions in priority order:
 *
 *   1. Source kind alone implies a default
 *      (github-discussions → discussion).
 *   2. Filename extension catches transcripts (.vtt, .srt).
 *   3. Title and (cheaply) the first few hundred chars of the body
 *      are scanned for keyword markers.
 *   4. Fall through to undefined — we don't claim "other" because
 *      that's an explicit user choice.
 */

export interface ClassifyInput {
  kind: SourceKind;
  title: string;
  /** Optional filename (only meaningful for local-folder + sharepoint). */
  filename?: string;
  /** Optional body — only scanned cheaply (first 500 chars). */
  body?: string;
  /** Labels/tags supplied by the source. */
  labels?: string[];
}

export function classifyDoc(input: ClassifyInput): DocClassification | undefined {
  // 1. Source kind defaults.
  if (input.kind === "github-discussions") {
    // Discussions look like discussions — but they might also be
    // roadmap-flavored if explicitly labeled.
    if (input.labels?.some((l) => /roadmap/i.test(l))) return "roadmap";
    return "discussion";
  }

  // 2. Filename → transcript.
  const fname = (input.filename ?? "").toLowerCase();
  if (fname.endsWith(".vtt") || fname.endsWith(".srt")) return "transcript";

  // 3. Title-based heuristics.
  const title = input.title.toLowerCase();
  if (/\btranscript\b/.test(title)) return "transcript";
  if (/\b(meeting|standup|stand-?up|1:1|1-on-1)\b/.test(title)) {
    return "meeting-notes";
  }
  if (/\b(roadmap|q[1-4]\s+plan)\b/.test(title)) return "roadmap";
  if (/\bprd\b|product\s+requirement/.test(title)) return "prd";
  if (/^rfc\b|\srfc\s/.test(title)) return "rfc";
  if (/\bdesign\b/.test(title)) return "design";
  if (/\b(runbook|playbook|incident)\b/.test(title)) return "runbook";
  if (/\b(policy|guideline|standard)\b/.test(title)) return "policy";

  // 4. Cheap body scan — only the first ~500 chars so we don't pay
  //    for a regex over a 50k-character page.
  if (input.body && input.body.length > 0) {
    const head = input.body.slice(0, 500).toLowerCase();
    // VTT files start with "WEBVTT" on the first line.
    if (head.startsWith("webvtt")) return "transcript";
    // Meeting transcript fingerprint: speaker timestamps like
    //   "[00:00:01] Alice: ..." or "Alice  0:01"
    if (/^\s*\d{1,2}:\d{2}(:\d{2})?\s+[a-z]/im.test(head)) return "transcript";
  }

  return undefined;
}
