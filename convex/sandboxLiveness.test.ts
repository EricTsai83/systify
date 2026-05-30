/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

const {
  assertSandboxProvisioningConfiguredMock,
  cloneRepositoryInSandboxMock,
  probeLiveSandboxMock,
  provisionSandboxMock,
  startSandboxMock,
  stopSandboxMock,
  deleteSandboxMock,
  getSandboxStateMock,
  listSandboxesByLabelMock,
  getSandboxFsClientMock,
  isSystifyManagedSandboxMock,
  getInstallationAccessTokenMock,
} = vi.hoisted(() => ({
  assertSandboxProvisioningConfiguredMock: vi.fn(),
  cloneRepositoryInSandboxMock: vi.fn(),
  probeLiveSandboxMock: vi.fn(),
  provisionSandboxMock: vi.fn(),
  startSandboxMock: vi.fn(),
  stopSandboxMock: vi.fn(),
  deleteSandboxMock: vi.fn(),
  getSandboxStateMock: vi.fn(),
  listSandboxesByLabelMock: vi.fn(),
  getSandboxFsClientMock: vi.fn(),
  isSystifyManagedSandboxMock: vi.fn().mockReturnValue(true),
  getInstallationAccessTokenMock: vi.fn(),
}));

vi.mock("./daytona", () => ({
  assertSandboxProvisioningConfigured: assertSandboxProvisioningConfiguredMock,
  cloneRepositoryInSandbox: cloneRepositoryInSandboxMock,
  probeLiveSandbox: probeLiveSandboxMock,
  provisionSandbox: provisionSandboxMock,
  startSandbox: startSandboxMock,
  stopSandbox: stopSandboxMock,
  deleteSandbox: deleteSandboxMock,
  getSandboxState: getSandboxStateMock,
  listSandboxesByLabel: listSandboxesByLabelMock,
  getSandboxFsClient: getSandboxFsClientMock,
  isSystifyManagedSandbox: isSystifyManagedSandboxMock,
  SYSTIFY_DAYTONA_MANAGED_LABELS: { app: "systify" },
}));

vi.mock("./githubAppNode", () => ({
  getInstallationAccessToken: getInstallationAccessTokenMock,
}));

async function seedRepoAndSandbox(
  t: ReturnType<typeof convexTest>,
  ownerTokenIdentifier: string,
  args: {
    sandbox?: {
      status: "provisioning" | "ready" | "stopped" | "archived" | "failed";
      remoteId: string;
      ttlExpiresAt?: number;
    };
  } = {},
) {
  return await t.run(async (ctx) => {
    const repositoryId = await ctx.db.insert("repositories", {
      ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: "https://github.com/acme/test",
      sourceRepoFullName: "acme/test",
      sourceRepoOwner: "acme",
      sourceRepoName: "test",
      defaultBranch: "main",
      visibility: "private",
      accessMode: "private",
      importStatus: "completed",
      detectedLanguages: [],
      packageManagers: [],
      entrypoints: [],
      fileCount: 0,
      color: "blue",
      lastAccessedAt: Date.now(),
    });
    let sandboxId: Id<"sandboxes"> | null = null;
    if (args.sandbox) {
      const sid = await ctx.db.insert("sandboxes", {
        repositoryId,
        ownerTokenIdentifier,
        provider: "daytona",
        sourceAdapter: "git_clone",
        remoteId: args.sandbox.remoteId,
        status: args.sandbox.status,
        workDir: "/workspace",
        repoPath: "/workspace/repo",
        cpuLimit: 2,
        memoryLimitGiB: 4,
        diskLimitGiB: 10,
        ttlExpiresAt: args.sandbox.ttlExpiresAt ?? Date.now() + 60 * 60_000,
        autoStopIntervalMinutes: 30,
        autoArchiveIntervalMinutes: 60,
        autoDeleteIntervalMinutes: 120,
        networkBlockAll: false,
      });
      await ctx.db.patch(repositoryId, { latestSandboxId: sid });
      sandboxId = sid;
    }
    return { repositoryId, sandboxId };
  });
}

describe("ensureSandboxReady (via runSandboxActivation)", () => {
  beforeEach(() => {
    assertSandboxProvisioningConfiguredMock.mockReset();
    cloneRepositoryInSandboxMock.mockReset();
    probeLiveSandboxMock.mockReset();
    provisionSandboxMock.mockReset();
    startSandboxMock.mockReset();
    getInstallationAccessTokenMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("returns existing sandbox when probe says started", async () => {
    const t = convexTest(schema, modules);
    const ownerTokenIdentifier = "user|ready-started";
    const { repositoryId, sandboxId } = await seedRepoAndSandbox(t, ownerTokenIdentifier, {
      sandbox: { status: "ready", remoteId: "rid-ready" },
    });
    probeLiveSandboxMock.mockResolvedValue({ ok: true, remoteState: "started" });

    const jobId = await t.run(async (ctx) =>
      ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "sandbox_activation",
        status: "queued",
        stage: "queued",
        progress: 0,
        costCategory: "ops",
        triggerSource: "user",
        leaseExpiresAt: Date.now() + 5 * 60_000,
      }),
    );

    await t.action(internal.sandboxActivationNode.runSandboxActivation, {
      jobId,
      repositoryId,
      ownerTokenIdentifier,
    });

    const job = await t.run(async (ctx) => await ctx.db.get(jobId));
    expect(job?.status).toBe("completed");
    expect(job?.sandboxId).toBe(sandboxId);
    expect(probeLiveSandboxMock).toHaveBeenCalledWith("rid-ready");
    expect(startSandboxMock).not.toHaveBeenCalled();
    expect(provisionSandboxMock).not.toHaveBeenCalled();
  });

  test("wakes a stopped sandbox via startSandbox", async () => {
    const t = convexTest(schema, modules);
    const ownerTokenIdentifier = "user|stopped-wake";
    const { repositoryId, sandboxId } = await seedRepoAndSandbox(t, ownerTokenIdentifier, {
      sandbox: { status: "ready", remoteId: "rid-stop" },
    });
    probeLiveSandboxMock.mockResolvedValue({
      ok: false,
      remoteState: "stopped",
      reason: "stopped",
      message: "stopped",
    });
    startSandboxMock.mockResolvedValue(undefined);

    const jobId = await t.run(async (ctx) =>
      ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "sandbox_activation",
        status: "queued",
        stage: "queued",
        progress: 0,
        costCategory: "ops",
        triggerSource: "user",
        leaseExpiresAt: Date.now() + 5 * 60_000,
      }),
    );

    await t.action(internal.sandboxActivationNode.runSandboxActivation, {
      jobId,
      repositoryId,
      ownerTokenIdentifier,
    });

    const job = await t.run(async (ctx) => await ctx.db.get(jobId));
    expect(job?.status).toBe("completed");
    expect(job?.sandboxId).toBe(sandboxId);
    expect(startSandboxMock).toHaveBeenCalledWith("rid-stop");
    expect(provisionSandboxMock).not.toHaveBeenCalled();
  });

  test("fails activation cleanly when GitHub installation is missing", async () => {
    const t = convexTest(schema, modules);
    const ownerTokenIdentifier = "user|no-installation";
    const { repositoryId } = await seedRepoAndSandbox(t, ownerTokenIdentifier, {
      sandbox: { status: "archived", remoteId: "rid-archived" },
    });

    const jobId = await t.run(async (ctx) =>
      ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "sandbox_activation",
        status: "queued",
        stage: "queued",
        progress: 0,
        costCategory: "ops",
        triggerSource: "user",
        leaseExpiresAt: Date.now() + 5 * 60_000,
      }),
    );

    await t.action(internal.sandboxActivationNode.runSandboxActivation, {
      jobId,
      repositoryId,
      ownerTokenIdentifier,
    });

    const job = await t.run(async (ctx) => await ctx.db.get(jobId));
    expect(job?.status).toBe("failed");
    expect(job?.errorMessage).toMatch(/Connect your GitHub account/);
  });
});

describe("reserveOnDemandSandboxRow CAS", () => {
  test("inserts a fresh provisioning row when the repository has no live sandbox", async () => {
    const t = convexTest(schema, modules);
    const ownerTokenIdentifier = "user|reserve-fresh";
    const { repositoryId } = await seedRepoAndSandbox(t, ownerTokenIdentifier, {
      sandbox: { status: "archived", remoteId: "rid-archived" },
    });

    const result = await t.mutation(internal.imports.reserveOnDemandSandboxRow, {
      repositoryId,
      ownerTokenIdentifier,
      sourceAdapter: "git_clone",
    });

    expect(result.alreadyExisted).toBe(false);
    const repo = await t.run(async (ctx) => await ctx.db.get(repositoryId));
    expect(repo?.latestSandboxId).toBe(result.sandboxId);
    const sandbox = await t.run(async (ctx) => await ctx.db.get(result.sandboxId));
    expect(sandbox?.status).toBe("provisioning");
  });

  test("returns the same sandbox when a provisioning row already exists", async () => {
    // Race scenario: System Design and Sandbox Activation both call
    // ensureSandboxReady at the same time. The CAS guarantees the second
    // mutation observes the first one's provisioning row instead of
    // inserting a duplicate row and leaking a Daytona sandbox.
    const t = convexTest(schema, modules);
    const ownerTokenIdentifier = "user|reserve-cas";
    const { repositoryId } = await seedRepoAndSandbox(t, ownerTokenIdentifier, {
      sandbox: { status: "archived", remoteId: "rid-archived" },
    });

    const first = await t.mutation(internal.imports.reserveOnDemandSandboxRow, {
      repositoryId,
      ownerTokenIdentifier,
      sourceAdapter: "git_clone",
    });
    const second = await t.mutation(internal.imports.reserveOnDemandSandboxRow, {
      repositoryId,
      ownerTokenIdentifier,
      sourceAdapter: "git_clone",
    });

    expect(first.alreadyExisted).toBe(false);
    expect(second.alreadyExisted).toBe(true);
    expect(second.sandboxId).toBe(first.sandboxId);

    const allSandboxes = await t.run(
      async (ctx) =>
        await ctx.db
          .query("sandboxes")
          .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
          .collect(),
    );
    // One pre-existing archived sandbox from the seed, plus one new
    // provisioning row. The second caller MUST NOT insert a third.
    expect(allSandboxes).toHaveLength(2);
    expect(allSandboxes.filter((s) => s.status === "provisioning")).toHaveLength(1);
  });

  test("returns the same sandbox when an existing ready row is still live", async () => {
    const t = convexTest(schema, modules);
    const ownerTokenIdentifier = "user|reserve-cas-ready";
    const { repositoryId, sandboxId } = await seedRepoAndSandbox(t, ownerTokenIdentifier, {
      sandbox: { status: "ready", remoteId: "rid-ready" },
    });

    const result = await t.mutation(internal.imports.reserveOnDemandSandboxRow, {
      repositoryId,
      ownerTokenIdentifier,
      sourceAdapter: "git_clone",
    });

    expect(result.alreadyExisted).toBe(true);
    expect(result.sandboxId).toBe(sandboxId);
  });
});
