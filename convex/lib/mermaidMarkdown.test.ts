import { describe, expect, it } from "vitest";
import { extractMermaidCodeBlocks, replaceMermaidCodeBlocks } from "./mermaidMarkdown";

describe("extractMermaidCodeBlocks", () => {
  it("extracts closed mermaid fences with source line metadata", () => {
    const markdown = ["# Architecture Diagram", "", "```  mermaid", "graph TD", "  a --> b", "```"].join("\n");

    expect(extractMermaidCodeBlocks(markdown)).toEqual([
      {
        blockIndex: 0,
        code: "graph TD\n  a --> b",
        startLine: 4,
        startLineIndex: 3,
        endLineIndex: 5,
      },
    ]);
  });

  it("can replace a mermaid block without touching surrounding markdown", () => {
    const markdown = ["Before", "```mermaid", "graph TD", "  a --> b", "```", "After"].join("\n");
    const replacements = new Map([[0, "graph LR\n  a --> b"]]);

    expect(replaceMermaidCodeBlocks(markdown, replacements)).toBe(
      ["Before", "```mermaid", "graph LR", "  a --> b", "```", "After"].join("\n"),
    );
  });

  it("ignores unterminated mermaid fences", () => {
    const markdown = ["```mermaid", "graph TD", "  a --> b"].join("\n");

    expect(extractMermaidCodeBlocks(markdown)).toEqual([]);
  });
});
