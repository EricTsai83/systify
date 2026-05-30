/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { MAX_AUTOGEN_TITLE_LENGTH, sanitizeTitle } from "./titleSanitization";

describe("sanitizeTitle", () => {
  test("trims surrounding whitespace", () => {
    expect(sanitizeTitle("   Auth Flow Overview   ")).toBe("Auth Flow Overview");
  });

  test("strips a single pair of double quotes", () => {
    expect(sanitizeTitle('"Auth Flow Overview"')).toBe("Auth Flow Overview");
  });

  test("strips a single pair of single quotes", () => {
    expect(sanitizeTitle("'Auth Flow Overview'")).toBe("Auth Flow Overview");
  });

  test("strips nested mixed quote wrappers", () => {
    expect(sanitizeTitle("\"'`Auth Flow`'\"")).toBe("Auth Flow");
  });

  test("strips trailing ASCII period", () => {
    expect(sanitizeTitle("Auth Flow Overview.")).toBe("Auth Flow Overview");
  });

  test("strips trailing CJK 句號", () => {
    expect(sanitizeTitle("Auth 流程說明。")).toBe("Auth 流程說明");
  });

  test("strips trailing question mark, both half- and full-width", () => {
    expect(sanitizeTitle("Why does Auth fail?")).toBe("Why does Auth fail");
    expect(sanitizeTitle("為何 Auth 失敗？")).toBe("為何 Auth 失敗");
  });

  test("strips trailing exclamation mark, both half- and full-width", () => {
    expect(sanitizeTitle("Auth works!")).toBe("Auth works");
    expect(sanitizeTitle("Auth 成功！")).toBe("Auth 成功");
  });

  test("preserves interior punctuation (only trailing terminators are stripped)", () => {
    expect(sanitizeTitle("Auth: OAuth Flow")).toBe("Auth: OAuth Flow");
    expect(sanitizeTitle("Step 1. Verify token")).toBe("Step 1. Verify token");
  });

  test("returns empty string for whitespace-only input so caller skips the patch", () => {
    expect(sanitizeTitle("   \n  \t  ")).toBe("");
  });

  test("returns empty string for pure-punctuation input", () => {
    expect(sanitizeTitle("...")).toBe("");
    expect(sanitizeTitle('""')).toBe("");
  });

  test("truncates to MAX_AUTOGEN_TITLE_LENGTH instead of rejecting", () => {
    const long = "a".repeat(MAX_AUTOGEN_TITLE_LENGTH + 50);
    const result = sanitizeTitle(long);
    expect(result.length).toBe(MAX_AUTOGEN_TITLE_LENGTH);
  });

  test("preserves titles at or below the cap unchanged", () => {
    const exact = "x".repeat(MAX_AUTOGEN_TITLE_LENGTH);
    expect(sanitizeTitle(exact)).toBe(exact);
  });

  test("returns Traditional Chinese title unchanged when within cap", () => {
    expect(sanitizeTitle("使用者認證流程說明")).toBe("使用者認證流程說明");
  });
});
