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

  test("uses exact raw fenced block text to disambiguate duplicate source", () => {
    const backtickBlock = ["```mermaid", "flowchart TD", "  A --> B", "```"].join("\n");
    const tildeBlock = ["~~~mermaid", "flowchart TD", "  A --> B", "~~~"].join("\n");
    const markdown = ["# Doc", backtickBlock, "", tildeBlock].join("\n");

    const result = replaceMatchingMermaidBlock({
      contentMarkdown: markdown,
      originalChart: tildeBlock,
      repairedChart: "flowchart TD\n  A[Start] --> B[Done]",
    });

    expect(result?.blockIndex).toBe(1);
    expect(result?.contentMarkdown).toBe(
      ["# Doc", backtickBlock, "", "~~~mermaid", "flowchart TD", "  A[Start] --> B[Done]", "~~~"].join("\n"),
    );
  });

  test("returns null for ambiguous code-only duplicate source", () => {
    const duplicate = ["```mermaid", "flowchart TD", "  A --> B", "```"].join("\n");
    const markdown = ["# Doc", duplicate, "", duplicate].join("\n");

    const result = replaceMatchingMermaidBlock({
      contentMarkdown: markdown,
      originalChart: "flowchart TD\n  A --> B",
      repairedChart: "flowchart TD\n  A[Start] --> B[Done]",
    });

    expect(result).toBeNull();
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

  test("unwraps fenced Mermaid responses inside surrounding text", () => {
    expect(stripMarkdownFence("Here is the repair:\n\n```mermaid\nflowchart TD\n  A --> B\n```\nDone.")).toBe(
      "flowchart TD\n  A --> B",
    );
  });
});
