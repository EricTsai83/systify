import type { ChatMode } from "./types";

/**
 * Plan 14 — passive mode-suggestion heuristic. Runs on every keystroke from
 * the composer and, when the input shape unambiguously fits a different
 * mode than the one the user is in, returns a one-line nudge with a stable
 * `key` so the composer can show / dismiss the same suggestion across
 * re-renders.
 *
 * Design constraints baked into the rules below:
 *
 *   1. **Pure function.** No React, no DOM, no clock. The composer wraps
 *      the call in `useMemo` so the regex passes execute at most once
 *      per (input, mode, available-modes) tuple. Tests can call this
 *      directly without any rendering harness.
 *
 *   2. **Fail closed.** When in doubt, return `null` and let the user
 *      send. False positives (a suggestion that pops on a question that
 *      genuinely belongs in the current mode) are *louder* than false
 *      negatives (no suggestion when one would have helped) — the inline
 *      hint takes screen real estate and trains the user to dismiss it.
 *
 *   3. **Suggestions never widen the user's mode budget.** If the
 *      suggested mode is not in `availableModes` (e.g. sandbox is
 *      gated by the rollout %, the repo isn't attached, or quotas
 *      ran out) we return `null` rather than show a [Switch] button
 *      that bounces off the disabled state. The hint must always be
 *      actionable.
 *
 *   4. **Stable `key` per heuristic.** The chat panel keeps a session
 *      `Set<string>` of dismissed keys; matching keys must collapse so
 *      dismissing "specific-file:lab" once silences every future
 *      file-path suggestion this session.
 *
 * The two heuristics intentionally cover only the highest-precision
 * cases. Adding more rules (e.g. "this looks like a stack trace") will
 * either produce false positives or duplicate work the LLM does anyway.
 */

/**
 * Matches "looks like a source-code path with a recognized extension".
 * Restricted to the language extensions present in this repo plus the
 * common adjacent ones engineering users tend to mention. Deliberately
 * narrow:
 *
 *   - Anchored on `\b` so a sentence like "switched to ts" doesn't fire.
 *   - `[\w/-]+` enforces "looks like a path or filename token" — bare
 *     ".ts" or " .ts" produce no match because there is no leading
 *     word/slash/dash run.
 *   - The extension list is closed; markdown / config files (`.md`,
 *     `.json`, `.toml`) are *not* on it because asking about them in
 *     docs mode is reasonable (they live in the design artifacts, not
 *     the live source tree).
 */
const SOURCE_PATH_REGEX = /\b[\w/-]+\.(?:ts|tsx|js|jsx|py|rs|go)\b/;

/**
 * Matches the two highest-precision "open-ended advice question"
 * prefixes called out in the plan. Both forms have the property that
 * the answer is almost always *general* (not repo-specific), so docs /
 * sandbox grounding wastes a step budget without improving accuracy.
 *
 *   - `^\s*` tolerates leading whitespace so a stray space at the
 *     start of the message doesn't suppress the hint.
 *   - The `'` is optional and matches both straight (`'`), curly
 *     (`’` / `‘`), and missing apostrophes (`whats`). Mobile keyboards
 *     auto-correct to curly quotes; not handling them would silently
 *     hide the hint for a non-trivial slice of users.
 *   - Trailing `\b` so "how should I" matches but "how should iterate"
 *     (no real-world example, but fail-closed) does not.
 */
const OPEN_ENDED_PREFIX_REGEX = /^\s*(?:how should i\b|what(?:['’‘]?)s\s+the\s+best\s+way\s+to\b)/i;

export type ModeSuggestion = {
  /** Mode the [Switch] button should jump to. */
  readonly suggested: ChatMode;
  /** Stable key used by the composer's session-level dismiss set. */
  readonly key: string;
  /** User-facing single-sentence reason rendered in the inline hint. */
  readonly reason: string;
};

/**
 * Returns the most relevant nudge for the current composer input, or
 * `null` if no heuristic fires (or the suggested mode isn't available).
 *
 * Heuristic precedence — first match wins, evaluated top-to-bottom:
 *
 *   1. **Specific-file → sandbox.** Triggers only when the user is in
 *      `discuss` or `docs` and types something that looks like a source
 *      path. Sandbox is the only mode that can read the live tree, so
 *      this is unambiguously the right mode for a file-specific
 *      question.
 *
 *   2. **Open-ended → discuss.** Triggers when the input starts with
 *      one of the two open-ended advice prefixes and the user is *not*
 *      already in `discuss`. These questions don't benefit from RAG /
 *      sandbox grounding, so docs / sandbox mode would just spend more
 *      tokens for the same general answer.
 *
 * Order matters: a message like "How should I refactor `convex/foo.ts`
 * for testability?" would match both rules; the file-path rule wins
 * because the user mentioned a concrete file (the answer benefits
 * from sandbox grounding even though the question phrasing is
 * open-ended).
 */
export function suggestMode(
  input: string,
  currentMode: ChatMode,
  availableModes: readonly ChatMode[],
): ModeSuggestion | null {
  // Cheap early-out: trim once for both rules. An all-whitespace input
  // produces no suggestion and saves the regex passes for the common
  // "user hasn't typed anything yet" case (composer mounts with empty
  // input but state changes still re-run the memo).
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return null;
  }

  // Rule 1 — file path mention: nudge from discuss/library to lab.
  // Lab is the only mode that can resolve `convex/chat/send.ts`
  // to actual content; library answers from a synthesized artifact would
  // hallucinate line numbers.
  if (
    (currentMode === "discuss" || currentMode === "library") &&
    availableModes.includes("lab") &&
    SOURCE_PATH_REGEX.test(input)
  ) {
    return {
      suggested: "lab",
      key: "specific-file:lab",
      reason: "This question references a specific file. Lab mode would give a more accurate answer.",
    };
  }

  // Rule 2 — open-ended advice prefix: nudge to discuss. Skipped when
  // the user is already in discuss (no useful switch target) or when
  // discuss is somehow unavailable (defensive: discuss is always
  // available today, but the gate keeps the contract honest).
  if (currentMode !== "discuss" && availableModes.includes("discuss") && OPEN_ENDED_PREFIX_REGEX.test(input)) {
    return {
      suggested: "discuss",
      key: "open-ended:discuss",
      reason: "This sounds open-ended; Discuss might be better.",
    };
  }

  return null;
}
