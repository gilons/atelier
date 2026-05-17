/**
 * Shared "completion suggestion" shape used by the REPL's inline
 * suggestion menu.
 *
 * A {@link Suggestion} is one item in the dropdown beneath the
 * prompt. The user navigates with ↑/↓ and accepts with Tab / →
 * (or Enter, which accepts + submits in one step).
 *
 * Why a structured shape rather than `string[]`?
 *   - We want a short description next to each suggestion so the
 *     user can disambiguate `/source list` from `/source onboard`
 *     without leaving the prompt.
 *   - The on-screen `display` might differ from the actual `value`
 *     that gets inserted (e.g. show `/source list` but insert
 *     just `list` to complete the current partial token).
 *   - Lets us tag suggestions for grouping later (commands vs.
 *     option flags vs. positional values) without breaking the
 *     wire shape.
 */
export interface Suggestion {
  /**
   * The token that replaces the partial the user has typed.
   * Whitespace at the end is meaningful — a trailing space means
   * "this completion is fully chosen, advance to the next token."
   */
  value: string;
  /** Display label in the menu. Defaults to `value`. */
  display?: string;
  /** Optional one-line hint shown dim, to the right of `display`. */
  description?: string;
}

/**
 * Result of a completer call. `span` is the substring of the current
 * input that `value` would replace; the input reader uses it to
 * compute the post-accept buffer + cursor position.
 */
export interface CompletionResult {
  span: string;
  items: Suggestion[];
}

/** A function the REPL calls on every keystroke to refresh suggestions. */
export type Completer = (line: string, cursor: number) => CompletionResult;
