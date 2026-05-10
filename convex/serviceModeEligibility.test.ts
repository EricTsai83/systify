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
 * Save / restore sandbox env vars between cases so a misbehaving test
 * cannot leak state into the next one. Mirrors the helper in
 * threadContext.test.ts so the two suites share the same discipline.
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

function withSandboxFeatureGateOpen() {
  withSandboxEnvSnapshot({ enabled: "true", allowlist: "*" });
}

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

describe("serviceModeEligibility.evaluate (open feature gate)", () => {
  withSandboxFeatureGateOpen();

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
    const result = await viewer.query(api.serviceModeEligibility.evaluate, { workspaceId: fakeId });
    expect(result).toBeNull();
  });

  test("returns null when the viewer does not own the workspace", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, { ownerTokenIdentifier: OWNER });
    const intruder = t.withIdentity({ tokenIdentifier: OTHER_OWNER });
    const result = await intruder.query(api.serviceModeEligibility.evaluate, { workspaceId });
    expect(result).toBeNull();
  });

  test("workspace without a repository: only discuss available, library + lab disabled with structured codes", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, { withRepository: false });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.serviceModeEligibility.evaluate, { workspaceId });

    expect(result).not.toBeNull();
    expect(result!.availableServiceModes).toEqual(["discuss"]);
    expect(result!.defaultServiceMode).toBe("discuss");
    expect(result!.hasAttachedRepo).toBe(false);
    expect(result!.hasAtLeastOneArtifact).toBe(false);

    expect(result!.disabledReasons.library?.code).toBe("no_repository_attached");
    expect(result!.disabledReasons.library?.message).toBeTruthy();
    expect(result!.disabledReasons.lab?.code).toBe("no_repository_attached");
  });

  test("workspace + repo + no artifact: library disabled with library_no_artifact code", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, {
      withRepository: true,
      withArtifact: false,
      sandboxStatus: "ready",
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.serviceModeEligibility.evaluate, { workspaceId });

    expect(result!.availableServiceModes).toEqual(expect.arrayContaining(["discuss", "lab"]));
    expect(result!.availableServiceModes).not.toContain("library");
    expect(result!.disabledReasons.library?.code).toBe("library_no_artifact");
    expect(result!.disabledReasons.library?.message).toBeTruthy();
  });

  test("workspace + repo + artifact + ready sandbox: all three modes available, no disabled reasons", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, {
      withRepository: true,
      withArtifact: true,
      sandboxStatus: "ready",
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.serviceModeEligibility.evaluate, { workspaceId });

    expect(result!.availableServiceModes.slice().sort()).toEqual(["discuss", "lab", "library"]);
    expect(result!.disabledReasons).toEqual({});
    expect(result!.labReadiness.canStart).toBe(true);
    expect(result!.askReadiness.canBind).toBe(true);
  });

  test("provisioning sandbox: lab disabled with sandbox_provisioning code", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, {
      withRepository: true,
      withArtifact: true,
      sandboxStatus: "provisioning",
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.serviceModeEligibility.evaluate, { workspaceId });

    expect(result!.availableServiceModes).not.toContain("lab");
    expect(result!.disabledReasons.lab?.code).toBe("sandbox_provisioning");
    expect(result!.labReadiness.canStart).toBe(false);
    expect(result!.labReadiness.reason?.code).toBe("sandbox_provisioning");
  });

  test("expired sandbox: lab disabled with sandbox_expired code", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, {
      withRepository: true,
      withArtifact: true,
      sandboxStatus: "stopped",
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.serviceModeEligibility.evaluate, { workspaceId });

    expect(result!.disabledReasons.lab?.code).toBe("sandbox_expired");
  });

  test("failed sandbox: lab disabled with sandbox_failed code", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, {
      withRepository: true,
      withArtifact: true,
      sandboxStatus: "failed",
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.serviceModeEligibility.evaluate, { workspaceId });

    expect(result!.disabledReasons.lab?.code).toBe("sandbox_failed");
  });

  test("repo without a sandbox: lab disabled with sandbox_missing code", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, {
      withRepository: true,
      withArtifact: true,
      sandboxStatus: null,
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.serviceModeEligibility.evaluate, { workspaceId });

    expect(result!.disabledReasons.lab?.code).toBe("sandbox_missing");
  });
});

describe("serviceModeEligibility.evaluate (closed feature gate)", () => {
  withSandboxEnvSnapshot({});

  test("flag off: lab disabled with sandbox_flag_off code regardless of sandbox state", async () => {
    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, {
      withRepository: true,
      withArtifact: true,
      sandboxStatus: "ready",
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.serviceModeEligibility.evaluate, { workspaceId });

    expect(result!.availableServiceModes).not.toContain("lab");
    expect(result!.disabledReasons.lab?.code).toBe("sandbox_flag_off");
  });

  test("viewer not on allowlist: lab disabled with sandbox_not_allowlisted code", async () => {
    process.env.SANDBOX_MODE_ENABLED = "true";
    process.env.SANDBOX_BETA_ALLOWLIST = "user|someone-else";

    const t = createTestConvex();
    const { workspaceId } = await seedWorkspace(t, {
      withRepository: true,
      withArtifact: true,
      sandboxStatus: "ready",
      ownerTokenIdentifier: OWNER,
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    const result = await viewer.query(api.serviceModeEligibility.evaluate, { workspaceId });

    expect(result!.disabledReasons.lab?.code).toBe("sandbox_not_allowlisted");
  });
});

describe("serviceModeEligibility.evaluate (cost cap closed)", () => {
  withSandboxFeatureGateOpen();

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

  test("user cap exhausted: lab disabled with sandbox_user_cap_exceeded + retryAfterMs", async () => {
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
    const result = await viewer.query(api.serviceModeEligibility.evaluate, { workspaceId });

    expect(result!.availableServiceModes).not.toContain("lab");
    expect(result!.disabledReasons.lab?.code).toBe("sandbox_user_cap_exceeded");
    expect(result!.disabledReasons.lab?.retryAfterMs).toBeGreaterThan(0);
  });

  test("workspace cap exhausted: lab disabled with sandbox_workspace_cap_exceeded + retryAfterMs", async () => {
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
    const result = await viewer.query(api.serviceModeEligibility.evaluate, { workspaceId });

    expect(result!.disabledReasons.lab?.code).toBe("sandbox_workspace_cap_exceeded");
    expect(result!.disabledReasons.lab?.retryAfterMs).toBeGreaterThan(0);
  });
});

// ─── assertServiceModeEligible (write path) ──────────────────────────────

describe("assertServiceModeEligible", () => {
  withSandboxFeatureGateOpen();

  test("discuss is always eligible: short-circuits without a repository or workspace", async () => {
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    // No throw == passing. Don't assert resolved value (convex-test marshals
    // void-returning callbacks as `null`; we only care that no exception
    // crossed the boundary).
    await viewer.run(async (ctx) => {
      const { assertServiceModeEligible } = await import("./serviceModeEligibility");
      await assertServiceModeEligible(ctx, { repositoryId: null, workspaceId: null, mode: "discuss" });
    });
  });

  test("library without a repository: throws no_repository_attached", async () => {
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    let caught: unknown;
    try {
      await viewer.run(async (ctx) => {
        const { assertServiceModeEligible } = await import("./serviceModeEligibility");
        await assertServiceModeEligible(ctx, { repositoryId: null, workspaceId: null, mode: "library" });
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(unwrapErrorData(caught)).toMatchObject({ code: "no_repository_attached", mode: "library" });
  });

  test("lab without a repository: throws no_repository_attached", async () => {
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    let caught: unknown;
    try {
      await viewer.run(async (ctx) => {
        const { assertServiceModeEligible } = await import("./serviceModeEligibility");
        await assertServiceModeEligible(ctx, { repositoryId: undefined, workspaceId: undefined, mode: "lab" });
      });
    } catch (err) {
      caught = err;
    }
    expect(unwrapErrorData(caught)).toMatchObject({ code: "no_repository_attached", mode: "lab" });
  });

  test("lab with repository owned by another user: throws RepositoryNotFound (opaque)", async () => {
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
        const { assertServiceModeEligible } = await import("./serviceModeEligibility");
        await assertServiceModeEligible(ctx, { repositoryId, workspaceId, mode: "lab" });
      });
    } catch (err) {
      caught = err;
    }
    expect(unwrapErrorData(caught)).toMatchObject({ code: "RepositoryNotFound" });
  });

  test("lab with provisioning sandbox: throws sandbox_provisioning", async () => {
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
        const { assertServiceModeEligible } = await import("./serviceModeEligibility");
        await assertServiceModeEligible(ctx, { repositoryId, workspaceId, mode: "lab" });
      });
    } catch (err) {
      caught = err;
    }
    expect(unwrapErrorData(caught)).toMatchObject({ code: "sandbox_provisioning", mode: "lab" });
  });

  test("lab with ready sandbox: passes", async () => {
    const t = createTestConvex();
    const { workspaceId, repositoryId } = await seedWorkspace(t, {
      withRepository: true,
      withArtifact: true,
      sandboxStatus: "ready",
    });
    const viewer = t.withIdentity({ tokenIdentifier: OWNER });
    await viewer.run(async (ctx) => {
      const { assertServiceModeEligible } = await import("./serviceModeEligibility");
      await assertServiceModeEligible(ctx, { repositoryId, workspaceId, mode: "lab" });
    });
  });

  test("lab without a workspace but with a ready repo + sandbox: passes (legacy threads)", async () => {
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
      const { assertServiceModeEligible } = await import("./serviceModeEligibility");
      await assertServiceModeEligible(ctx, { repositoryId, workspaceId: undefined, mode: "lab" });
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
        const { assertServiceModeEligible } = await import("./serviceModeEligibility");
        await assertServiceModeEligible(ctx, { repositoryId, workspaceId, mode: "library" });
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
      const { assertServiceModeEligible } = await import("./serviceModeEligibility");
      await assertServiceModeEligible(ctx, { repositoryId, workspaceId, mode: "library" });
    });
  });
});

// ─── throwIfDisabled (pure) ──────────────────────────────────────────────

describe("throwIfDisabled (pure)", () => {
  test("available mode: no throw", async () => {
    const { throwIfDisabled } = await import("./serviceModeEligibility");
    expect(() =>
      throwIfDisabled(
        {
          availableServiceModes: ["discuss", "library", "lab"],
          defaultServiceMode: "library",
          disabledReasons: {},
          labReadiness: { canStart: true, reason: null },
          askReadiness: { canBind: true, reason: null },
          hasAttachedRepo: true,
          hasAtLeastOneArtifact: true,
        },
        "lab",
      ),
    ).not.toThrow();
  });

  test("disabled with structured reason: throws ConvexError carrying code + retryAfterMs", async () => {
    const { throwIfDisabled } = await import("./serviceModeEligibility");
    let caught: unknown;
    try {
      throwIfDisabled(
        {
          availableServiceModes: ["discuss"],
          defaultServiceMode: "discuss",
          disabledReasons: {
            lab: {
              code: "sandbox_user_cap_exceeded",
              message: "Daily sandbox spend limit reached for your account.",
              retryAfterMs: 1234,
            },
          },
          labReadiness: { canStart: false, reason: null },
          askReadiness: { canBind: false, reason: null },
          hasAttachedRepo: true,
          hasAtLeastOneArtifact: true,
        },
        "lab",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string; retryAfterMs: number }>).data).toMatchObject({
      code: "sandbox_user_cap_exceeded",
      retryAfterMs: 1234,
    });
  });

  test("disabled without a structured reason (defensive): throws generic service_mode_unavailable", async () => {
    const { throwIfDisabled } = await import("./serviceModeEligibility");
    let caught: unknown;
    try {
      throwIfDisabled(
        {
          availableServiceModes: ["discuss"],
          defaultServiceMode: "discuss",
          disabledReasons: {},
          labReadiness: { canStart: false, reason: null },
          askReadiness: { canBind: false, reason: null },
          hasAttachedRepo: false,
          hasAtLeastOneArtifact: false,
        },
        "lab",
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConvexError);
    expect((caught as ConvexError<{ code: string }>).data.code).toBe("service_mode_unavailable");
  });
});
