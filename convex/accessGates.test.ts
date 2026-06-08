/// <reference types="vite/client" />

import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

function createTestConvex() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

async function seedAccessProfile(t: ReturnType<typeof createTestConvex>, ownerTokenIdentifier: string) {
  await t.run(async (ctx) => {
    await ctx.db.insert("userAccessProfiles", {
      ownerTokenIdentifier,
      email: `${ownerTokenIdentifier}@example.com`,
      plan: "free",
      billingStatus: "none",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function seedGitHubInstallation(t: ReturnType<typeof createTestConvex>, ownerTokenIdentifier: string) {
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

async function seedRepository(t: ReturnType<typeof createTestConvex>, ownerTokenIdentifier: string) {
  await seedAccessProfile(t, ownerTokenIdentifier);
  return await t.run(async (ctx) => {
    return await ctx.db.insert("repositories", {
      ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: "https://github.com/acme/access-gate",
      sourceRepoFullName: "acme/access-gate",
      sourceRepoOwner: "acme",
      sourceRepoName: "access-gate",
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
      lastSyncedCommitSha: "local-sha",
    });
  });
}

async function seedArtifact(
  t: ReturnType<typeof createTestConvex>,
  ownerTokenIdentifier: string,
  repositoryId: Id<"repositories">,
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("artifacts", {
      ownerTokenIdentifier,
      repositoryId,
      kind: "readme_summary",
      title: "README Summary",
      summary: "Summary",
      contentMarkdown: "# Summary\n\nThis is indexed content.",
      version: 1,
    });
  });
}

async function expectFeatureBlocked(operation: Promise<unknown>) {
  await expect(operation).rejects.toThrow(/FEATURE_NOT_INCLUDED/);
}

async function expectNotFeatureBlocked(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    expect(String(error)).not.toMatch(/FEATURE_NOT_INCLUDED/);
  }
}

describe("free plan backend access gates", () => {
  test("blocks direct chat send before creating thread, messages, or jobs", async () => {
    const ownerTokenIdentifier = "user|free-chat-send";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await expectFeatureBlocked(
      viewer.mutation(api.chat.send.sendMessageStartingNewThread, {
        content: "Hello",
        mode: "discuss",
      }),
    );

    const rows = await t.run(async (ctx) => {
      const threads = (await ctx.db.query("threads").collect()).filter(
        (thread) => thread.ownerTokenIdentifier === ownerTokenIdentifier,
      );
      const jobs = (await ctx.db.query("jobs").collect()).filter(
        (job) => job.ownerTokenIdentifier === ownerTokenIdentifier && job.kind === "chat",
      );
      return { threads, jobs };
    });
    expect(rows.threads).toHaveLength(0);
    expect(rows.jobs).toHaveLength(0);
  });

  test("blocks direct Library Ask send", async () => {
    const ownerTokenIdentifier = "user|free-library-ask";
    const t = createTestConvex();
    const repositoryId = await seedRepository(t, ownerTokenIdentifier);
    const artifactId = await seedArtifact(t, ownerTokenIdentifier, repositoryId);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await expectFeatureBlocked(
      viewer.mutation(api.chat.send.sendMessageStartingNewThread, {
        repositoryId,
        content: "Summarize the library.",
        mode: "library",
        artifactContext: [artifactId],
      }),
    );
  });

  test("blocks system design generation before enqueueing a job", async () => {
    const ownerTokenIdentifier = "user|free-system-design";
    const t = createTestConvex();
    const repositoryId = await seedRepository(t, ownerTokenIdentifier);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await expectFeatureBlocked(
      viewer.mutation(api.systemDesign.requestSystemDesignGeneration, {
        repositoryId,
        selections: ["readme_summary"],
      }),
    );

    const jobs = await t.run(async (ctx) =>
      ctx.db
        .query("jobs")
        .withIndex("by_repositoryId_and_kind", (q) => q.eq("repositoryId", repositoryId).eq("kind", "system_design"))
        .take(1),
    );
    expect(jobs).toHaveLength(0);
  });

  test("allows repository import and sync to queue import work", async () => {
    const ownerTokenIdentifier = "user|free-import-sync";
    const t = createTestConvex();
    const repositoryId = await seedRepository(t, ownerTokenIdentifier);
    await seedGitHubInstallation(t, ownerTokenIdentifier);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await viewer.mutation(api.repositories.createRepositoryImport, {
      url: "https://github.com/acme/new-repo",
    });
    await viewer.mutation(api.repositories.syncRepository, { repositoryId });

    const rows = await t.run(async (ctx) => {
      const jobs = (await ctx.db.query("jobs").collect()).filter(
        (job) => job.ownerTokenIdentifier === ownerTokenIdentifier && job.kind === "import",
      );
      const importedRepositories = (await ctx.db.query("repositories").collect()).filter(
        (repository) =>
          repository.ownerTokenIdentifier === ownerTokenIdentifier &&
          repository.sourceUrl === "https://github.com/acme/new-repo",
      );
      return { jobs, importedRepositories };
    });
    expect(rows.jobs).toHaveLength(2);
    expect(rows.importedRepositories).toHaveLength(1);
  });

  test("allows GitHub import helper actions through the entitlement gate", async () => {
    const ownerTokenIdentifier = "user|free-github-import-helpers";
    const t = createTestConvex();
    await seedAccessProfile(t, ownerTokenIdentifier);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubEnv("GITHUB_APP_SLUG", "systify-test");
    vi.stubEnv("GITHUB_APP_CLIENT_ID", "client-id");
    vi.stubEnv("GITHUB_APP_CLIENT_SECRET", "client-secret");
    vi.stubEnv("ALLOWED_RETURN_TO_ORIGINS", "https://systify.example");

    const installUrl = await viewer.action(api.githubAppNode.initiateGitHubInstall, {
      returnTo: "https://systify.example/chat",
    });
    await expect(viewer.action(api.githubAppNode.listInstallationRepos, {})).resolves.toMatchObject({
      repos: [],
      totalCount: 0,
      hasMore: false,
    });
    await expect(viewer.action(api.githubAppNode.searchGitHubRepos, { query: "acme" })).resolves.toMatchObject({
      repos: [],
      totalCount: 0,
    });
    await expectNotFeatureBlocked(
      viewer.action(api.githubAppNode.verifyRepoAccess, {
        url: "https://github.com/acme/private-repo",
      }),
    );

    const oauthStates = await t.run(async (ctx) => await ctx.db.query("githubOAuthStates").take(1));
    expect(installUrl).toContain("https://github.com/apps/systify-test/installations/new?state=");
    expect(oauthStates).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("allows update checks through the entitlement gate", async () => {
    const ownerTokenIdentifier = "user|free-check-updates";
    const t = createTestConvex();
    const repositoryId = await seedRepository(t, ownerTokenIdentifier);
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ object: { sha: "remote-sha" } }),
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      t.withIdentity({ tokenIdentifier: ownerTokenIdentifier }).action(api.githubCheck.checkForUpdates, {
        repositoryId,
      }),
    ).resolves.toBeNull();

    const repository = await t.run(async (ctx) => await ctx.db.get(repositoryId));
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(repository?.lastCheckedForUpdatesAt).toBeGreaterThan(0);
    expect(repository?.latestRemoteSha).toBe("remote-sha");
  });

  test("blocks sandbox session start before creating a session", async () => {
    const ownerTokenIdentifier = "user|free-sandbox-session";
    const t = createTestConvex();
    const repositoryId = await seedRepository(t, ownerTokenIdentifier);

    await expectFeatureBlocked(
      t.withIdentity({ tokenIdentifier: ownerTokenIdentifier }).mutation(api.sandboxSessions.startSandboxSession, {
        repositoryId,
      }),
    );

    const sessions = await t.run(async (ctx) =>
      ctx.db
        .query("sandboxSessions")
        .withIndex("by_repositoryId_and_startedAt", (q) => q.eq("repositoryId", repositoryId))
        .take(1),
    );
    expect(sessions).toHaveLength(0);
  });

  test("blocks artifact indexing before chunk or embedding work", async () => {
    const ownerTokenIdentifier = "user|free-artifact-indexing";
    const t = createTestConvex();
    const repositoryId = await seedRepository(t, ownerTokenIdentifier);
    const artifactId = await seedArtifact(t, ownerTokenIdentifier, repositoryId);

    await expectFeatureBlocked(t.action(internal.artifactIndexing.reindexArtifact, { artifactId }));

    const state = await t.run(async (ctx) => {
      const artifact = await ctx.db.get(artifactId);
      const chunks = await ctx.db
        .query("artifactChunks")
        .withIndex("by_artifactId_and_chunkIndex", (q) => q.eq("artifactId", artifactId))
        .take(1);
      return { artifact, chunks };
    });
    expect(state.artifact?.chunkingStatus).toBeUndefined();
    expect(state.chunks).toHaveLength(0);
  });

  test("marks retry artifact indexing failures as non-retryable when the feature is blocked", async () => {
    const ownerTokenIdentifier = "user|free-artifact-indexing-retry";
    const t = createTestConvex();
    const repositoryId = await seedRepository(t, ownerTokenIdentifier);
    const artifactId = await seedArtifact(t, ownerTokenIdentifier, repositoryId);

    await t.run(async (ctx) => {
      await ctx.db.patch(artifactId, {
        chunkingStatus: "failed",
        chunkingFailureReason: "embedding_failed",
        lastChunkedAt: 0,
        lastChunkedVersion: 1,
      });
    });

    const result = await t.action(internal.artifactIndexing.retryFailedArtifactIndexing, {});

    const state = await t.run(async (ctx) => {
      const artifact = await ctx.db.get(artifactId);
      const chunks = await ctx.db
        .query("artifactChunks")
        .withIndex("by_artifactId_and_chunkIndex", (q) => q.eq("artifactId", artifactId))
        .take(1);
      return { artifact, chunks };
    });
    expect(result.scheduled).toBe(1);
    expect(state.artifact?.chunkingStatus).toBe("failed");
    expect(state.artifact?.chunkingFailureReason).toBe("feature_not_included");
    expect(state.chunks).toHaveLength(0);
  });
});
