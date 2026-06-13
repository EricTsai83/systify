/// <reference types="vite/client" />

import { afterEach, describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";
import { SYSTEM_DESIGN_PROMPT_VERSIONS } from "./lib/systemDesignPrompts";
import { peekSandboxDailyCostForUser } from "./lib/rateLimit";
import { createRateLimitedTestConvex } from "../test/convex/harness";
import { withPausedConvexScheduler } from "../test/convex/scheduler";

const modules = import.meta.glob("./**/*.ts");

function createTestConvex() {
  return convexTest(schema, modules);
}

afterEach(() => {
  delete process.env.SANDBOX_DAILY_CAP_PER_USER_USD;
  delete process.env.SANDBOX_DAILY_CAP_PER_REPOSITORY_USD;
});

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
    folderId?: Id<"artifactFolders">;
    alignedImportCommitSha?: string;
    generatedByProvider?: "openai" | "anthropic";
    generatedByModel?: string;
    promptVersion?: number;
    title?: string;
    contentMarkdown?: string;
  },
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("artifacts", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: args.repositoryId,
      kind: args.kind ?? "readme_summary",
      title: args.title ?? "README Summary",
      summary: "Summary",
      contentMarkdown: args.contentMarkdown ?? "# Summary",
      version: 1,
      ...(args.folderId !== undefined ? { folderId: args.folderId } : {}),
      ...(args.alignedImportCommitSha !== undefined ? { alignedImportCommitSha: args.alignedImportCommitSha } : {}),
      ...(args.generatedByProvider !== undefined ? { generatedByProvider: args.generatedByProvider } : {}),
      ...(args.generatedByModel !== undefined ? { generatedByModel: args.generatedByModel } : {}),
      ...(args.promptVersion !== undefined ? { promptVersion: args.promptVersion } : {}),
    });
  });
}

async function insertSystemDesignFolder(
  t: ReturnType<typeof createTestConvex>,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories">;
    systemKey?: string;
    name?: string;
  },
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("artifactFolders", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: args.repositoryId,
      name: args.name ?? "Overview",
      systemKey: args.systemKey ?? "overview",
    });
  });
}

async function insertRunningSystemDesignJob(
  t: ReturnType<typeof createTestConvex>,
  args: {
    ownerTokenIdentifier: string;
    repositoryId: Id<"repositories">;
    startedAt?: number;
    selections?: Array<"readme_summary" | "security_overview">;
    leaseExpiresAt?: number;
  },
) {
  const startedAt = args.startedAt ?? Date.now();
  return await t.run(async (ctx) => {
    return await ctx.db.insert("jobs", {
      repositoryId: args.repositoryId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      kind: "system_design",
      status: "running",
      stage: "generating",
      progress: 0.5,
      costCategory: "system_design",
      triggerSource: "user",
      selections: args.selections,
      startedAt,
      leaseExpiresAt: args.leaseExpiresAt ?? Date.now() + 60_000,
    });
  });
}

describe("findCachedArtifact", () => {
  test("returns an exact cache-key hit", async () => {
    const ownerTokenIdentifier = "user|cached-artifact-hit";
    const t = createRateLimitedTestConvex();
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

describe("finalizeKindPublication", () => {
  test("generated success replaces stale artifact, links kindRun, and settles usage once", async () => {
    await withPausedConvexScheduler(async () => {
      process.env.SANDBOX_DAILY_CAP_PER_USER_USD = "0.10";
      process.env.SANDBOX_DAILY_CAP_PER_REPOSITORY_USD = "0.10";

      const ownerTokenIdentifier = "user|system-design-finalize-generated";
      const t = createRateLimitedTestConvex();
      const startedAt = Date.UTC(2026, 3, 24, 10, 0, 0);
      const repositoryId = await insertRepository(t, ownerTokenIdentifier);
      const folderId = await insertSystemDesignFolder(t, { ownerTokenIdentifier, repositoryId });
      const staleArtifactId = await insertArtifact(t, {
        ownerTokenIdentifier,
        repositoryId,
        folderId,
        contentMarkdown: "# Old summary",
      });
      const jobId = await insertRunningSystemDesignJob(t, { ownerTokenIdentifier, repositoryId, startedAt });
      const sourceId = `systemDesign:${jobId}:readme_summary:${startedAt}`;

      const result = await t.mutation(internal.systemDesign.finalizeKindPublication, {
        ownerTokenIdentifier,
        repositoryId,
        jobId,
        kind: "readme_summary",
        provider: "anthropic",
        modelName: "claude-sonnet-4-6",
        promptVersion: SYSTEM_DESIGN_PROMPT_VERSIONS.readme_summary,
        alignedImportCommitSha: "commit-a",
        stepCap: 20,
        actualSteps: 3,
        durationMs: 1_000,
        startedAt,
        outcome: {
          kind: "generated",
          title: "README Summary",
          summary: "Fresh summary",
          contentMarkdown: "# Fresh summary\n\nGenerated body.",
          outputCharLength: 32,
          usage: {
            inputTokens: 2_000,
            outputTokens: 750,
            cacheWriteTokens: 25,
          },
          totalCostUsd: 0.03,
        },
      });

      expect(result).toMatchObject({
        finalized: true,
        status: "succeeded",
        countsAsSucceeded: true,
        aborted: false,
      });
      if (!result.finalized || !result.artifactId) {
        throw new Error("Expected generated finalization to create an artifact.");
      }
      const artifactId = result.artifactId;

      const state = await t.run(async (ctx) => {
        const artifact = await ctx.db.get(artifactId);
        const staleArtifact = await ctx.db.get(staleArtifactId);
        const kindRuns = await ctx.db
          .query("systemDesignKindRuns")
          .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
          .take(10);
        const events = await ctx.db
          .query("userUsageEvents")
          .withIndex("by_sourceId", (q) => q.eq("sourceId", sourceId))
          .take(10);
        const rollups = await ctx.db
          .query("userUsageDailyRollups")
          .withIndex("by_ownerTokenIdentifier_and_yyyymmdd", (q) =>
            q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("yyyymmdd", "2026-04-24"),
          )
          .take(10);
        const budget = await peekSandboxDailyCostForUser(ctx, ownerTokenIdentifier);
        return { artifact, staleArtifact, kindRuns, events, rollups, budget };
      });

      expect(state.staleArtifact).toBeNull();
      expect(state.kindRuns).toHaveLength(1);
      expect(state.artifact).toMatchObject({
        repositoryId,
        folderId,
        ownerTokenIdentifier,
        kind: "readme_summary",
        title: "README Summary",
        summary: "Fresh summary",
        version: 1,
        chunkingStatus: "pending",
        alignedImportCommitSha: "commit-a",
        generatedByProvider: "anthropic",
        generatedByModel: "claude-sonnet-4-6",
        promptVersion: SYSTEM_DESIGN_PROMPT_VERSIONS.readme_summary,
        kindRunId: state.kindRuns[0]._id,
      });
      expect(state.kindRuns[0]).toMatchObject({
        status: "succeeded",
        artifactId: result.artifactId,
        inputTokens: 2_000,
        outputTokens: 750,
        cacheWriteTokens: 25,
        totalCostUsd: 0.03,
        outputCharLength: 32,
      });
      expect(state.events).toHaveLength(1);
      expect(state.rollups[0]).toMatchObject({
        feature: "systemDesign",
        events: 1,
        inputTokens: 2_000,
        outputTokens: 750,
        cacheWriteTokens: 25,
      });
      expect(state.budget.remainingCents).toBe(7);
    });
  });

  test("cache hit records a free kindRun and leaves cached artifact provenance untouched", async () => {
    const ownerTokenIdentifier = "user|system-design-finalize-cache-hit";
    const t = createTestConvex();
    const startedAt = Date.now();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier);
    const jobId = await insertRunningSystemDesignJob(t, { ownerTokenIdentifier, repositoryId, startedAt });
    const cachedArtifactId = await insertArtifact(t, {
      ownerTokenIdentifier,
      repositoryId,
      contentMarkdown: "# Cached summary",
    });
    const sourceId = `systemDesign:${jobId}:readme_summary:${startedAt}`;

    const result = await t.mutation(internal.systemDesign.finalizeKindPublication, {
      ownerTokenIdentifier,
      repositoryId,
      jobId,
      kind: "readme_summary",
      provider: "openai",
      modelName: "gpt-5.5",
      promptVersion: SYSTEM_DESIGN_PROMPT_VERSIONS.readme_summary,
      stepCap: 20,
      actualSteps: 0,
      durationMs: 10,
      startedAt,
      outcome: {
        kind: "cached_hit",
        cachedArtifactId,
        outputCharLength: "# Cached summary".length,
      },
    });

    const state = await t.run(async (ctx) => {
      const artifact = await ctx.db.get(cachedArtifactId);
      const kindRuns = await ctx.db
        .query("systemDesignKindRuns")
        .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
        .take(10);
      const events = await ctx.db
        .query("userUsageEvents")
        .withIndex("by_sourceId", (q) => q.eq("sourceId", sourceId))
        .take(10);
      return { artifact, kindRuns, events };
    });

    expect(result).toMatchObject({
      finalized: true,
      status: "cached_hit",
      artifactId: cachedArtifactId,
      countsAsSucceeded: true,
      aborted: false,
    });
    expect(state.kindRuns).toHaveLength(1);
    expect(state.kindRuns[0]).toMatchObject({
      status: "cached_hit",
      artifactId: cachedArtifactId,
      actualSteps: 0,
      outputCharLength: "# Cached summary".length,
    });
    expect(state.artifact?.kindRunId).toBeUndefined();
    expect(state.events).toHaveLength(0);
  });

  test("quality rejection records missing sections, settles usage, and creates no artifact", async () => {
    process.env.SANDBOX_DAILY_CAP_PER_USER_USD = "0.10";
    process.env.SANDBOX_DAILY_CAP_PER_REPOSITORY_USD = "0.10";

    const ownerTokenIdentifier = "user|system-design-finalize-quality";
    const t = createRateLimitedTestConvex();
    const startedAt = Date.now();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier);
    const jobId = await insertRunningSystemDesignJob(t, { ownerTokenIdentifier, repositoryId, startedAt });
    const sourceId = `systemDesign:${jobId}:readme_summary:${startedAt}`;

    const result = await t.mutation(internal.systemDesign.finalizeKindPublication, {
      ownerTokenIdentifier,
      repositoryId,
      jobId,
      kind: "readme_summary",
      provider: "openai",
      modelName: "gpt-5.5",
      promptVersion: SYSTEM_DESIGN_PROMPT_VERSIONS.readme_summary,
      stepCap: 20,
      actualSteps: 2,
      durationMs: 500,
      startedAt,
      outcome: {
        kind: "quality_rejected",
        failureReason: "output_quality",
        missingSections: ["overview", "risks"],
        outputCharLength: 128,
        usage: {
          inputTokens: 900,
          outputTokens: 300,
        },
        totalCostUsd: 0.02,
      },
    });

    const state = await t.run(async (ctx) => {
      const artifacts = await ctx.db
        .query("artifacts")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
        .take(10);
      const kindRuns = await ctx.db
        .query("systemDesignKindRuns")
        .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
        .take(10);
      const events = await ctx.db
        .query("userUsageEvents")
        .withIndex("by_sourceId", (q) => q.eq("sourceId", sourceId))
        .take(10);
      const budget = await peekSandboxDailyCostForUser(ctx, ownerTokenIdentifier);
      return { artifacts, kindRuns, events, budget };
    });

    expect(result).toMatchObject({
      finalized: true,
      status: "quality_rejected",
      countsAsSucceeded: false,
      aborted: false,
    });
    expect(state.artifacts).toHaveLength(0);
    expect(state.kindRuns).toHaveLength(1);
    expect(state.kindRuns[0]).toMatchObject({
      status: "quality_rejected",
      failureReason: "output_quality",
      missingSections: ["overview", "risks"],
      outputCharLength: 128,
    });
    expect(state.events).toHaveLength(1);
    expect(state.budget.remainingCents).toBe(8);
  });

  test("failed outcome appends job failure, settles usage, and creates no artifact", async () => {
    process.env.SANDBOX_DAILY_CAP_PER_USER_USD = "0.10";
    process.env.SANDBOX_DAILY_CAP_PER_REPOSITORY_USD = "0.10";

    const ownerTokenIdentifier = "user|system-design-finalize-failed";
    const t = createRateLimitedTestConvex();
    const startedAt = Date.now();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier);
    const jobId = await insertRunningSystemDesignJob(t, { ownerTokenIdentifier, repositoryId, startedAt });
    const sourceId = `systemDesign:${jobId}:readme_summary:${startedAt}`;

    const result = await t.mutation(internal.systemDesign.finalizeKindPublication, {
      ownerTokenIdentifier,
      repositoryId,
      jobId,
      kind: "readme_summary",
      provider: "openai",
      modelName: "gpt-5.5",
      promptVersion: SYSTEM_DESIGN_PROMPT_VERSIONS.readme_summary,
      stepCap: 20,
      actualSteps: 1,
      durationMs: 400,
      startedAt,
      outcome: {
        kind: "failed",
        failureReason: "transport_other",
        failureLog: {
          errorId: "err_123",
          message: "provider failed",
        },
        usage: {
          inputTokens: 500,
          outputTokens: 100,
        },
        totalCostUsd: 0.01,
      },
    });

    const state = await t.run(async (ctx) => {
      const job = await ctx.db.get(jobId);
      const artifacts = await ctx.db
        .query("artifacts")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
        .take(10);
      const kindRuns = await ctx.db
        .query("systemDesignKindRuns")
        .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
        .take(10);
      const events = await ctx.db
        .query("userUsageEvents")
        .withIndex("by_sourceId", (q) => q.eq("sourceId", sourceId))
        .take(10);
      return { job, artifacts, kindRuns, events };
    });

    expect(result).toMatchObject({
      finalized: true,
      status: "failed",
      countsAsSucceeded: false,
      aborted: false,
    });
    expect(state.artifacts).toHaveLength(0);
    expect(state.kindRuns).toHaveLength(1);
    expect(state.kindRuns[0]).toMatchObject({
      status: "failed",
      failureReason: "transport_other",
      inputTokens: 500,
      outputTokens: 100,
    });
    expect(state.job?.kindFailures).toEqual([
      {
        kind: "readme_summary",
        errorId: "err_123",
        message: "provider failed",
        reason: "transport_other",
      },
    ]);
    expect(state.events).toHaveLength(1);
  });

  test("settles paid generated output but writes nothing when repository is archived", async () => {
    process.env.SANDBOX_DAILY_CAP_PER_USER_USD = "0.10";
    process.env.SANDBOX_DAILY_CAP_PER_REPOSITORY_USD = "0.10";

    const ownerTokenIdentifier = "user|system-design-finalize-archived-paid";
    const t = createRateLimitedTestConvex();
    const startedAt = Date.now();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier);
    const jobId = await insertRunningSystemDesignJob(t, { ownerTokenIdentifier, repositoryId, startedAt });
    const sourceId = `systemDesign:${jobId}:readme_summary:${startedAt}`;
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, { archivedAt: Date.now() });
    });

    const result = await t.mutation(internal.systemDesign.finalizeKindPublication, {
      ownerTokenIdentifier,
      repositoryId,
      jobId,
      kind: "readme_summary",
      provider: "openai",
      modelName: "gpt-5.5",
      promptVersion: SYSTEM_DESIGN_PROMPT_VERSIONS.readme_summary,
      stepCap: 20,
      actualSteps: 3,
      durationMs: 1_000,
      startedAt,
      outcome: {
        kind: "generated",
        title: "README Summary",
        summary: "Summary",
        contentMarkdown: "# Summary",
        outputCharLength: 9,
        usage: {
          inputTokens: 1_000,
          outputTokens: 500,
        },
        totalCostUsd: 0.02,
      },
    });

    const state = await t.run(async (ctx) => {
      const artifacts = await ctx.db
        .query("artifacts")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
        .take(10);
      const kindRuns = await ctx.db
        .query("systemDesignKindRuns")
        .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
        .take(10);
      const events = await ctx.db
        .query("userUsageEvents")
        .withIndex("by_sourceId", (q) => q.eq("sourceId", sourceId))
        .take(10);
      const budget = await peekSandboxDailyCostForUser(ctx, ownerTokenIdentifier);
      return { artifacts, kindRuns, events, budget };
    });

    expect(result).toEqual({
      finalized: false,
      status: "succeeded",
      countsAsSucceeded: false,
      aborted: true,
      reason: "inactive_target",
      settledUsage: true,
    });
    expect(state.artifacts).toHaveLength(0);
    expect(state.kindRuns).toHaveLength(0);
    expect(state.events).toHaveLength(1);
    expect(state.budget.remainingCents).toBe(8);
  });

  test("aborts archived cache hit without kindRun or settlement", async () => {
    const ownerTokenIdentifier = "user|system-design-finalize-archived-cache";
    const t = createTestConvex();
    const startedAt = Date.now();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier);
    const jobId = await insertRunningSystemDesignJob(t, { ownerTokenIdentifier, repositoryId, startedAt });
    const cachedArtifactId = await insertArtifact(t, { ownerTokenIdentifier, repositoryId });
    const sourceId = `systemDesign:${jobId}:readme_summary:${startedAt}`;
    await t.run(async (ctx) => {
      await ctx.db.patch(repositoryId, { archivedAt: Date.now() });
    });

    const result = await t.mutation(internal.systemDesign.finalizeKindPublication, {
      ownerTokenIdentifier,
      repositoryId,
      jobId,
      kind: "readme_summary",
      provider: "openai",
      modelName: "gpt-5.5",
      promptVersion: SYSTEM_DESIGN_PROMPT_VERSIONS.readme_summary,
      stepCap: 20,
      actualSteps: 0,
      durationMs: 10,
      startedAt,
      outcome: {
        kind: "cached_hit",
        cachedArtifactId,
        outputCharLength: 9,
      },
    });

    const state = await t.run(async (ctx) => {
      const kindRuns = await ctx.db
        .query("systemDesignKindRuns")
        .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
        .take(10);
      const events = await ctx.db
        .query("userUsageEvents")
        .withIndex("by_sourceId", (q) => q.eq("sourceId", sourceId))
        .take(10);
      return { kindRuns, events };
    });

    expect(result).toEqual({
      finalized: false,
      status: "cached_hit",
      countsAsSucceeded: false,
      aborted: true,
      reason: "inactive_target",
      settledUsage: false,
    });
    expect(state.kindRuns).toHaveLength(0);
    expect(state.events).toHaveLength(0);
  });

  test("aborts invalid cached artifact without kindRun or settlement", async () => {
    const ownerTokenIdentifier = "user|system-design-finalize-invalid-cache";
    const t = createTestConvex();
    const startedAt = Date.now();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier);
    const jobId = await insertRunningSystemDesignJob(t, { ownerTokenIdentifier, repositoryId, startedAt });
    const wrongKindArtifactId = await insertArtifact(t, {
      ownerTokenIdentifier,
      repositoryId,
      kind: "security_overview",
    });
    const sourceId = `systemDesign:${jobId}:readme_summary:${startedAt}`;

    const result = await t.mutation(internal.systemDesign.finalizeKindPublication, {
      ownerTokenIdentifier,
      repositoryId,
      jobId,
      kind: "readme_summary",
      provider: "openai",
      modelName: "gpt-5.5",
      promptVersion: SYSTEM_DESIGN_PROMPT_VERSIONS.readme_summary,
      stepCap: 20,
      actualSteps: 0,
      durationMs: 10,
      startedAt,
      outcome: {
        kind: "cached_hit",
        cachedArtifactId: wrongKindArtifactId,
        outputCharLength: 9,
      },
    });

    const state = await t.run(async (ctx) => {
      const kindRuns = await ctx.db
        .query("systemDesignKindRuns")
        .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
        .take(10);
      const events = await ctx.db
        .query("userUsageEvents")
        .withIndex("by_sourceId", (q) => q.eq("sourceId", sourceId))
        .take(10);
      return { kindRuns, events };
    });

    expect(result).toEqual({
      finalized: false,
      status: "cached_hit",
      countsAsSucceeded: false,
      aborted: true,
      reason: "invalid_cached_artifact",
      settledUsage: false,
    });
    expect(state.kindRuns).toHaveLength(0);
    expect(state.events).toHaveLength(0);
  });

  test("duplicate sourceId settlement keeps usage and daily cap idempotent", async () => {
    await withPausedConvexScheduler(async () => {
      process.env.SANDBOX_DAILY_CAP_PER_USER_USD = "0.10";
      process.env.SANDBOX_DAILY_CAP_PER_REPOSITORY_USD = "0.10";

      const ownerTokenIdentifier = "user|system-design-idempotent-settle";
      const t = createRateLimitedTestConvex();
      const startedAt = Date.now();
      const repositoryId = await insertRepository(t, ownerTokenIdentifier);
      await insertSystemDesignFolder(t, { ownerTokenIdentifier, repositoryId });
      const jobId = await insertRunningSystemDesignJob(t, { ownerTokenIdentifier, repositoryId, startedAt });
      const sourceId = `systemDesign:${jobId}:readme_summary:${startedAt}`;
      const args = {
        ownerTokenIdentifier,
        repositoryId,
        jobId,
        kind: "readme_summary",
        provider: "openai",
        modelName: "gpt-5.5",
        promptVersion: SYSTEM_DESIGN_PROMPT_VERSIONS.readme_summary,
        stepCap: 20,
        actualSteps: 3,
        durationMs: 1_000,
        startedAt,
        outcome: {
          kind: "generated",
          title: "README Summary",
          summary: "Summary",
          contentMarkdown: "# Summary",
          outputCharLength: 9,
          usage: {
            inputTokens: 1_000,
            outputTokens: 500,
          },
          totalCostUsd: 0.03,
        },
      } as const;

      await t.mutation(internal.systemDesign.finalizeKindPublication, args);
      await t.mutation(internal.systemDesign.finalizeKindPublication, args);

      const state = await t.run(async (ctx) => {
        const kindRuns = await ctx.db
          .query("systemDesignKindRuns")
          .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
          .take(10);
        const events = await ctx.db
          .query("userUsageEvents")
          .withIndex("by_sourceId", (q) => q.eq("sourceId", sourceId))
          .take(10);
        const artifacts = await ctx.db
          .query("artifacts")
          .withIndex("by_repositoryId_and_kind", (q) => q.eq("repositoryId", repositoryId).eq("kind", "readme_summary"))
          .take(10);
        const budget = await peekSandboxDailyCostForUser(ctx, ownerTokenIdentifier);
        return { kindRuns, events, artifacts, budget };
      });

      expect(state.kindRuns).toHaveLength(2);
      expect(state.events).toHaveLength(1);
      expect(state.artifacts).toHaveLength(1);
      expect(state.budget.remainingCents).toBe(7);
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
