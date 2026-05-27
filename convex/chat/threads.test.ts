/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { register as registerRateLimiter } from "@convex-dev/rate-limiter/test";
import { convexTest } from "convex-test";
import { api } from "../_generated/api";
import schema from "../schema";

// Resolve sibling Convex modules relative to the convex/ root rather than
// relative to this test file's directory. Without this, convex-test's
// resolver — which looks up modules by their `convex/`-relative path
// (e.g. `chat/threads`) — fails to match the `../` prefix that an
// `import.meta.glob("../**/*.ts")` would produce from a nested test file.
const modules = import.meta.glob("/convex/**/*.ts");

function createTestConvex() {
  const t = convexTest(schema, modules);
  registerRateLimiter(t);
  return t;
}

async function insertRepository(t: ReturnType<typeof createTestConvex>, ownerTokenIdentifier: string, slug: string) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("repositories", {
      ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: `https://github.com/acme/${slug}`,
      sourceRepoFullName: `acme/${slug}`,
      sourceRepoOwner: "acme",
      sourceRepoName: slug,
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
    });
  });
}

describe("createThread", () => {
  test("repoless library mode is rejected — library requires an attached repository", async () => {
    const ownerTokenIdentifier = "user|create-thread-repoless-library";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await expect(viewer.mutation(api.chat.threads.createThread, { mode: "library" })).rejects.toThrow(
      /library.*requires an attached repository/i,
    );
  });

  test("repoless discuss thread is allowed and defaults to discuss mode", async () => {
    const ownerTokenIdentifier = "user|create-thread-repoless-discuss";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const result = await viewer.mutation(api.chat.threads.createThread, {});
    expect(result.mode).toBe("discuss");
  });

  test("attached repo defaults the thread to library mode", async () => {
    const ownerTokenIdentifier = "user|create-thread-with-repo";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier, "with-repo");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const result = await viewer.mutation(api.chat.threads.createThread, { repositoryId });
    expect(result.mode).toBe("library");
  });
});

describe("setThreadRepository", () => {
  test("attach: repoless thread → repo flips the mode to the repo default (library)", async () => {
    const ownerTokenIdentifier = "user|set-thread-repo-attach";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier, "attach");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const { _id: threadId, mode: initialMode } = await viewer.mutation(api.chat.threads.createThread, {});
    expect(initialMode).toBe("discuss");

    const result = await viewer.mutation(api.chat.threads.setThreadRepository, {
      threadId,
      repositoryId,
    });
    expect(result.repositoryId).toBe(repositoryId);
    expect(result.mode).toBe("library");
    expect(result).not.toHaveProperty("swappedFromRepositoryId");

    const stored = await t.run((ctx) => ctx.db.get(threadId));
    expect(stored?.repositoryId).toBe(repositoryId);
    expect(stored?.mode).toBe("library");
  });

  test("swap: repo-A → repo-B preserves the user's chosen mode and reports swappedFromRepositoryId", async () => {
    const ownerTokenIdentifier = "user|set-thread-repo-swap";
    const t = createTestConvex();
    const repoA = await insertRepository(t, ownerTokenIdentifier, "swap-a");
    const repoB = await insertRepository(t, ownerTokenIdentifier, "swap-b");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    // Start with repo-A bound (mode defaults to library), then flip to discuss to
    // make sure the swap preserves the user-chosen mode rather than re-applying
    // the repo default.
    const { _id: threadId } = await viewer.mutation(api.chat.threads.createThread, {
      repositoryId: repoA,
      mode: "discuss",
    });

    const swapResult = await viewer.mutation(api.chat.threads.setThreadRepository, {
      threadId,
      repositoryId: repoB,
    });
    expect(swapResult.repositoryId).toBe(repoB);
    expect(swapResult.mode).toBe("discuss");
    // Narrow the discriminated union — `swappedFromRepositoryId` only
    // appears on the attached variant.
    if (swapResult.repositoryId === null) {
      throw new Error("swap mutation should return the new repositoryId");
    }
    expect(swapResult.swappedFromRepositoryId).toBe(repoA);
  });

  test("detach: repo → null resets mode to discuss and clears grounding defaults", async () => {
    const ownerTokenIdentifier = "user|set-thread-repo-detach";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier, "detach");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const { _id: threadId } = await viewer.mutation(api.chat.threads.createThread, {
      repositoryId,
      mode: "discuss",
    });
    // Seed grounding defaults so the detach reset is observable.
    await t.run(async (ctx) => {
      await ctx.db.patch(threadId, {
        defaultGroundLibrary: true,
        defaultGroundSandbox: true,
      });
    });

    const result = await viewer.mutation(api.chat.threads.setThreadRepository, {
      threadId,
      repositoryId: null,
    });
    expect(result.repositoryId).toBeNull();
    expect(result.mode).toBe("discuss");

    const stored = await t.run((ctx) => ctx.db.get(threadId));
    expect(stored?.repositoryId).toBeUndefined();
    expect(stored?.mode).toBe("discuss");
    expect(stored?.defaultGroundLibrary).toBe(false);
    expect(stored?.defaultGroundSandbox).toBe(false);
  });

  test("non-owner cannot mutate someone else's thread", async () => {
    const ownerTokenIdentifier = "user|set-thread-repo-owner";
    const intruderTokenIdentifier = "user|set-thread-repo-intruder";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier, "owner-thread");
    const owner = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const intruder = t.withIdentity({ tokenIdentifier: intruderTokenIdentifier });

    const { _id: threadId } = await owner.mutation(api.chat.threads.createThread, {});

    await expect(intruder.mutation(api.chat.threads.setThreadRepository, { threadId, repositoryId })).rejects.toThrow(
      /thread not found/i,
    );
  });

  test("attaching a repository the viewer doesn't own surfaces as Repository not found", async () => {
    const ownerTokenIdentifier = "user|set-thread-repo-foreign";
    const otherTokenIdentifier = "user|set-thread-repo-foreign-other";
    const t = createTestConvex();
    const foreignRepositoryId = await insertRepository(t, otherTokenIdentifier, "foreign");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const { _id: threadId } = await viewer.mutation(api.chat.threads.createThread, {});

    await expect(
      viewer.mutation(api.chat.threads.setThreadRepository, {
        threadId,
        repositoryId: foreignRepositoryId,
      }),
    ).rejects.toThrow(/repository not found/i);
  });
});

describe("listRepolessThreads", () => {
  test("empty viewer returns no threads", async () => {
    const ownerTokenIdentifier = "user|list-repoless-empty";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const result = await viewer.query(api.chat.threads.listRepolessThreads, {});
    expect(result).toEqual([]);
  });

  test("orders by lastMessageAt desc and excludes repo-bound threads", async () => {
    const ownerTokenIdentifier = "user|list-repoless-ordering";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier, "list-repoless");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    // One repo-bound thread (should be excluded) plus three repoless threads
    // with explicit lastMessageAt so the recency ordering is unambiguous.
    await viewer.mutation(api.chat.threads.createThread, { repositoryId });
    const { _id: olderThreadId } = await viewer.mutation(api.chat.threads.createThread, {});
    const { _id: middleThreadId } = await viewer.mutation(api.chat.threads.createThread, {});
    const { _id: newestThreadId } = await viewer.mutation(api.chat.threads.createThread, {});

    await t.run(async (ctx) => {
      await ctx.db.patch(olderThreadId, { lastMessageAt: 100 });
      await ctx.db.patch(middleThreadId, { lastMessageAt: 200 });
      await ctx.db.patch(newestThreadId, { lastMessageAt: 300 });
    });

    const result = await viewer.query(api.chat.threads.listRepolessThreads, {});
    expect(result.map((thread) => thread._id)).toEqual([newestThreadId, middleThreadId, olderThreadId]);
    expect(result.every((thread) => thread.repositoryId === undefined)).toBe(true);
  });

  test("owner isolation: viewer A never sees viewer B's repoless threads", async () => {
    const aliceTokenIdentifier = "user|list-repoless-alice";
    const bobTokenIdentifier = "user|list-repoless-bob";
    const t = createTestConvex();
    const alice = t.withIdentity({ tokenIdentifier: aliceTokenIdentifier });
    const bob = t.withIdentity({ tokenIdentifier: bobTokenIdentifier });

    await alice.mutation(api.chat.threads.createThread, {});
    await alice.mutation(api.chat.threads.createThread, {});
    const { _id: bobThreadId } = await bob.mutation(api.chat.threads.createThread, {});

    const aliceResult = await alice.query(api.chat.threads.listRepolessThreads, {});
    const bobResult = await bob.query(api.chat.threads.listRepolessThreads, {});

    expect(aliceResult).toHaveLength(2);
    expect(aliceResult.every((thread) => thread._id !== bobThreadId)).toBe(true);
    expect(bobResult.map((thread) => thread._id)).toEqual([bobThreadId]);
  });
});
