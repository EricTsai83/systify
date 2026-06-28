import { describe, expect, test } from "vitest";
import { buildGitHubSourceUrl, parseCodeFileSources } from "@/lib/source-citations";

describe("parseCodeFileSources", () => {
  test("parses single-line citations", () => {
    expect(parseCodeFileSources("See [src/chat.ts:10].")).toEqual([
      {
        path: "src/chat.ts",
        basename: "chat.ts",
        ranges: [{ startLine: 10, endLine: 10 }],
        rawTokens: ["[src/chat.ts:10]"],
      },
    ]);
  });

  test("parses line ranges", () => {
    expect(parseCodeFileSources("The handler is in [src/chat.ts:10-20].")[0]?.ranges).toEqual([
      { startLine: 10, endLine: 20 },
    ]);
  });

  test("groups duplicate file citations and preserves first-seen order", () => {
    expect(parseCodeFileSources("[b.ts:2] [a.ts:1] [b.ts:2] [b.ts:8-9]")).toEqual([
      {
        path: "b.ts",
        basename: "b.ts",
        ranges: [
          { startLine: 2, endLine: 2 },
          { startLine: 8, endLine: 9 },
        ],
        rawTokens: ["[b.ts:2]", "[b.ts:8-9]"],
      },
      {
        path: "a.ts",
        basename: "a.ts",
        ranges: [{ startLine: 1, endLine: 1 }],
        rawTokens: ["[a.ts:1]"],
      },
    ]);
  });

  test("rejects URL-like paths containing a protocol", () => {
    expect(parseCodeFileSources("Ignore [https://github.com/acme/repo:10] but keep [src/app.ts:4].")).toEqual([
      {
        path: "src/app.ts",
        basename: "app.ts",
        ranges: [{ startLine: 4, endLine: 4 }],
        rawTokens: ["[src/app.ts:4]"],
      },
    ]);
  });
});

describe("buildGitHubSourceUrl", () => {
  test("builds blob URLs with single-line anchors", () => {
    expect(
      buildGitHubSourceUrl({
        sourceRepoFullName: "acme/widget",
        ref: "abc123",
        path: "src/app.ts",
        startLine: 12,
        endLine: 12,
      }),
    ).toBe("https://github.com/acme/widget/blob/abc123/src/app.ts#L12");
  });

  test("builds blob URLs with range anchors", () => {
    expect(
      buildGitHubSourceUrl({
        sourceRepoFullName: "acme/widget",
        ref: "main",
        path: "src/app.ts",
        startLine: 12,
        endLine: 18,
      }),
    ).toBe("https://github.com/acme/widget/blob/main/src/app.ts#L12-L18");
  });
});
