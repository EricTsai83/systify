/**
 * Plan 11 — Sandbox-mode citation lint.
 *
 * The sandbox prompt teaches the model two rules:
 *   1. Every factual claim about the codebase is followed by a
 *      `[path/to/file.ts:line-line]` citation pointing at the exact source
 *      that was inspected.
 *   2. When the model can't cite (it didn't run a tool, or the tool errored),
 *      the claim must be prefixed with the literal `Unverified:`.
 *
 * The lint scans a finalized assistant reply and returns the ranges of
 * sentences that violate *both* rules — i.e. claim-shaped prose without a
 * citation and without an `Unverified:` excuse. The frontend (chat-panel.tsx)
 * uses these ranges to render a soft yellow underline under the unverified
 * sentences. The lint is **non-blocking** by design: we never reject the
 * model's output, we just nudge the user to read flagged sentences with extra
 * skepticism.
 *
 * Rationale for the per-sentence design (vs. semantic parsing):
 *   - The check has to run at finalize time inside a Convex mutation, so it
 *     must be CPU-only and cheap. Splitting on `[.!?]+\s` plus paragraph
 *     breaks gives O(n) without a tokenizer dependency.
 *   - The model is taught to prefix *each* unverified sentence; a paragraph
 *     of unverified prose with one prefix is by design partially flagged,
 *     which is the right incentive to keep using the prefix.
 *   - Code fences are excluded so a triple-backtick block of model-emitted
 *     code (which by definition has no `[path:line]` citation) doesn't get
 *     highlighted as unverified prose.
 *
 * The lint is best-effort: there is no goal of perfect "factual claim"
 * detection. A short greeting, a transitional phrase, or a sentence that
 * already cites is left alone; everything else gets flagged. The frontend
 * caps how alarming this looks (subtle background, no error styling) so the
 * occasional false positive is just a hint, not a wrong-flag accusation.
 */

/**
 * One flagged-sentence range, expressed as half-open offsets into the
 * assistant reply's `messages.content` string. The frontend uses these to
 * render a `<mark>` wrapper over the highlighted substring.
 *
 * Stored offsets are over `String.prototype` indexing (UTF-16 code units),
 * matching how the database column is stored and how the renderer slices
 * the content. No surrogate-pair-aware indexing is needed because both the
 * lint output and the renderer use the same code-unit indexing.
 */
export type UnverifiedClaimRange = {
  /** Inclusive start offset into the assistant reply's content. */
  readonly start: number;
  /** Exclusive end offset into the assistant reply's content. */
  readonly end: number;
};

/**
 * `[path:line]` or `[path:line-line]` citation. The path token allows any
 * non-whitespace, non-bracket characters (so directory separators, dots, and
 * extensions all match). The line range is required and uses digits with an
 * optional `-digits` suffix.
 *
 * Stricter than the plan's `\[\S+:\d+(-\d+)?\]` sketch in that it forbids
 * brackets inside the path token — otherwise a stray `[A1] [B:42]` could
 * masquerade as nested citations. Identical behavior on every well-formed
 * citation the model is taught to emit.
 *
 * `lastIndex` is reset on each test so the regex stays usable across calls
 * (it is non-global anyway, but keeping the reset documented avoids the
 * trap if the flag ever gets `g` added).
 */
const CITATION_REGEX = /\[[^[\]\s]+:\d+(?:-\d+)?\]/;

/**
 * `Unverified:` excuse marker. Must appear at the very start of the
 * (trimmed) sentence to count — putting it mid-sentence would let any
 * sentence escape by including the literal somewhere inside. Case-insensitive
 * because the model occasionally produces "unverified:" lowercase.
 */
const UNVERIFIED_PREFIX_REGEX = /^unverified:/i;

/**
 * Sentence-terminator regex. Matches one or more `.!?` characters followed
 * by either whitespace or end-of-string, OR a paragraph break (a blank line
 * with optional surrounding whitespace).
 *
 * Why both: sentence-terminator alone would lump a multi-paragraph list
 * into a single block; paragraph-break alone would lump multiple sentences
 * in one paragraph into one block. Combining gives sub-sentence resolution
 * for prose and per-paragraph resolution for un-punctuated blocks (headers,
 * single bullets without periods).
 *
 * The lookahead on the punctuation case (`(?=\s|$)`) keeps the matched
 * length minimal so two adjacent ranges don't overlap.
 */
const SENTENCE_TERMINATOR_REGEX = /(?:[.!?]+(?=\s|$))|(?:\n[ \t]*\n)/g;

/**
 * Code fence detector. Matches triple-backtick blocks (with optional
 * language tag) including the opening and closing fences. Sentences that
 * overlap any fence range are excluded from the lint — code is not prose
 * and would be uniformly flagged otherwise.
 *
 * The pattern uses `[\s\S]*?` (lazy match across newlines) so the regex
 * doesn't need the `s` flag, which keeps it portable across environments
 * that may not support `dotAll`.
 */
const CODE_FENCE_REGEX = /```[\s\S]*?```/g;

/**
 * Minimum trimmed length for a sentence to be eligible for the unverified
 * flag. Below this floor the sentence is too short to plausibly be a factual
 * claim about the codebase — typical examples are "Sure.", "Done.",
 * "Let me check.", or a header like "## Summary".
 *
 * 24 chars is empirically the sweet spot between noise (highlighting "I'll
 * help you with that.") and missed claims (real factual sentences are
 * almost always longer than 24 chars). Tested in `citationLint.test.ts`
 * with concrete fixtures.
 */
const MIN_CLAIM_LENGTH = 24;

/**
 * Defensive cap on the number of ranges we return from a single lint pass.
 * `streaming.ts` re-applies the same cap before persisting to keep the
 * `messages` row well under Convex's 1 MB document limit even on a runaway
 * 200-sentence reply where every sentence is unverified.
 */
export const MAX_UNVERIFIED_CLAIMS_PER_MESSAGE = 50;

type SentenceSpan = {
  readonly text: string;
  readonly start: number;
  readonly end: number;
};

/**
 * Locate every code-fence range in the content. Returned ranges are
 * non-overlapping and sorted by `start` (the regex itself emits them in
 * order). Used by the sentence walker to skip code blocks when determining
 * whether a span is lintable prose.
 *
 * O(n) in `content.length`. Allocates only the result array; no per-match
 * substring is materialized.
 */
function findCodeFences(content: string): UnverifiedClaimRange[] {
  const ranges: UnverifiedClaimRange[] = [];
  // Re-use one mutable RegExp by resetting `lastIndex`. `matchAll` would
  // also work but allocates a generator + per-match array; the explicit
  // exec loop is one allocation per match.
  CODE_FENCE_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null = CODE_FENCE_REGEX.exec(content);
  while (match !== null) {
    ranges.push({ start: match.index, end: match.index + match[0].length });
    match = CODE_FENCE_REGEX.exec(content);
  }
  return ranges;
}

/**
 * Build the list of "prose regions" — the parts of `content` that are NOT
 * inside any code fence. The sentence splitter only walks these regions so
 * a sentence terminator inside a code block (e.g. a comment ending in
 * `…call.\n`) cannot accidentally consume a piece of trailing prose into
 * the same span.
 *
 * Returned ranges are non-overlapping, sorted by `start`, and form a
 * partition of `content` minus the fences. Empty regions (zero-width gaps
 * between two adjacent fences, which the regex never emits anyway) are
 * filtered out so callers don't have to special-case them.
 */
function buildProseRegions(content: string, fenceRanges: ReadonlyArray<UnverifiedClaimRange>): UnverifiedClaimRange[] {
  if (fenceRanges.length === 0) {
    return [{ start: 0, end: content.length }];
  }
  const regions: UnverifiedClaimRange[] = [];
  let cursor = 0;
  for (const fence of fenceRanges) {
    if (fence.start > cursor) {
      regions.push({ start: cursor, end: fence.start });
    }
    cursor = fence.end;
  }
  if (cursor < content.length) {
    regions.push({ start: cursor, end: content.length });
  }
  return regions;
}

/**
 * Walk one prose region and emit sentence spans inside it. A "span" is the
 * half-open range from the previous terminator (or region start) to the
 * end of the next terminator. Leading and trailing whitespace are trimmed
 * from the range so the persisted highlight aligns visually with the
 * sentence text rather than running into the gap between sentences.
 *
 * The terminator regex is rewound to `regionStart` and applied with a
 * boundary check (`match.index + match[0].length <= regionEnd`) so a
 * terminator landing in a downstream region does not get attributed to
 * this one.
 *
 * Worst-case allocations: one entry per sentence boundary plus one for the
 * trailing fragment. For a typical 1 KB assistant reply that's ~10 entries.
 */
function splitSentencesInRegion(
  content: string,
  regionStart: number,
  regionEnd: number,
  isLastRegion: boolean,
): SentenceSpan[] {
  const spans: SentenceSpan[] = [];
  let cursor = regionStart;
  SENTENCE_TERMINATOR_REGEX.lastIndex = regionStart;
  let match: RegExpExecArray | null = SENTENCE_TERMINATOR_REGEX.exec(content);
  while (match !== null) {
    const spanEnd = match.index + match[0].length;
    if (spanEnd > regionEnd) {
      // Terminator started inside the region but its match length crossed
      // out — bail out so we don't double-count it in the next region's
      // walk. The trailing fragment branch below covers the remaining
      // text up to `regionEnd`.
      break;
    }
    pushTrimmedSpan(spans, content, cursor, spanEnd);
    cursor = spanEnd;
    if (cursor >= regionEnd) {
      break;
    }
    match = SENTENCE_TERMINATOR_REGEX.exec(content);
    if (match !== null && match.index >= regionEnd) {
      break;
    }
  }
  // Trailing fragment without a terminator. Only emitted for the *last*
  // prose region — i.e. the literal end of the assistant reply. A trailing
  // fragment in any other region is by construction the prose immediately
  // before a code fence, which is almost always an introducer phrase
  // ("Here is the snippet:", "The relevant code is:") rather than a
  // factual claim. Flagging introducers would generate yellow underlines
  // under every code-followed-by-prose paragraph, training the user to
  // ignore the highlight entirely. Dropping them keeps the signal-to-noise
  // ratio high.
  if (cursor < regionEnd && isLastRegion) {
    pushTrimmedSpan(spans, content, cursor, regionEnd);
  }
  return spans;
}

/**
 * Append `[start, end)` as a sentence span, trimming leading and trailing
 * whitespace so the persisted range aligns flush against the sentence text.
 *
 * Whitespace detection runs over UTF-16 code units via `charCodeAt`, which
 * is what V8 indexes natively and what the renderer uses to slice the
 * content. Rare unicode whitespace (NBSP, etc.) is uncommon in model
 * output and not worth the extra lookup.
 */
function pushTrimmedSpan(spans: SentenceSpan[], content: string, start: number, end: number): void {
  let trimStart = start;
  while (trimStart < end) {
    const code = content.charCodeAt(trimStart);
    // 9..13 covers \t \n \v \f \r; 32 is space.
    if (code !== 32 && (code < 9 || code > 13)) {
      break;
    }
    trimStart += 1;
  }
  if (trimStart >= end) {
    return;
  }

  let trimEnd = end;
  while (trimEnd > trimStart) {
    const code = content.charCodeAt(trimEnd - 1);
    if (code !== 32 && (code < 9 || code > 13)) {
      break;
    }
    trimEnd -= 1;
  }

  spans.push({ text: content.slice(trimStart, trimEnd), start: trimStart, end: trimEnd });
}

/**
 * Decide whether a single sentence should be flagged as unverified.
 *
 * Returns `true` only when *all* of the following hold:
 *   1. The trimmed sentence is at least `MIN_CLAIM_LENGTH` characters —
 *      shorter sentences are nearly always conversational ("Sure.",
 *      "Let me check.") rather than factual claims.
 *   2. The sentence does not start with `Unverified:` — that is the
 *      opt-out the model is taught to use.
 *   3. The sentence contains no `[path:line]` citation — that is the
 *      verification contract the model is taught to honor.
 */
function shouldFlagAsUnverified(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < MIN_CLAIM_LENGTH) {
    return false;
  }
  if (UNVERIFIED_PREFIX_REGEX.test(trimmed)) {
    return false;
  }
  if (CITATION_REGEX.test(trimmed)) {
    return false;
  }
  return true;
}

/**
 * Scan a finalized assistant reply for sentences that violate the
 * sandbox-mode citation contract.
 *
 * Returns at most {@link MAX_UNVERIFIED_CLAIMS_PER_MESSAGE} ranges, in
 * ascending `start` order, with no overlaps (the splitter emits non-
 * overlapping spans). Empty input or content with no detectable claims
 * returns `[]` so the caller can simply check `.length === 0` to skip
 * persistence.
 *
 * Time complexity: O(n) over `content.length`; the regex passes are
 * linear DFAs (no backreferences or nested quantifiers). Memory:
 * O(matches) for the result array. Safe to call from a Convex mutation
 * on replies up to multiple megabytes without budget concerns.
 *
 * @param content The finalized `messages.content` string.
 * @returns Sorted, non-overlapping unverified-claim ranges.
 */
export function lintCitations(content: string): UnverifiedClaimRange[] {
  if (typeof content !== "string" || content.length === 0) {
    return [];
  }
  const fenceRanges = findCodeFences(content);
  const proseRegions = buildProseRegions(content, fenceRanges);
  const result: UnverifiedClaimRange[] = [];
  for (let regionIndex = 0; regionIndex < proseRegions.length; regionIndex += 1) {
    const region = proseRegions[regionIndex];
    const isLastRegion = regionIndex === proseRegions.length - 1;
    const sentences = splitSentencesInRegion(content, region.start, region.end, isLastRegion);
    for (const sentence of sentences) {
      if (shouldFlagAsUnverified(sentence.text)) {
        result.push({ start: sentence.start, end: sentence.end });
        // Stop early once we hit the cap so we never produce more ranges
        // than we'll persist. The streaming-side cap is identical, but
        // returning early here saves work on pathological inputs.
        if (result.length >= MAX_UNVERIFIED_CLAIMS_PER_MESSAGE) {
          return result;
        }
      }
    }
  }
  return result;
}
