/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import type { Doc, Id } from "../_generated/dataModel";
import schema from "../schema";
import { enqueueJob, findActiveJob, type EnqueueJobArgs } from "./jobs";

const modules = import.meta.glob("../**/*.ts");

function createTestConvex() {
  return convexTest(schema, modules);
}

const BASE_OWNER = "user|jobs-fixture";

async function seedRepositoryAndThread(t: ReturnType<typeof convexTest>) {
  return await t.run(async (ctx) => {
    const repositoryId = await ctx.db.insert("repositories", {
      ownerTokenIdentifier: BASE_OWNER,
      sourceHost: "github",
      sourceUrl: "https://github.com/acme/jobs-fixture",
      sourceRepoFullName: "acme/jobs-fixture",
      sourceRepoOwner: "acme",
      sourceRepoName: "jobs-fixture",
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
    const threadId = await ctx.db.insert("threads", {
      repositoryId,
      ownerTokenIdentifier: BASE_OWNER,
      title: "Jobs fixture",
      mode: "discuss",
      lastMessageAt: Date.now(),
    });
    return { repositoryId, threadId };
  });
}

async function callEnqueue(
  t: ReturnType<typeof convexTest>,
  args: EnqueueJobArgs,
): Promise<{ jobId: Id<"jobs">; job: Doc<"jobs"> | null }> {
  return await t.run(async (ctx) => {
    const jobId = await enqueueJob(ctx, args);
    const job = await ctx.db.get(jobId);
    return { jobId, job };
  });
}

describe("enqueueJob defaults and lease", () => {
  test("writes status=queued, stage=queued, progress=0 by default", async () => {
    const t = createTestConvex();
    const { repositoryId } = await seedRepositoryAndThread(t);

    const { job } = await callEnqueue(t, {
      kind: "import",
      repositoryId,
      ownerTokenIdentifier: BASE_OWNER,
      costCategory: "indexing",
      triggerSource: "user",
    });

    expect(job?.status).toBe("queued");
    expect(job?.stage).toBe("queued");
    expect(job?.progress).toBe(0);
    expect(job?.leaseExpiresAt).toBeUndefined();
  });

  test("computes leaseExpiresAt from leaseMs", async () => {
    const t = createTestConvex();
    const { repositoryId } = await seedRepositoryAndThread(t);

    const before = Date.now();
    const { job } = await callEnqueue(t, {
      kind: "sandbox_activation",
      repositoryId,
      ownerTokenIdentifier: BASE_OWNER,
      costCategory: "ops",
      triggerSource: "user",
      leaseMs: 60_000,
    });
    const after = Date.now();

    expect(job?.leaseExpiresAt).toBeDefined();
    expect(job!.leaseExpiresAt!).toBeGreaterThanOrEqual(before + 60_000);
    expect(job!.leaseExpiresAt!).toBeLessThanOrEqual(after + 60_000);
  });

  test("threads optional fields (sandboxId, requestedCommand, outputSummary, selections)", async () => {
    const t = createTestConvex();
    const { repositoryId, threadId } = await seedRepositoryAndThread(t);
    const sandboxId = await t.run(async (ctx) =>
      ctx.db.insert("sandboxes", {
        repositoryId,
        ownerTokenIdentifier: BASE_OWNER,
        provider: "daytona",
        sourceAdapter: "git_clone",
        remoteId: "rid",
        status: "ready",
        workDir: "/w",
        repoPath: "/w/repo",
        cpuLimit: 1,
        memoryLimitGiB: 1,
        diskLimitGiB: 1,
        ttlExpiresAt: Date.now() + 60_000,
        autoStopIntervalMinutes: 10,
        autoArchiveIntervalMinutes: 30,
        autoDeleteIntervalMinutes: 60,
        networkBlockAll: false,
      }),
    );

    const { job } = await callEnqueue(t, {
      kind: "system_design",
      repositoryId,
      threadId,
      sandboxId,
      ownerTokenIdentifier: BASE_OWNER,
      costCategory: "system_design",
      triggerSource: "user",
      requestedCommand: "library_generation:architecture_overview",
      outputSummary: "Queued System Design generation",
      selections: ["architecture_overview"],
    });

    expect(job?.sandboxId).toBe(sandboxId);
    expect(job?.threadId).toBe(threadId);
    expect(job?.requestedCommand).toBe("library_generation:architecture_overview");
    expect(job?.outputSummary).toBe("Queued System Design generation");
    expect(job?.selections).toEqual(["architecture_overview"]);
  });

  test("omits unset optional fields rather than persisting undefined", async () => {
    const t = createTestConvex();
    const { repositoryId } = await seedRepositoryAndThread(t);

    const { job } = await callEnqueue(t, {
      kind: "cleanup",
      repositoryId,
      ownerTokenIdentifier: BASE_OWNER,
      costCategory: "ops",
      triggerSource: "system",
    });

    expect(job).not.toBeNull();
    expect("sandboxId" in (job ?? {})).toBe(false);
    expect("threadId" in (job ?? {})).toBe(false);
    expect("requestedCommand" in (job ?? {})).toBe(false);
  });
});

describe("enqueueJob per-kind invariants", () => {
  test("chat without threadId throws", async () => {
    const t = createTestConvex();
    await seedRepositoryAndThread(t);

    await expect(
      t.run(async (ctx) =>
        enqueueJob(ctx, {
          kind: "chat",
          ownerTokenIdentifier: BASE_OWNER,
          costCategory: "chat",
          triggerSource: "user",
        }),
      ),
    ).rejects.toThrow(/requires a threadId/);
  });

  test("import without repositoryId throws", async () => {
    const t = createTestConvex();

    await expect(
      t.run(async (ctx) =>
        enqueueJob(ctx, {
          kind: "import",
          ownerTokenIdentifier: BASE_OWNER,
          costCategory: "indexing",
          triggerSource: "user",
        }),
      ),
    ).rejects.toThrow(/requires a repositoryId/);
  });

  test("cleanup with threadId throws (repository-only kinds reject thread scope)", async () => {
    const t = createTestConvex();
    const { repositoryId, threadId } = await seedRepositoryAndThread(t);

    await expect(
      t.run(async (ctx) =>
        enqueueJob(ctx, {
          kind: "cleanup",
          repositoryId,
          threadId,
          ownerTokenIdentifier: BASE_OWNER,
          costCategory: "ops",
          triggerSource: "system",
        }),
      ),
    ).rejects.toThrow(/cannot carry a threadId/);
  });
});

describe("findActiveJob", () => {
  test("returns null when no active job exists", async () => {
    const t = createTestConvex();
    const { repositoryId } = await seedRepositoryAndThread(t);

    const result = await t.run(async (ctx) =>
      findActiveJob(ctx, {
        kind: "sandbox_activation",
        scope: { type: "repository", id: repositoryId },
        now: Date.now(),
      }),
    );

    expect(result).toBeNull();
  });

  test("prefers running over queued when both exist", async () => {
    const t = createTestConvex();
    const { repositoryId } = await seedRepositoryAndThread(t);
    const now = Date.now();

    const queuedId = await t.run(async (ctx) =>
      enqueueJob(ctx, {
        kind: "sandbox_activation",
        repositoryId,
        ownerTokenIdentifier: BASE_OWNER,
        costCategory: "ops",
        triggerSource: "user",
        leaseMs: 60_000,
      }),
    );
    const runningId = await t.run(async (ctx) => {
      const id = await enqueueJob(ctx, {
        kind: "sandbox_activation",
        repositoryId,
        ownerTokenIdentifier: BASE_OWNER,
        costCategory: "ops",
        triggerSource: "user",
        leaseMs: 60_000,
      });
      await ctx.db.patch(id, { status: "running" });
      return id;
    });

    const result = await t.run(async (ctx) =>
      findActiveJob(ctx, {
        kind: "sandbox_activation",
        scope: { type: "repository", id: repositoryId },
        now,
      }),
    );

    expect(result?._id).toBe(runningId);
    expect(result?._id).not.toBe(queuedId);
  });

  test("excludes jobs whose lease has expired", async () => {
    const t = createTestConvex();
    const { repositoryId } = await seedRepositoryAndThread(t);

    // Insert a job, then patch leaseExpiresAt to 60s in the past.
    const jobId = await t.run(async (ctx) =>
      enqueueJob(ctx, {
        kind: "sandbox_activation",
        repositoryId,
        ownerTokenIdentifier: BASE_OWNER,
        costCategory: "ops",
        triggerSource: "user",
        leaseMs: 60_000,
      }),
    );
    const stalePoint = Date.now() + 120_000;
    await t.run(async (ctx) => ctx.db.patch(jobId, { leaseExpiresAt: stalePoint - 180_000 }));

    const result = await t.run(async (ctx) =>
      findActiveJob(ctx, {
        kind: "sandbox_activation",
        scope: { type: "repository", id: repositoryId },
        now: stalePoint,
      }),
    );

    expect(result).toBeNull();
  });

  test("applies predicate to discriminate same-kind jobs", async () => {
    const t = createTestConvex();
    const { repositoryId } = await seedRepositoryAndThread(t);
    const now = Date.now();

    // Two same-kind jobs distinguished by `triggerSource`. The predicate
    // filters by that field — exercising the helper's predicate parameter.
    await t.run(async (ctx) =>
      enqueueJob(ctx, {
        kind: "system_design",
        repositoryId,
        ownerTokenIdentifier: BASE_OWNER,
        costCategory: "system_design",
        triggerSource: "user",
        leaseMs: 60_000,
      }),
    );
    const systemTriggeredId = await t.run(async (ctx) =>
      enqueueJob(ctx, {
        kind: "system_design",
        repositoryId,
        ownerTokenIdentifier: BASE_OWNER,
        costCategory: "system_design",
        triggerSource: "system",
        leaseMs: 60_000,
      }),
    );

    const found = await t.run(async (ctx) =>
      findActiveJob(ctx, {
        kind: "system_design",
        scope: { type: "repository", id: repositoryId },
        now,
        predicate: (job) => job.triggerSource === "system",
        limit: 4,
      }),
    );

    expect(found?._id).toBe(systemTriggeredId);
  });

  test("thread scope queries via thread index (does not pick up repository-only jobs)", async () => {
    const t = createTestConvex();
    const { repositoryId, threadId } = await seedRepositoryAndThread(t);
    const now = Date.now();

    // Repository-only sandbox_activation job (no threadId).
    await t.run(async (ctx) =>
      enqueueJob(ctx, {
        kind: "sandbox_activation",
        repositoryId,
        ownerTokenIdentifier: BASE_OWNER,
        costCategory: "ops",
        triggerSource: "user",
        leaseMs: 60_000,
      }),
    );

    // Thread scope must NOT see it.
    const fromThreadScope = await t.run(async (ctx) =>
      findActiveJob(ctx, {
        kind: "sandbox_activation",
        scope: { type: "thread", id: threadId },
        now,
      }),
    );
    expect(fromThreadScope).toBeNull();

    // Repository scope must see it.
    const fromRepositoryScope = await t.run(async (ctx) =>
      findActiveJob(ctx, {
        kind: "sandbox_activation",
        scope: { type: "repository", id: repositoryId },
        now,
      }),
    );
    expect(fromRepositoryScope).not.toBeNull();
  });
});
