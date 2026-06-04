/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { api } from "../_generated/api";
import schema from "../schema";
import { TEST_INTERNALS } from "./userCost";

const { makeBucket, addToBucket, utcDayKey } = TEST_INTERNALS;
const modules = import.meta.glob("/convex/**/*.ts");

function createTestConvex() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

describe("userCost.makeBucket", () => {
  it("seeds zero values across every field", () => {
    const bucket = makeBucket();
    expect(bucket).toEqual({
      usd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      count: 0,
    });
  });
});

describe("userCost.addToBucket", () => {
  it("sums non-zero token + cost fields and bumps count", () => {
    const bucket = makeBucket();
    addToBucket(bucket, { usd: 0.0125, inputTokens: 1000, outputTokens: 500 });
    addToBucket(bucket, { usd: 0.0075, inputTokens: 200, outputTokens: 100, cachedInputTokens: 50 });
    expect(bucket.count).toBe(2);
    expect(bucket.usd).toBeCloseTo(0.02, 5);
    expect(bucket.inputTokens).toBe(1200);
    expect(bucket.outputTokens).toBe(600);
    expect(bucket.cachedInputTokens).toBe(50);
  });

  it("ignores undefined / non-positive USD but still bumps count", () => {
    const bucket = makeBucket();
    addToBucket(bucket, { inputTokens: 100 });
    addToBucket(bucket, { usd: 0, inputTokens: 50 });
    addToBucket(bucket, { usd: -1, inputTokens: 25 });
    expect(bucket.count).toBe(3);
    expect(bucket.usd).toBe(0);
    expect(bucket.inputTokens).toBe(175);
  });

  it("treats undefined token fields as zero contribution", () => {
    const bucket = makeBucket();
    addToBucket(bucket, { usd: 1, inputTokens: undefined, outputTokens: undefined });
    expect(bucket.inputTokens).toBe(0);
    expect(bucket.outputTokens).toBe(0);
    expect(bucket.count).toBe(1);
  });
});

describe("userCost.utcDayKey", () => {
  it("produces YYYY-MM-DD aligned to UTC midnight", () => {
    expect(utcDayKey(Date.UTC(2026, 4, 31, 12, 30, 0))).toBe("2026-05-31");
    expect(utcDayKey(Date.UTC(2026, 0, 1, 0, 0, 0))).toBe("2026-01-01");
  });

  it("zero-pads month and day", () => {
    expect(utcDayKey(Date.UTC(2026, 2, 5, 12, 0, 0))).toBe("2026-03-05");
  });

  it("rolls to the next day at UTC midnight", () => {
    const justBeforeMidnight = Date.UTC(2026, 5, 1, 23, 59, 59, 999);
    const atMidnight = Date.UTC(2026, 5, 2, 0, 0, 0, 0);
    expect(utcDayKey(justBeforeMidnight)).toBe("2026-06-01");
    expect(utcDayKey(atMidnight)).toBe("2026-06-02");
  });
});

describe("getViewerUsageSummary", () => {
  it("summarizes only the authenticated viewer's recent priced usage", async () => {
    const ownerTokenIdentifier = "user|usage-summary-owner";
    const otherOwnerTokenIdentifier = "user|usage-summary-other";
    const t = createTestConvex();
    const now = Date.now();

    await seedPricedAssistantMessage(t, {
      ownerTokenIdentifier,
      now,
      inputTokens: 1_000,
      outputTokens: 500,
      cachedInputTokens: 100,
      reasoningTokens: 50,
      costUsd: 0.0123,
    });
    await seedPricedAssistantMessage(t, {
      ownerTokenIdentifier: otherOwnerTokenIdentifier,
      now,
      inputTokens: 9_000,
      outputTokens: 9_000,
      costUsd: 9,
    });
    await seedSystemDesignKindRun(t, {
      ownerTokenIdentifier,
      now,
      startedAt: now - 60_000,
      inputTokens: 2_000,
      outputTokens: 750,
      cacheWriteTokens: 25,
      costUsd: 0.045,
    });
    await seedSystemDesignKindRun(t, {
      ownerTokenIdentifier,
      now,
      startedAt: now - 31 * 24 * 60 * 60 * 1000,
      inputTokens: 100_000,
      outputTokens: 100_000,
      costUsd: 100,
    });

    const summary = await t
      .withIdentity({ tokenIdentifier: ownerTokenIdentifier })
      .query(api.lib.userCost.getViewerUsageSummary, {});

    expect(summary.window.days).toBe(30);
    expect(summary.totals.events).toBe(2);
    expect(summary.totals.costUsd).toBeCloseTo(0.0573, 5);
    expect(summary.totals.inputTokens).toBe(3_000);
    expect(summary.totals.outputTokens).toBe(1_250);
    expect(summary.totals.cachedInputTokens).toBe(100);
    expect(summary.totals.cacheWriteTokens).toBe(25);
    expect(summary.totals.reasoningTokens).toBe(50);
    expect(summary.totals.totalTokens).toBe(4_425);
    expect(summary.byFeature.chat).toMatchObject({
      events: 1,
      totalTokens: 1_650,
    });
    expect(summary.byFeature.systemDesign).toMatchObject({
      events: 1,
      totalTokens: 2_775,
    });
  });

  it("requires an authenticated viewer instead of accepting an owner argument", async () => {
    const t = createTestConvex();

    await expect(t.query(api.lib.userCost.getViewerUsageSummary, {})).rejects.toThrow("You must sign in");
  });
});

async function seedPricedAssistantMessage(
  t: ReturnType<typeof createTestConvex>,
  args: {
    ownerTokenIdentifier: string;
    now: number;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens?: number;
    reasoningTokens?: number;
    costUsd: number;
  },
) {
  await t.run(async (ctx) => {
    const repositoryId = await ctx.db.insert("repositories", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: `https://github.com/acme/${args.ownerTokenIdentifier}`,
      sourceRepoFullName: `acme/${args.ownerTokenIdentifier}`,
      sourceRepoOwner: "acme",
      sourceRepoName: args.ownerTokenIdentifier,
      defaultBranch: "main",
      visibility: "private",
      accessMode: "private",
      importStatus: "completed",
      detectedLanguages: [],
      packageManagers: [],
      entrypoints: [],
      fileCount: 1,
      color: "blue",
      lastAccessedAt: args.now,
      lastImportedAt: args.now,
    });
    const threadId = await ctx.db.insert("threads", {
      repositoryId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      title: "Usage summary fixture",
      mode: "discuss",
      lastMessageAt: args.now,
    });
    const jobId = await ctx.db.insert("jobs", {
      repositoryId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      threadId,
      kind: "chat",
      status: "completed",
      stage: "completed",
      progress: 1,
      costCategory: "chat",
      triggerSource: "user",
      startedAt: args.now,
      completedAt: args.now,
    });
    await ctx.db.insert("messages", {
      repositoryId,
      threadId,
      jobId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      role: "assistant",
      status: "completed",
      mode: "discuss",
      content: "Done.",
      provider: "openai",
      modelName: "gpt-4o-mini",
      estimatedInputTokens: args.inputTokens,
      estimatedOutputTokens: args.outputTokens,
      estimatedCachedInputTokens: args.cachedInputTokens,
      estimatedReasoningTokens: args.reasoningTokens,
      estimatedCostUsd: args.costUsd,
    });
  });
}

async function seedSystemDesignKindRun(
  t: ReturnType<typeof createTestConvex>,
  args: {
    ownerTokenIdentifier: string;
    now: number;
    startedAt: number;
    inputTokens: number;
    outputTokens: number;
    cacheWriteTokens?: number;
    costUsd: number;
  },
) {
  await t.run(async (ctx) => {
    const repositoryId = await ctx.db.insert("repositories", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: `https://github.com/acme/system-${args.startedAt}`,
      sourceRepoFullName: `acme/system-${args.startedAt}`,
      sourceRepoOwner: "acme",
      sourceRepoName: `system-${args.startedAt}`,
      defaultBranch: "main",
      visibility: "private",
      accessMode: "private",
      importStatus: "completed",
      detectedLanguages: [],
      packageManagers: [],
      entrypoints: [],
      fileCount: 1,
      color: "blue",
      lastAccessedAt: args.now,
      lastImportedAt: args.now,
    });
    const jobId = await ctx.db.insert("jobs", {
      repositoryId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      kind: "system_design",
      status: "completed",
      stage: "completed",
      progress: 1,
      costCategory: "system_design",
      triggerSource: "user",
      startedAt: args.startedAt,
      completedAt: args.now,
    });
    await ctx.db.insert("systemDesignKindRuns", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId,
      jobId,
      kind: "readme_summary",
      provider: "anthropic",
      modelName: "claude-sonnet-4-6",
      promptVersion: 1,
      stepCap: 20,
      actualSteps: 3,
      inputTokens: args.inputTokens,
      outputTokens: args.outputTokens,
      cacheWriteTokens: args.cacheWriteTokens,
      totalCostUsd: args.costUsd,
      durationMs: 1_000,
      status: "succeeded",
      startedAt: args.startedAt,
    });
  });
}
