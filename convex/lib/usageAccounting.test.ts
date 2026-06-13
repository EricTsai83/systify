/// <reference types="vite/client" />

import { afterEach, describe, expect, test } from "vitest";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { api, internal } from "../_generated/api";
import schema from "../schema";
import { peekSandboxDailyCostForUser } from "./rateLimit";

const modules = import.meta.glob("/convex/**/*.ts");

function createTestConvex() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

afterEach(() => {
  delete process.env.SANDBOX_DAILY_CAP_PER_USER_USD;
  delete process.env.SANDBOX_DAILY_CAP_PER_REPOSITORY_USD;
});

describe("usageAccounting lifecycle", () => {
  test("empty sourceId throws", async () => {
    const t = createTestConvex();

    await expect(
      t.mutation(internal.lib.usageAccountingMutations.reserveUsageLifecycle, {
        sourceId: "   ",
        ownerTokenIdentifier: "user|usage-accounting-empty-source",
        repositoryId: null,
        feature: "titleGeneration",
        occurredAtMs: Date.now(),
      }),
    ).rejects.toThrow("sourceId must be non-empty");
  });

  test("reserve is idempotent by sourceId", async () => {
    const ownerTokenIdentifier = "user|usage-accounting-reserve-idempotent";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const now = Date.now();

    await viewer.mutation(api.lib.userCost.updateViewerUsageProfile, {
      cycleAnchorDay: 1,
      timeZone: "UTC",
      budgetUsd: 1,
      hardCapEnabled: true,
    });

    const first = await t.mutation(internal.lib.usageAccountingMutations.reserveUsageLifecycle, {
      sourceId: "message:reserve-idempotent",
      ownerTokenIdentifier,
      repositoryId: null,
      feature: "chatReply",
      sandboxDailyCap: "none",
      occurredAtMs: now,
    });
    const second = await t.mutation(internal.lib.usageAccountingMutations.reserveUsageLifecycle, {
      sourceId: "message:reserve-idempotent",
      ownerTokenIdentifier,
      repositoryId: null,
      feature: "chatReply",
      sandboxDailyCap: "none",
      occurredAtMs: now,
    });

    const state = await t.run(async (ctx) => {
      const reservations = await ctx.db
        .query("userUsageBudgetReservations")
        .withIndex("by_sourceId", (q) => q.eq("sourceId", "message:reserve-idempotent"))
        .take(10);
      return { reservations };
    });
    const dashboard = await viewer.query(api.lib.userCost.getViewerUsageDashboard, {});

    expect(first).toEqual(second);
    expect(first.reserved).toBe(true);
    expect(state.reservations).toHaveLength(1);
    expect(dashboard.budget.reservedUsd).toBeCloseTo(0.05, 5);
  });

  test("reserve retry skips sandbox cap precheck for an existing sourceId", async () => {
    process.env.SANDBOX_DAILY_CAP_PER_USER_USD = "0.10";
    process.env.SANDBOX_DAILY_CAP_PER_REPOSITORY_USD = "0.10";

    const ownerTokenIdentifier = "user|usage-accounting-reserve-sandbox-idempotent";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const now = Date.now();

    await viewer.mutation(api.lib.userCost.updateViewerUsageProfile, {
      cycleAnchorDay: 1,
      timeZone: "UTC",
      budgetUsd: 1,
      hardCapEnabled: true,
    });

    const first = await t.mutation(internal.lib.usageAccountingMutations.reserveUsageLifecycle, {
      sourceId: "message:reserve-sandbox-idempotent",
      ownerTokenIdentifier,
      repositoryId: null,
      feature: "chatReply",
      sandboxDailyCap: "precheckAndSettle",
      occurredAtMs: now,
    });
    await t.mutation(internal.lib.usageAccountingMutations.settleUsageLifecycle, {
      sourceId: "systemDesign:reserve-sandbox-idempotent-cap-filler:readme_summary:1",
      ownerTokenIdentifier,
      repositoryId: null,
      feature: "systemDesignGeneration",
      occurredAtMs: now,
      usage: {
        costUsd: 0.1,
        inputTokens: 1_000,
        outputTokens: 500,
      },
    });

    const budget = await t.run(async (ctx) => await peekSandboxDailyCostForUser(ctx, ownerTokenIdentifier));
    const second = await t.mutation(internal.lib.usageAccountingMutations.reserveUsageLifecycle, {
      sourceId: "message:reserve-sandbox-idempotent",
      ownerTokenIdentifier,
      repositoryId: null,
      feature: "chatReply",
      sandboxDailyCap: "precheckAndSettle",
      occurredAtMs: now,
    });

    expect(budget.remainingCents).toBe(0);
    expect(second).toEqual(first);
  });

  test("settle is idempotent for durable event, rollups, and daily cap", async () => {
    process.env.SANDBOX_DAILY_CAP_PER_USER_USD = "0.10";
    process.env.SANDBOX_DAILY_CAP_PER_REPOSITORY_USD = "0.10";

    const ownerTokenIdentifier = "user|usage-accounting-settle-idempotent";
    const t = createTestConvex();
    const now = Date.now();

    const first = await t.mutation(internal.lib.usageAccountingMutations.settleUsageLifecycle, {
      sourceId: "systemDesign:settle-idempotent:readme_summary:1",
      ownerTokenIdentifier,
      repositoryId: null,
      feature: "systemDesignGeneration",
      occurredAtMs: now,
      usage: {
        costUsd: 0.03,
        inputTokens: 1_000,
        outputTokens: 500,
      },
    });
    const second = await t.mutation(internal.lib.usageAccountingMutations.settleUsageLifecycle, {
      sourceId: "systemDesign:settle-idempotent:readme_summary:1",
      ownerTokenIdentifier,
      repositoryId: null,
      feature: "systemDesignGeneration",
      occurredAtMs: now,
      usage: {
        costUsd: 0.09,
        inputTokens: 9_000,
        outputTokens: 9_000,
      },
    });

    const state = await t.run(async (ctx) => {
      const events = await ctx.db
        .query("userUsageEvents")
        .withIndex("by_sourceId", (q) => q.eq("sourceId", "systemDesign:settle-idempotent:readme_summary:1"))
        .take(10);
      const rollups = await ctx.db.query("userUsageDailyRollups").take(10);
      const budget = await peekSandboxDailyCostForUser(ctx, ownerTokenIdentifier);
      return { events, rollups, budget };
    });

    expect(first).toEqual({ recorded: true, settledCents: 3 });
    expect(second).toEqual({ recorded: false, settledCents: null });
    expect(state.events).toHaveLength(1);
    expect(state.events[0]?.costUsd).toBeCloseTo(0.03, 5);
    expect(state.rollups).toHaveLength(1);
    expect(state.rollups[0]?.costUsd).toBeCloseTo(0.03, 5);
    expect(state.budget.remainingCents).toBe(7);
  });

  test("release after reservation marks reservation released without rollups", async () => {
    const ownerTokenIdentifier = "user|usage-accounting-release";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const now = Date.now();

    await viewer.mutation(api.lib.userCost.updateViewerUsageProfile, {
      cycleAnchorDay: 1,
      timeZone: "UTC",
      budgetUsd: 1,
      hardCapEnabled: true,
    });

    await t.mutation(internal.lib.usageAccountingMutations.reserveUsageLifecycle, {
      sourceId: "title:thread:message",
      ownerTokenIdentifier,
      repositoryId: null,
      feature: "titleGeneration",
      occurredAtMs: now,
    });
    await t.mutation(internal.lib.usageAccountingMutations.releaseUsageLifecycle, {
      sourceId: "title:thread:message",
      ownerTokenIdentifier,
      repositoryId: null,
      feature: "titleGeneration",
      occurredAtMs: now,
    });

    const state = await t.run(async (ctx) => {
      const reservation = await ctx.db
        .query("userUsageBudgetReservations")
        .withIndex("by_sourceId", (q) => q.eq("sourceId", "title:thread:message"))
        .unique();
      const events = await ctx.db
        .query("userUsageEvents")
        .withIndex("by_sourceId", (q) => q.eq("sourceId", "title:thread:message"))
        .take(10);
      const dailyRollups = await ctx.db.query("userUsageDailyRollups").take(10);
      const cycleRollups = await ctx.db.query("userUsageCycleRollups").take(10);
      const totals = await ctx.db.query("userUsageTotals").take(10);
      return { reservation, events, dailyRollups, cycleRollups, totals };
    });
    const dashboard = await viewer.query(api.lib.userCost.getViewerUsageDashboard, {});

    expect(state.reservation?.status).toBe("released");
    expect(state.events).toHaveLength(0);
    expect(state.dailyRollups).toHaveLength(0);
    expect(state.cycleRollups).toHaveLength(0);
    expect(state.totals).toHaveLength(0);
    expect(dashboard.budget.reservedUsd).toBe(0);
  });

  test("settlement over reserved amount updates spent and reserved budgets", async () => {
    const ownerTokenIdentifier = "user|usage-accounting-overrun";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const now = Date.now();

    await viewer.mutation(api.lib.userCost.updateViewerUsageProfile, {
      cycleAnchorDay: 1,
      timeZone: "UTC",
      budgetUsd: 1,
      hardCapEnabled: true,
    });
    await t.mutation(internal.lib.usageAccountingMutations.reserveUsageLifecycle, {
      sourceId: "message:overrun",
      ownerTokenIdentifier,
      repositoryId: null,
      feature: "chatReply",
      sandboxDailyCap: "none",
      occurredAtMs: now,
    });
    await t.mutation(internal.lib.usageAccountingMutations.settleUsageLifecycle, {
      sourceId: "message:overrun",
      ownerTokenIdentifier,
      repositoryId: null,
      feature: "chatReply",
      sandboxDailyCap: "none",
      occurredAtMs: now,
      usage: {
        costUsd: 0.12,
        inputTokens: 2_000,
        outputTokens: 500,
      },
    });

    const dashboard = await viewer.query(api.lib.userCost.getViewerUsageDashboard, {});

    expect(dashboard.budget.usedUsd).toBeCloseTo(0.12, 5);
    expect(dashboard.budget.reservedUsd).toBe(0);
    expect(dashboard.budget.remainingUsd).toBeCloseTo(0.88, 5);
  });
});
