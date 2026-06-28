import { describe, expect, test } from "vitest";
import { buildEditorUrl } from "@/lib/local-editor";

describe("buildEditorUrl", () => {
  test("builds Cursor URLs", () => {
    expect(
      buildEditorUrl({
        editor: "cursor",
        rootPath: "/Users/eric/project",
        relativePath: "src/app.ts",
        line: 12,
      }),
    ).toBe("cursor://file//Users/eric/project/src/app.ts:12");
  });

  test("builds VS Code URLs", () => {
    expect(
      buildEditorUrl({
        editor: "vscode",
        rootPath: "/Users/eric/project",
        relativePath: "src/app.ts",
        line: 12,
      }),
    ).toBe("vscode://file//Users/eric/project/src/app.ts:12:1");
  });

  test("strips duplicate slashes at the join boundary", () => {
    expect(
      buildEditorUrl({
        editor: "cursor",
        rootPath: "/Users/eric/project/",
        relativePath: "/src/app.ts",
        line: 12,
      }),
    ).toBe("cursor://file//Users/eric/project/src/app.ts:12");
  });

  test("rejects parent-directory traversal", () => {
    expect(() =>
      buildEditorUrl({
        editor: "cursor",
        rootPath: "/Users/eric/project",
        relativePath: "../secret.ts",
        line: 1,
      }),
    ).toThrow("parent-directory");
  });
});
