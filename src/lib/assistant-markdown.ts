/**
 * Tag-injection helpers that prepare a raw assistant reply for the
 * streamdown markdown renderer.
 *
 * The chat bubble carries two inline annotations that must survive a
 * markdown parse: `[A#]` artifact-citation links and unverified-claim
 * highlights. Both are preserved by rewriting the raw `message.content`
 * string into custom HTML tags (`<citation>` / `<unverified>`) *before*
 * streamdown parses it; streamdown then routes those tags through its
 * `allowedTags` + `components` mechanism. Doing the rewrite as plain
 * string surgery — rather than walking the parsed tree — keeps these
 * helpers pure and unit-testable (mirrors `src/lib/suggest-mode.ts`).
 *
 * The server (`convex/chat/citationLint.ts`, the lint invocation, the
 * `messages.unverifiedClaims` schema field) is unchanged: it stays the
 * single source of truth for *which* sentences are flagged — these
 * helpers only change how that data is *rendered*.
 */

/**
 * Token regex for the citation rewriter: matches both the artifact-level
 * `[A#]` form and Library Ask's chunk-level `[A#section-path]` form.
 * Captures the numeric index so {@link injectCitationTags} (and
 * `CitationRef` in `chat-message.tsx`, which resolves the index against
 * `messages.citationMap`) can read it back out.
 *
 * Non-global on purpose: `RegExp.prototype.exec` against a non-global
 * regex is stateless, so a single shared instance is safe to reuse.
 * Call sites that need to scan/replace globally build their own `g`
 * copy from `.source`.
 */
export const CITATION_TOKEN_REGEX = /\[A(\d+)(?:#[^\]]+)?\]/;

/**
 * Code-span detector, in priority order:
 *   1. a fenced block — `` ``` `` … `` ``` `` (or, mid-stream, an
 *      unclosed fence running to end-of-string), or
 *   2. an inline code span — `` ` `` … `` ` `` on a single line.
 *
 * Citation rewriting skips whatever this matches, so an `[A1]` that
 * appears inside code stays literal rather than turning into a link.
 */
const CODE_SPAN_REGEX = /```[\s\S]*?(?:```|$)|`[^`\n]+`/g;

/**
 * Wrap a single matched citation token in a `<citation>` tag. The token
 * text is HTML-escaped first: a `[A#section-path]` slug should never
 * contain `<`/`>`/`&`, but escaping makes a malformed token degrade to
 * inert text instead of a broken tag (streamdown's sanitizer is the
 * real safety net — this just keeps the token's text content intact).
 */
function wrapCitationToken(token: string): string {
  const escaped = token.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return `<citation>${escaped}</citation>`;
}

/**
 * Wrap every `[A#]` / `[A#section-path]` token in `<citation>` tags.
 *
 * Fence-aware: code spans (fenced blocks and inline backtick spans) are
 * copied through verbatim so a citation-shaped token inside code is not
 * linkified. Resolution of the numeric index against the citation map
 * happens later, in `CitationRef` — this helper rewrites every token,
 * resolvable or not.
 *
 * Linear in `content.length`: one pass over the code-span matches, with
 * a single regex `replace` over each prose gap between them.
 */
export function injectCitationTags(content: string): string {
  if (!content) {
    return content;
  }
  const citationRe = new RegExp(CITATION_TOKEN_REGEX.source, "g");
  const codeRe = new RegExp(CODE_SPAN_REGEX.source, "g");

  let result = "";
  let cursor = 0;
  let codeSpan: RegExpExecArray | null = codeRe.exec(content);
  while (codeSpan !== null) {
    // Prose before this code span — rewrite citations.
    result += content.slice(cursor, codeSpan.index).replace(citationRe, wrapCitationToken);
    // The code span itself — verbatim.
    result += codeSpan[0];
    cursor = codeSpan.index + codeSpan[0].length;
    codeSpan = codeRe.exec(content);
  }
  // Trailing prose after the last code span (or the whole string when
  // there were none).
  result += content.slice(cursor).replace(citationRe, wrapCitationToken);
  return result;
}

/**
 * Wrap each `unverifiedClaims` range in `<unverified>` tags.
 *
 * Pure function over the content and the persisted ranges; defensive
 * about out-of-bounds or out-of-order ranges so a future schema change
 * with relaxed invariants cannot crash the renderer. Lives alongside the
 * citation rewriter so `chat-message.tsx`'s `buildContentRuns` can compose
 * both transforms without owning their internals:
 *
 *   - Sorts a defensive copy of the ranges by `start` (the lint emits
 *     them sorted, but the renderer can't trust that across schema
 *     versions).
 *   - Clamps each range into `[cursor, content.length]` so an
 *     overlapping range degrades to "starts where the previous one
 *     ended" — visually a single longer highlight — instead of emitting
 *     nested `<unverified>` wrappers or slicing a negative range.
 *   - Skips empty ranges (`end <= start`) silently.
 *
 * No fence-skipping is needed here: `lintCitations` already excludes
 * code fences, so a stored range never overlaps a ``` ``` ``` block.
 */
export function injectUnverifiedTags(
  content: string,
  ranges: ReadonlyArray<{ start: number; end: number }> | undefined,
): string {
  if (!ranges || ranges.length === 0) {
    return content;
  }
  const sortedRanges = [...ranges].sort((a, b) => a.start - b.start);

  let result = "";
  let cursor = 0;
  for (const range of sortedRanges) {
    const start = Math.max(cursor, Math.min(range.start, content.length));
    const end = Math.max(start, Math.min(range.end, content.length));
    if (end <= start) {
      continue;
    }
    result += content.slice(cursor, start);
    result += `<unverified>${content.slice(start, end)}</unverified>`;
    cursor = end;
  }
  result += content.slice(cursor);
  return result;
}

/**
 * Prepare a raw assistant reply for the streamdown renderer.
 *
 * Runs the two injection passes in a fixed order:
 *
 *   1. `injectUnverifiedTags` — offset-based, so it must see the
 *      *original* string before any tags shift the indices.
 *   2. `injectCitationTags` — regex-based and position-independent, so
 *      it runs cleanly on the already-tagged string.
 *
 * The order is safe because an `[A#]` token never straddles a sentence
 * boundary, so a citation always nests fully inside or fully outside an
 * unverified span — the two annotations never produce interleaved tags.
 */
export function prepareAssistantMarkdown(
  content: string,
  unverifiedClaims?: ReadonlyArray<{ start: number; end: number }>,
): string {
  return injectCitationTags(injectUnverifiedTags(content, unverifiedClaims));
}
