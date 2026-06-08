/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function createTestConvex() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

async function seedRepoWithSandbox(
  t: ReturnType<typeof convexTest>,
  ownerTokenIdentifier: string,
  sandboxStatus: "provisioning" | "ready" | "stopped" | "archived" | "failed" | "none",
) {
  return await t.run(async (ctx) => {
    await ctx.db.insert("userAccessProfiles", {
      ownerTokenIdentifier,
      email: `${ownerTokenIdentifier}@example.com`,
      plan: "internal",
      billingStatus: "none",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });

    const repositoryId = await ctx.db.insert("repositories", {
      ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: "https://github.com/acme/sandbox-activation",
      sourceRepoFullName: "acme/sandbox-activation",
      sourceRepoOwner: "acme",
      sourceRepoName: "sandbox-activation",
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

    if (sandboxStatus !== "none") {
      const ttl = sandboxStatus === "ready" ? Date.now() + 60 * 60_000 : Date.now() - 1_000;
      const sandboxId = await ctx.db.insert("sandboxes", {
        repositoryId,
        ownerTokenIdentifier,
        provider: "daytona",
        sourceAdapter: "git_clone",
        remoteId: sandboxStatus === "ready" ? "remote-ready" : "remote-other",
        status: sandboxStatus,
        workDir: "/workspace",
        repoPath: "/workspace/repo",
        cpuLimit: 2,
        memoryLimitGiB: 4,
        diskLimitGiB: 10,
        ttlExpiresAt: ttl,
        autoStopIntervalMinutes: 30,
        autoArchiveIntervalMinutes: 60,
        autoDeleteIntervalMinutes: 120,
        networkBlockAll: false,
      });
      await ctx.db.patch(repositoryId, { latestSandboxId: sandboxId });
    }
    return repositoryId;
  });
}

describe("getSandboxActivityStatus", () => {
  test("returns idle when no sandbox is attached", async () => {
    const ownerTokenIdentifier = "user|status-idle";
    const t = createTestConvex();
    const repositoryId = await seedRepoWithSandbox(t, ownerTokenIdentifier, "none");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const status = await viewer.query(api.repositories.getSandboxActivityStatus, { repositoryId });
    expect(status.kind).toBe("idle");
    expect(status.activeJob).toBeNull();
  });

  test("returns idle when sandbox is archived", async () => {
    const ownerTokenIdentifier = "user|status-archived";
    const t = createTestConvex();
    const repositoryId = await seedRepoWithSandbox(t, ownerTokenIdentifier, "archived");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const status = await viewer.query(api.repositories.getSandboxActivityStatus, { repositoryId });
    expect(status.kind).toBe("idle");
  });

  test("returns ready when sandbox is ready with healthy TTL", async () => {
    const ownerTokenIdentifier = "user|status-ready";
    const t = createTestConvex();
    const repositoryId = await seedRepoWithSandbox(t, ownerTokenIdentifier, "ready");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const status = await viewer.query(api.repositories.getSandboxActivityStatus, { repositoryId });
    expect(status.kind).toBe("ready");
    expect(status.sandbox?.status).toBe("ready");
  });

  test("returns expiring_soon when TTL is under 5 minutes", async () => {
    const ownerTokenIdentifier = "user|status-expiring";
    const t = createTestConvex();
    const repositoryId = await t.run(async (ctx) => {
      const repoId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/expiring",
        sourceRepoFullName: "acme/expiring",
        sourceRepoOwner: "acme",
        sourceRepoName: "expiring",
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
      const sandboxId = await ctx.db.insert("sandboxes", {
        repositoryId: repoId,
        ownerTokenIdentifier,
        provider: "daytona",
        sourceAdapter: "git_clone",
        remoteId: "remote-expiring",
        status: "ready",
        workDir: "/workspace",
        repoPath: "/workspace/repo",
        cpuLimit: 2,
        memoryLimitGiB: 4,
        diskLimitGiB: 10,
        ttlExpiresAt: Date.now() + 2 * 60_000,
        autoStopIntervalMinutes: 30,
        autoArchiveIntervalMinutes: 60,
        autoDeleteIntervalMinutes: 120,
        networkBlockAll: false,
      });
      await ctx.db.patch(repoId, { latestSandboxId: sandboxId });
      return repoId;
    });
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const status = await viewer.query(api.repositories.getSandboxActivityStatus, { repositoryId });
    expect(status.kind).toBe("expiring_soon");
  });

  test("returns preparing when the latest sandbox row is provisioning without an active job", async () => {
    const ownerTokenIdentifier = "user|status-provisioning";
    const t = createTestConvex();
    const repositoryId = await seedRepoWithSandbox(t, ownerTokenIdentifier, "provisioning");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const status = await viewer.query(api.repositories.getSandboxActivityStatus, { repositoryId });
    expect(status.kind).toBe("preparing");
    expect(status.activeJob).toBeNull();
    expect(status.sandbox?.status).toBe("provisioning");
  });
});

describe("requestSandboxActivation", () => {
  test("queues a sandbox_activation job and returns its id", async () => {
    const ownerTokenIdentifier = "user|activate-fresh";
    const t = createTestConvex();
    const repositoryId = await seedRepoWithSandbox(t, ownerTokenIdentifier, "archived");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const { jobId } = await viewer.mutation(api.repositories.requestSandboxActivation, {
      repositoryId,
    });

    const job = await t.run(async (ctx) => await ctx.db.get(jobId));
    expect(job?.kind).toBe("sandbox_activation");
    expect(job?.status).toBe("queued");
    expect(job?.repositoryId).toBe(repositoryId);
  });

  test("dedups when an in-flight activation already exists", async () => {
    const ownerTokenIdentifier = "user|activate-dedup";
    const t = createTestConvex();
    const repositoryId = await seedRepoWithSandbox(t, ownerTokenIdentifier, "archived");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const first = await viewer.mutation(api.repositories.requestSandboxActivation, { repositoryId });
    const second = await viewer.mutation(api.repositories.requestSandboxActivation, { repositoryId });

    expect(second.jobId).toBe(first.jobId);

    const allJobs = await t.run(
      async (ctx) =>
        await ctx.db
          .query("jobs")
          .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
          .collect(),
    );
    const activationJobs = allJobs.filter((j) => j.kind === "sandbox_activation");
    expect(activationJobs).toHaveLength(1);
  });

  test("getSandboxActivityStatus reports preparing while a sandbox-backed job is in flight", async () => {
    const ownerTokenIdentifier = "user|activate-status-flip";
    const t = createTestConvex();
    const repositoryId = await seedRepoWithSandbox(t, ownerTokenIdentifier, "archived");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await viewer.mutation(api.repositories.requestSandboxActivation, { repositoryId });
    const status = await viewer.query(api.repositories.getSandboxActivityStatus, { repositoryId });
    expect(status.kind).toBe("preparing");
    expect(status.activeJob?.kind).toBe("sandbox_activation");
  });
});

describe("recoverStaleSandboxActivationJob", () => {
  test("fails a queued sandbox_activation job whose lease has expired", async () => {
    const ownerTokenIdentifier = "user|stale-queued";
    const t = createTestConvex();
    const repositoryId = await seedRepoWithSandbox(t, ownerTokenIdentifier, "archived");

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
        leaseExpiresAt: Date.now() - 60_000,
      }),
    );

    await t.mutation(internal.repositories.recoverStaleSandboxActivationJob, { jobId });

    const job = await t.run(async (ctx) => await ctx.db.get(jobId));
    expect(job?.status).toBe("failed");
    expect(job?.errorMessage).toMatch(/Sandbox activation stalled/);
    expect(job?.leaseExpiresAt).toBeUndefined();
  });

  test("fails a running sandbox_activation job whose lease has expired", async () => {
    const ownerTokenIdentifier = "user|stale-running";
    const t = createTestConvex();
    const repositoryId = await seedRepoWithSandbox(t, ownerTokenIdentifier, "archived");

    const jobId = await t.run(async (ctx) =>
      ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "sandbox_activation",
        status: "running",
        stage: "Preparing environment…",
        progress: 0.1,
        costCategory: "ops",
        triggerSource: "user",
        startedAt: Date.now() - 10 * 60_000,
        leaseExpiresAt: Date.now() - 5 * 60_000,
      }),
    );

    await t.mutation(internal.repositories.recoverStaleSandboxActivationJob, { jobId });

    const job = await t.run(async (ctx) => await ctx.db.get(jobId));
    expect(job?.status).toBe("failed");
    expect(job?.errorMessage).toMatch(/Sandbox activation stalled/);
  });

  test("leaves jobs alone when the lease has not expired yet", async () => {
    const ownerTokenIdentifier = "user|stale-not-yet";
    const t = createTestConvex();
    const repositoryId = await seedRepoWithSandbox(t, ownerTokenIdentifier, "archived");

    const jobId = await t.run(async (ctx) =>
      ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "sandbox_activation",
        status: "running",
        stage: "Preparing environment…",
        progress: 0.1,
        costCategory: "ops",
        triggerSource: "user",
        leaseExpiresAt: Date.now() + 60_000,
      }),
    );

    await t.mutation(internal.repositories.recoverStaleSandboxActivationJob, { jobId });

    const job = await t.run(async (ctx) => await ctx.db.get(jobId));
    expect(job?.status).toBe("running");
  });

  test("does not touch jobs in a terminal state", async () => {
    const ownerTokenIdentifier = "user|stale-terminal";
    const t = createTestConvex();
    const repositoryId = await seedRepoWithSandbox(t, ownerTokenIdentifier, "archived");

    const jobId = await t.run(async (ctx) =>
      ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "sandbox_activation",
        status: "completed",
        stage: "completed",
        progress: 1,
        costCategory: "ops",
        triggerSource: "user",
        completedAt: Date.now() - 60_000,
      }),
    );

    await t.mutation(internal.repositories.recoverStaleSandboxActivationJob, { jobId });

    const job = await t.run(async (ctx) => await ctx.db.get(jobId));
    expect(job?.status).toBe("completed");
  });
});

describe("completeSandboxActivation", () => {
  test("skips the sandboxId patch when the job is already failed", async () => {
    const ownerTokenIdentifier = "user|complete-after-fail";
    const t = createTestConvex();
    const repositoryId = await seedRepoWithSandbox(t, ownerTokenIdentifier, "archived");
    const sandboxId = await t.run(async (ctx) => {
      const repo = (await ctx.db.get(repositoryId))!;
      return repo.latestSandboxId!;
    });

    const jobId = await t.run(async (ctx) =>
      ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "sandbox_activation",
        status: "failed",
        stage: "failed",
        progress: 1,
        costCategory: "ops",
        triggerSource: "user",
        errorMessage: "Sandbox activation stalled and was automatically marked as failed.",
        completedAt: Date.now() - 60_000,
      }),
    );

    await t.mutation(internal.repositories.completeSandboxActivation, { jobId, sandboxId });

    const job = await t.run(async (ctx) => await ctx.db.get(jobId));
    expect(job?.status).toBe("failed");
    expect(job?.sandboxId).toBeUndefined();
  });
});
