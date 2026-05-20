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

async function seedRepository(
  t: ReturnType<typeof convexTest>,
  args: {
    ownerTokenIdentifier: string;
    sourceRepoName?: string;
    archivedAt?: number;
    deletionRequestedAt?: number;
  },
) {
  return await t.run(async (ctx) => {
    const shortName = args.sourceRepoName ?? "archive-fixture";
    const repositoryId = await ctx.db.insert("repositories", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: `https://github.com/acme/${shortName}`,
      sourceRepoFullName: `acme/${shortName}`,
      sourceRepoOwner: "acme",
      sourceRepoName: shortName,
      defaultBranch: "main",
      visibility: "private",
      accessMode: "private",
      importStatus: "completed",
      detectedLanguages: [],
      packageManagers: [],
      entrypoints: [],
      fileCount: 1,
      ...(args.archivedAt !== undefined ? { archivedAt: args.archivedAt } : {}),
      ...(args.deletionRequestedAt !== undefined ? { deletionRequestedAt: args.deletionRequestedAt } : {}),
    });
    return repositoryId;
  });
}

describe("archiveRepository", () => {
  test("sets archivedAt and preserves child data", async () => {
    const ownerTokenIdentifier = "user|archive-owner";
    const t = createTestConvex();
    const repositoryId = await seedRepository(t, { ownerTokenIdentifier });

    const threadId = await t.run(async (ctx) => {
      const threadId = await ctx.db.insert("threads", {
        repositoryId,
        ownerTokenIdentifier,
        title: "Repo thread",
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
        content: "What's the architecture?",
      });
      return threadId;
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await viewer.mutation(api.repositories.archiveRepository, { repositoryId });

    const repo = await t.run((ctx) => ctx.db.get(repositoryId));
    expect(typeof repo?.archivedAt).toBe("number");

    // Thread + message survive the archive.
    const remainingThread = await t.run((ctx) => ctx.db.get(threadId));
    expect(remainingThread).not.toBeNull();
    const messages = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .collect(),
    );
    expect(messages.length).toBe(1);
  });

  test("is idempotent when called twice", async () => {
    const ownerTokenIdentifier = "user|archive-idempotent";
    const t = createTestConvex();
    const repositoryId = await seedRepository(t, { ownerTokenIdentifier });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await viewer.mutation(api.repositories.archiveRepository, { repositoryId });
    const firstStamp = (await t.run((ctx) => ctx.db.get(repositoryId)))?.archivedAt;

    await viewer.mutation(api.repositories.archiveRepository, { repositoryId });
    const secondStamp = (await t.run((ctx) => ctx.db.get(repositoryId)))?.archivedAt;

    expect(firstStamp).toBe(secondStamp);
  });

  test("rejects archive of a repository that is being permanently deleted", async () => {
    const ownerTokenIdentifier = "user|archive-after-delete";
    const t = createTestConvex();
    const repositoryId = await seedRepository(t, {
      ownerTokenIdentifier,
      deletionRequestedAt: Date.now(),
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await expect(viewer.mutation(api.repositories.archiveRepository, { repositoryId })).rejects.toThrow(
      /being deleted/i,
    );
  });
});

describe("restoreRepository", () => {
  test("clears archivedAt", async () => {
    const ownerTokenIdentifier = "user|restore-owner";
    const t = createTestConvex();
    const repositoryId = await seedRepository(t, {
      ownerTokenIdentifier,
      archivedAt: Date.now() - 10_000,
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await viewer.mutation(api.repositories.restoreRepository, { repositoryId });

    const repo = await t.run((ctx) => ctx.db.get(repositoryId));
    expect(repo?.archivedAt).toBeUndefined();
  });

  test("is idempotent when the repo is not archived", async () => {
    const ownerTokenIdentifier = "user|restore-idempotent";
    const t = createTestConvex();
    const repositoryId = await seedRepository(t, { ownerTokenIdentifier });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await expect(viewer.mutation(api.repositories.restoreRepository, { repositoryId })).resolves.toBeNull();
  });

  test("rejects restore of a repository that is being permanently deleted", async () => {
    const ownerTokenIdentifier = "user|restore-after-delete";
    const t = createTestConvex();
    const repositoryId = await seedRepository(t, {
      ownerTokenIdentifier,
      deletionRequestedAt: Date.now(),
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await expect(viewer.mutation(api.repositories.restoreRepository, { repositoryId })).rejects.toThrow(
      /being deleted/i,
    );
  });
});

describe("deleteRepository preconditions", () => {
  test("rejects permanent delete on an active repository (must archive first)", async () => {
    const ownerTokenIdentifier = "user|permanent-delete-active";
    const t = createTestConvex();
    const repositoryId = await seedRepository(t, { ownerTokenIdentifier });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await expect(viewer.mutation(api.repositories.deleteRepository, { repositoryId })).rejects.toThrow(
      /Archive the repository before deleting it permanently\./,
    );
  });

  test("permanent delete proceeds when repository is already archived", async () => {
    const ownerTokenIdentifier = "user|permanent-delete-archived";
    const t = createTestConvex();
    const repositoryId = await seedRepository(t, {
      ownerTokenIdentifier,
      archivedAt: Date.now() - 1000,
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await expect(viewer.mutation(api.repositories.deleteRepository, { repositoryId })).resolves.toBeNull();

    const repo = await t.run((ctx) => ctx.db.get(repositoryId));
    expect(typeof repo?.deletionRequestedAt).toBe("number");
  });
});

describe("repository listings honour archive state", () => {
  test("listRepositories excludes archived rows; listArchivedRepositories returns them", async () => {
    const ownerTokenIdentifier = "user|listing-archive";
    const t = createTestConvex();

    const activeId = await seedRepository(t, { ownerTokenIdentifier, sourceRepoName: "active" });
    const archivedId = await seedRepository(t, {
      ownerTokenIdentifier,
      sourceRepoName: "archived",
      archivedAt: Date.now(),
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const active = await viewer.query(api.repositories.listRepositories, {});
    const archived = await viewer.query(api.repositories.listArchivedRepositories, {
      paginationOpts: { numItems: 50, cursor: null },
    });

    expect(active.map((repo) => repo._id)).toEqual([activeId]);
    expect(archived.page.map((repo) => repo._id)).toEqual([archivedId]);
    expect(archived.isDone).toBe(true);
  });

  test("listArchivedRepositories paginates across cursors and stops on isDone", async () => {
    const ownerTokenIdentifier = "user|listing-archive-pagination";
    const t = createTestConvex();
    const baseTimestamp = Date.now();

    const archivedIds: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const repoId = await seedRepository(t, {
        ownerTokenIdentifier,
        sourceRepoName: `paged-${i}`,
        // Stagger archivedAt so order is deterministic; later index → newer.
        archivedAt: baseTimestamp + i,
      });
      archivedIds.push(repoId);
    }

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const firstPage = await viewer.query(api.repositories.listArchivedRepositories, {
      paginationOpts: { numItems: 2, cursor: null },
    });
    expect(firstPage.page).toHaveLength(2);
    expect(firstPage.isDone).toBe(false);
    // `archivedAt` desc → newest (index 4) first.
    expect(firstPage.page.map((repo) => repo._id)).toEqual([archivedIds[4], archivedIds[3]]);

    const secondPage = await viewer.query(api.repositories.listArchivedRepositories, {
      paginationOpts: { numItems: 2, cursor: firstPage.continueCursor },
    });
    expect(secondPage.page).toHaveLength(2);
    expect(secondPage.isDone).toBe(false);
    expect(secondPage.page.map((repo) => repo._id)).toEqual([archivedIds[2], archivedIds[1]]);

    const thirdPage = await viewer.query(api.repositories.listArchivedRepositories, {
      paginationOpts: { numItems: 2, cursor: secondPage.continueCursor },
    });
    expect(thirdPage.page).toHaveLength(1);
    expect(thirdPage.isDone).toBe(true);
    expect(thirdPage.page.map((repo) => repo._id)).toEqual([archivedIds[0]]);
  });

  // `convex-test` splits the search field on whitespace and prefix-matches,
  // so `acme/frontend-app` reads as one token starting with `acme/`. Tests
  // therefore search with a token-prefix like `acme/frontend`; production
  // Convex tokenises on punctuation and would also accept `frontend` alone.
  test("listArchivedRepositories search returns matching archived repos and excludes active ones", async () => {
    const ownerTokenIdentifier = "user|listing-archive-search";
    const t = createTestConvex();

    const matchingArchivedId = await seedRepository(t, {
      ownerTokenIdentifier,
      sourceRepoName: "frontend-app",
      archivedAt: Date.now(),
    });
    await seedRepository(t, {
      ownerTokenIdentifier,
      sourceRepoName: "backend-service",
      archivedAt: Date.now(),
    });
    // Active row whose name also prefix-matches — must NOT leak through search.
    await seedRepository(t, { ownerTokenIdentifier, sourceRepoName: "frontend-toolkit" });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const result = await viewer.query(api.repositories.listArchivedRepositories, {
      paginationOpts: { numItems: 20, cursor: null },
      searchTerm: "acme/frontend-app",
    });

    expect(result.page.map((repo) => repo._id)).toEqual([matchingArchivedId]);
  });

  test("listArchivedRepositories search excludes pending-deletion repos", async () => {
    const ownerTokenIdentifier = "user|listing-archive-search-pending";
    const t = createTestConvex();

    await seedRepository(t, {
      ownerTokenIdentifier,
      sourceRepoName: "queued-for-delete",
      archivedAt: Date.now(),
      deletionRequestedAt: Date.now(),
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const result = await viewer.query(api.repositories.listArchivedRepositories, {
      paginationOpts: { numItems: 20, cursor: null },
      searchTerm: "acme/queued",
    });

    expect(result.page).toHaveLength(0);
  });

  test("listArchivedRepositories search isolates results to the calling user", async () => {
    const ownerA = "user|listing-archive-search-isolation-a";
    const ownerB = "user|listing-archive-search-isolation-b";
    const t = createTestConvex();

    // Two archived repos with the same name across two different users —
    // verifies the `ownerTokenIdentifier` filter on the search index keeps
    // them tenant-isolated.
    const archivedAId = await seedRepository(t, {
      ownerTokenIdentifier: ownerA,
      sourceRepoName: "shared-name",
      archivedAt: Date.now(),
    });
    await seedRepository(t, {
      ownerTokenIdentifier: ownerB,
      sourceRepoName: "shared-name",
      archivedAt: Date.now(),
    });

    const viewerA = t.withIdentity({ tokenIdentifier: ownerA });
    const result = await viewerA.query(api.repositories.listArchivedRepositories, {
      paginationOpts: { numItems: 20, cursor: null },
      searchTerm: "acme/shared",
    });

    expect(result.page.map((repo) => repo._id)).toEqual([archivedAId]);
  });

  test("getImportedRepoSummaries excludes archived repos", async () => {
    const ownerTokenIdentifier = "user|summaries-archive";
    const t = createTestConvex();

    await seedRepository(t, { ownerTokenIdentifier, sourceRepoName: "summaries-active" });
    await seedRepository(t, {
      ownerTokenIdentifier,
      sourceRepoName: "summaries-archived",
      archivedAt: Date.now(),
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const summaries = await viewer.query(api.repositories.getImportedRepoSummaries, {});

    expect(Object.keys(summaries).sort()).toEqual(["acme/summaries-active"]);
  });
});

describe("getRepositoryDetail behaviour with archived repos", () => {
  test("returns the archived repository with isArchived=true", async () => {
    const ownerTokenIdentifier = "user|detail-archived";
    const t = createTestConvex();
    const archivedAt = Date.now();
    const repositoryId = await seedRepository(t, { ownerTokenIdentifier, archivedAt });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const detail = await viewer.query(api.repositories.getRepositoryDetail, { repositoryId });

    expect(detail).not.toBeNull();
    expect(detail!.isArchived).toBe(true);
    expect(detail!.archivedAt).toBe(archivedAt);
  });
});

describe("write paths reject archived repositories with a clear message", () => {
  test("requestSystemDesignGeneration on an archived repo throws the archived message", async () => {
    const ownerTokenIdentifier = "user|system-design-archived";
    const t = createTestConvex();
    const repositoryId = await seedRepository(t, {
      ownerTokenIdentifier,
      archivedAt: Date.now(),
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await expect(
      viewer.mutation(api.systemDesign.requestSystemDesignGeneration, {
        repositoryId,
        selections: ["architecture_overview"],
      }),
    ).rejects.toThrow(/archived/i);
  });
});
