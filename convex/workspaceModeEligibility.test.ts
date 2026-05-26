/// <reference types="vite/client" />

import { ConvexError } from "convex/values";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function createTestConvex() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

const OWNER = "user|service-mode-test";
const OTHER_OWNER = "user|service-mode-other";

/**
 * convex-test marshals ConvexError `data` across the function boundary as a
 * JSON string (sometimes double-encoded). Unwrap any number of JSON layers
 * so structured-error assertions can match against the actual payload.
 */
function unwrapErrorData(error: unknown): unknown {
  let data: unknown = (error as { data?: unknown } | null | undefined)?.data;
  while (typeof data === "string") {
    try {
      data = JSON.parse(data);
    } catch {
      break;
    }
  }
  return data;
}

interface WorkspaceSeedOptions {
  withArtifact?: boolean;
  sandboxStatus?: "provisioning" | "ready" | "stopped" | "archived" | "failed" | null;
  ownerTokenIdentifier?: string;
}

async function seedWorkspace(
  t: ReturnType<typeof convexTest>,
  options: WorkspaceSeedOptions = {},
): Promise<{
  workspaceId: Id<"workspaces">;
  repositoryId: Id<"repositories">;
  sandboxId: Id<"sandboxes"> | null;
}> {
  const owner = options.ownerTokenIdentifier ?? OWNER;
  return await t.run(async (ctx) => {
    let sandboxId: Id<"sandboxes"> | null = null;

    const repositoryId = await ctx.db.insert("repositories", {
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

    if (options.withArtifact) {
      await ctx.db.insert("artifacts", {
        repositoryId,
        ownerTokenIdentifier: owner,
        kind: "manifest",
        title: "manifest",
        summary: "Seeded for tests",
        contentMarkdown: "## Manifest",
        source: "heuristic",
        version: 1,
      });
    }

    const workspaceId = await ctx.db.insert("workspaces", {
      ownerTokenIdentifier: owner,
      repositoryId,
      name: "Test Workspace",
      color: "blue",
      lastAccessedAt: Date.now(),
    });

    return { workspaceId, repositoryId, sandboxId };
  });
}

// ─── evaluate (read path) ────────────────────────────────────────────────

describe("workspaceModeEligibility.evaluate", () => {
  test("returns null when the workspace does not exist", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t);
    await t.run(async (ctx) => {
      await ctx.db.delete(workspaceId);
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.workspaceModeEligibility.evaluate, { workspaceId });
    expect(result).toBeNull();
  });

  test("returns null when the viewer does not own the workspace", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, { ownerTokenIdentifier: OWNER });
    const intruder = t.withIdentity({ tokenIdentifier: OTHER_OWNER });
    const result = await intruder.query(api.workspaceModeEligibility.evaluate, { workspaceId });
    expect(result).toBeNull();
  });

  test("undefined workspaceId returns the workspaceless verdict (discuss-only)", async () => {
    // Workspaceless threads structurally cannot satisfy Library mode (no
    // repo to anchor artifacts). The eligibility query must accept an
    // omitted workspaceId so the workspaceless shell can subscribe (or
    // skip) uniformly with workspace-bound consumers.
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.workspaceModeEligibility.evaluate, {});

    expect(result).not.toBeNull();
    expect(result!.modes.discuss.enabled).toBe(true);
    expect(result!.modes.library.enabled).toBe(false);
    expect(result!.modes.library).toHaveProperty("code", "no_repository_attached");
    expect(result!.defaultMode).toBe("discuss");
    expect(result!.hasAttachedRepo).toBe(false);
    expect(result!.grounding.sandbox.enabled).toBe(false);
    expect(result!.grounding.sandbox).toHaveProperty("code", "no_repository_attached");
  });

  test("workspace + repo + no artifact: library is navigable, ask binding blocked, library grounding closed", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, {
      withArtifact: false,
      sandboxStatus: "ready",
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.workspaceModeEligibility.evaluate, { workspaceId });

    expect(result!.modes.discuss.enabled).toBe(true);
    expect(result!.modes.library.enabled).toBe(true);
    expect(result!.askReadiness.enabled).toBe(false);
    expect(result!.askReadiness).toHaveProperty("code", "library_no_artifact");
    expect(result!.grounding.library.enabled).toBe(false);
    expect(result!.grounding.library).toHaveProperty("code", "library_no_artifact");
    expect(result!.grounding.sandbox.enabled).toBe(true);
  });

  test("workspace + repo + artifact + ready sandbox: both grounding axes open, no disabled reasons", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, {
      withArtifact: true,
      sandboxStatus: "ready",
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.workspaceModeEligibility.evaluate, { workspaceId });

    expect(result!.modes.discuss.enabled).toBe(true);
    expect(result!.modes.library.enabled).toBe(true);
    expect(result!.grounding.library.enabled).toBe(true);
    expect(result!.grounding.sandbox.enabled).toBe(true);
    expect(result!.askReadiness.enabled).toBe(true);
  });

  test("provisioning sandbox: sandbox grounding closes with sandbox_provisioning code", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, {
      withArtifact: true,
      sandboxStatus: "provisioning",
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.workspaceModeEligibility.evaluate, { workspaceId });

    // Discuss and library remain navigable; the sandbox state surfaces via
    // the grounding axis.
    expect(result!.modes.discuss.enabled).toBe(true);
    expect(result!.modes.library.enabled).toBe(true);
    const sandbox = result!.grounding.sandbox;
    expect(sandbox.enabled).toBe(false);
    if (!sandbox.enabled) {
      expect(sandbox.code).toBe("sandbox_provisioning");
      expect(sandbox.isActivatable).toBe(false);
    }
  });

  test("expired sandbox: sandbox grounding closes with sandbox_expired code and is activatable", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, {
      withArtifact: true,
      sandboxStatus: "stopped",
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.workspaceModeEligibility.evaluate, { workspaceId });

    const sandbox = result!.grounding.sandbox;
    expect(sandbox.enabled).toBe(false);
    if (!sandbox.enabled) {
      expect(sandbox.code).toBe("sandbox_expired");
      expect(sandbox.isActivatable).toBe(true);
    }
  });

  test("failed sandbox: sandbox grounding closes with sandbox_failed code and is activatable", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, {
      withArtifact: true,
      sandboxStatus: "failed",
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.workspaceModeEligibility.evaluate, { workspaceId });

    const sandbox = result!.grounding.sandbox;
    expect(sandbox.enabled).toBe(false);
    if (!sandbox.enabled) {
      expect(sandbox.code).toBe("sandbox_failed");
      expect(sandbox.isActivatable).toBe(true);
    }
  });

  test("repo without a sandbox: sandbox grounding closes with sandbox_missing and is activatable", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, {
      withArtifact: true,
      sandboxStatus: null,
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.workspaceModeEligibility.evaluate, { workspaceId });

    // The most common real case: a freshly-imported repo with no sandbox yet.
    // The composer must still let the user click the Sandbox toggle so the
    // shell can enqueue `requestSandboxActivation`.
    const sandbox = result!.grounding.sandbox;
    expect(sandbox.enabled).toBe(false);
    if (!sandbox.enabled) {
      expect(sandbox.code).toBe("sandbox_missing");
      expect(sandbox.isActivatable).toBe(true);
    }
  });
});

describe("workspaceModeEligibility.evaluate (cost cap closed)", () => {
  let priorUserCapEnv: string | undefined;
  let priorEstimateEnv: string | undefined;
  beforeEach(() => {
    priorUserCapEnv = process.env.SANDBOX_DAILY_CAP_PER_USER_USD;
    priorEstimateEnv = process.env.SANDBOX_REPLY_ESTIMATE_USD;
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

  test("user cap exhausted: sandbox grounding closes with sandbox_user_cap_exceeded", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, {
      withArtifact: true,
      sandboxStatus: "ready",
    });

    // Drive the user cap to 0 directly via the rate-limiter component.
    await t.run(async (ctx) => {
      const { rateLimiter } = await import("./lib/rateLimit");
      await rateLimiter.limit(ctx, "sandboxCostUsdPerUserDaily", {
        key: OWNER,
        count: 5,
        config: { kind: "fixed window", rate: 5, capacity: 5, period: 86_400_000, maxReserved: 5, start: 0 },
      });
    });

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.workspaceModeEligibility.evaluate, { workspaceId });

    const sandbox = result!.grounding.sandbox;
    expect(sandbox.enabled).toBe(false);
    if (!sandbox.enabled) {
      expect(sandbox.code).toBe("sandbox_user_cap_exceeded");
    }
    // Verdicts deliberately carry no `retryAfterMs?`: reactive subscriptions
    // update naturally when the bucket flips, so a parallel retry timer
    // would just drift from the wall-clock event. Timing data lives on the
    // cost-budget snapshot in `threadContext.sandboxCostBudgets`.
  });

  test("workspace cap exhausted: sandbox grounding closes with sandbox_workspace_cap_exceeded", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, {
      withArtifact: true,
      sandboxStatus: "ready",
    });

    // Workspace cap defaults to $50 = 5000 cents — burn it.
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

    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.workspaceModeEligibility.evaluate, { workspaceId });

    const sandbox = result!.grounding.sandbox;
    expect(sandbox.enabled).toBe(false);
    if (!sandbox.enabled) {
      expect(sandbox.code).toBe("sandbox_workspace_cap_exceeded");
    }
    // See test above: verdicts carry no retry timing; reactive subscriptions
    // handle the recovery push.
  });
});

// ─── assertWorkspaceModeEligible (write path) ──────────────────────────────

describe("assertWorkspaceModeEligible", () => {
  test("discuss is always eligible: short-circuits without a repository or workspace", async () => {
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    // No throw == passing. Don't assert resolved value (convex-test marshals
    // void-returning callbacks as `null`; we only care that no exception
    // crossed the boundary).
    await viewer.run(async (ctx) => {
      const { assertWorkspaceModeEligible } = await import("./workspaceModeEligibility");
      await assertWorkspaceModeEligible(ctx, { repositoryId: null, workspaceId: null, mode: "discuss" });
    });
  });

  test("library without a repository: throws no_repository_attached", async () => {
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    let caught: unknown;
    try {
      await viewer.run(async (ctx) => {
        const { assertWorkspaceModeEligible } = await import("./workspaceModeEligibility");
        await assertWorkspaceModeEligible(ctx, { repositoryId: null, workspaceId: null, mode: "library" });
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(unwrapErrorData(caught)).toMatchObject({ code: "no_repository_attached", mode: "library" });
  });

  test("discuss with groundSandbox=true and no repository: throws no_repository_attached", async () => {
    // Post-Lab collapse: requesting sandbox grounding without a repo is
    // the closest equivalent to the old "lab without a repo" assert.
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    let caught: unknown;
    try {
      await viewer.run(async (ctx) => {
        const { assertWorkspaceModeEligible } = await import("./workspaceModeEligibility");
        await assertWorkspaceModeEligible(ctx, {
          repositoryId: undefined,
          workspaceId: undefined,
          mode: "discuss",
          groundSandbox: true,
        });
      });
    } catch (err) {
      caught = err;
    }
    expect(unwrapErrorData(caught)).toMatchObject({ code: "no_repository_attached", mode: "discuss" });
  });

  test("discuss with groundSandbox=true and repository owned by another user: throws RepositoryNotFound (opaque)", async () => {
    const t = createTestConvex();
    const { workspaceId, repositoryId } = await seedWorkspace(t, {
      withArtifact: true,
      sandboxStatus: "ready",
      ownerTokenIdentifier: OTHER_OWNER,
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    let caught: unknown;
    try {
      await viewer.run(async (ctx) => {
        const { assertWorkspaceModeEligible } = await import("./workspaceModeEligibility");
        await assertWorkspaceModeEligible(ctx, {
          repositoryId,
          workspaceId,
          mode: "discuss",
          groundSandbox: true,
        });
      });
    } catch (err) {
      caught = err;
    }
    expect(unwrapErrorData(caught)).toMatchObject({ code: "RepositoryNotFound" });
  });

  test("discuss with groundSandbox=true and provisioning sandbox: throws sandbox_provisioning", async () => {
    const t = createTestConvex();
    const { workspaceId, repositoryId } = await seedWorkspace(t, {
      withArtifact: true,
      sandboxStatus: "provisioning",
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    let caught: unknown;
    try {
      await viewer.run(async (ctx) => {
        const { assertWorkspaceModeEligible } = await import("./workspaceModeEligibility");
        await assertWorkspaceModeEligible(ctx, {
          repositoryId,
          workspaceId,
          mode: "discuss",
          groundSandbox: true,
        });
      });
    } catch (err) {
      caught = err;
    }
    expect(unwrapErrorData(caught)).toMatchObject({ code: "sandbox_provisioning", mode: "discuss" });
  });

  test("discuss with groundSandbox=true and ready sandbox: passes", async () => {
    const t = createTestConvex();
    const { workspaceId, repositoryId } = await seedWorkspace(t, {
      withArtifact: true,
      sandboxStatus: "ready",
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    await viewer.run(async (ctx) => {
      const { assertWorkspaceModeEligible } = await import("./workspaceModeEligibility");
      await assertWorkspaceModeEligible(ctx, {
        repositoryId,
        workspaceId,
        mode: "discuss",
        groundSandbox: true,
      });
    });
  });

  test("discuss with groundSandbox=true without a workspace but with a ready repo + sandbox: passes (legacy threads)", async () => {
    // Legacy threads created before the workspace abstraction may have a
    // `repositoryId` but no `workspaceId`. Eligibility must not require a
    // workspace just because the read-path query happens to be keyed by one.
    const t = createTestConvex();
    const { repositoryId } = await seedWorkspace(t, {
      withArtifact: true,
      sandboxStatus: "ready",
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    await viewer.run(async (ctx) => {
      const { assertWorkspaceModeEligible } = await import("./workspaceModeEligibility");
      await assertWorkspaceModeEligible(ctx, {
        repositoryId,
        workspaceId: undefined,
        mode: "discuss",
        groundSandbox: true,
      });
    });
  });

  test("library with no artifact: throws library_no_artifact (write-path enforcement)", async () => {
    // Behavior change vs. pre-deepening write path: send.ts previously
    // accepted Library Ask sends even when no artifact existed, while the
    // read-path UI greyed out Library. Deepening closes that gap.
    const t = createTestConvex();
    const { workspaceId, repositoryId } = await seedWorkspace(t, {
      withArtifact: false,
      sandboxStatus: "ready",
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    let caught: unknown;
    try {
      await viewer.run(async (ctx) => {
        const { assertWorkspaceModeEligible } = await import("./workspaceModeEligibility");
        await assertWorkspaceModeEligible(ctx, { repositoryId, workspaceId, mode: "library" });
      });
    } catch (err) {
      caught = err;
    }
    expect(unwrapErrorData(caught)).toMatchObject({ code: "library_no_artifact", mode: "library" });
  });

  test("library with at least one artifact: passes", async () => {
    const t = createTestConvex();
    const { workspaceId, repositoryId } = await seedWorkspace(t, {
      withArtifact: true,
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    await viewer.run(async (ctx) => {
      const { assertWorkspaceModeEligible } = await import("./workspaceModeEligibility");
      await assertWorkspaceModeEligible(ctx, { repositoryId, workspaceId, mode: "library" });
    });
  });
});

// ─── throwIfDisabled (pure) ──────────────────────────────────────────────

describe("throwIfDisabled (pure)", () => {
  test("enabled mode: no throw", async () => {
    const { throwIfDisabled } = await import("./workspaceModeEligibility");
    expect(() =>
      throwIfDisabled(
        {
          modes: {
            discuss: { enabled: true },
            library: { enabled: true },
          },
          defaultMode: "library",
          grounding: {
            library: { enabled: true },
            sandbox: { enabled: true },
          },
          askReadiness: { enabled: true },
          hasAttachedRepo: true,
          hasAtLeastOneArtifact: true,
        },
        "library",
      ),
    ).not.toThrow();
  });

  test("disabled mode: throws ConvexError carrying the verdict's code and message", async () => {
    const { throwIfDisabled } = await import("./workspaceModeEligibility");
    let caught: unknown;
    try {
      throwIfDisabled(
        {
          modes: {
            discuss: { enabled: true },
            library: {
              enabled: false,
              code: "no_repository_attached",
              message: "Attach a repository to use Library mode.",
            },
          },
          defaultMode: "discuss",
          grounding: {
            library: {
              enabled: false,
              code: "no_repository_attached",
              message: "Library grounding needs a repo.",
            },
            sandbox: {
              enabled: false,
              code: "no_repository_attached",
              message: "Sandbox grounding needs a repo.",
              isActivatable: false,
            },
          },
          askReadiness: {
            enabled: false,
            code: "no_repository_attached",
            message: "Library Ask needs a repo.",
          },
          hasAttachedRepo: false,
          hasAtLeastOneArtifact: false,
        },
        "library",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string; message: string }>).data).toMatchObject({
      code: "no_repository_attached",
      message: "Attach a repository to use Library mode.",
    });
  });
});
