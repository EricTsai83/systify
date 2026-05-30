/**
 * Pure helpers for the title-autogen path. Lives outside `chat/titles.ts`
 * (which has `"use node"` for the AI SDK) so the sanitizer and its cap can
 * be unit-tested under the edge-runtime test environment without dragging
 * Node-only imports into the test bundle.
 */

/**
 * Hard cap on the persisted title length for the autogen path. Generous
 * enough to keep a meaningful CJK / English summary, tight enough that a
 * stray model spew cannot bloat the threads document. `sanitizeTitle`
 * truncates (instead of rejecting) so a verbose LLM still produces a usable
 * title.
 *
 * Intentionally smaller than `MAX_RENAME_TITLE_LENGTH` (200, in
 * `threadDefaults.ts`) — manual renames trust the user, autogen does not
 * trust the model.
 */
export const MAX_AUTOGEN_TITLE_LENGTH = 80;

/**
 * Strip wrapper characters and trailing terminator punctuation, then cap
 * length. The model is instructed to omit these, but instruction-following
 * isn't load-bearing — sanitization is.
 *
 * Returns the empty string when the result is empty (caller skips the patch
 * so the default title stays).
 */
export function sanitizeTitle(text: string): string {
  let candidate = text.trim();
  // Strip leading/trailing quotes/backticks. Loop because the model can
  // produce nested wrappers like `"'title'"`.
  while (candidate.length > 0 && /^["'`]/.test(candidate)) {
    candidate = candidate.slice(1).trim();
  }
  while (candidate.length > 0 && /["'`]$/.test(candidate)) {
    candidate = candidate.slice(0, -1).trim();
  }
  // Strip trailing terminator punctuation — both ASCII and CJK-width.
  candidate = candidate.replace(/[.。!?！？]+$/u, "").trim();
  if (candidate.length === 0) {
    return "";
  }
  if (candidate.length > MAX_AUTOGEN_TITLE_LENGTH) {
    candidate = candidate.slice(0, MAX_AUTOGEN_TITLE_LENGTH).trim();
  }
  return candidate;
}
