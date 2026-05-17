import { test } from "node:test";
import assert from "node:assert/strict";
import { decodeKeys, applyEdit, acceptSuggestion } from "../dist/input-keys.js";

// ============================================================
// decodeKeys
// ============================================================

test("decodeKeys: plain characters", () => {
  assert.deepEqual(decodeKeys("abc"), [
    { type: "char", value: "a" },
    { type: "char", value: "b" },
    { type: "char", value: "c" },
  ]);
});

test("decodeKeys: enter (CR and LF both)", () => {
  assert.deepEqual(decodeKeys("\r"), [{ type: "enter" }]);
  assert.deepEqual(decodeKeys("\n"), [{ type: "enter" }]);
});

test("decodeKeys: backspace via 0x7f and 0x08", () => {
  assert.deepEqual(decodeKeys("\x7f"), [{ type: "backspace" }]);
  assert.deepEqual(decodeKeys("\b"), [{ type: "backspace" }]);
});

test("decodeKeys: tab", () => {
  assert.deepEqual(decodeKeys("\t"), [{ type: "tab" }]);
});

test("decodeKeys: arrow keys", () => {
  assert.deepEqual(decodeKeys("\x1b[A"), [{ type: "up" }]);
  assert.deepEqual(decodeKeys("\x1b[B"), [{ type: "down" }]);
  assert.deepEqual(decodeKeys("\x1b[C"), [{ type: "right" }]);
  assert.deepEqual(decodeKeys("\x1b[D"), [{ type: "left" }]);
});

test("decodeKeys: home/end via CSI", () => {
  assert.deepEqual(decodeKeys("\x1b[H"), [{ type: "home" }]);
  assert.deepEqual(decodeKeys("\x1b[F"), [{ type: "end" }]);
  assert.deepEqual(decodeKeys("\x1b[1~"), [{ type: "home" }]);
  assert.deepEqual(decodeKeys("\x1b[4~"), [{ type: "end" }]);
});

test("decodeKeys: delete-forward via CSI 3~", () => {
  assert.deepEqual(decodeKeys("\x1b[3~"), [{ type: "delete-forward" }]);
});

test("decodeKeys: bare ESC", () => {
  assert.deepEqual(decodeKeys("\x1b"), [{ type: "escape" }]);
});

test("decodeKeys: control codes", () => {
  assert.deepEqual(decodeKeys("\x01"), [{ type: "ctrl-a" }]);
  assert.deepEqual(decodeKeys("\x03"), [{ type: "ctrl-c" }]);
  assert.deepEqual(decodeKeys("\x04"), [{ type: "ctrl-d" }]);
  assert.deepEqual(decodeKeys("\x05"), [{ type: "ctrl-e" }]);
  assert.deepEqual(decodeKeys("\x0b"), [{ type: "ctrl-k" }]);
  assert.deepEqual(decodeKeys("\x15"), [{ type: "ctrl-u" }]);
  assert.deepEqual(decodeKeys("\x17"), [{ type: "ctrl-w" }]);
});

test("decodeKeys: multi-key chunk", () => {
  const keys = decodeKeys("ab\x1b[A\r");
  assert.deepEqual(keys, [
    { type: "char", value: "a" },
    { type: "char", value: "b" },
    { type: "up" },
    { type: "enter" },
  ]);
});

test("decodeKeys: unknown CSI sequence falls through cleanly", () => {
  // Mode-set sequence — not one we handle, but shouldn't crash.
  const keys = decodeKeys("\x1b[?25l");
  assert.equal(keys.length, 1);
  assert.equal(keys[0].type, "unknown");
});

// ============================================================
// applyEdit
// ============================================================

test("applyEdit: insert at cursor", () => {
  const s = applyEdit({ buffer: "abc", cursor: 1 }, { type: "char", value: "X" });
  assert.equal(s.buffer, "aXbc");
  assert.equal(s.cursor, 2);
});

test("applyEdit: backspace at start is a no-op", () => {
  const s = applyEdit({ buffer: "abc", cursor: 0 }, { type: "backspace" });
  assert.deepEqual(s, { buffer: "abc", cursor: 0 });
});

test("applyEdit: backspace deletes char before cursor", () => {
  const s = applyEdit({ buffer: "abc", cursor: 2 }, { type: "backspace" });
  assert.deepEqual(s, { buffer: "ac", cursor: 1 });
});

test("applyEdit: delete-forward removes char at cursor", () => {
  const s = applyEdit({ buffer: "abc", cursor: 1 }, { type: "delete-forward" });
  assert.deepEqual(s, { buffer: "ac", cursor: 1 });
});

test("applyEdit: delete-forward at end is a no-op", () => {
  const s = applyEdit({ buffer: "abc", cursor: 3 }, { type: "delete-forward" });
  assert.deepEqual(s, { buffer: "abc", cursor: 3 });
});

test("applyEdit: left/right clamp at buffer boundaries", () => {
  assert.deepEqual(
    applyEdit({ buffer: "abc", cursor: 0 }, { type: "left" }),
    { buffer: "abc", cursor: 0 }
  );
  assert.deepEqual(
    applyEdit({ buffer: "abc", cursor: 3 }, { type: "right" }),
    { buffer: "abc", cursor: 3 }
  );
});

test("applyEdit: home and ctrl-a go to 0", () => {
  assert.equal(
    applyEdit({ buffer: "abc", cursor: 2 }, { type: "home" }).cursor,
    0
  );
  assert.equal(
    applyEdit({ buffer: "abc", cursor: 2 }, { type: "ctrl-a" }).cursor,
    0
  );
});

test("applyEdit: end and ctrl-e go to buffer length", () => {
  assert.equal(
    applyEdit({ buffer: "abc", cursor: 0 }, { type: "end" }).cursor,
    3
  );
  assert.equal(
    applyEdit({ buffer: "abc", cursor: 0 }, { type: "ctrl-e" }).cursor,
    3
  );
});

test("applyEdit: ctrl-u kills from start to cursor", () => {
  const s = applyEdit({ buffer: "hello world", cursor: 6 }, { type: "ctrl-u" });
  assert.deepEqual(s, { buffer: "world", cursor: 0 });
});

test("applyEdit: ctrl-k kills from cursor to end", () => {
  const s = applyEdit({ buffer: "hello world", cursor: 5 }, { type: "ctrl-k" });
  assert.deepEqual(s, { buffer: "hello", cursor: 5 });
});

test("applyEdit: ctrl-w deletes the previous word", () => {
  const s = applyEdit({ buffer: "hello world", cursor: 11 }, { type: "ctrl-w" });
  assert.deepEqual(s, { buffer: "hello ", cursor: 6 });
});

test("applyEdit: ctrl-w deletes trailing spaces then the word", () => {
  const s = applyEdit({ buffer: "foo bar   ", cursor: 10 }, { type: "ctrl-w" });
  assert.deepEqual(s, { buffer: "foo ", cursor: 4 });
});

// ============================================================
// acceptSuggestion
// ============================================================

test("acceptSuggestion: replaces span immediately to the left of cursor", () => {
  // Buffer: "/sou", cursor at 4, span "sou", value "source "
  const s = acceptSuggestion(
    { buffer: "/sou", cursor: 4 },
    "/sou",
    "/source "
  );
  assert.equal(s.buffer, "/source ");
  assert.equal(s.cursor, 8);
});

test("acceptSuggestion: replaces a mid-line span", () => {
  // Buffer "/repo a", cursor at 7, completer span "a" → "add "
  const s = acceptSuggestion(
    { buffer: "/repo a", cursor: 7 },
    "a",
    "add "
  );
  assert.equal(s.buffer, "/repo add ");
  assert.equal(s.cursor, 10);
});

test("acceptSuggestion: empty span inserts at cursor", () => {
  const s = acceptSuggestion(
    { buffer: "/repo ", cursor: 6 },
    "",
    "list"
  );
  assert.equal(s.buffer, "/repo list");
  assert.equal(s.cursor, 10);
});

test("acceptSuggestion: span mismatch falls back to insert at cursor", () => {
  const s = acceptSuggestion(
    { buffer: "/repo ", cursor: 6 },
    "xyz", // doesn't match anything before the cursor
    "list"
  );
  assert.equal(s.buffer, "/repo list");
  assert.equal(s.cursor, 10);
});
