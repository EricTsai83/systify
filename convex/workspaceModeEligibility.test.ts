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
  withRepository?: boolean;
  withArtifact?: boolean;
  sandboxStatus?: "provisioning" | "ready" | "stopped" | "archived" | "failed" | null;
  ownerTokenIdentifier?: string;
}

async function seedWorkspace(
  t: ReturnType<typeof convexTest>,
  options: WorkspaceSeedOptions = {},
): Promise<{
  workspaceId: Id<"workspaces">;
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
    }

    const workspaceId = await ctx.db.insert("workspaces", {
      ownerTokenIdentifier: owner,
      repositoryId: repositoryId ?? undefined,
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
    const fakeId = await t.run(async (ctx) => {
      const id = await ctx.db.insert("workspaces", {
        ownerTokenIdentifier: OWNER,
        name: "tmp",
        color: "blue",
        lastAccessedAt: Date.now(),
      });
      await ctx.db.delete(id);
      return id;
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.workspaceModeEligibility.evaluate, { workspaceId: fakeId });
    expect(result).toBeNull();
  });

  test("returns null when the viewer does not own the workspace", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, { ownerTokenIdentifier: OWNER });
    const intruder = t.withIdentity({ tokenIdentifier: OTHER_OWNER });
    const result = await intruder.query(api.workspaceModeEligibility.evaluate, { workspaceId });
    expect(result).toBeNull();
  });

  test("workspace without a repository: only discuss available, library disabled, sandbox grounding closed", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, { withRepository: false });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.workspaceModeEligibility.evaluate, { workspaceId });

    expect(result).not.toBeNull();
    expect(result!.availableModes).toEqual(["discuss"]);
    expect(result!.defaultMode).toBe("discuss");
    expect(result!.hasAttachedRepo).toBe(false);
    expect(result!.hasAtLeastOneArtifact).toBe(false);

    expect(result!.disabledReasons.library?.code).toBe("no_repository_attached");
    expect(result!.disabledReasons.library?.message).toBeTruthy();
    // Post-collapse: sandbox is a grounding axis, not a mode. The
    // sandbox grounding axis closes with `no_repository_attached` when
    // no repo is attached.
    expect(result!.grounding.sandbox.available).toBe(false);
    expect(result!.grounding.sandbox.reason?.code).toBe("no_repository_attached");
  });

  test("workspace + repo + no artifact: library is navigable, ask binding blocked, library grounding closed", async () => {
    // Library navigation no longer gates on an existing artifact — the empty
    // Library page now carries the Generate System Design CTA, so landing
    // there is the intended starting surface for a fresh repo. Library Ask
    // (the write surface) still needs at least one artifact to retrieve
    // against, so `askReadiness.canBind` stays false with the legacy code.
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, {
      withRepository: true,
      withArtifact: false,
      sandboxStatus: "ready",
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.workspaceModeEligibility.evaluate, { workspaceId });

    expect(result!.availableModes.slice().sort()).toEqual(["discuss", "library"]);
    expect(result!.disabledReasons.library).toBeUndefined();
    expect(result!.askReadiness.canBind).toBe(false);
    expect(result!.askReadiness.reason?.code).toBe("library_no_artifact");
    // Library grounding requires at least one artifact; sandbox grounding
    // requires a ready sandbox (which we have).
    expect(result!.grounding.library.available).toBe(false);
    expect(result!.grounding.library.reason?.code).toBe("library_no_artifact");
    expect(result!.grounding.sandbox.available).toBe(true);
  });

  test("workspace + repo + artifact + ready sandbox: both grounding axes open, no disabled reasons", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, {
      withRepository: true,
      withArtifact: true,
      sandboxStatus: "ready",
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.workspaceModeEligibility.evaluate, { workspaceId });

    expect(result!.availableModes.slice().sort()).toEqual(["discuss", "library"]);
    expect(result!.disabledReasons).toEqual({});
    expect(result!.grounding.library.available).toBe(true);
    expect(result!.grounding.sandbox.available).toBe(true);
    expect(result!.askReadiness.canBind).toBe(true);
  });

  test("provisioning sandbox: sandbox grounding closes with sandbox_provisioning code", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, {
      withRepository: true,
      withArtifact: true,
      sandboxStatus: "provisioning",
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.workspaceModeEligibility.evaluate, { workspaceId });

    // Discuss and library remain navigable; the sandbox state surfaces via
    // the grounding axis instead of a disabledReasons entry.
    expect(result!.availableModes).toContain("discuss");
    expect(result!.availableModes).toContain("library");
    expect(result!.grounding.sandbox.available).toBe(false);
    expect(result!.grounding.sandbox.reason?.code).toBe("sandbox_provisioning");
    expect(result!.grounding.sandbox.isActivatable).toBe(false);
  });

  test("expired sandbox: sandbox grounding closes with sandbox_expired code and is activatable", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, {
      withRepository: true,
      withArtifact: true,
      sandboxStatus: "stopped",
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.workspaceModeEligibility.evaluate, { workspaceId });

    expect(result!.grounding.sandbox.available).toBe(false);
    expect(result!.grounding.sandbox.reason?.code).toBe("sandbox_expired");
    expect(result!.grounding.sandbox.isActivatable).toBe(true);
  });

  test("failed sandbox: sandbox grounding closes with sandbox_failed code and is activatable", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, {
      withRepository: true,
      withArtifact: true,
      sandboxStatus: "failed",
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.workspaceModeEligibility.evaluate, { workspaceId });

    expect(result!.grounding.sandbox.available).toBe(false);
    expect(result!.grounding.sandbox.reason?.code).toBe("sandbox_failed");
    expect(result!.grounding.sandbox.isActivatable).toBe(true);
  });

  test("repo without a sandbox: sandbox grounding closes with sandbox_missing and is activatable", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, {
      withRepository: true,
      withArtifact: true,
      sandboxStatus: null,
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.workspaceModeEligibility.evaluate, { workspaceId });

    // The most common real case: a freshly-imported repo with no sandbox yet.
    // The composer must still let the user click the Sandbox toggle so the
    // shell can enqueue `requestSandboxActivation`.
    expect(result!.grounding.sandbox.available).toBe(false);
    expect(result!.grounding.sandbox.reason?.code).toBe("sandbox_missing");
    expect(result!.grounding.sandbox.isActivatable).toBe(true);
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
      withRepository: true,
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

    expect(result!.grounding.sandbox.available).toBe(false);
    expect(result!.grounding.sandbox.reason?.code).toBe("sandbox_user_cap_exceeded");
    // Verdicts deliberately carry no `retryAfterMs?`: reactive subscriptions
    // update naturally when the bucket flips, so a parallel retry timer
    // would just drift from the wall-clock event. Timing data lives on the
    // cost-budget snapshot in `threadContext.sandboxCostBudgets`.
  });

  test("workspace cap exhausted: sandbox grounding closes with sandbox_workspace_cap_exceeded", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, {
      withRepository: true,
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

    expect(result!.grounding.sandbox.available).toBe(false);
    expect(result!.grounding.sandbox.reason?.code).toBe("sandbox_workspace_cap_exceeded");
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
      withRepository: true,
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
      withRepository: true,
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
      withRepository: true,
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
      withRepository: true,
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
      withRepository: true,
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
      withRepository: true,
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
  test("available mode: no throw", async () => {
    const { throwIfDisabled } = await import("./workspaceModeEligibility");
    expect(() =>
      throwIfDisabled(
        {
          availableModes: ["discuss", "library"],
          defaultMode: "library",
          disabledReasons: {},
          grounding: {
            library: { available: true, reason: null },
            sandbox: { available: true, reason: null, isActivatable: false },
          },
          askReadiness: { canBind: true, reason: null },
          hasAttachedRepo: true,
          hasAtLeastOneArtifact: true,
        },
        "library",
      ),
    ).not.toThrow();
  });

  test("disabled with structured reason: throws ConvexError carrying code", async () => {
    const { throwIfDisabled } = await import("./workspaceModeEligibility");
    let caught: unknown;
    try {
      throwIfDisabled(
        {
          availableModes: ["discuss"],
          defaultMode: "discuss",
          disabledReasons: {
            library: {
              code: "no_repository_attached",
              message: "Attach a repository to use Library mode.",
            },
          },
          grounding: {
            library: {
              available: false,
              reason: { code: "no_repository_attached", message: "Library grounding needs a repo." },
            },
            sandbox: {
              available: false,
              reason: { code: "no_repository_attached", message: "Sandbox grounding needs a repo." },
              isActivatable: false,
            },
          },
          askReadiness: { canBind: false, reason: null },
          hasAttachedRepo: false,
          hasAtLeastOneArtifact: false,
        },
        "library",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data).toMatchObject({
      code: "no_repository_attached",
    });
  });

  test("disabled without a structured reason (defensive): throws generic workspace_mode_unavailable", async () => {
    const { throwIfDisabled } = await import("./workspaceModeEligibility");
    let caught: unknown;
    try {
      throwIfDisabled(
        {
          availableModes: ["discuss"],
          defaultMode: "discuss",
          disabledReasons: {},
          grounding: {
            library: { available: false, reason: null },
            sandbox: { available: false, reason: null, isActivatable: false },
          },
          askReadiness: { canBind: false, reason: null },
          hasAttachedRepo: false,
          hasAtLeastOneArtifact: false,
        },
        "library",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("workspace_mode_unavailable");
  });
});
