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
    expect(result!.chatModes.modes.discuss.enabled).toBe(true);
    expect(result!.chatModes.modes.library.enabled).toBe(false);
    expect(result!.chatModes.defaultMode).toBe("discuss");
    // Post-Lab collapse: library is the only mode that can be disabled
    // here. Sandbox state is now surfaced via `sandboxIsActivatable` +
    // grounding axes, not as a mode.
    if (!result!.chatModes.modes.library.enabled) {
      expect(result!.chatModes.modes.library.code).toBe("no_repository_attached");
    }
    // Without a repository there is nothing to provision against, so the
    // disabled Sandbox option must not pretend it's actionable.
    expect(result!.sandboxIsActivatable).toBe(false);
  });

  test("thread with repository but no sandbox: discuss + library available, sandbox is activatable", async () => {
    const t = createTestConvex();
    const { threadId, repositoryId } = await seedThread(t, { withRepository: true });

    const result = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId,
    });

    expect(result!.attachedRepository?._id).toBe(repositoryId);
    expect(result!.sandboxStatus).toBeNull();
    expect(result!.chatModes.modes.discuss.enabled).toBe(true);
    expect(result!.chatModes.modes.library.enabled).toBe(true);
    expect(result!.chatModes.defaultMode).toBe("library");
    // Lazy provisioning: the disabled Sandbox grounding option must still
    // be clickable so the UI can enqueue `requestSandboxActivation`.
    expect(result!.sandboxIsActivatable).toBe(true);
  });

  test("thread with repository and ready sandbox: discuss + library available, sandbox not activatable", async () => {
    const t = createTestConvex();
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "ready",
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId,
    });

    expect(result!.sandboxStatus).toBe("ready");
    expect(result!.chatModes.modes.discuss.enabled).toBe(true);
    expect(result!.chatModes.modes.library.enabled).toBe(true);
    expect(result!.chatModes.defaultMode).toBe("library");
    // Already-ready sandboxes don't need re-activation.
    expect(result!.sandboxIsActivatable).toBe(false);
  });

  test("thread with stopped sandbox: sandboxStatus surfaces as stopped; activatable for re-provision", async () => {
    const t = createTestConvex();
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "stopped",
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId,
    });

    expect(result!.sandboxStatus).toBe("stopped");
    expect(result!.chatModes.modes.discuss.enabled).toBe(true);
    expect(result!.chatModes.modes.library.enabled).toBe(true);
    expect(result!.sandboxIsActivatable).toBe(true);
  });

  test("thread with archived sandbox: sandboxStatus surfaces as archived; activatable for re-provision", async () => {
    const t = createTestConvex();
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "archived",
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId,
    });

    expect(result!.sandboxStatus).toBe("archived");
    expect(result!.chatModes.modes.discuss.enabled).toBe(true);
    expect(result!.chatModes.modes.library.enabled).toBe(true);
    expect(result!.sandboxIsActivatable).toBe(true);
  });

  test("thread with provisioning sandbox: sandboxStatus surfaces as provisioning; not activatable", async () => {
    const t = createTestConvex();
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "provisioning",
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId,
    });

    expect(result!.sandboxStatus).toBe("provisioning");
    expect(result!.chatModes.modes.discuss.enabled).toBe(true);
    expect(result!.chatModes.modes.library.enabled).toBe(true);
    // A second click during provisioning would just dedupe; the option
    // stays not-activatable to avoid suggesting otherwise.
    expect(result!.sandboxIsActivatable).toBe(false);
  });

  test("thread with failed sandbox: sandboxStatus surfaces as failed; activatable for re-provision", async () => {
    const t = createTestConvex();
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "failed",
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId,
    });

    expect(result!.sandboxStatus).toBe("failed");
    // Failed sandboxes are re-activatable — same path provisions a fresh one.
    expect(result!.sandboxIsActivatable).toBe(true);
  });
});

describe("getThreadContext (public, owner-scoped)", () => {
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
 * Plan 10 — daily-cost-cap signals at the thread-context boundary.
 *
 * Verifies that:
 *
 *   1. `sandboxCostBudgets` is `null` for no-repo threads (the cap is
 *      irrelevant; we save the rate-limiter peek and avoid polluting
 *      the reactive query's read set).
 *   2. With a repo attached, `sandboxCostBudgets.userBudget` is
 *      populated with capacity / remaining / resetAtMs.
 *   3. When the user cap is exhausted, the sandbox grounding axis
 *      closes and `sandboxIsActivatable` flips to `false`.
 */
describe("getThreadContext sandbox cost-cap gate (Plan 10)", () => {
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

  test("when the user cap is exhausted, sandbox grounding closes (sandboxIsActivatable is false) and the bucket peek reflects exhaustion", async () => {
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

    // Post-Lab collapse: discuss/library availability is no longer touched
    // by the sandbox cost cap. The cap closes the sandbox grounding axis
    // (consumed by the Discuss composer) and gates lazy activation via
    // `sandboxIsActivatable: false`.
    expect(result!.chatModes.modes.discuss.enabled).toBe(true);
    expect(result!.chatModes.modes.library.enabled).toBe(true);
    expect(result!.sandboxIsActivatable).toBe(false);
    // Bucket peek reflects the exhaustion in the exposed snapshot too.
    expect(result!.sandboxCostBudgets!.userBudget.remainingCents).toBe(0);
  });

  test("when the workspace cap is exhausted, sandboxIsActivatable closes and the workspace budget reports 0 remaining", async () => {
    const t = createTestConvex();
    const ownerTokenIdentifier = OWNER;
    const { threadId, repositoryId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "ready",
    });
    if (!repositoryId) throw new Error("expected repository fixture");
    const workspaceId = await t.run(async (ctx) => {
      return await ctx.db.insert("workspaces", {
        ownerTokenIdentifier,
        repositoryId,
        name: "Cap Workspace",
        color: "blue",
        lastAccessedAt: Date.now(),
      });
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

    expect(result!.chatModes.modes.discuss.enabled).toBe(true);
    expect(result!.chatModes.modes.library.enabled).toBe(true);
    expect(result!.sandboxIsActivatable).toBe(false);
    expect(result!.sandboxCostBudgets!.workspaceBudget!.remainingCents).toBe(0);
  });
});

/**
 * Regression pin — the sandbox feature gate is gone, replaced by the
 * cost cap as the single control axis. Set every env var that USED to
 * gate sandbox mode and assert that none of them disable sandbox mode
 * any more. If a future refactor accidentally re-introduces an
 * env-driven gate on the chatModes resolver, this test will fail.
 */
describe("getThreadContext — no env-driven feature gate is consulted", () => {
  const RETIRED_ENV_VARS = [
    "SANDBOX_MODE_ENABLED",
    "SANDBOX_BETA_ALLOWLIST",
    "SANDBOX_ROLLOUT_PERCENT",
    "DAYTONA_NETWORK_ALLOW_LIST",
  ] as const;
  const priorValues: Partial<Record<(typeof RETIRED_ENV_VARS)[number], string | undefined>> = {};

  beforeEach(() => {
    for (const name of RETIRED_ENV_VARS) {
      priorValues[name] = process.env[name];
    }
    process.env.SANDBOX_MODE_ENABLED = "false";
    process.env.SANDBOX_BETA_ALLOWLIST = "";
    process.env.SANDBOX_ROLLOUT_PERCENT = "0";
    process.env.DAYTONA_NETWORK_ALLOW_LIST = "";
  });
  afterEach(() => {
    for (const name of RETIRED_ENV_VARS) {
      const prior = priorValues[name];
      if (prior === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = prior;
      }
    }
  });

  test("retired feature-gate env vars do not affect sandbox availability", async () => {
    const t = createTestConvex();
    const { threadId } = await seedThread(t, {
      withRepository: true,
      sandboxStatus: "ready",
    });

    const result = await t.query(internal.threadContext.getThreadContextInternal, {
      threadId,
    });

    expect(result!.chatModes.modes.discuss.enabled).toBe(true);
    expect(result!.chatModes.modes.library.enabled).toBe(true);
    // Sandbox is in `ready` state and the cost cap is open, so it does not
    // need re-activation.
    expect(result!.sandboxIsActivatable).toBe(false);
  });
});
