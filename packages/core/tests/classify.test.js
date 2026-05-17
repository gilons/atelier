import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDoc } from "../dist/index.js";

test("classifyDoc: github-discussions defaults to discussion", () => {
  assert.equal(
    classifyDoc({ kind: "github-discussions", title: "Some idea" }),
    "discussion"
  );
});

test("classifyDoc: github-discussions with roadmap label → roadmap", () => {
  assert.equal(
    classifyDoc({
      kind: "github-discussions",
      title: "Q2 plans",
      labels: ["roadmap", "team-platform"],
    }),
    "roadmap"
  );
});

test("classifyDoc: .vtt filename → transcript", () => {
  assert.equal(
    classifyDoc({
      kind: "sharepoint",
      title: "Standup-2026-05-17",
      filename: "Standup-2026-05-17.vtt",
    }),
    "transcript"
  );
});

test("classifyDoc: .srt filename → transcript", () => {
  assert.equal(
    classifyDoc({ kind: "sharepoint", title: "x", filename: "x.srt" }),
    "transcript"
  );
});

test("classifyDoc: body starting with WEBVTT → transcript", () => {
  assert.equal(
    classifyDoc({
      kind: "sharepoint",
      title: "Recording",
      body: "WEBVTT\n\n00:00:01.000 --> 00:00:04.000\n<v Alice>hi</v>\n",
    }),
    "transcript"
  );
});

test("classifyDoc: title with 'meeting' → meeting-notes", () => {
  assert.equal(
    classifyDoc({ kind: "notion", title: "Team meeting May 17" }),
    "meeting-notes"
  );
});

test("classifyDoc: title with 'standup' → meeting-notes", () => {
  assert.equal(
    classifyDoc({ kind: "notion", title: "Engineering Standup" }),
    "meeting-notes"
  );
});

test("classifyDoc: title with 'roadmap' → roadmap", () => {
  assert.equal(
    classifyDoc({ kind: "notion", title: "Q3 Roadmap" }),
    "roadmap"
  );
});

test("classifyDoc: title with PRD → prd", () => {
  assert.equal(
    classifyDoc({ kind: "notion", title: "CSV Export PRD" }),
    "prd"
  );
});

test("classifyDoc: returns undefined when no signal matches", () => {
  assert.equal(
    classifyDoc({ kind: "notion", title: "Random page title" }),
    undefined
  );
});

test("classifyDoc: github-discussions classification ignores transcript keywords", () => {
  // We trust the source signal: github-discussions are always
  // discussions even if the title mentions "transcript" (unusual but
  // possible).
  assert.equal(
    classifyDoc({ kind: "github-discussions", title: "Transcript review" }),
    "discussion"
  );
});
