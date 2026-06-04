/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { SYSTEM_DESIGN_PROMPT_VERSIONS } from "./lib/systemDesignPrompts";

const modules = import.meta.glob("./**/*.ts");

function createTestConvex() {
  return convexTest(schema, modules);
}

async function insertRepository(
  t: ReturnType<typeof createTestConvex>,
  ownerTokenIdentifier: string,
  overrides: { lastSyncedCommitSha?: string } = {},
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("repositories", {
      ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: "https://github.com/acme/system-design",
      sourceRepoFullName: "acme/system-design",
      sourceRepoOwner: "acme",
      sourceRepoName: "system-design",
      defaultBranch: "main",
      visibility: "private",
      accessMode: "private",
      importStatus: "completed",
      detectedLanguages: [],
      packageManagers: [],
      entrypoints: [],
      fileCount: 1,
      ...overrides,
      color: "blue",
      lastAccessedAt: Date.now(),
    });
  });
}

async function insertArtifact(
  t: ReturnType<typeof createTestConvex>,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories">;
    kind?: "readme_summary" | "security_overview";
    alignedImportCommitSha?: string;
    generatedByProvider?: "openai" | "anthropic";
    generatedByModel?: string;
    promptVersion?: number;
    title?: string;
  },
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("artifacts", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: args.repositoryId,
      kind: args.kind ?? "readme_summary",
      title: args.title ?? "README Summary",
      summary: "Summary",
      contentMarkdown: "# Summary",
      version: 1,
      ...(args.alignedImportCommitSha !== undefined ? { alignedImportCommitSha: args.alignedImportCommitSha } : {}),
      ...(args.generatedByProvider !== undefined ? { generatedByProvider: args.generatedByProvider } : {}),
      ...(args.generatedByModel !== undefined ? { generatedByModel: args.generatedByModel } : {}),
      ...(args.promptVersion !== undefined ? { promptVersion: args.promptVersion } : {}),
    });
  });
}

describe("findCachedArtifact", () => {
  test("returns an exact cache-key hit", async () => {
    const ownerTokenIdentifier = "user|cached-artifact-hit";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier);
    const artifactId = await insertArtifact(t, {
      ownerTokenIdentifier,
      repositoryId,
      alignedImportCommitSha: "commit-a",
      generatedByProvider: "openai",
      generatedByModel: "gpt-5.5",
      promptVersion: 3,
    });

    const cached = await t.query(internal.systemDesign.findCachedArtifact, {
      repositoryId,
      kind: "readme_summary",
      alignedImportCommitSha: "commit-a",
      generatedByProvider: "openai",
      generatedByModel: "gpt-5.5",
      promptVersion: 3,
    });

    expect(cached?._id).toBe(artifactId);
  });

  test("misses when commit, provider, model, or promptVersion differs", async () => {
    const ownerTokenIdentifier = "user|cached-artifact-miss";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier);
    await insertArtifact(t, {
      ownerTokenIdentifier,
      repositoryId,
      alignedImportCommitSha: "commit-a",
      generatedByProvider: "openai",
      generatedByModel: "gpt-5.5",
      promptVersion: 3,
    });

    const mismatches = [
      {
        alignedImportCommitSha: "commit-b",
        generatedByProvider: "openai" as const,
        generatedByModel: "gpt-5.5",
        promptVersion: 3,
      },
      {
        alignedImportCommitSha: "commit-a",
        generatedByProvider: "anthropic" as const,
        generatedByModel: "gpt-5.5",
        promptVersion: 3,
      },
      {
        alignedImportCommitSha: "commit-a",
        generatedByProvider: "openai" as const,
        generatedByModel: "gpt-5.6",
        promptVersion: 3,
      },
      {
        alignedImportCommitSha: "commit-a",
        generatedByProvider: "openai" as const,
        generatedByModel: "gpt-5.5",
        promptVersion: 4,
      },
    ];

    for (const mismatch of mismatches) {
      const cached = await t.query(internal.systemDesign.findCachedArtifact, {
        repositoryId,
        kind: "readme_summary",
        ...mismatch,
      });
      expect(cached).toBeNull();
    }
  });

  test("returns the newest duplicate matching key", async () => {
    const ownerTokenIdentifier = "user|cached-artifact-newest";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier);
    await insertArtifact(t, {
      ownerTokenIdentifier,
      repositoryId,
      alignedImportCommitSha: "commit-a",
      generatedByProvider: "openai",
      generatedByModel: "gpt-5.5",
      promptVersion: 3,
      title: "Older artifact",
    });
    const newestArtifactId = await insertArtifact(t, {
      ownerTokenIdentifier,
      repositoryId,
      alignedImportCommitSha: "commit-a",
      generatedByProvider: "openai",
      generatedByModel: "gpt-5.5",
      promptVersion: 3,
      title: "Newer artifact",
    });

    const cached = await t.query(internal.systemDesign.findCachedArtifact, {
      repositoryId,
      kind: "readme_summary",
      alignedImportCommitSha: "commit-a",
      generatedByProvider: "openai",
      generatedByModel: "gpt-5.5",
      promptVersion: 3,
    });

    expect(cached?._id).toBe(newestArtifactId);
    expect(cached?.title).toBe("Newer artifact");
  });
});

describe("recordKindRun usage rollups", () => {
  test("records metered System Design usage and skips cached hits", async () => {
    const ownerTokenIdentifier = "user|system-design-rollup";
    const t = createTestConvex();
    const startedAt = Date.UTC(2026, 3, 24, 10, 0, 0);
    const repositoryId = await insertRepository(t, ownerTokenIdentifier);
    const jobId = await t.run(async (ctx) => {
      return await ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "system_design",
        status: "running",
        stage: "generating",
        progress: 0.5,
        costCategory: "system_design",
        triggerSource: "user",
        startedAt,
      });
    });
    const cachedArtifactId = await insertArtifact(t, {
      ownerTokenIdentifier,
      repositoryId,
      kind: "security_overview",
    });

    await t.mutation(internal.systemDesign.recordKindRun, {
      ownerTokenIdentifier,
      repositoryId,
      jobId,
      kind: "readme_summary",
      provider: "anthropic",
      modelName: "claude-sonnet-4-6",
      promptVersion: SYSTEM_DESIGN_PROMPT_VERSIONS.readme_summary,
      stepCap: 20,
      actualSteps: 3,
      inputTokens: 2_000,
      outputTokens: 750,
      cacheWriteTokens: 25,
      durationMs: 1_000,
      status: "succeeded",
      startedAt,
    });
    await t.mutation(internal.systemDesign.recordKindRun, {
      ownerTokenIdentifier,
      repositoryId,
      jobId,
      kind: "security_overview",
      artifactId: cachedArtifactId,
      provider: "anthropic",
      modelName: "claude-sonnet-4-6",
      promptVersion: SYSTEM_DESIGN_PROMPT_VERSIONS.security_overview,
      stepCap: 20,
      actualSteps: 0,
      durationMs: 10,
      status: "cached_hit",
      startedAt,
    });

    const rollups = await t.run(async (ctx) => {
      return await ctx.db
        .query("userUsageDailyRollups")
        .withIndex("by_ownerTokenIdentifier_and_yyyymmdd", (q) =>
          q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("yyyymmdd", "2026-04-24"),
        )
        .take(10);
    });

    expect(rollups).toHaveLength(1);
    expect(rollups[0]).toMatchObject({
      feature: "systemDesign",
      events: 1,
      inputTokens: 2_000,
      outputTokens: 750,
      cacheWriteTokens: 25,
    });
  });
});

describe("getCachedSelectionStatus", () => {
  test("deduplicates repeated selections before reporting totals", async () => {
    const ownerTokenIdentifier = "user|cached-selection-dedupe";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const result = await viewer.query(api.systemDesign.getCachedSelectionStatus, {
      repositoryId,
      selections: ["readme_summary", "readme_summary", "security_overview"],
    });

    expect(result.total).toBe(2);
    expect(result.cachedKinds).toEqual([]);
    expect(result.pendingKinds).toEqual(["readme_summary", "security_overview"]);
  });

  test("uses exact cache-key metadata for the preview", async () => {
    const ownerTokenIdentifier = "user|cached-selection-exact-key";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier, {
      lastSyncedCommitSha: "commit-current",
    });
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await insertArtifact(t, {
      ownerTokenIdentifier,
      repositoryId,
      kind: "readme_summary",
      alignedImportCommitSha: "commit-current",
      generatedByProvider: "openai",
      generatedByModel: "gpt-5.5",
      promptVersion: SYSTEM_DESIGN_PROMPT_VERSIONS.readme_summary,
    });
    await insertArtifact(t, {
      ownerTokenIdentifier,
      repositoryId,
      kind: "security_overview",
      alignedImportCommitSha: "commit-current",
      generatedByProvider: "anthropic",
      generatedByModel: "claude-sonnet-4-5",
      promptVersion: SYSTEM_DESIGN_PROMPT_VERSIONS.security_overview,
    });
    await insertArtifact(t, {
      ownerTokenIdentifier,
      repositoryId,
      kind: "security_overview",
      title: "Legacy security overview",
    });

    const result = await viewer.query(api.systemDesign.getCachedSelectionStatus, {
      repositoryId,
      selections: ["readme_summary", "security_overview"],
      provider: "openai",
      modelName: "gpt-5.5",
    });

    expect(result).toEqual({
      total: 2,
      cachedKinds: ["readme_summary"],
      pendingKinds: ["security_overview"],
    });
  });
});
