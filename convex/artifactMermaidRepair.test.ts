import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import { replaceMatchingMermaidBlock } from "./artifactMermaidRepair";
import { stripMarkdownFence } from "./artifactMermaidRepairNode";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function createTestConvex() {
  return convexTest(schema, modules);
}

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

describe("getRepairContext", () => {
  test("rejects repository-scoped artifacts after repository archive", async () => {
    const t = createTestConvex();
    const ownerTokenIdentifier = "user|mermaid-repair-archived";
    const { artifactId } = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/mermaid",
        sourceRepoFullName: "acme/mermaid",
        sourceRepoOwner: "acme",
        sourceRepoName: "mermaid",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 1,
        color: "blue",
        lastAccessedAt: Date.now(),
        archivedAt: Date.now(),
      });
      const artifactId = await ctx.db.insert("artifacts", {
        ownerTokenIdentifier,
        repositoryId,
        kind: "architecture_diagram",
        title: "Diagram",
        description: "Summary",
        contentMarkdown: ["```mermaid", "flowchart TD", "  A --> B", "```"].join("\n"),
        version: 1,
      });
      return { artifactId };
    });

    await expect(
      t.query(internal.artifactMermaidRepair.getRepairContext, {
        artifactId,
        ownerTokenIdentifier,
        chart: "flowchart TD\n  A --> B",
      }),
    ).rejects.toThrow(/artifact not found/i);
  });
});

describe("applyRepairedBlock", () => {
  test("creates a matching artifact version row for repaired content", async () => {
    const t = createTestConvex();
    const ownerTokenIdentifier = "user|mermaid-repair-version";
    const { artifactId } = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/mermaid-version",
        sourceRepoFullName: "acme/mermaid-version",
        sourceRepoOwner: "acme",
        sourceRepoName: "mermaid-version",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 1,
        color: "blue",
        lastAccessedAt: Date.now(),
      });
      const contentMarkdown = ["```mermaid", "flowchart TD", "  A --> B", "```"].join("\n");
      const artifactId = await ctx.db.insert("artifacts", {
        ownerTokenIdentifier,
        repositoryId,
        kind: "architecture_diagram",
        title: "Diagram",
        description: "Summary",
        contentMarkdown,
        version: 1,
        chunkingStatus: "failed",
        chunkingFailureReason: "embedding_failed",
      });
      const versionId = await ctx.db.insert("artifactVersions", {
        artifactId,
        version: 1,
        ownerTokenIdentifier,
        repositoryId,
        title: "Diagram",
        description: "Summary",
        contentMarkdown,
        renderFormat: "markdown",
        createdAt: Date.now(),
      });
      await ctx.db.patch(artifactId, { currentVersionId: versionId });
      return { artifactId };
    });

    const result = await t.mutation(internal.artifactMermaidRepair.applyRepairedBlock, {
      artifactId,
      ownerTokenIdentifier,
      expectedVersion: 1,
      originalChart: "flowchart TD\n  A --> B",
      repairedChart: "flowchart TD\n  A[Start] --> B[Done]",
    });

    const state = await t.run(async (ctx) => {
      const artifact = await ctx.db.get(artifactId);
      const versions = await ctx.db
        .query("artifactVersions")
        .withIndex("by_artifactId", (q) => q.eq("artifactId", artifactId))
        .collect();
      const currentVersion = artifact?.currentVersionId ? await ctx.db.get(artifact.currentVersionId) : null;
      return { artifact, versions, currentVersion };
    });

    expect(result).toMatchObject({ updated: true, version: 2, blockIndex: 0 });
    expect(state.artifact?.version).toBe(2);
    expect(state.artifact?.chunkingStatus).toBe("pending");
    expect(state.artifact?.chunkingFailureReason).toBeUndefined();
    expect(state.versions.map((version) => version.version).sort()).toEqual([1, 2]);
    expect(state.currentVersion?.version).toBe(2);
    expect(state.currentVersion?.contentMarkdown).toContain("A[Start] --> B[Done]");
  });
});
