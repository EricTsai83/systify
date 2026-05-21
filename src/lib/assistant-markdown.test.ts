import { describe, expect, test } from "vitest";
import { injectCitationTags, injectUnverifiedTags, prepareAssistantMarkdown } from "./assistant-markdown";

describe("injectCitationTags", () => {
  test("wraps a bare [A#] token", () => {
    expect(injectCitationTags("The boundary is documented [A1].")).toBe(
      "The boundary is documented <citation>[A1]</citation>.",
    );
  });

  test("wraps the chunk-level [A#section-path] form", () => {
    expect(injectCitationTags("See [A2#architecture/data-model] for details.")).toBe(
      "See <citation>[A2#architecture/data-model]</citation> for details.",
    );
  });

  test("wraps every token regardless of whether the index resolves", () => {
    // The helper has no citation map — it wraps `[A1]` and a possibly
    // unresolvable `[A99]` alike; resolution happens later in CitationRef.
    expect(injectCitationTags("Compare [A1] against [A99].")).toBe(
      "Compare <citation>[A1]</citation> against <citation>[A99]</citation>.",
    );
  });

  test("leaves a token inside a fenced code block literal", () => {
    const input = "Before.\n```\nconst x = arr[A1];\n```\nAfter [A2].";
    expect(injectCitationTags(input)).toBe("Before.\n```\nconst x = arr[A1];\n```\nAfter <citation>[A2]</citation>.");
  });

  test("leaves a token inside an inline code span literal", () => {
    expect(injectCitationTags("Use `arr[A1]`, not [A2].")).toBe("Use `arr[A1]`, not <citation>[A2]</citation>.");
  });

  test("leaves a token inside an unclosed fence (stream tail) literal", () => {
    // A mid-stream reply can end inside a fence; the still-open block
    // must not have its `[A1]` linkified before the fence closes.
    expect(injectCitationTags("Here is code:\n```ts\nconst y = m[A1]")).toBe("Here is code:\n```ts\nconst y = m[A1]");
  });

  test("leaves a partial [A token at a stream tail untouched", () => {
    expect(injectCitationTags("trailing [A")).toBe("trailing [A");
    expect(injectCitationTags("trailing [A12")).toBe("trailing [A12");
  });

  test("does not linkify a [path:line] source-file citation", () => {
    expect(injectCitationTags("Defined at [convex/chat/send.ts:80].")).toBe("Defined at [convex/chat/send.ts:80].");
  });

  test("returns empty input unchanged", () => {
    expect(injectCitationTags("")).toBe("");
  });
});

describe("injectUnverifiedTags", () => {
  test("returns content unchanged for undefined ranges", () => {
    expect(injectUnverifiedTags("hello world", undefined)).toBe("hello world");
  });

  test("returns content unchanged for an empty range list", () => {
    expect(injectUnverifiedTags("hello world", [])).toBe("hello world");
  });

  test("wraps a single range", () => {
    expect(injectUnverifiedTags("abcdef", [{ start: 2, end: 4 }])).toBe("ab<unverified>cd</unverified>ef");
  });

  test("wraps multiple non-overlapping ranges", () => {
    expect(
      injectUnverifiedTags("abcdef", [
        { start: 0, end: 2 },
        { start: 4, end: 6 },
      ]),
    ).toBe("<unverified>ab</unverified>cd<unverified>ef</unverified>");
  });

  test("sorts out-of-order ranges before wrapping", () => {
    expect(
      injectUnverifiedTags("abcdef", [
        { start: 4, end: 6 },
        { start: 0, end: 2 },
      ]),
    ).toBe("<unverified>ab</unverified>cd<unverified>ef</unverified>");
  });

  test("clamps offsets to the content bounds", () => {
    expect(injectUnverifiedTags("abc", [{ start: -5, end: 99 }])).toBe("<unverified>abc</unverified>");
  });

  test("skips an empty range", () => {
    expect(injectUnverifiedTags("abc", [{ start: 1, end: 1 }])).toBe("abc");
  });

  test("degrades overlapping ranges to adjacent wrappers instead of nesting", () => {
    // The second range starts inside the first — clamped to begin where
    // the first ended, so no nested `<unverified>` tags are emitted.
    expect(
      injectUnverifiedTags("abcdef", [
        { start: 0, end: 4 },
        { start: 2, end: 6 },
      ]),
    ).toBe("<unverified>abcd</unverified><unverified>ef</unverified>");
  });
});

describe("prepareAssistantMarkdown", () => {
  test("nests a citation cleanly inside an unverified span", () => {
    const content = "The flow routes through [A1] before persisting.";
    const claims = [{ start: 0, end: content.length }];
    expect(prepareAssistantMarkdown(content, claims)).toBe(
      "<unverified>The flow routes through <citation>[A1]</citation> before persisting.</unverified>",
    );
  });

  test("injects citations when there are no unverified claims", () => {
    expect(prepareAssistantMarkdown("Cited at [A1].")).toBe("Cited at <citation>[A1]</citation>.");
    expect(prepareAssistantMarkdown("Cited at [A1].", undefined)).toBe("Cited at <citation>[A1]</citation>.");
  });

  test("keeps a citation outside an unverified span linkified", () => {
    const content = "Cited [A1]. Flagged claim with no citation here.";
    const flaggedStart = content.indexOf("Flagged");
    const claims = [{ start: flaggedStart, end: content.length }];
    expect(prepareAssistantMarkdown(content, claims)).toBe(
      "Cited <citation>[A1]</citation>. <unverified>Flagged claim with no citation here.</unverified>",
    );
  });
});
