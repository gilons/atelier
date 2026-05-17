/**
 * Keystroke decoder + line-buffer state machine for the REPL prompt.
 *
 * Two halves, both pure (no IO):
 *
 *   1. {@link decodeKey}    — translates a chunk of raw bytes from
 *      stdin (in raw mode) into one of a small set of named keys.
 *      Handles plain characters, modifier-free arrow keys, common
 *      control codes, and a handful of ANSI escape sequences.
 *
 *   2. {@link applyEdit}    — given the current input state and an
 *      "edit" key, returns the new state. Doesn't touch the screen
 *      — the input reader does the rendering separately.
 *
 * The state machine handles only buffer editing (insert / delete /
 * cursor move). Suggestion navigation, history, submit, and exit
 * are routed by the caller because they need access to the
 * completer / history / process exit.
 */

// ============================================================
// Key decoding
// ============================================================

export type Key =
  /** A printable character to insert. */
  | { type: "char"; value: string }
  | { type: "backspace" }
  | { type: "delete-forward" }
  | { type: "enter" }
  | { type: "tab" }
  | { type: "left" }
  | { type: "right" }
  | { type: "up" }
  | { type: "down" }
  | { type: "home" }
  | { type: "end" }
  | { type: "escape" }
  /** Ctrl-A — beginning of line. */
  | { type: "ctrl-a" }
  /** Ctrl-C — abort the prompt. */
  | { type: "ctrl-c" }
  /** Ctrl-D — EOF (only meaningful on empty buffer). */
  | { type: "ctrl-d" }
  /** Ctrl-E — end of line. */
  | { type: "ctrl-e" }
  /** Ctrl-K — kill from cursor to end of line. */
  | { type: "ctrl-k" }
  /** Ctrl-U — kill from start to cursor. */
  | { type: "ctrl-u" }
  /** Ctrl-W — delete previous word. */
  | { type: "ctrl-w" }
  /** Anything else — ignored. */
  | { type: "unknown"; raw: string };

/**
 * Decode the bytes from a single `data` event into one or more keys.
 *
 * Most user keystrokes arrive as a single chunk; multi-byte ANSI
 * escape sequences usually arrive in one chunk too because the OS
 * delivers them atomically. We don't bother with cross-chunk
 * stateful decoding for v1 — pathological terminals can fall
 * through to the `unknown` branch and be ignored.
 */
export function decodeKeys(chunk: string): Key[] {
  const keys: Key[] = [];
  let i = 0;
  while (i < chunk.length) {
    const ch = chunk[i];
    const code = chunk.charCodeAt(i);

    // ANSI escape sequence
    if (code === 0x1b) {
      // Try common CSI sequences first.
      // `\x1b[A` up, `\x1b[B` down, `\x1b[C` right, `\x1b[D` left
      // `\x1b[H` home, `\x1b[F` end, `\x1b[3~` delete-forward, etc.
      if (chunk[i + 1] === "[") {
        const seq = chunk[i + 2];
        if (seq === "A") { keys.push({ type: "up" }); i += 3; continue; }
        if (seq === "B") { keys.push({ type: "down" }); i += 3; continue; }
        if (seq === "C") { keys.push({ type: "right" }); i += 3; continue; }
        if (seq === "D") { keys.push({ type: "left" }); i += 3; continue; }
        if (seq === "H") { keys.push({ type: "home" }); i += 3; continue; }
        if (seq === "F") { keys.push({ type: "end" }); i += 3; continue; }
        if (seq === "3" && chunk[i + 3] === "~") {
          keys.push({ type: "delete-forward" });
          i += 4;
          continue;
        }
        if (seq === "1" && chunk[i + 3] === "~") {
          keys.push({ type: "home" });
          i += 4;
          continue;
        }
        if (seq === "4" && chunk[i + 3] === "~") {
          keys.push({ type: "end" });
          i += 4;
          continue;
        }
        // Unknown CSI — skip the whole sequence up to the final byte.
        let j = i + 2;
        while (j < chunk.length && !/[a-zA-Z~]/.test(chunk[j])) j++;
        keys.push({ type: "unknown", raw: chunk.slice(i, j + 1) });
        i = j + 1;
        continue;
      }
      // Bare ESC.
      keys.push({ type: "escape" });
      i++;
      continue;
    }

    // Control codes (0x01 – 0x1f, and 0x7f for backspace on most terminals).
    if (code === 0x7f || code === 0x08) {
      keys.push({ type: "backspace" });
      i++;
      continue;
    }
    if (code === 0x0d || code === 0x0a) {
      keys.push({ type: "enter" });
      i++;
      continue;
    }
    if (code === 0x09) {
      keys.push({ type: "tab" });
      i++;
      continue;
    }
    if (code === 0x01) { keys.push({ type: "ctrl-a" }); i++; continue; }
    if (code === 0x03) { keys.push({ type: "ctrl-c" }); i++; continue; }
    if (code === 0x04) { keys.push({ type: "ctrl-d" }); i++; continue; }
    if (code === 0x05) { keys.push({ type: "ctrl-e" }); i++; continue; }
    if (code === 0x0b) { keys.push({ type: "ctrl-k" }); i++; continue; }
    if (code === 0x15) { keys.push({ type: "ctrl-u" }); i++; continue; }
    if (code === 0x17) { keys.push({ type: "ctrl-w" }); i++; continue; }

    // Other control codes — drop.
    if (code < 0x20) {
      keys.push({ type: "unknown", raw: ch });
      i++;
      continue;
    }

    // Printable. Multi-byte UTF-8 characters arrive as their JS
    // string representation (surrogate pairs or single code units),
    // so we just consume one JS char at a time.
    keys.push({ type: "char", value: ch });
    i++;
  }
  return keys;
}

// ============================================================
// Buffer state + edits
// ============================================================

export interface LineState {
  buffer: string;
  cursor: number;
}

/**
 * Apply a buffer-editing key to the line state. Returns the new
 * state — never mutates the input. Keys that aren't edits (arrows
 * that move beyond the buffer, suggestion-navigation keys) are
 * either no-ops or routed elsewhere by the caller.
 */
export function applyEdit(state: LineState, key: Key): LineState {
  switch (key.type) {
    case "char":
      return {
        buffer: state.buffer.slice(0, state.cursor) + key.value + state.buffer.slice(state.cursor),
        cursor: state.cursor + key.value.length,
      };

    case "backspace":
      if (state.cursor === 0) return state;
      return {
        buffer: state.buffer.slice(0, state.cursor - 1) + state.buffer.slice(state.cursor),
        cursor: state.cursor - 1,
      };

    case "delete-forward":
      if (state.cursor >= state.buffer.length) return state;
      return {
        buffer: state.buffer.slice(0, state.cursor) + state.buffer.slice(state.cursor + 1),
        cursor: state.cursor,
      };

    case "left":
      return { ...state, cursor: Math.max(0, state.cursor - 1) };

    case "right":
      return { ...state, cursor: Math.min(state.buffer.length, state.cursor + 1) };

    case "home":
    case "ctrl-a":
      return { ...state, cursor: 0 };

    case "end":
    case "ctrl-e":
      return { ...state, cursor: state.buffer.length };

    case "ctrl-u":
      return { buffer: state.buffer.slice(state.cursor), cursor: 0 };

    case "ctrl-k":
      return { buffer: state.buffer.slice(0, state.cursor), cursor: state.cursor };

    case "ctrl-w": {
      // Delete the word to the left of the cursor: scan back over
      // whitespace, then over non-whitespace.
      let i = state.cursor;
      while (i > 0 && /\s/.test(state.buffer[i - 1])) i--;
      while (i > 0 && !/\s/.test(state.buffer[i - 1])) i--;
      return {
        buffer: state.buffer.slice(0, i) + state.buffer.slice(state.cursor),
        cursor: i,
      };
    }

    default:
      return state;
  }
}

/**
 * Accept a suggestion: replace the span (the substring being
 * completed) with the suggestion's value, and put the cursor at
 * the end of the inserted value.
 *
 * The span must appear in `buffer` immediately to the left of
 * `cursor` — the completer is responsible for returning a span that
 * matches the current input. We're tolerant: if it doesn't match,
 * we insert the value at the cursor instead.
 */
export function acceptSuggestion(
  state: LineState,
  span: string,
  value: string
): LineState {
  if (span && state.buffer.slice(state.cursor - span.length, state.cursor) === span) {
    const before = state.buffer.slice(0, state.cursor - span.length);
    const after = state.buffer.slice(state.cursor);
    return { buffer: before + value + after, cursor: before.length + value.length };
  }
  // Fallback: insert at the cursor.
  const before = state.buffer.slice(0, state.cursor);
  const after = state.buffer.slice(state.cursor);
  return { buffer: before + value + after, cursor: before.length + value.length };
}
