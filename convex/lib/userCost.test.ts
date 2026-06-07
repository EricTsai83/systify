/// <reference types="vite/client" />

import { describe, expect, it } from "vitest";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { TEST_INTERNALS, type UsageFeature } from "./userCost";

const { makeBucket, addToBucket, utcDayKey, hasRecordableUsage, getUsagePeriodForMs } = TEST_INTERNALS;
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

describe("userCost billing cycle helpers", () => {
  it("calculates UTC cycles for anchor day 1", () => {
    const period = getUsagePeriodForMs(Date.UTC(2026, 5, 6, 12), {
      cycleAnchorDay: 1,
      timeZone: "UTC",
      budgetUsd: null,
      hardCapEnabled: false,
    });

    expect(period.periodStartMs).toBe(Date.UTC(2026, 5, 1));
    expect(period.periodEndMs).toBe(Date.UTC(2026, 6, 1));
  });

  it("calculates UTC cycles for anchor day 15", () => {
    const beforeAnchor = getUsagePeriodForMs(Date.UTC(2026, 5, 14, 23), {
      cycleAnchorDay: 15,
      timeZone: "UTC",
      budgetUsd: null,
      hardCapEnabled: false,
    });
    const atAnchor = getUsagePeriodForMs(Date.UTC(2026, 5, 15, 0), {
      cycleAnchorDay: 15,
      timeZone: "UTC",
      budgetUsd: null,
      hardCapEnabled: false,
    });

    expect(beforeAnchor.periodStartMs).toBe(Date.UTC(2026, 4, 15));
    expect(beforeAnchor.periodEndMs).toBe(Date.UTC(2026, 5, 15));
    expect(atAnchor.periodStartMs).toBe(Date.UTC(2026, 5, 15));
    expect(atAnchor.periodEndMs).toBe(Date.UTC(2026, 6, 15));
  });

  it("clamps anchor day 31 to February in leap years", () => {
    const february = getUsagePeriodForMs(Date.UTC(2024, 1, 15, 12), {
      cycleAnchorDay: 31,
      timeZone: "UTC",
      budgetUsd: null,
      hardCapEnabled: false,
    });
    const afterLeapDay = getUsagePeriodForMs(Date.UTC(2024, 2, 1, 12), {
      cycleAnchorDay: 31,
      timeZone: "UTC",
      budgetUsd: null,
      hardCapEnabled: false,
    });

    expect(february.periodStartMs).toBe(Date.UTC(2024, 0, 31));
    expect(february.periodEndMs).toBe(Date.UTC(2024, 1, 29));
    expect(afterLeapDay.periodStartMs).toBe(Date.UTC(2024, 1, 29));
    expect(afterLeapDay.periodEndMs).toBe(Date.UTC(2024, 2, 31));
  });

  it("uses timezone-local midnight for cycle boundaries", () => {
    const period = getUsagePeriodForMs(Date.UTC(2026, 4, 31, 16, 30), {
      cycleAnchorDay: 1,
      timeZone: "Asia/Taipei",
      budgetUsd: null,
      hardCapEnabled: false,
    });

    expect(period.periodStartMs).toBe(Date.UTC(2026, 4, 31, 16));
    expect(period.periodEndMs).toBe(Date.UTC(2026, 5, 30, 16));
  });
});

describe("usage profile", () => {
  it("returns defaults when no profile row exists", async () => {
    const ownerTokenIdentifier = "user|usage-profile-defaults";
    const t = createTestConvex();

    const dashboard = await t
      .withIdentity({ tokenIdentifier: ownerTokenIdentifier })
      .query(api.lib.userCost.getViewerUsageDashboard, {});

    expect(dashboard.profile).toEqual({
      cycleAnchorDay: 1,
      timeZone: "UTC",
      budgetUsd: null,
      hardCapEnabled: false,
    });
    expect(dashboard.budget.state).toBe("unset");
  });

  it("validates profile updates", async () => {
    const ownerTokenIdentifier = "user|usage-profile-validation";
    const viewer = createTestConvex().withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await expect(
      viewer.mutation(api.lib.userCost.updateViewerUsageProfile, {
        cycleAnchorDay: 0,
        timeZone: "UTC",
        budgetUsd: null,
        hardCapEnabled: false,
      }),
    ).rejects.toThrow("Cycle anchor day");

    await expect(
      viewer.mutation(api.lib.userCost.updateViewerUsageProfile, {
        cycleAnchorDay: 1,
        timeZone: "Not/AZone",
        budgetUsd: null,
        hardCapEnabled: false,
      }),
    ).rejects.toThrow("Time zone");

    await expect(
      viewer.mutation(api.lib.userCost.updateViewerUsageProfile, {
        cycleAnchorDay: 1,
        timeZone: "UTC",
        budgetUsd: 0,
        hardCapEnabled: true,
      }),
    ).rejects.toThrow("Budget");

    await viewer.mutation(api.lib.userCost.updateViewerUsageProfile, {
      cycleAnchorDay: 15,
      timeZone: "Asia/Taipei",
      budgetUsd: 25,
      hardCapEnabled: true,
    });

    const dashboard = await viewer.query(api.lib.userCost.getViewerUsageDashboard, {});
    expect(dashboard.profile).toEqual({
      cycleAnchorDay: 15,
      timeZone: "Asia/Taipei",
      budgetUsd: 25,
      hardCapEnabled: true,
    });
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

    const dashboard = await t
      .withIdentity({ tokenIdentifier: ownerTokenIdentifier })
      .query(api.lib.userCost.getViewerUsageDashboard, {});
    expect(dashboard.currentPeriod.events).toBe(1);
    expect(dashboard.allTime.events).toBe(1);
    expect(dashboard.currentPeriod.byFeature.chat.events).toBe(1);
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

describe("getViewerUsageDashboard", () => {
  it("returns current, previous, all-time, history, and every usage feature", async () => {
    const ownerTokenIdentifier = "user|usage-dashboard-features";
    const t = createTestConvex();
    const now = Date.now();
    const features: UsageFeature[] = [
      "chat",
      "systemDesign",
      "artifactIndexing",
      "libraryRetrieval",
      "titleGeneration",
    ];

    for (const [index, feature] of features.entries()) {
      await recordUsage(t, {
        sourceId: `feature:${feature}`,
        ownerTokenIdentifier,
        feature,
        occurredAtMs: now + index,
        inputTokens: 100 + index,
        outputTokens: feature === "artifactIndexing" || feature === "libraryRetrieval" ? undefined : 50,
        usd: 0.01 + index / 100,
      });
    }

    const dashboard = await t
      .withIdentity({ tokenIdentifier: ownerTokenIdentifier })
      .query(api.lib.userCost.getViewerUsageDashboard, {});

    expect(dashboard.currentPeriod.events).toBe(features.length);
    expect(dashboard.allTime.events).toBe(features.length);
    expect(dashboard.previousPeriod).not.toBeNull();
    expect(dashboard.history).toHaveLength(12);
    for (const feature of features) {
      expect(dashboard.currentPeriod.byFeature[feature].events).toBe(1);
      expect(dashboard.allTime.byFeature[feature].events).toBe(1);
    }
  });

  it("does not scan raw messages when no usage rollup exists", async () => {
    const ownerTokenIdentifier = "user|usage-dashboard-raw-only";
    const t = createTestConvex();
    await seedRawPricedAssistantMessage(t, {
      ownerTokenIdentifier,
      inputTokens: 1_000,
      outputTokens: 500,
      costUsd: 0.0123,
    });

    const dashboard = await t
      .withIdentity({ tokenIdentifier: ownerTokenIdentifier })
      .query(api.lib.userCost.getViewerUsageDashboard, {});

    expect(dashboard.currentPeriod.events).toBe(0);
    expect(dashboard.allTime.events).toBe(0);
    expect(dashboard.currentPeriod.costUsd).toBe(0);
  });
});

describe("usage budget reservations", () => {
  it("reserves, blocks over-budget work, and settles actual spend", async () => {
    const ownerTokenIdentifier = "user|usage-budget-reservation";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const now = Date.now();

    await viewer.mutation(api.lib.userCost.updateViewerUsageProfile, {
      cycleAnchorDay: 1,
      timeZone: "UTC",
      budgetUsd: 0.1,
      hardCapEnabled: true,
    });

    await t.mutation(internal.lib.userCost.reserveUsageBudget, {
      sourceId: "message:budget-ok",
      ownerTokenIdentifier,
      feature: "chat",
      estimatedCostUsd: 0.05,
      occurredAtMs: now,
    });

    let dashboard = await viewer.query(api.lib.userCost.getViewerUsageDashboard, {});
    expect(dashboard.budget.reservedUsd).toBeCloseTo(0.05, 5);
    expect(dashboard.budget.remainingUsd).toBeCloseTo(0.05, 5);

    await expect(
      t.mutation(internal.lib.userCost.reserveUsageBudget, {
        sourceId: "message:budget-blocked",
        ownerTokenIdentifier,
        feature: "chat",
        estimatedCostUsd: 0.06,
        occurredAtMs: now,
      }),
    ).rejects.toThrow("Usage budget reached");

    await recordUsage(t, {
      sourceId: "message:budget-ok",
      ownerTokenIdentifier,
      feature: "chat",
      occurredAtMs: now,
      inputTokens: 500,
      outputTokens: 100,
      usd: 0.03,
    });

    dashboard = await viewer.query(api.lib.userCost.getViewerUsageDashboard, {});
    expect(dashboard.budget.usedUsd).toBeCloseTo(0.03, 5);
    expect(dashboard.budget.reservedUsd).toBe(0);
    expect(dashboard.budget.remainingUsd).toBeCloseTo(0.07, 5);

    await expect(
      t.mutation(internal.lib.userCost.reserveUsageBudget, {
        sourceId: "message:budget-after-settle-blocked",
        ownerTokenIdentifier,
        feature: "chat",
        estimatedCostUsd: 0.08,
        occurredAtMs: now,
      }),
    ).rejects.toThrow("Usage budget reached");
  });

  it("allows actual cost to exceed the estimate and then blocks subsequent work", async () => {
    const ownerTokenIdentifier = "user|usage-budget-overrun";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const now = Date.now();

    await viewer.mutation(api.lib.userCost.updateViewerUsageProfile, {
      cycleAnchorDay: 1,
      timeZone: "UTC",
      budgetUsd: 0.1,
      hardCapEnabled: true,
    });
    await t.mutation(internal.lib.userCost.reserveUsageBudget, {
      sourceId: "message:overrun",
      ownerTokenIdentifier,
      feature: "chat",
      estimatedCostUsd: 0.05,
      occurredAtMs: now,
    });
    await recordUsage(t, {
      sourceId: "message:overrun",
      ownerTokenIdentifier,
      feature: "chat",
      occurredAtMs: now,
      inputTokens: 500,
      outputTokens: 100,
      usd: 0.12,
    });

    const dashboard = await viewer.query(api.lib.userCost.getViewerUsageDashboard, {});
    expect(dashboard.budget.usedUsd).toBeCloseTo(0.12, 5);
    expect(dashboard.budget.state).toBe("exceeded");

    await expect(
      t.mutation(internal.lib.userCost.reserveUsageBudget, {
        sourceId: "message:blocked-after-overrun",
        ownerTokenIdentifier,
        feature: "chat",
        estimatedCostUsd: 0.001,
        occurredAtMs: now,
      }),
    ).rejects.toThrow("Usage budget reached");
  });
});

describe("usage budget integration gates", () => {
  it("blocks chat sends before scheduling assistant generation", async () => {
    const ownerTokenIdentifier = "user|usage-budget-chat-send";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await t.run(async (ctx) => {
      await ctx.db.insert("userAccessProfiles", {
        ownerTokenIdentifier,
        email: "usage-budget-chat-send@example.com",
        plan: "internal",
        billingStatus: "none",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    await viewer.mutation(api.lib.userCost.updateViewerUsageProfile, {
      cycleAnchorDay: 1,
      timeZone: "UTC",
      budgetUsd: 0.01,
      hardCapEnabled: true,
    });

    await expect(
      viewer.mutation(api.chat.send.sendMessageStartingNewThread, {
        content: "Explain this repository",
        mode: "discuss",
      }),
    ).rejects.toThrow("Usage budget reached");

    const rows = await t.run(async (ctx) => ({
      threads: await ctx.db.query("threads").take(10),
      messages: await ctx.db.query("messages").take(10),
      jobs: await ctx.db.query("jobs").take(10),
    }));
    expect(rows.threads).toHaveLength(0);
    expect(rows.messages).toHaveLength(0);
    expect(rows.jobs).toHaveLength(0);
  });
});

async function recordUsage(
  t: ReturnType<typeof createTestConvex>,
  args: {
    sourceId: string;
    ownerTokenIdentifier: string;
    feature: UsageFeature;
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
