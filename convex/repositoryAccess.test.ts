/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import { hasRemoteUpdates } from "./lib/repositoryAccess";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function createTestConvex() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

async function seedRepositoryAccessFixture(
  t: ReturnType<typeof convexTest>,
  args: {
    ownerTokenIdentifier: string;
    deletionRequestedAt?: number;
  },
) {
  return await t.run(async (ctx) => {
    const repositoryId = await ctx.db.insert("repositories", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: "https://github.com/acme/access-fixture",
      sourceRepoFullName: "acme/access-fixture",
      sourceRepoOwner: "acme",
      sourceRepoName: "access-fixture",
      defaultBranch: "main",
      visibility: "private",
      accessMode: "private",
      importStatus: "completed",
      detectedLanguages: [],
      packageManagers: [],
      entrypoints: [],
      fileCount: 3,
      color: "blue",
      lastAccessedAt: Date.now(),
      ...(args.deletionRequestedAt !== undefined ? { deletionRequestedAt: args.deletionRequestedAt } : {}),
    });

    const threadId = await ctx.db.insert("threads", {
      repositoryId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      title: "Repository access fixture",
      mode: "library",
      lastMessageAt: Date.now(),
    });

    await ctx.db.insert("messages", {
      repositoryId,
      threadId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      role: "user",
      status: "completed",
      mode: "library",
      content: "Capture the architecture decision.",
    });

    const sandboxId = await ctx.db.insert("sandboxes", {
      repositoryId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      provider: "daytona",
      sourceAdapter: "git_clone",
      remoteId: "remote-access-fixture",
      status: "ready",
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

describe("repository access helpers", () => {
  test("owner can access an active repository", async () => {
    const ownerTokenIdentifier = "user|repo-access-owner";
    const t = createTestConvex();
    const { repositoryId } = await seedRepositoryAccessFixture(t, { ownerTokenIdentifier });

    const detail = await t
      .withIdentity({ tokenIdentifier: ownerTokenIdentifier })
      .query(api.repositories.getRepositoryDetail, { repositoryId });

    expect(detail).not.toBeNull();
    expect(detail!.repository._id).toBe(repositoryId);
    expect(detail!.isArchived).toBe(false);
  });

  test("non-owner sees a null repository detail (no thrown error)", async () => {
    const ownerTokenIdentifier = "user|repo-access-owner-only";
    const t = createTestConvex();
    const { repositoryId } = await seedRepositoryAccessFixture(t, { ownerTokenIdentifier });

    const detail = await t
      .withIdentity({ tokenIdentifier: "user|repo-access-stranger" })
      .query(api.repositories.getRepositoryDetail, { repositoryId });

    expect(detail).toBeNull();
  });

  test("owner sees a null repository detail after deletion is requested", async () => {
    const ownerTokenIdentifier = "user|repo-access-tombstone";
    const t = createTestConvex();
    const { repositoryId } = await seedRepositoryAccessFixture(t, {
      ownerTokenIdentifier,
      deletionRequestedAt: Date.now(),
    });

    const detail = await t
      .withIdentity({ tokenIdentifier: ownerTokenIdentifier })
      .query(api.repositories.getRepositoryDetail, { repositoryId });

    expect(detail).toBeNull();
  });

  test("repository-backed entry points reject tombstoned repositories", async () => {
    const ownerTokenIdentifier = "user|repo-access-entrypoints";
    const t = createTestConvex();
    const { repositoryId, threadId } = await seedRepositoryAccessFixture(t, {
      ownerTokenIdentifier,
      deletionRequestedAt: Date.now(),
    });
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await expect(
      viewer.mutation(api.chat.send.sendMessage, {
        threadId,
        content: "What should we inspect?",
        mode: "library",
      }),
    ).rejects.toThrow("Thread not found.");

    await expect(
      viewer.mutation(api.systemDesign.requestSystemDesignGeneration, {
        repositoryId,
        selections: ["architecture_overview"],
      }),
    ).rejects.toThrow("Repository not found.");

    await expect(
      viewer.mutation(api.designArtifacts.requestFailureModeAnalysis, {
        threadId,
        subsystem: "billing pipeline",
      }),
    ).rejects.toThrow("Repository not found.");

    await expect(viewer.mutation(api.designArtifacts.captureAdr, { threadId })).rejects.toThrow("Thread not found.");
  });
});

describe("hasRemoteUpdates", () => {
  test("returns false when both SHAs are unset", () => {
    expect(hasRemoteUpdates({})).toBe(false);
  });

  test("returns false when only latestRemoteSha is set", () => {
    expect(hasRemoteUpdates({ latestRemoteSha: "abc" })).toBe(false);
  });

  test("returns false when only lastSyncedCommitSha is set", () => {
    expect(hasRemoteUpdates({ lastSyncedCommitSha: "abc" })).toBe(false);
  });

  test("returns false when SHAs are equal", () => {
    expect(hasRemoteUpdates({ latestRemoteSha: "abc", lastSyncedCommitSha: "abc" })).toBe(false);
  });

  test("returns true when SHAs are both set and differ", () => {
    expect(hasRemoteUpdates({ latestRemoteSha: "abc", lastSyncedCommitSha: "def" })).toBe(true);
  });

  test("returns false for null/undefined repositories", () => {
    expect(hasRemoteUpdates(null)).toBe(false);
    expect(hasRemoteUpdates(undefined)).toBe(false);
  });
});
