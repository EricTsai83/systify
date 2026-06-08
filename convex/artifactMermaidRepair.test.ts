import { describe, expect, test } from "vitest";
import { replaceMatchingMermaidBlock } from "./artifactMermaidRepair";
import { stripMarkdownFence } from "./artifactMermaidRepairNode";

describe("replaceMatchingMermaidBlock", () => {
  test("replaces only the matching Mermaid block", () => {
    const markdown = [
      "# Doc",
      "```mermaid",
      "flowchart TD",
      "  A --> B",
      "```",
      "",
      "```mermaid",
      "flowchart TD",
      "  C --> D",
      "```",
    ].join("\n");

    const result = replaceMatchingMermaidBlock({
      contentMarkdown: markdown,
      originalChart: "flowchart TD\n  A --> B",
      repairedChart: "flowchart TD\n  A[Start] --> B[Done]",
    });

    expect(result?.blockIndex).toBe(0);
    expect(result?.contentMarkdown).toContain("A[Start] --> B[Done]");
    expect(result?.contentMarkdown).toContain("C --> D");
  });

  test("matches the current block when renderer trims source whitespace", () => {
    const markdown = ["```mermaid", "flowchart TD", "  A --> B", "```"].join("\n");

    const result = replaceMatchingMermaidBlock({
      contentMarkdown: markdown,
      originalChart: "\nflowchart TD\n  A --> B\n",
      repairedChart: "flowchart TD\n  A --> B",
    });

    expect(result?.blockIndex).toBe(0);
  });

  test("returns null when the diagram is no longer present", () => {
    const result = replaceMatchingMermaidBlock({
      contentMarkdown: ["```mermaid", "flowchart TD", "  A --> B", "```"].join("\n"),
      originalChart: "flowchart TD\n  X --> Y",
      repairedChart: "flowchart TD\n  X --> Y",
    });

    expect(result).toBeNull();
  });
});

describe("stripMarkdownFence", () => {
  test("unwraps fenced Mermaid responses", () => {
    expect(stripMarkdownFence("```mermaid\nflowchart TD\n  A --> B\n```")).toBe("flowchart TD\n  A --> B");
    expect(stripMarkdownFence("~~~\nflowchart TD\n  A --> B\n~~~")).toBe("flowchart TD\n  A --> B");
  });
});
