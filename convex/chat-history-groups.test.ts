/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { insertTestRepository } from "../test/convex/fixtures";
import { createTestConvex } from "../test/convex/harness";

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

async function insertRepository(ownerTokenIdentifier: string, slug: string) {
  const t = createTestConvex();
  const repositoryId = await insertTestRepository(t, {
    ownerTokenIdentifier,
    sourceUrl: `https://github.com/acme/${slug}`,
    sourceRepoFullName: `acme/${slug}`,
    sourceRepoName: slug,
    visibility: "private",
    importStatus: "completed",
  });
  return { t, repositoryId };
}

describe("chat history groups", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("groups are isolated by owner and include pinned no-repository plus repository chats", async () => {
    const ownerTokenIdentifier = "user|history-groups-owner";
    const intruderTokenIdentifier = "user|history-groups-intruder";
    const { t, repositoryId } = await insertRepository(ownerTokenIdentifier, "history-groups");
    const intruderRepositoryId = await insertTestRepository(t, {
      ownerTokenIdentifier: intruderTokenIdentifier,
      sourceRepoFullName: "acme/intruder-history",
      sourceRepoName: "intruder-history",
    });
    const owner = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const intruder = t.withIdentity({ tokenIdentifier: intruderTokenIdentifier });

    const noRepositoryThread = await owner.mutation(api.chat.threads.createThread, {});
    vi.advanceTimersByTime(1_000);
    const repositoryThread = await owner.mutation(api.chat.threads.createThread, {
      repositoryId,
      mode: "discuss",
    });
    vi.advanceTimersByTime(1_000);
    await intruder.mutation(api.chat.threads.createThread, {
      repositoryId: intruderRepositoryId,
      mode: "discuss",
    });

    const groups = await owner.query(api.chat.history.listThreadHistoryGroups, {
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(groups.page.map((group) => group.lastThreadId)).toEqual([noRepositoryThread._id, repositoryThread._id]);
    expect(groups.page).toHaveLength(2);
    expect(groups.page[0]?.repositoryId).toBeUndefined();
    expect(groups.page[1]?.repository?.sourceRepoFullName).toBe("acme/history-groups");
  });

  test("pins no-repository chats into the first history page even when repository groups are newer", async () => {
    const ownerTokenIdentifier = "user|history-groups-pin-no-repo";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const noRepositoryThread = await viewer.mutation(api.chat.threads.createThread, {});
    for (let index = 0; index < 3; index += 1) {
      vi.advanceTimersByTime(1_000);
      const repositoryId = await insertTestRepository(t, {
        ownerTokenIdentifier,
        sourceUrl: `https://github.com/acme/history-pin-${index}`,
        sourceRepoFullName: `acme/history-pin-${index}`,
        sourceRepoName: `history-pin-${index}`,
        visibility: "private",
        importStatus: "completed",
      });
      await viewer.mutation(api.chat.threads.createThread, {
        repositoryId,
        mode: "discuss",
      });
    }

    const firstPage = await viewer.query(api.chat.history.listThreadHistoryGroups, {
      paginationOpts: { numItems: 2, cursor: null },
    });
    const secondPage = await viewer.query(api.chat.history.listThreadHistoryGroups, {
      paginationOpts: { numItems: 10, cursor: firstPage.continueCursor },
    });

    expect(firstPage.page.map((group) => group.lastThreadId)).toEqual([noRepositoryThread._id, expect.any(String)]);
    expect(firstPage.page[0]?.repositoryId).toBeUndefined();
    expect(firstPage.page[1]?.repository?.sourceRepoFullName).toBe("acme/history-pin-2");
    expect(secondPage.page.every((group) => group.groupKey !== "no_repository")).toBe(true);
  });

  test("repository and no-repository thread lists paginate independently", async () => {
    const ownerTokenIdentifier = "user|history-thread-pagination";
    const { t, repositoryId } = await insertRepository(ownerTokenIdentifier, "history-pagination");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const repoThreadIds: Id<"threads">[] = [];
    for (let index = 0; index < 3; index += 1) {
      const thread = await viewer.mutation(api.chat.threads.createThread, {
        repositoryId,
        mode: "discuss",
      });
      repoThreadIds.push(thread._id);
      vi.advanceTimersByTime(1_000);
    }
    const noRepositoryThread = await viewer.mutation(api.chat.threads.createThread, {});

    const firstPage = await viewer.query(api.chat.history.listThreadsForHistoryGroup, {
      repositoryId,
      paginationOpts: { numItems: 2, cursor: null },
    });
    const secondPage = await viewer.query(api.chat.history.listThreadsForHistoryGroup, {
      repositoryId,
      paginationOpts: { numItems: 2, cursor: firstPage.continueCursor },
    });
    const noRepositoryPage = await viewer.query(api.chat.history.listThreadsForHistoryGroup, {
      repositoryId: null,
      paginationOpts: { numItems: 5, cursor: null },
    });

    expect(firstPage.page.map((thread) => thread._id)).toEqual([repoThreadIds[2], repoThreadIds[1]]);
    expect(secondPage.page.map((thread) => thread._id)).toEqual([repoThreadIds[0]]);
    expect(noRepositoryPage.page.map((thread) => thread._id)).toEqual([noRepositoryThread._id]);
  });

  test("thread delete removes share rows and updates the no-repository history group", async () => {
    const ownerTokenIdentifier = "user|history-delete-thread";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const olderThread = await viewer.mutation(api.chat.threads.createThread, {});
    vi.advanceTimersByTime(1_000);
    const newerThread = await viewer.mutation(api.chat.threads.createThread, {});
    await viewer.mutation(api.chat.threadShares.createOrGetThreadShare, { threadId: newerThread._id });

    await viewer.mutation(api.chat.threads.deleteThread, { threadId: newerThread._id });

    const state = await t.run(async (ctx) => {
      const shares = await ctx.db
        .query("threadShares")
        .withIndex("by_threadId", (q) => q.eq("threadId", newerThread._id))
        .collect();
      const groups = await ctx.db
        .query("chatHistoryGroups")
        .withIndex("by_ownerTokenIdentifier_and_groupKey", (q) =>
          q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("groupKey", "no_repository"),
        )
        .collect();
      return { shares, groups };
    });

    expect(state.shares).toHaveLength(0);
    expect(state.groups).toHaveLength(1);
    expect(state.groups[0]?.threadCount).toBe(1);
    expect(state.groups[0]?.lastThreadId).toBe(olderThread._id);
  });

  test("backfill counts legacy active threads without double-counting repaired rows", async () => {
    const ownerTokenIdentifier = "user|history-backfill-legacy";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await t.run(async (ctx) => {
      await ctx.db.insert("threads", {
        ownerTokenIdentifier,
        title: "Legacy one",
        mode: "discuss",
        lastMessageAt: Date.now(),
      });
      vi.advanceTimersByTime(1_000);
      await ctx.db.insert("threads", {
        ownerTokenIdentifier,
        title: "Legacy two",
        mode: "discuss",
        lastMessageAt: Date.now(),
      });
    });

    await t.mutation(internal.chat.history.backfillChatHistoryGroups, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    await t.mutation(internal.chat.history.backfillChatHistoryGroups, {
      paginationOpts: { numItems: 10, cursor: null },
    });

    const groups = await viewer.query(api.chat.history.listThreadHistoryGroups, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    const repairedRows = await t.run(async (ctx) => {
      return await ctx.db
        .query("threads")
        .withIndex("by_ownerTokenIdentifier_and_historyGroupKey_and_lastMessageAt", (q) =>
          q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("historyGroupKey", "no_repository"),
        )
        .collect();
    });

    expect(groups.page[0]?.threadCount).toBe(2);
    expect(repairedRows).toHaveLength(2);
    expect(repairedRows.every((thread) => typeof thread.historyBackfilledAt === "number")).toBe(true);
  });

  test("repair job skips inactive legacy rows so batches can drain", async () => {
    const ownerTokenIdentifier = "user|history-backfill-inactive";
    const t = createTestConvex();

    await t.run(async (ctx) => {
      await ctx.db.insert("threads", {
        ownerTokenIdentifier,
        title: "Legacy archived",
        mode: "discuss",
        lastMessageAt: Date.now(),
        archivedAt: Date.now(),
      });
    });

    await t.mutation(internal.chat.history.repairChatHistoryGroups, {});

    const rows = await t.run(async (ctx) => {
      return await ctx.db
        .query("threads")
        .withIndex("by_historyBackfilledAt", (q) => q.eq("historyBackfilledAt", undefined))
        .take(10);
    });
    expect(rows).toHaveLength(0);
  });

  test("permanently deleting an archived thread does not remove active history twice", async () => {
    const ownerTokenIdentifier = "user|history-delete-archived-thread";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const archivedThread = await viewer.mutation(api.chat.threads.createThread, {});
    vi.advanceTimersByTime(1_000);
    const activeThread = await viewer.mutation(api.chat.threads.createThread, {});

    await viewer.mutation(api.chat.threads.archiveThread, { threadId: archivedThread._id });
    await viewer.mutation(api.chat.threads.deleteArchivedThread, { threadId: archivedThread._id });

    const groups = await viewer.query(api.chat.history.listThreadHistoryGroups, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(groups.page).toHaveLength(1);
    expect(groups.page[0]?.threadCount).toBe(1);
    expect(groups.page[0]?.lastThreadId).toBe(activeThread._id);
  });

  test("long thread delete immediately invalidates shares and removes the history group before continuation", async () => {
    const ownerTokenIdentifier = "user|history-long-delete-thread";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const thread = await viewer.mutation(api.chat.threads.createThread, {});
    const share = await viewer.mutation(api.chat.threadShares.createOrGetThreadShare, { threadId: thread._id });
    await t.run(async (ctx) => {
      for (let index = 0; index < 500; index += 1) {
        await ctx.db.insert("messages", {
          threadId: thread._id,
          ownerTokenIdentifier,
          role: index % 2 === 0 ? "user" : "assistant",
          status: "completed",
          mode: "discuss",
          content: `message ${index}`,
        });
      }
    });

    await viewer.mutation(api.chat.threads.deleteThread, { threadId: thread._id });

    expect(await t.query(api.chat.threadShares.getPublicThreadShare, { token: share.token })).toBeNull();
    const groups = await viewer.query(api.chat.history.listThreadHistoryGroups, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    const state = await t.run(async (ctx) => {
      return await ctx.db.get(thread._id);
    });

    expect(groups.page).toHaveLength(0);
    expect(state?.deletionRequestedAt).toBeTypeOf("number");
  });

  test("repository cascade removes related history groups and share rows", async () => {
    const ownerTokenIdentifier = "user|history-repository-cascade";
    const { t, repositoryId } = await insertRepository(ownerTokenIdentifier, "history-cascade");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const thread = await viewer.mutation(api.chat.threads.createThread, {
      repositoryId,
      mode: "discuss",
    });
    await viewer.mutation(api.chat.threadShares.createOrGetThreadShare, { threadId: thread._id });

    await viewer.mutation(api.repositories.archiveRepository, { repositoryId });
    await viewer.mutation(api.repositories.deleteRepository, { repositoryId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const remaining = await t.run(async (ctx) => {
      const groups = await ctx.db
        .query("chatHistoryGroups")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
        .collect();
      const shares = await ctx.db
        .query("threadShares")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
        .collect();
      const threads = await ctx.db
        .query("threads")
        .withIndex("by_repositoryId_and_lastMessageAt", (q) => q.eq("repositoryId", repositoryId))
        .collect();
      return { groups, shares, threads };
    });

    expect(remaining.groups).toHaveLength(0);
    expect(remaining.shares).toHaveLength(0);
    expect(remaining.threads).toHaveLength(0);
  });

  test("moving a thread updates existing share repository scope", async () => {
    const ownerTokenIdentifier = "user|history-share-move";
    const { t, repositoryId: firstRepositoryId } = await insertRepository(ownerTokenIdentifier, "history-share-a");
    const secondRepositoryId = await insertTestRepository(t, {
      ownerTokenIdentifier,
      sourceUrl: "https://github.com/acme/history-share-b",
      sourceRepoFullName: "acme/history-share-b",
      sourceRepoName: "history-share-b",
      visibility: "private",
      importStatus: "completed",
    });
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const thread = await viewer.mutation(api.chat.threads.createThread, {
      repositoryId: firstRepositoryId,
      mode: "discuss",
    });
    const share = await viewer.mutation(api.chat.threadShares.createOrGetThreadShare, { threadId: thread._id });

    await viewer.mutation(api.chat.threads.setThreadRepository, {
      threadId: thread._id,
      repositoryId: secondRepositoryId,
    });

    const shareRow = await t.run(async (ctx) => {
      return await ctx.db.get(share._id);
    });
    expect(shareRow?.repositoryId).toBe(secondRepositoryId);
  });

  test("moving a thread continues share repository scope updates across batches", async () => {
    const ownerTokenIdentifier = "user|history-share-move-batched";
    const { t, repositoryId: firstRepositoryId } = await insertRepository(
      ownerTokenIdentifier,
      "history-share-batch-a",
    );
    const secondRepositoryId = await insertTestRepository(t, {
      ownerTokenIdentifier,
      sourceUrl: "https://github.com/acme/history-share-batch-b",
      sourceRepoFullName: "acme/history-share-batch-b",
      sourceRepoName: "history-share-batch-b",
      visibility: "private",
      importStatus: "completed",
    });
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const thread = await viewer.mutation(api.chat.threads.createThread, {
      repositoryId: firstRepositoryId,
      mode: "discuss",
    });

    await t.run(async (ctx) => {
      for (let index = 0; index < 201; index += 1) {
        await ctx.db.insert("threadShares", {
          ownerTokenIdentifier,
          threadId: thread._id,
          repositoryId: firstRepositoryId,
          token: `share-token-${index}`,
          tokenPrefix: `share-${index}`,
          createdAt: Date.now(),
          expiresAt: Date.now() + THIRTY_DAYS_MS,
        });
      }
    });

    await viewer.mutation(api.chat.threads.setThreadRepository, {
      threadId: thread._id,
      repositoryId: secondRepositoryId,
    });
    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const remainingOldScope = await t.run(async (ctx) => {
      return await ctx.db
        .query("threadShares")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", firstRepositoryId))
        .take(10);
    });
    const updatedScope = await t.run(async (ctx) => {
      return await ctx.db
        .query("threadShares")
        .withIndex("by_repositoryId", (q) => q.eq("repositoryId", secondRepositoryId))
        .take(250);
    });

    expect(remainingOldScope).toHaveLength(0);
    expect(updatedScope).toHaveLength(201);
  });
});

describe("thread shares", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("share creation is idempotent while active and expires after 30 days", async () => {
    const ownerTokenIdentifier = "user|thread-share-idempotent";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const thread = await viewer.mutation(api.chat.threads.createThread, {});

    const first = await viewer.mutation(api.chat.threadShares.createOrGetThreadShare, { threadId: thread._id });
    const second = await viewer.mutation(api.chat.threadShares.createOrGetThreadShare, { threadId: thread._id });

    expect(second._id).toBe(first._id);
    expect(first.expiresAt - first.createdAt).toBe(THIRTY_DAYS_MS);
  });

  test("revoked and expired links fail public access", async () => {
    const ownerTokenIdentifier = "user|thread-share-access";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const thread = await viewer.mutation(api.chat.threads.createThread, {});
    const revoked = await viewer.mutation(api.chat.threadShares.createOrGetThreadShare, { threadId: thread._id });

    await viewer.mutation(api.chat.threadShares.revokeThreadShare, { shareId: revoked._id });
    expect(await t.query(api.chat.threadShares.getPublicThreadShare, { token: revoked.token })).toBeNull();
    await expect(
      t.query(api.chat.threadShares.listPublicThreadShareMessages, {
        token: revoked.token,
        paginationOpts: { numItems: 10, cursor: null },
      }),
    ).rejects.toThrow(/share link not found/i);

    const expiring = await viewer.mutation(api.chat.threadShares.createOrGetThreadShare, { threadId: thread._id });
    vi.advanceTimersByTime(THIRTY_DAYS_MS + 1);

    expect(await t.query(api.chat.threadShares.getPublicThreadShare, { token: expiring.token })).toBeNull();
  });

  test("archived threads keep existing shares visible to owner and public readers", async () => {
    const ownerTokenIdentifier = "user|thread-share-archived";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const sharedThread = await viewer.mutation(api.chat.threads.createThread, {});
    const share = await viewer.mutation(api.chat.threadShares.createOrGetThreadShare, { threadId: sharedThread._id });
    const unsharedThread = await viewer.mutation(api.chat.threads.createThread, {});

    await viewer.mutation(api.chat.threads.archiveThread, { threadId: sharedThread._id });
    await viewer.mutation(api.chat.threads.archiveThread, { threadId: unsharedThread._id });

    expect(await t.query(api.chat.threadShares.getPublicThreadShare, { token: share.token })).not.toBeNull();
    const activeShares = await viewer.query(api.chat.threadShares.listActiveThreadShares, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(activeShares.page).toMatchObject([
      {
        _id: share._id,
        threadId: sharedThread._id,
        threadArchivedAt: expect.any(Number),
      },
    ]);
    await expect(
      viewer.mutation(api.chat.threadShares.createOrGetThreadShare, { threadId: unsharedThread._id }),
    ).rejects.toThrow(/thread not found/i);
  });

  test("revoked archived shares disappear from owner and public access", async () => {
    const ownerTokenIdentifier = "user|thread-share-revoked-archived";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const thread = await viewer.mutation(api.chat.threads.createThread, {});
    const share = await viewer.mutation(api.chat.threadShares.createOrGetThreadShare, { threadId: thread._id });

    await viewer.mutation(api.chat.threads.archiveThread, { threadId: thread._id });
    await viewer.mutation(api.chat.threadShares.revokeThreadShare, { shareId: share._id });

    expect(await t.query(api.chat.threadShares.getPublicThreadShare, { token: share.token })).toBeNull();
    const activeShares = await viewer.query(api.chat.threadShares.listActiveThreadShares, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(activeShares.page).toEqual([]);
  });

  test("owner share listing scans past leftover deleted-thread rows", async () => {
    const ownerTokenIdentifier = "user|thread-share-scan-deleted";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const deletedThread = await viewer.mutation(api.chat.threads.createThread, {});
    const visibleThread = await viewer.mutation(api.chat.threads.createThread, {});
    const visibleShare = await viewer.mutation(api.chat.threadShares.createOrGetThreadShare, {
      threadId: visibleThread._id,
    });
    await viewer.mutation(api.chat.threads.deleteThread, { threadId: deletedThread._id });

    await t.run(async (ctx) => {
      await ctx.db.insert("threadShares", {
        ownerTokenIdentifier,
        threadId: deletedThread._id,
        token: "deleted-thread-leftover-token",
        tokenPrefix: "deleted-th",
        createdAt: Date.now(),
        expiresAt: Date.now() + THIRTY_DAYS_MS + 1_000,
      });
    });

    const activeShares = await viewer.query(api.chat.threadShares.listActiveThreadShares, {
      paginationOpts: { numItems: 1, cursor: null },
    });
    expect(activeShares.page.map((share) => share._id)).toEqual([visibleShare._id]);
  });

  test("public transcript excludes private message fields and tool rows", async () => {
    const ownerTokenIdentifier = "user|thread-share-transcript";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const thread = await viewer.mutation(api.chat.threads.createThread, {});
    const share = await viewer.mutation(api.chat.threadShares.createOrGetThreadShare, { threadId: thread._id });

    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        threadId: thread._id,
        ownerTokenIdentifier,
        role: "user",
        status: "completed",
        mode: "discuss",
        content: "What changed?",
        estimatedCostUsd: 1.23,
      });
      await ctx.db.insert("messages", {
        threadId: thread._id,
        ownerTokenIdentifier,
        role: "assistant",
        status: "completed",
        mode: "discuss",
        content: "Only safe fields should be public.",
        reasoning: "private reasoning",
        toolCalls: [
          {
            toolCallId: "call_1",
            toolName: "read_file",
            inputSummary: "{}",
            outputSummary: "{}",
            startedAt: Date.now(),
            endedAt: Date.now(),
          },
        ],
      });
      await ctx.db.insert("messages", {
        threadId: thread._id,
        ownerTokenIdentifier,
        role: "tool",
        status: "completed",
        mode: "discuss",
        content: "tool output",
      });
    });

    const publicShare = await t.query(api.chat.threadShares.getPublicThreadShare, { token: share.token });
    const transcript = await t.query(api.chat.threadShares.listPublicThreadShareMessages, {
      token: share.token,
      paginationOpts: { numItems: 10, cursor: null },
    });

    expect(publicShare?.title).toBe("New chat");
    expect(transcript.page.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(Object.keys(transcript.page[0]!).sort()).toEqual(["_id", "content", "createdAt", "role", "status"]);
    expect(transcript.page[1]).not.toHaveProperty("reasoning");
    expect(transcript.page[1]).not.toHaveProperty("toolCalls");
    expect(transcript.page[0]).not.toHaveProperty("estimatedCostUsd");
  });

  test("public transcript scans past leading tool rows to fill the requested page", async () => {
    const ownerTokenIdentifier = "user|thread-share-leading-tools";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const thread = await viewer.mutation(api.chat.threads.createThread, {});
    const share = await viewer.mutation(api.chat.threadShares.createOrGetThreadShare, { threadId: thread._id });

    await t.run(async (ctx) => {
      for (const role of ["tool", "system"] as const) {
        await ctx.db.insert("messages", {
          threadId: thread._id,
          ownerTokenIdentifier,
          role,
          status: "completed",
          mode: "discuss",
          content: `${role} content`,
        });
      }
      await ctx.db.insert("messages", {
        threadId: thread._id,
        ownerTokenIdentifier,
        role: "user",
        status: "completed",
        mode: "discuss",
        content: "Visible user message",
      });
      await ctx.db.insert("messages", {
        threadId: thread._id,
        ownerTokenIdentifier,
        role: "assistant",
        status: "completed",
        mode: "discuss",
        content: "Visible assistant message",
      });
    });

    const transcript = await t.query(api.chat.threadShares.listPublicThreadShareMessages, {
      token: share.token,
      paginationOpts: { numItems: 2, cursor: null },
    });

    expect(transcript.page.map((message) => message.content)).toEqual([
      "Visible user message",
      "Visible assistant message",
    ]);
  });
});
