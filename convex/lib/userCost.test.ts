/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { TEST_INTERNALS } from "./userCost";

const { makeBucket, addToBucket, utcDayKey, hasRecordableUsage } = TEST_INTERNALS;
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

describe("userCost.hasRecordableUsage", () => {
  it("treats cost or any token slice as metered usage", () => {
    expect(hasRecordableUsage({ usd: 0.01 })).toBe(true);
    expect(hasRecordableUsage({ cachedInputTokens: 10 })).toBe(true);
    expect(hasRecordableUsage({ cacheWriteTokens: 10 })).toBe(true);
    expect(hasRecordableUsage({ reasoningTokens: 10 })).toBe(true);
  });

  it("rejects empty, zero, negative, and non-finite usage", () => {
    expect(hasRecordableUsage({})).toBe(false);
    expect(hasRecordableUsage({ usd: 0, inputTokens: 0, outputTokens: 0 })).toBe(false);
    expect(hasRecordableUsage({ usd: -1, inputTokens: Number.NaN })).toBe(false);
  });
});

describe("getViewerUsageSummary", () => {
  it("summarizes only the authenticated viewer's recent priced usage", async () => {
    const ownerTokenIdentifier = "user|usage-summary-owner";
    const otherOwnerTokenIdentifier = "user|usage-summary-other";
    const t = createTestConvex();
    const now = Date.now();

    await recordUsage(t, {
      sourceId: "chat:recent-owner",
      ownerTokenIdentifier,
      feature: "chat",
      occurredAtMs: now,
      inputTokens: 1_000,
      outputTokens: 500,
      cachedInputTokens: 100,
      reasoningTokens: 50,
      usd: 0.0123,
    });
    await recordUsage(t, {
      sourceId: "chat:recent-other-owner",
      ownerTokenIdentifier: otherOwnerTokenIdentifier,
      feature: "chat",
      occurredAtMs: now,
      inputTokens: 9_000,
      outputTokens: 9_000,
      usd: 9,
    });
    await recordUsage(t, {
      sourceId: "system-design:recent-owner",
      ownerTokenIdentifier,
      feature: "systemDesign",
      occurredAtMs: now - 60_000,
      inputTokens: 2_000,
      outputTokens: 750,
      cacheWriteTokens: 25,
      usd: 0.045,
    });
    await recordUsage(t, {
      sourceId: "system-design:old-owner",
      ownerTokenIdentifier,
      feature: "systemDesign",
      occurredAtMs: now - 31 * 24 * 60 * 60 * 1000,
      inputTokens: 100_000,
      outputTokens: 100_000,
      usd: 100,
    });
    await recordUsage(t, {
      sourceId: "system-design:empty-owner",
      ownerTokenIdentifier,
      feature: "systemDesign",
      occurredAtMs: now,
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

  it("deduplicates repeated rollup writes for the same source event", async () => {
    const ownerTokenIdentifier = "user|usage-summary-dedupe";
    const t = createTestConvex();
    const now = Date.now();

    await recordUsage(t, {
      sourceId: "message:dedupe",
      ownerTokenIdentifier,
      feature: "chat",
      occurredAtMs: now,
      inputTokens: 1_000,
      outputTokens: 500,
      usd: 0.0123,
    });
    await recordUsage(t, {
      sourceId: "message:dedupe",
      ownerTokenIdentifier,
      feature: "chat",
      occurredAtMs: now,
      inputTokens: 9_000,
      outputTokens: 9_000,
      usd: 9,
    });

    const summary = await t
      .withIdentity({ tokenIdentifier: ownerTokenIdentifier })
      .query(api.lib.userCost.getViewerUsageSummary, {});

    expect(summary.totals.events).toBe(1);
    expect(summary.totals.costUsd).toBeCloseTo(0.0123, 5);
    expect(summary.totals.inputTokens).toBe(1_000);
    expect(summary.totals.outputTokens).toBe(500);
  });

  it("does not scan raw messages when no daily rollup exists", async () => {
    const ownerTokenIdentifier = "user|usage-summary-raw-only";
    const t = createTestConvex();
    await seedRawPricedAssistantMessage(t, {
      ownerTokenIdentifier,
      inputTokens: 1_000,
      outputTokens: 500,
      costUsd: 0.0123,
    });

    const summary = await t
      .withIdentity({ tokenIdentifier: ownerTokenIdentifier })
      .query(api.lib.userCost.getViewerUsageSummary, {});

    expect(summary.totals.events).toBe(0);
    expect(summary.totals.totalTokens).toBe(0);
    expect(summary.totals.costUsd).toBe(0);
  });

  it("requires an authenticated viewer instead of accepting an owner argument", async () => {
    const t = createTestConvex();

    await expect(t.query(api.lib.userCost.getViewerUsageSummary, {})).rejects.toThrow("You must sign in");
  });
});

async function recordUsage(
  t: ReturnType<typeof createTestConvex>,
  args: {
    sourceId: string;
    ownerTokenIdentifier: string;
    feature: "chat" | "systemDesign";
    occurredAtMs: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    reasoningTokens?: number;
    usd?: number;
  },
) {
  await t.mutation(internal.lib.userCost.recordUsageEvent, {
    sourceId: args.sourceId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    feature: args.feature,
    occurredAtMs: args.occurredAtMs,
    inputTokens: args.inputTokens,
    outputTokens: args.outputTokens,
    cachedInputTokens: args.cachedInputTokens,
    cacheWriteTokens: args.cacheWriteTokens,
    reasoningTokens: args.reasoningTokens,
    usd: args.usd,
  });
}

async function seedRawPricedAssistantMessage(
  t: ReturnType<typeof createTestConvex>,
  args: {
    ownerTokenIdentifier: string;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  },
) {
  const now = Date.now();
  await t.run(async (ctx) => {
    const threadId = await ctx.db.insert("threads", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      title: "Raw usage fixture",
      mode: "discuss",
      lastMessageAt: now,
    });
    await ctx.db.insert("messages", {
      threadId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      role: "assistant",
      status: "completed",
      mode: "discuss",
      content: "Done.",
      provider: "openai",
      modelName: "gpt-4o-mini",
      estimatedInputTokens: args.inputTokens,
      estimatedOutputTokens: args.outputTokens,
      estimatedCostUsd: args.costUsd,
    });
  });
}
