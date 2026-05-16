/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
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

  test("getSandboxActivityStatus reports activating while a job is in flight", async () => {
    const ownerTokenIdentifier = "user|activate-status-flip";
    const t = createTestConvex();
    const repositoryId = await seedRepoWithSandbox(t, ownerTokenIdentifier, "archived");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await viewer.mutation(api.repositories.requestSandboxActivation, { repositoryId });
    const status = await viewer.query(api.repositories.getSandboxActivityStatus, { repositoryId });
    expect(status.kind).toBe("activating");
    expect(status.activeJob?.kind).toBe("sandbox_activation");
  });
});
