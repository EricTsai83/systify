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
    sourceRepoFullName?: string;
    archivedAt?: number;
    deletionRequestedAt?: number;
  },
) {
  return await t.run(async (ctx) => {
    const repositoryId = await ctx.db.insert("repositories", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: `https://github.com/acme/${args.sourceRepoFullName ?? "archive-fixture"}`,
      sourceRepoFullName: `acme/${args.sourceRepoFullName ?? "archive-fixture"}`,
      sourceRepoOwner: "acme",
      sourceRepoName: args.sourceRepoFullName ?? "archive-fixture",
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

    const activeId = await seedRepository(t, { ownerTokenIdentifier, sourceRepoFullName: "active" });
    const archivedId = await seedRepository(t, {
      ownerTokenIdentifier,
      sourceRepoFullName: "archived",
      archivedAt: Date.now(),
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const active = await viewer.query(api.repositories.listRepositories, {});
    const archived = await viewer.query(api.repositories.listArchivedRepositories, {});

    expect(active.map((repo) => repo._id)).toEqual([activeId]);
    expect(archived.map((repo) => repo._id)).toEqual([archivedId]);
  });

  test("getImportedRepoSummaries excludes archived repos", async () => {
    const ownerTokenIdentifier = "user|summaries-archive";
    const t = createTestConvex();

    await seedRepository(t, { ownerTokenIdentifier, sourceRepoFullName: "summaries-active" });
    await seedRepository(t, {
      ownerTokenIdentifier,
      sourceRepoFullName: "summaries-archived",
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
  test("requestDeepAnalysis on an archived repo throws the archived message", async () => {
    const ownerTokenIdentifier = "user|deep-analysis-archived";
    const t = createTestConvex();
    const repositoryId = await seedRepository(t, {
      ownerTokenIdentifier,
      archivedAt: Date.now(),
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await expect(
      viewer.mutation(api.analysis.requestDeepAnalysis, { repositoryId, prompt: "summarize" }),
    ).rejects.toThrow(/archived/i);
  });
});
