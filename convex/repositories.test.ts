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

describe("repository detail metadata", () => {
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
      });

      return repositoryId;
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const detail = await viewer.query(api.repositories.getRepositoryDetail, { repositoryId });

    expect(detail.fileCount).toBe(401);
    expect(detail.fileCountLabel).toBe("400+");
  });

  test("syncRepository keeps the last completed snapshot until the new sync finishes", async () => {
    const ownerTokenIdentifier = "user|sync-pointer";
    const t = createTestConvex();
    const lastImportedAt = Date.now() - 60_000;

    const repositoryId = await t.run(async (ctx) => {
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

  test("getRepositoryDetail limits artifacts to 20 without thread fan-out lookups", async () => {
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

      for (let index = 0; index < 10; index += 1) {
        await ctx.db.insert("artifacts", {
          repositoryId,
          ownerTokenIdentifier,
          jobId: importJobId,
          kind: "manifest",
          title: `import-artifact-${index}`,
          summary: `Import artifact ${index}`,
          contentMarkdown: "import content",
          source: "heuristic",
          version: 1,
        });
      }

      for (let index = 0; index < 40; index += 1) {
        await ctx.db.insert("artifacts", {
          repositoryId,
          ownerTokenIdentifier,
          kind: "deep_analysis",
          title: `deep-artifact-${index}`,
          summary: `Deep artifact ${index}`,
          contentMarkdown: "deep content",
          source: "llm",
          version: 1,
        });
      }

      return repositoryId;
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const detail = await viewer.query(api.repositories.getRepositoryDetail, { repositoryId });

    expect(detail.artifacts).toHaveLength(20);
    const uniqueArtifactIds = new Set(detail.artifacts.map((artifact) => artifact._id));
    expect(uniqueArtifactIds.size).toBe(detail.artifacts.length);
  });
});

describe("repository import guards", () => {
  test("createRepositoryImport creates a repo workspace and assigns the default thread to it", async () => {
    const ownerTokenIdentifier = "user|import-workspace";
    const t = createTestConvex();
    await seedGithubInstallation(t, ownerTokenIdentifier);

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const result = await viewer.mutation(api.repositories.createRepositoryImport, {
      url: "https://github.com/acme/import-workspace",
    });

    const state = await t.run(async (ctx) => {
      const workspace = await ctx.db.get(result.workspaceId);
      const thread = result.defaultThreadId ? await ctx.db.get(result.defaultThreadId) : null;
      const workspaces = await ctx.db
        .query("workspaces")
        .withIndex("by_ownerTokenIdentifier_and_repositoryId", (q) =>
          q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("repositoryId", result.repositoryId),
        )
        .take(10);

      return { workspace, thread, workspaces };
    });

    expect(state.workspace?.name).toBe("acme/import-workspace");
    expect(state.workspace?.repositoryId).toBe(result.repositoryId);
    expect(state.thread?.workspaceId).toBe(result.workspaceId);
    expect(state.thread?.repositoryId).toBe(result.repositoryId);
    expect(state.workspaces).toHaveLength(1);
  });

  test("completed repeated imports reuse the repo workspace", async () => {
    const ownerTokenIdentifier = "user|repeat-import-workspace";
    const t = createTestConvex();
    await seedGithubInstallation(t, ownerTokenIdentifier);

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const first = await viewer.mutation(api.repositories.createRepositoryImport, {
      url: "https://github.com/acme/repeat-import-workspace",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(first.repositoryId, { importStatus: "completed" });
    });

    const second = await viewer.mutation(api.repositories.createRepositoryImport, {
      url: "https://github.com/acme/repeat-import-workspace",
    });
    const workspaceCount = await countRepositoryWorkspaces(t, ownerTokenIdentifier, first.repositoryId);

    expect(second.repositoryId).toBe(first.repositoryId);
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(workspaceCount).toBe(1);
  });

  test("createRepositoryImport rejects duplicate imports while one is already running", async () => {
    const ownerTokenIdentifier = "user|duplicate-import";
    const t = createTestConvex();

    await t.run(async (ctx) => {
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

async function countRepositoryWorkspaces(
  t: ReturnType<typeof createTestConvex>,
  ownerTokenIdentifier: string,
  repositoryId: Id<"repositories">,
) {
  return await t.run(async (ctx) => {
    const workspaces = await ctx.db
      .query("workspaces")
      .withIndex("by_ownerTokenIdentifier_and_repositoryId", (q) =>
        q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("repositoryId", repositoryId),
      )
      .take(10);
    return workspaces.length;
  });
}
