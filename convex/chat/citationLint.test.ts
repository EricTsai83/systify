/**
 * Citation lint behavior tests.
 *
 * These exercise `lintCitations` as a pure function, no Convex runtime
 * required. The contract under test is:
 *
 *   - Sentences that contain a `[path:line]` or `[path:line-line]` citation
 *     are NOT flagged.
 *   - Sentences prefixed with `Unverified:` are NOT flagged.
 *   - Short fragments (greetings, transitional phrases) are NOT flagged.
 *   - Code fence content is NOT flagged.
 *   - Other claim-shaped prose IS flagged with stable, non-overlapping
 *     ranges that the renderer can wrap in a `<mark>`.
 *
 * The tests pin the off-by-one behavior of the reported ranges (start /
 * end positions correspond to actual content slices) so any future tweak
 * to the splitter regex must keep the renderer's slicing valid.
 */

import { describe, expect, test } from "vitest";
import { lintCitations, MAX_UNVERIFIED_CLAIMS_PER_MESSAGE } from "./citationLint";

describe("lintCitations", () => {
  test("returns an empty array for empty input", () => {
    // Heuristic / cancelled / blank-content paths must not throw — they
    // pass through with no ranges so the caller can persist `undefined`.
    expect(lintCitations("")).toEqual([]);
  });

  test("flags a plain factual claim that lacks any citation", () => {
    const content = "The function calls performWork before returning.";
    const ranges = lintCitations(content);

    expect(ranges).toHaveLength(1);
    // Range covers the entire (trimmed) sentence including its terminator.
    const [range] = ranges;
    expect(content.slice(range.start, range.end)).toBe("The function calls performWork before returning.");
  });

  test("does not flag a sentence with a [path:line-line] citation", () => {
    const content = "The function calls performWork before returning [convex/lib/work.ts:120-148].";
    expect(lintCitations(content)).toEqual([]);
  });

  test("does not flag a sentence with a [path:line] (single-line) citation", () => {
    const content = "Performance regression introduced in [convex/chat/send.ts:42].";
    expect(lintCitations(content)).toEqual([]);
  });

  test("does not flag a sentence prefixed with Unverified:", () => {
    const content = "Unverified: I think the queue is processed in batches of ten.";
    expect(lintCitations(content)).toEqual([]);
  });

  test("Unverified: prefix is case-insensitive", () => {
    // The model occasionally emits lowercase "unverified:" — covering it
    // here keeps the lint forgiving without forcing the prompt to police
    // the exact casing.
    const content = "unverified: this might be wrong; double-check the helper.";
    expect(lintCitations(content)).toEqual([]);
  });

  test("does not flag short conversational fragments", () => {
    // Below the MIN_CLAIM_LENGTH floor (24 chars after trim). Fragments
    // like "Sure.", "Let me check.", "Done." would otherwise generate
    // noise on every reply opener.
    const content = "Sure. Let me check. Done.";
    expect(lintCitations(content)).toEqual([]);
  });

  test("flags exactly the unverified sentence in a mixed reply", () => {
    const content =
      "The handler validates the payload [convex/api/foo.ts:12-30]. " +
      "Then it dispatches to a worker queue without retry semantics. " +
      "Unverified: I expect the deadletter table is named `dead_letters`.";

    const ranges = lintCitations(content);

    // Only the middle sentence is flagged: the first has a citation, the
    // third has the Unverified: prefix.
    expect(ranges).toHaveLength(1);
    const [range] = ranges;
    expect(content.slice(range.start, range.end)).toBe("Then it dispatches to a worker queue without retry semantics.");
  });

  test("emits non-overlapping, ascending ranges for multiple flagged sentences", () => {
    const content =
      "First, the function fetches the user record. " +
      "Second, the function decrements the credit balance. " +
      "Third, the function commits the transaction.";

    const ranges = lintCitations(content);

    expect(ranges).toHaveLength(3);
    for (let index = 0; index + 1 < ranges.length; index += 1) {
      // Strict ordering keeps the renderer's left-to-right walker correct.
      expect(ranges[index].end).toBeLessThanOrEqual(ranges[index + 1].start);
    }

    expect(ranges.map((range) => content.slice(range.start, range.end))).toEqual([
      "First, the function fetches the user record.",
      "Second, the function decrements the credit balance.",
      "Third, the function commits the transaction.",
    ]);
  });

  test("does not flag sentences inside fenced code blocks", () => {
    // Code emitted by the model occupies fenced blocks. The block lacks
    // citations by construction, so flagging it would produce a wall of
    // yellow under every code sample.
    const content =
      "Here is the relevant snippet:\n" +
      "```ts\n" +
      "export function performWork() {\n" +
      "  // The runner schedules an upstream call.\n" +
      "  return queue.dispatch();\n" +
      "}\n" +
      "```\n" +
      "The dispatch is asynchronous and does not await the result.";

    const ranges = lintCitations(content);

    expect(ranges).toHaveLength(1);
    const [range] = ranges;
    // Only the trailing prose sentence is flagged; the code block (and
    // its embedded comment-with-period) is left alone.
    expect(content.slice(range.start, range.end)).toBe("The dispatch is asynchronous and does not await the result.");
  });

  test("ranges align with offsets the frontend can slice without surprises", () => {
    // The persisted ranges are half-open `[start, end)` offsets into
    // `messages.content`. The renderer slices the content with these
    // offsets and wraps the result in `<mark>`. This test pins that
    // contract: `content.slice(start, end)` round-trips to the flagged
    // sentence text exactly.
    const content = "Alpha sentence with no citation here. " + "Beta sentence has [convex/foo.ts:10] citation.";
    const ranges = lintCitations(content);
    expect(ranges).toHaveLength(1);
    const [range] = ranges;
    expect(content.slice(range.start, range.end)).toBe("Alpha sentence with no citation here.");
  });

  test("trims leading and trailing whitespace from each range", () => {
    // Sentences split on `[.!?]+\s` end with a period; the splitter may
    // include a leading space carried over from the previous boundary.
    // The lint must drop that whitespace so the highlight aligns visually
    // with the sentence text rather than starting one column to the left.
    const content = "  The runner is asynchronous and unbatched.  ";
    const ranges = lintCitations(content);
    expect(ranges).toHaveLength(1);
    const [range] = ranges;
    expect(range.start).toBe(2);
    expect(range.end).toBe(content.length - 2);
    expect(content.slice(range.start, range.end)).toBe("The runner is asynchronous and unbatched.");
  });

  test("treats paragraph breaks as sentence terminators", () => {
    // A header-like single line without a period followed by a paragraph
    // break should be a span on its own. Without paragraph splitting the
    // header would merge with the next sentence and overshoot.
    const content = "Findings\n\n" + "The downstream consumer never acknowledges receipt.";
    const ranges = lintCitations(content);
    // The header "Findings" is below MIN_CLAIM_LENGTH so it is NOT
    // flagged; the sentence after the paragraph break is.
    expect(ranges).toHaveLength(1);
    const [range] = ranges;
    expect(content.slice(range.start, range.end)).toBe("The downstream consumer never acknowledges receipt.");
  });

  test("does not mistake [A#] artifact citations for code citations", () => {
    // Docs-mode `[A1]` style is a different shape (no colon, no digits
    // after a colon). The lint must NOT accept `[A1]` as a satisfaction
    // of the sandbox-mode `[path:line]` contract — otherwise the model
    // could escape the contract by sprinkling docs-mode tokens.
    const content = "The mutation appends to the queue and returns immediately [A1].";
    const ranges = lintCitations(content);
    expect(ranges).toHaveLength(1);
    expect(content.slice(ranges[0].start, ranges[0].end)).toBe(
      "The mutation appends to the queue and returns immediately [A1].",
    );
  });

  test("returns at most MAX_UNVERIFIED_CLAIMS_PER_MESSAGE ranges", () => {
    // A pathological reply that produces more flagged sentences than the
    // cap should be truncated to the cap so the persisted payload stays
    // bounded. The lint stops early at the cap rather than scanning the
    // entire input and slicing at the end.
    const sentence = "The function emits an event and returns immediately. ";
    const repeated = sentence.repeat(MAX_UNVERIFIED_CLAIMS_PER_MESSAGE + 5);
    const ranges = lintCitations(repeated);
    expect(ranges.length).toBe(MAX_UNVERIFIED_CLAIMS_PER_MESSAGE);
  });

  test("does not flag a sentence with embedded backticks but no citation", () => {
    // Inline code like \`foo\` does not count as a citation. The model
    // is taught to use `[path:line]`. Without this guard the lint would
    // pretend an inline-code sentence is verified and miss real claims.
    const content = "The handler hands off to `performWork` immediately after validation.";
    const ranges = lintCitations(content);
    expect(ranges).toHaveLength(1);
    expect(content.slice(ranges[0].start, ranges[0].end)).toBe(
      "The handler hands off to `performWork` immediately after validation.",
    );
  });

  test("flags trailing prose that lacks a sentence terminator", () => {
    // Reality check: the model sometimes ends a reply without a final
    // period (e.g. a streamed reply truncated at a token boundary). The
    // lint must still flag the trailing fragment if it crosses the
    // length floor, otherwise long un-punctuated tails would be a hole.
    const content = "Findings:\n\n" + "The retry policy doubles the backoff on every transient error";
    const ranges = lintCitations(content);
    expect(ranges).toHaveLength(1);
    expect(content.slice(ranges[0].start, ranges[0].end)).toBe(
      "The retry policy doubles the backoff on every transient error",
    );
  });
});
