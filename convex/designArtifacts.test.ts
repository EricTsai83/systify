/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
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

async function seedThreadWithRepository(
  t: ReturnType<typeof convexTest>,
  ownerTokenIdentifier: string,
  sandboxStatus: "provisioning" | "ready" | "stopped" | "archived" | "failed",
) {
  return await t.run(async (ctx) => {
    const repositoryId = await ctx.db.insert("repositories", {
      ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: "https://github.com/acme/design-artifacts",
      sourceRepoFullName: "acme/design-artifacts",
      sourceRepoOwner: "acme",
      sourceRepoName: "design-artifacts",
      defaultBranch: "main",
      visibility: "private",
      accessMode: "private",
      importStatus: "completed",
      detectedLanguages: [],
      packageManagers: [],
      entrypoints: [],
      fileCount: 0,
    });

    const threadId = await ctx.db.insert("threads", {
      repositoryId,
      ownerTokenIdentifier,
      title: "Design thread",
      mode: "docs",
      lastMessageAt: Date.now(),
    });

    await ctx.db.insert("messages", {
      repositoryId,
      threadId,
      ownerTokenIdentifier,
      role: "user",
      status: "completed",
      mode: "docs",
      content: "We should isolate write paths behind a service boundary.",
    });
    await ctx.db.insert("messages", {
      repositoryId,
      threadId,
      ownerTokenIdentifier,
      role: "assistant",
      status: "completed",
      mode: "docs",
      content: "Adopt a dedicated write service and keep reads in existing handlers.",
    });

    const sandboxId = await ctx.db.insert("sandboxes", {
      repositoryId,
      ownerTokenIdentifier,
      provider: "daytona",
      sourceAdapter: "git_clone",
      remoteId: `remote-${sandboxStatus}`,
      status: sandboxStatus,
      workDir: "/workspace",
      repoPath: "/workspace/repo",
      cpuLimit: 2,
      memoryLimitGiB: 4,
      diskLimitGiB: 10,
      ttlExpiresAt: Date.now() + 60 * 60_000,
      autoStopIntervalMinutes: 30,
      autoArchiveIntervalMinutes: 60,
      autoDeleteIntervalMinutes: 120,
      networkBlockAll: false,
    });
    await ctx.db.patch(repositoryId, { latestSandboxId: sandboxId });

    return { repositoryId, threadId };
  });
}

describe("design artifacts phase 4", () => {
  test("captureAdr stores a structured ADR artifact on the thread", async () => {
    const ownerTokenIdentifier = "user|phase4-adr";
    const t = createTestConvex();
    const { threadId } = await seedThreadWithRepository(t, ownerTokenIdentifier, "ready");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const result = await viewer.mutation(api.designArtifacts.captureAdr, { threadId });

    const artifact = await t.run(async (ctx) => await ctx.db.get(result.artifactId as Id<"artifacts">));
    expect(artifact?.kind).toBe("adr");
    expect(artifact?.threadId).toBe(threadId);
    expect(artifact?.contentMarkdown).toContain("## Context");
    expect(artifact?.contentMarkdown).toContain("## Decision");
    expect(artifact?.contentMarkdown).toContain("## Consequences");
    expect(artifact?.contentMarkdown).toContain("## Alternatives");
  });

  test("requestFailureModeAnalysis rejects when sandbox is not ready", async () => {
    const ownerTokenIdentifier = "user|phase4-fma-reject";
    const t = createTestConvex();
    const { threadId, repositoryId } = await seedThreadWithRepository(t, ownerTokenIdentifier, "provisioning");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await expect(
      viewer.mutation(api.designArtifacts.requestFailureModeAnalysis, {
        threadId,
        subsystem: "billing pipeline",
      }),
    ).rejects.toThrow("sandbox is still provisioning");

    const jobs = await t.run(
      async (ctx) =>
        await ctx.db
          .query("jobs")
          .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
          .take(10),
    );
    expect(jobs).toHaveLength(0);
  });

  test("requestFailureModeAnalysis queues a deep-analysis job for the thread", async () => {
    const ownerTokenIdentifier = "user|phase4-fma-queue";
    const t = createTestConvex();
    const { threadId, repositoryId } = await seedThreadWithRepository(t, ownerTokenIdentifier, "ready");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const { jobId } = await viewer.mutation(api.designArtifacts.requestFailureModeAnalysis, {
      threadId,
      subsystem: "billing pipeline",
    });

    const job = await t.run(async (ctx) => await ctx.db.get(jobId));
    expect(job?.repositoryId).toBe(repositoryId);
    expect(job?.threadId).toBe(threadId);
    expect(job?.kind).toBe("system_design");
    expect(job?.status).toBe("queued");
    expect(job?.requestedCommand).toBe("failure_mode_analysis:billing pipeline");
  });
});
