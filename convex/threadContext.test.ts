/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function createTestConvex() {
  const t = convexTest(schema, modules);
  // Plan 10 — getThreadContext now peeks the rate-limiter for sandbox
  // cost budgets, so the rate-limiter component must be registered for
  // every test in this file (not just the cost-cap-specific ones —
  // every code path now reads the bucket).
  registerRateLimiter(t);
  return t;
}

const OWNER = "user|thread-context-test";
const OTHER_OWNER = "user|thread-context-other";

/**
 * Snapshot the sandbox feature-gate env vars before each test and restore
 * them after, optionally seeding a starting value (or explicitly clearing
 * them). Centralizing this avoids drift between describe blocks that all
 * need the same save/restore discipline but differ in *what* the test body
 * starts from — open-gate suites pre-set "true" + "*", closed-gate suites
 * delete both, per-test customizations layer on top of the cleared state.
 *
 * Pass `undefined` to delete the var on entry; pass a string to set it.
 */
function withSandboxEnvSnapshot(initial: { enabled?: string; allowlist?: string }) {
  let priorEnabled: string | undefined;
  let priorAllowlist: string | undefined;

  beforeEach(() => {
    priorEnabled = process.env.SANDBOX_MODE_ENABLED;
    priorAllowlist = process.env.SANDBOX_BETA_ALLOWLIST;
    if (initial.enabled === undefined) {
      delete process.env.SANDBOX_MODE_ENABLED;
    } else {
      process.env.SANDBOX_MODE_ENABLED = initial.enabled;
    }
    if (initial.allowlist === undefined) {
      delete process.env.SANDBOX_BETA_ALLOWLIST;
    } else {
      process.env.SANDBOX_BETA_ALLOWLIST = initial.allowlist;
    }
  });

  afterEach(() => {
    if (priorEnabled === undefined) {
      delete process.env.SANDBOX_MODE_ENABLED;
    } else {
      process.env.SANDBOX_MODE_ENABLED = priorEnabled;
    }
    if (priorAllowlist === undefined) {
      delete process.env.SANDBOX_BETA_ALLOWLIST;
    } else {
      process.env.SANDBOX_BETA_ALLOWLIST = priorAllowlist;
    }
  });
}

/**
 * The Plan-04 feature gate is consulted inside `enrichThreadContext` via
 * `getSandboxFeatureGate(viewer)`, which reads `process.env`. The
 * pre-existing test suite was written before the gate existed and
 * therefore expects the resolver to return its lifecycle-derived shape;
 * to keep those tests honest about *that* contract (separate from the
 * gate), we open the gate for the duration of every test in this file
 * via the wildcard allowlist. Closed-gate behavior is exercised in the
 * dedicated describe block at the bottom.
 */
function withSandboxFeatureGateOpen() {
  withSandboxEnvSnapshot({ enabled: "true", allowlist: "*" });
}

interface SeedOptions {
  withRepository?: boolean;
  sandboxStatus?: "provisioning" | "ready" | "stopped" | "archived" | "failed" | null;
  ownerTokenIdentifier?: string;
}

async function seedThread(
  t: ReturnType<typeof convexTest>,
  options: SeedOptions = {},
): Promise<{
  threadId: Id<"threads">;
  repositoryId: Id<"repositories"> | null;
  sandboxId: Id<"sandboxes"> | null;
}> {
  const owner = options.ownerTokenIdentifier ?? OWNER;
  return await t.run(async (ctx) => {
    let repositoryId: Id<"repositories"> | null = null;
    let sandboxId: Id<"sandboxes"> | null = null;

    if (options.withRepository) {
      repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier: owner,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/widget",
        sourceRepoFullName: "acme/widget",
        sourceRepoOwner: "acme",
        sourceRepoName: "widget",
        visibility: "unknown",
        accessMode: "private",
        importStatus: "idle",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
      });

      if (options.sandboxStatus) {
        sandboxId = await ctx.db.insert("sandboxes", {
          repositoryId,
          ownerTokenIdentifier: owner,
          provider: "daytona",
          sourceAdapter: "git_clone",
          remoteId: "remote-1",
          status: options.sandboxStatus,
          workDir: "/work",
          repoPath: "/work/repo",
          cpuLimit: 1,
          memoryLimitGiB: 1,
          diskLimitGiB: 5,
          ttlExpiresAt: Date.now() + 60_000,
          autoStopIntervalMinutes: 10,
          autoArchiveIntervalMinutes: 30,
          autoDeleteIntervalMinutes: 60,
          networkBlockAll: false,
        });

        await ctx.db.patch(repositoryId, { latestSandboxId: sandboxId });
      }
    }

    const threadId = await ctx.db.insert("threads", {
      repositoryId: repositoryId ?? undefined,
      ownerTokenIdentifier: owner,
      title: "thread",
      mode: "discuss",
      lastMessageAt: Date.now(),
    });

    return { threadId, repositoryId, sandboxId };
  });
}

describe("getThreadContext (internal)", () => {
  withSandboxFeatureGateOpen();

  test("returns null when the thread does not exist", async () => {
    const t = createTestConvex();
    const fakeId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("threads", {
        ownerTokenIdentifier: OWNER,
        title: "temp",
        mode: "discuss",
        lastMessageAt: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId: fakeId,
    });
    expect(result).toBeNull();
  });

  test("thread without a repository: only discuss mode is available", async () => {
    const t = createTestConvex();
    const { threadId } = await seedThread(t, { withRepository: false });

    const result = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId,
    });

    expect(result).not.toBeNull();
    expect(result!.attachedRepository).toBeNull();
    expect(result!.sandboxStatus).toBeNull();
    expect(result!.chatModes.availableModes).toEqual(["discuss"]);
    expect(result!.chatModes.defaultMode).toBe("discuss");
    expect(Object.keys(result!.chatModes.disabledReasons).sort()).toEqual(["docs", "sandbox"]);
  });

  test("thread with repository but no sandbox: discuss + docs available", async () => {
    const t = createTestConvex();
    const { threadId, repositoryId } = await seedThread(t, { withRepository: true });

    const result = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId,
    });

    expect(result!.attachedRepository?._id).toBe(repositoryId);
    expect(result!.sandboxStatus).toBeNull();
    expect(result!.chatModes.availableModes).toEqual(["discuss", "docs"]);
    expect(result!.chatModes.defaultMode).toBe("docs");
    expect(Object.keys(result!.chatModes.disabledReasons)).toEqual(["sandbox"]);
  });

  test("thread with repository and ready sandbox: all three modes available, default docs", async () => {
    const t = createTestConvex();
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "ready",
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId,
    });

    expect(result!.sandboxStatus).toBe("ready");
    expect(result!.chatModes.availableModes).toEqual(["discuss", "docs", "sandbox"]);
    expect(result!.chatModes.defaultMode).toBe("docs");
    expect(result!.chatModes.disabledReasons).toEqual({});
  });

  test("thread with stopped sandbox maps to expired in resolver input", async () => {
    const t = createTestConvex();
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "stopped",
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId,
    });

    expect(result!.sandboxStatus).toBe("stopped");
    expect(result!.chatModes.availableModes).toEqual(["discuss", "docs"]);
    expect(result!.chatModes.disabledReasons.sandbox).toMatch(/expired|provision a new sandbox/i);
  });

  test("thread with archived sandbox maps to expired in resolver input", async () => {
    const t = createTestConvex();
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "archived",
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId,
    });

    expect(result!.sandboxStatus).toBe("archived");
    expect(result!.chatModes.availableModes).toEqual(["discuss", "docs"]);
    expect(result!.chatModes.disabledReasons.sandbox).toMatch(/expired|provision a new sandbox/i);
  });

  test("thread with provisioning sandbox surfaces a provisioning hint for sandbox mode", async () => {
    const t = createTestConvex();
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "provisioning",
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId,
    });

    expect(result!.sandboxStatus).toBe("provisioning");
    expect(result!.chatModes.availableModes).toEqual(["discuss", "docs"]);
    expect(result!.chatModes.disabledReasons.sandbox).toMatch(/provisioning/i);
  });

  test("thread with failed sandbox surfaces a failed hint for sandbox mode", async () => {
    const t = createTestConvex();
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "failed",
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId,
    });

    expect(result!.sandboxStatus).toBe("failed");
    expect(result!.chatModes.disabledReasons.sandbox).toMatch(/failed|provision a new sandbox/i);
  });
});

describe("getThreadContext (public, owner-scoped)", () => {
  withSandboxFeatureGateOpen();

  test("rejects access from a different owner", async () => {
    const t = createTestConvex();
    const { threadId } = await seedThread(t, {
      withRepository: false,
      ownerTokenIdentifier: OWNER,
    });

    const intruder = t.withIdentity({ tokenIdentifier: OTHER_OWNER });
    await expect(intruder.query(api.threadContext.getThreadContext, { threadId })).rejects.toThrow();
  });

  test("returns the same shape as the internal query for the owner", async () => {
    const t = createTestConvex();
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "ready",
    });

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const publicResult = await viewer.query(api.threadContext.getThreadContext, { threadId });
    const internalResult = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId,
    });

    expect(publicResult).not.toBeNull();
    expect(publicResult!.thread._id).toBe(internalResult!.thread._id);
    expect(publicResult!.chatModes).toEqual(internalResult!.chatModes);
  });
});

/**
 * Plan-04 sandbox feature-flag behavior at the thread-context boundary.
 *
 * The resolver tests in `chatModeResolver.test.ts` exercise the gate as a
 * pure function. These tests close the loop by exercising the *env-driven*
 * gate through the actual `internal.threadContext.getThreadContextInternal`
 * call path — proof that `enrichThreadContext` reads the gate per-viewer
 * and applies it.
 */
describe("getThreadContext sandbox feature gate", () => {
  // Each test in this block starts from a *cleared* env so the per-test
  // setting is the only signal — the snapshot helper restores any value the
  // outer process had on entry.
  withSandboxEnvSnapshot({});

  test("flag off: ready sandbox no longer surfaces sandbox in availableModes", async () => {
    // Default env state (flag unset) — even with a fully-eligible thread,
    // sandbox mode must be hidden. The disabled tooltip explains the
    // private-beta status; the user is not stuck without an explanation.
    const t = createTestConvex();
    const { threadId } = await seedThread(t, { withRepository: true, sandboxStatus: "ready" });

    const result = await t.query(internal.threadContext.getThreadContextInternal, { threadId });

    expect(result!.sandboxStatus).toBe("ready");
    expect(result!.chatModes.availableModes).toEqual(["discuss", "docs"]);
    expect(result!.chatModes.disabledReasons.sandbox).toMatch(/private beta/i);
  });

  test("flag on + viewer in allowlist: ready sandbox is selectable end-to-end", async () => {
    process.env.SANDBOX_MODE_ENABLED = "true";
    process.env.SANDBOX_BETA_ALLOWLIST = OWNER;

    const t = createTestConvex();
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "ready",
      ownerTokenIdentifier: OWNER,
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, { threadId });

    expect(result!.chatModes.availableModes).toEqual(["discuss", "docs", "sandbox"]);
    expect(result!.chatModes.disabledReasons).toEqual({});
  });

  test("flag on + viewer NOT in allowlist: tooltip explains the allowlist requirement", async () => {
    // The internal query evaluates the gate against the *thread owner*
    // (since there is no authenticated viewer in an internal query). With
    // the owner left off the allowlist, the gate closes with the
    // not_allowlisted tooltip — that is the per-viewer signal flowing
    // through the same code the public query uses.
    process.env.SANDBOX_MODE_ENABLED = "true";
    process.env.SANDBOX_BETA_ALLOWLIST = "user|someone-else";

    const t = createTestConvex();
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "ready",
      ownerTokenIdentifier: OWNER,
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, { threadId });

    expect(result!.chatModes.availableModes).toEqual(["discuss", "docs"]);
    expect(result!.chatModes.disabledReasons.sandbox).toMatch(/allowlist/i);
  });
});

/**
 * Plan 10 — daily-cost-cap signals at the thread-context boundary.
 *
 * Verifies that:
 *
 *   1. `sandboxCostBudgets` is `null` for no-repo threads (the cap is
 *      irrelevant; we save the rate-limiter peek and avoid polluting
 *      the reactive query's read set).
 *   2. With a repo attached, `sandboxCostBudgets.userBudget` is
 *      populated with capacity / remaining / resetAtMs.
 *   3. When the user cap is exhausted, the resolver removes sandbox
 *      from `availableModes` and surfaces the cost-cap tooltip.
 */
describe("getThreadContext sandbox cost-cap gate (Plan 10)", () => {
  // Open the feature gate so cost-cap is the only gate variable
  // these tests vary.
  withSandboxFeatureGateOpen();

  let priorUserCapEnv: string | undefined;
  let priorEstimateEnv: string | undefined;
  beforeEach(() => {
    priorUserCapEnv = process.env.SANDBOX_DAILY_CAP_PER_USER_USD;
    priorEstimateEnv = process.env.SANDBOX_REPLY_ESTIMATE_USD;
    // Cap = 5 cents; estimate = 1 cent. Lets us drive the bucket to 0
    // by consuming exactly the capacity, then assert that the gate
    // closes on the very next peek.
    process.env.SANDBOX_DAILY_CAP_PER_USER_USD = "0.05";
    process.env.SANDBOX_REPLY_ESTIMATE_USD = "0.01";
  });
  afterEach(() => {
    if (priorUserCapEnv === undefined) {
      delete process.env.SANDBOX_DAILY_CAP_PER_USER_USD;
    } else {
      process.env.SANDBOX_DAILY_CAP_PER_USER_USD = priorUserCapEnv;
    }
    if (priorEstimateEnv === undefined) {
      delete process.env.SANDBOX_REPLY_ESTIMATE_USD;
    } else {
      process.env.SANDBOX_REPLY_ESTIMATE_USD = priorEstimateEnv;
    }
  });

  test("threads without a repository skip the cost-cap peek (sandboxCostBudgets is null)", async () => {
    // Performance contract: no-repo threads don't subscribe to the
    // rate-limiter's docs (which would trigger reactive re-renders for
    // every other user's settlement). The frontend's mode selector
    // already has sandbox disabled in that branch from the no-repo
    // disabled-reason, so the budget read would be wasted work.
    const t = createTestConvex();
    const { threadId } = await seedThread(t, { withRepository: false });
    const result = await t.query(internal.threadContext.getThreadContextInternal, { threadId });

    expect(result!.sandboxCostBudgets).toBeNull();
  });

  test("threads with a repository expose the user-budget snapshot", async () => {
    const t = createTestConvex();
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "ready",
    });
    const result = await t.query(internal.threadContext.getThreadContextInternal, { threadId });

    expect(result!.sandboxCostBudgets).not.toBeNull();
    expect(result!.sandboxCostBudgets!.userBudget.capacityCents).toBe(5);
    expect(result!.sandboxCostBudgets!.userBudget.remainingCents).toBe(5);
    expect(result!.sandboxCostBudgets!.userBudget.resetAtMs).toBeGreaterThan(Date.now());
    // No workspace attached → workspaceBudget is null.
    expect(result!.sandboxCostBudgets!.workspaceBudget).toBeNull();
  });

  test("when the user cap is exhausted, sandbox is removed from availableModes and the cap tooltip surfaces", async () => {
    const t = createTestConvex();
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "ready",
    });

    // Drive the bucket to 0 directly via the rate-limiter component.
    // Inline config matches the runtime helper so the bucket's persisted
    // shape lines up with what the production code peeks.
    await t.run(async (ctx) => {
      const { rateLimiter } = await import("./lib/rateLimit");
      await rateLimiter.limit(ctx, "sandboxCostUsdPerUserDaily", {
        key: OWNER,
        count: 5,
        config: { kind: "fixed window", rate: 5, capacity: 5, period: 86_400_000, maxReserved: 5, start: 0 },
      });
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, { threadId });

    expect(result!.chatModes.availableModes).toEqual(["discuss", "docs"]);
    expect(result!.chatModes.disabledReasons.sandbox).toMatch(/daily.*spend.*account/i);
    // Bucket peek reflects the exhaustion in the exposed snapshot too.
    expect(result!.sandboxCostBudgets!.userBudget.remainingCents).toBe(0);
  });

  test("when the workspace cap is exhausted, the workspace-cap tooltip surfaces", async () => {
    const t = createTestConvex();
    const ownerTokenIdentifier = OWNER;
    const workspaceId = await t.run(async (ctx) => {
      return await ctx.db.insert("workspaces", {
        ownerTokenIdentifier,
        name: "Cap Workspace",
        color: "blue",
        lastAccessedAt: Date.now(),
      });
    });
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "ready",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(threadId, { workspaceId });
    });

    // Workspace cap defaults to $50 = 5000 cents. Burn it.
    await t.run(async (ctx) => {
      const { rateLimiter, workspaceCostKey } = await import("./lib/rateLimit");
      await rateLimiter.limit(ctx, "sandboxCostUsdPerWorkspaceDaily", {
        key: workspaceCostKey(workspaceId),
        count: 5000,
        config: {
          kind: "fixed window",
          rate: 5000,
          capacity: 5000,
          period: 86_400_000,
          maxReserved: 5000,
          start: 0,
        },
      });
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, { threadId });

    expect(result!.chatModes.availableModes).toEqual(["discuss", "docs"]);
    expect(result!.chatModes.disabledReasons.sandbox).toMatch(/daily.*spend.*workspace/i);
    expect(result!.sandboxCostBudgets!.workspaceBudget!.remainingCents).toBe(0);
  });
});
