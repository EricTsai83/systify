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

describe("repository detail metadata", () => {
  test("listResourceInventory returns active owned repositories with sync and sandbox state", async () => {
    const ownerTokenIdentifier = "user|resource-inventory";
    const otherTokenIdentifier = "user|resource-inventory-other";
    const t = createTestConvex();
    const now = Date.now();

    const { readyRepositoryId, syncRepositoryId, sandboxId } = await t.run(async (ctx) => {
      const readyRepositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/ready",
        sourceRepoFullName: "acme/ready",
        sourceRepoOwner: "acme",
        sourceRepoName: "ready",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 12,
        color: "blue",
        lastAccessedAt: now,
        lastImportedAt: now - 60_000,
        lastSyncedCommitSha: "abc123",
        latestRemoteSha: "def456",
      });
      const sandboxId = await ctx.db.insert("sandboxes", {
        repositoryId: readyRepositoryId,
        ownerTokenIdentifier,
        provider: "daytona",
        sourceAdapter: "git_clone",
        remoteId: "ready-remote",
        status: "ready",
        workDir: "/workspace",
        repoPath: "/workspace/ready",
        cpuLimit: 2,
        memoryLimitGiB: 4,
        diskLimitGiB: 10,
        ttlExpiresAt: now + 60 * 60_000,
        autoStopIntervalMinutes: 30,
        autoArchiveIntervalMinutes: 60,
        autoDeleteIntervalMinutes: 120,
        networkBlockAll: false,
      });
      await ctx.db.patch(readyRepositoryId, { latestSandboxId: sandboxId });

      const syncRepositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/syncing",
        sourceRepoFullName: "acme/syncing",
        sourceRepoOwner: "acme",
        sourceRepoName: "syncing",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "running",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 4,
        color: "emerald",
        lastAccessedAt: now,
        lastImportedAt: now - 120_000,
      });

      await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/archived",
        sourceRepoFullName: "acme/archived",
        sourceRepoOwner: "acme",
        sourceRepoName: "archived",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 1,
        color: "violet",
        lastAccessedAt: now,
        archivedAt: now,
      });

      await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/deleting",
        sourceRepoFullName: "acme/deleting",
        sourceRepoOwner: "acme",
        sourceRepoName: "deleting",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 1,
        color: "orange",
        lastAccessedAt: now,
        deletionRequestedAt: now,
      });

      await ctx.db.insert("repositories", {
        ownerTokenIdentifier: otherTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/other",
        sourceRepoFullName: "acme/other",
        sourceRepoOwner: "acme",
        sourceRepoName: "other",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 1,
        color: "teal",
        lastAccessedAt: now,
      });

      return { readyRepositoryId, syncRepositoryId, sandboxId };
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const inventory = await viewer.query(api.repositories.listResourceInventory, {});

    expect(inventory.map((row) => row.repositoryId)).toEqual([readyRepositoryId, syncRepositoryId]);
    expect(inventory.map((row) => row.fullName)).toEqual(["acme/ready", "acme/syncing"]);

    const ready = inventory.find((row) => row.repositoryId === readyRepositoryId);
    expect(ready).toMatchObject({
      importStatus: "completed",
      hasRemoteUpdates: true,
      sandboxModeStatus: { reasonCode: "available", message: null },
      sandbox: { status: "ready", ttlExpiresAt: now + 60 * 60_000 },
    });
    expect(ready?.sandbox).not.toBeNull();
    expect(ready?.sandbox?.status).toBe("ready");

    const syncing = inventory.find((row) => row.repositoryId === syncRepositoryId);
    expect(syncing).toMatchObject({
      importStatus: "running",
      hasRemoteUpdates: false,
      sandboxModeStatus: { reasonCode: "missing_sandbox" },
      sandbox: null,
    });
    expect(sandboxId).toBeTruthy();
  });

  test("list queries read only active repositories even when tombstones dominate the owner", async () => {
    const ownerTokenIdentifier = "user|active-list-index";
    const t = createTestConvex();
    const now = Date.now();

    const activeRepositoryId = await t.run(async (ctx) => {
      for (let index = 0; index < 120; index += 1) {
        await ctx.db.insert("repositories", {
          ownerTokenIdentifier,
          sourceHost: "github",
          sourceUrl: `https://github.com/acme/deleting-${index}`,
          sourceRepoFullName: `acme/deleting-${index}`,
          sourceRepoOwner: "acme",
          sourceRepoName: `deleting-${index}`,
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
          lastImportedAt: now + index,
          deletionRequestedAt: now + index,
        });
      }

      return await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/active-list-index",
        sourceRepoFullName: "acme/active-list-index",
        sourceRepoOwner: "acme",
        sourceRepoName: "active-list-index",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 1,
        color: "blue",
        lastAccessedAt: Date.now(),
        lastImportedAt: now - 1,
        lastSyncedCommitSha: "abc123",
        latestRemoteSha: "def456",
      });
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const repositories = await viewer.query(api.repositories.listRepositories, {});
    const summaries = await viewer.query(api.repositories.getImportedRepoSummaries, {});

    expect(repositories.map((repository) => repository._id)).toEqual([activeRepositoryId]);
    expect(Object.keys(summaries)).toEqual(["acme/active-list-index"]);
    expect(summaries["acme/active-list-index"]?.hasRemoteUpdates).toBe(true);
  });

  test("getRepositoryDetail reads denormalized file counts and caps oversized labels as 400+", async () => {
    const ownerTokenIdentifier = "user|repo-detail";
    const t = createTestConvex();

    const repositoryId = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/huge-repo",
        sourceRepoFullName: "acme/huge-repo",
        sourceRepoOwner: "acme",
        sourceRepoName: "huge-repo",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 401,
        color: "blue",
        lastAccessedAt: Date.now(),
      });

      return repositoryId;
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const detail = await viewer.query(api.repositories.getRepositoryDetail, { repositoryId });

    expect(detail).not.toBeNull();
    expect(detail!.fileCount).toBe(401);
    expect(detail!.fileCountLabel).toBe("400+");
  });

  test("syncRepository keeps the last completed snapshot until the new sync finishes", async () => {
    const ownerTokenIdentifier = "user|sync-pointer";
    const t = createTestConvex();
    const lastImportedAt = Date.now() - 60_000;

    const repositoryId = await t.run(async (ctx) => {
      await ctx.db.insert("userAccessProfiles", {
        ownerTokenIdentifier,
        email: "sync-pointer@example.com",
        plan: "internal",
        billingStatus: "none",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("githubInstallations", {
        ownerTokenIdentifier,
        installationId: 123,
        accountLogin: "acme",
        accountType: "User",
        status: "active",
        repositorySelection: "all",
        connectedAt: Date.now(),
      });

      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/sync-me",
        sourceRepoFullName: "acme/sync-me",
        sourceRepoOwner: "acme",
        sourceRepoName: "sync-me",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 12,
        color: "blue",
        lastAccessedAt: Date.now(),
        lastImportedAt,
        lastSyncedCommitSha: "abc123",
        latestRemoteSha: "def456",
      });

      const previousJobId = await ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "import",
        status: "completed",
        stage: "completed",
        progress: 1,
        costCategory: "indexing",
        triggerSource: "user",
      });

      const previousImportId = await ctx.db.insert("imports", {
        repositoryId,
        ownerTokenIdentifier,
        sourceUrl: "https://github.com/acme/sync-me",
        branch: "main",
        adapterKind: "git_clone",
        status: "completed",
        jobId: previousJobId,
      });

      await ctx.db.patch(repositoryId, {
        latestImportId: previousImportId,
        latestImportJobId: previousJobId,
      });

      return repositoryId;
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await viewer.mutation(api.repositories.syncRepository, { repositoryId });

    const repository = await t.run(async (ctx) => await ctx.db.get(repositoryId));
    expect(repository?.importStatus).toBe("queued");
    expect(repository?.lastImportedAt).toBe(lastImportedAt);
    expect(repository?.fileCount).toBe(12);
    expect(repository?.latestRemoteSha).toBeUndefined();
    expect(repository?.latestImportId).toBeDefined();
    expect(repository?.latestImportJobId).toBeDefined();
  });

  test("getRepositoryDetail caps artifacts to the most recent import-job rows", async () => {
    const ownerTokenIdentifier = "user|repo-detail-artifacts";
    const t = createTestConvex();

    const repositoryId = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/artifact-heavy",
        sourceRepoFullName: "acme/artifact-heavy",
        sourceRepoOwner: "acme",
        sourceRepoName: "artifact-heavy",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 24,
        color: "blue",
        lastAccessedAt: Date.now(),
      });

      const importJobId = await ctx.db.insert("jobs", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "import",
        status: "completed",
        stage: "completed",
        progress: 1,
        costCategory: "indexing",
        triggerSource: "user",
      });

      await ctx.db.patch(repositoryId, {
        latestImportJobId: importJobId,
      });

      // Seed 25 import-job artifacts so the take() cap is exercised.
      for (let index = 0; index < 25; index += 1) {
        await ctx.db.insert("artifacts", {
          repositoryId,
          ownerTokenIdentifier,
          jobId: importJobId,
          kind: "architecture_diagram",
          title: `import-artifact-${index}`,
          summary: `Import artifact ${index}`,
          contentMarkdown: "import content",
          version: 1,
        });
      }

      return repositoryId;
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const detail = await viewer.query(api.repositories.getRepositoryDetail, { repositoryId });

    expect(detail).not.toBeNull();
    expect(detail!.artifacts).toHaveLength(10);
    const uniqueArtifactIds = new Set(detail!.artifacts.map((artifact) => artifact._id));
    expect(uniqueArtifactIds.size).toBe(detail!.artifacts.length);
  });
});

describe("repository import guards", () => {
  test("createRepositoryImport stamps repository color/lastAccessedAt and creates the default thread", async () => {
    const ownerTokenIdentifier = "user|import-repository";
    const t = createTestConvex();
    await seedGithubInstallation(t, ownerTokenIdentifier);

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const result = await viewer.mutation(api.repositories.createRepositoryImport, {
      url: "https://github.com/acme/import-repository",
    });

    const state = await t.run(async (ctx) => {
      const repository = await ctx.db.get(result.repositoryId);
      const thread = result.defaultThreadId ? await ctx.db.get(result.defaultThreadId) : null;
      return { repository, thread };
    });

    expect(state.repository?.sourceRepoFullName).toBe("acme/import-repository");
    expect(state.repository?.color).toBeDefined();
    expect(state.repository?.lastAccessedAt).toBeDefined();
    expect(state.thread?.repositoryId).toBe(result.repositoryId);
  });

  test("completed repeated imports reuse the existing repository row", async () => {
    const ownerTokenIdentifier = "user|repeat-import-repository";
    const t = createTestConvex();
    await seedGithubInstallation(t, ownerTokenIdentifier);

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const first = await viewer.mutation(api.repositories.createRepositoryImport, {
      url: "https://github.com/acme/repeat-import-repository",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(first.repositoryId, { importStatus: "completed" });
    });

    const second = await viewer.mutation(api.repositories.createRepositoryImport, {
      url: "https://github.com/acme/repeat-import-repository",
    });

    expect(second.repositoryId).toBe(first.repositoryId);
  });

  test("archived repeated imports restore the repository row and reuse its default thread", async () => {
    const ownerTokenIdentifier = "user|repeat-archived-import";
    const t = createTestConvex();
    await seedGithubInstallation(t, ownerTokenIdentifier);
    const now = Date.now();

    const { repositoryId, threadId } = await t.run(async (ctx) => {
      const repositoryId = await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/archived-repeat",
        sourceRepoFullName: "acme/archived-repeat",
        sourceRepoOwner: "acme",
        sourceRepoName: "archived-repeat",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 1,
        color: "blue",
        lastAccessedAt: now - 10_000,
        archivedAt: now - 1_000,
      });
      const threadId = await ctx.db.insert("threads", {
        repositoryId,
        ownerTokenIdentifier,
        title: "Archived repeat chat",
        mode: "library",
        lastMessageAt: now - 5_000,
      });
      await ctx.db.patch(repositoryId, { defaultThreadId: threadId });

      return { repositoryId, threadId };
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const result = await viewer.mutation(api.repositories.createRepositoryImport, {
      url: "https://github.com/acme/archived-repeat",
    });

    const state = await t.run(async (ctx) => {
      const repository = await ctx.db.get(repositoryId);
      const threads = await ctx.db
        .query("threads")
        .withIndex("by_repositoryId_and_lastMessageAt", (q) => q.eq("repositoryId", repositoryId))
        .take(10);
      return { repository, threads };
    });

    expect(result.repositoryId).toBe(repositoryId);
    expect(result.defaultThreadId).toBe(threadId);
    expect(result.defaultThreadMode).toBe("library");
    expect(state.repository?.archivedAt).toBeUndefined();
    expect(state.repository?.importStatus).toBe("queued");
    expect(state.repository?.defaultThreadId).toBe(threadId);
    expect(state.threads.map((thread) => thread._id)).toEqual([threadId]);
  });

  test("createRepositoryImport rejects duplicate imports while one is already running", async () => {
    const ownerTokenIdentifier = "user|duplicate-import";
    const t = createTestConvex();

    await t.run(async (ctx) => {
      await ctx.db.insert("userAccessProfiles", {
        ownerTokenIdentifier,
        email: "duplicate-import@example.com",
        plan: "internal",
        billingStatus: "none",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("githubInstallations", {
        ownerTokenIdentifier,
        installationId: 456,
        accountLogin: "acme",
        accountType: "User",
        status: "active",
        repositorySelection: "all",
        connectedAt: Date.now(),
      });

      await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/duplicate",
        sourceRepoFullName: "acme/duplicate",
        sourceRepoOwner: "acme",
        sourceRepoName: "duplicate",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "running",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
        color: "blue",
        lastAccessedAt: Date.now(),
      });
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await expect(
      viewer.mutation(api.repositories.createRepositoryImport, {
        url: "https://github.com/acme/duplicate",
      }),
    ).rejects.toThrow("already in progress");
  });
});

async function seedGithubInstallation(t: ReturnType<typeof createTestConvex>, ownerTokenIdentifier: string) {
  await t.run(async (ctx) => {
    await ctx.db.insert("userAccessProfiles", {
      ownerTokenIdentifier,
      email: `${ownerTokenIdentifier}@example.com`,
      plan: "internal",
      billingStatus: "none",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
    await ctx.db.insert("githubInstallations", {
      ownerTokenIdentifier,
      installationId: 123,
      accountLogin: "acme",
      accountType: "User",
      status: "active",
      repositorySelection: "all",
      connectedAt: Date.now(),
    });
  });
}
