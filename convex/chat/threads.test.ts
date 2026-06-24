/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { insertTestArtifact, insertTestRepository, insertTestThread } from "../../test/convex/fixtures";
import { createRateLimitedTestConvex as createTestConvex, type SystifyTestConvex } from "../../test/convex/harness";
import { drainConvexScheduler, withPausedConvexScheduler } from "../../test/convex/scheduler";
import { NEW_THREAD_DEFAULT_TITLE } from "../lib/threadDefaults";

async function insertRepository(t: SystifyTestConvex, ownerTokenIdentifier: string, slug: string) {
  return await insertTestRepository(t, {
    ownerTokenIdentifier,
    sourceUrl: `https://github.com/acme/${slug}`,
    sourceRepoFullName: `acme/${slug}`,
    sourceRepoName: slug,
    defaultBranch: "main",
    visibility: "private",
    importStatus: "completed",
    fileCount: 1,
  });
}

async function seedInternalAccess(t: SystifyTestConvex, ownerTokenIdentifier: string) {
  await t.run(async (ctx) => {
    await ctx.db.insert("userAccessProfiles", {
      ownerTokenIdentifier,
      email: `${ownerTokenIdentifier}@example.com`,
      plan: "internal",
      billingStatus: "none",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    });
  });
}

async function insertThreadMessage(
  t: SystifyTestConvex,
  args: {
    threadId: Id<"threads">;
    ownerTokenIdentifier: string;
    role: "user" | "assistant";
    content: string;
  },
) {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("messages", {
      threadId: args.threadId,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      role: args.role,
      status: "completed",
      mode: "discuss",
      content: args.content,
    });
  });
}

async function seedThreadListingOrderingContract(
  t: SystifyTestConvex,
  args: {
    ownerTokenIdentifier: string;
    repositoryId?: Id<"repositories">;
    mode?: "discuss" | "library";
  },
) {
  const base = {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    repositoryId: args.repositoryId,
    mode: args.mode ?? "discuss",
  };
  const pinnedNewest = await insertTestThread(t, {
    ...base,
    title: "Pinned newest",
    pinnedAt: 500,
    lastMessageAt: 1_000,
  });
  const unpinnedNewest = await insertTestThread(t, {
    ...base,
    title: "Unpinned newest",
    lastMessageAt: 900,
  });
  const pinnedOlder = await insertTestThread(t, {
    ...base,
    title: "Pinned older",
    pinnedAt: 400,
    lastMessageAt: 800,
  });
  const unpinnedOlder = await insertTestThread(t, {
    ...base,
    title: "Unpinned older",
    lastMessageAt: 700,
  });

  return [pinnedNewest, pinnedOlder, unpinnedNewest, unpinnedOlder];
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

  test("foreign repository ids are rejected before inserting a thread", async () => {
    const ownerTokenIdentifier = "user|create-thread-foreign-owner";
    const intruderTokenIdentifier = "user|create-thread-foreign-intruder";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier, "foreign-create");
    const intruder = t.withIdentity({ tokenIdentifier: intruderTokenIdentifier });

    await expect(intruder.mutation(api.chat.threads.createThread, { repositoryId })).rejects.toThrow(
      /repository not found/i,
    );

    const intruderThreads = await intruder.query(api.chat.threads.listRepolessThreads, {});
    expect(intruderThreads).toEqual([]);
  });
});

describe("repoless Agent Profile", () => {
  test("new repoless threads default single-turn off", async () => {
    const ownerTokenIdentifier = "user|agent-profile-default";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const { _id: threadId } = await viewer.mutation(api.chat.threads.createThread, {});
    const thread = await t.run((ctx) => ctx.db.get(threadId));

    expect(thread?.singleTurnEnabled).toBeUndefined();
    expect(thread?.singleTurnResetPending).toBeUndefined();
  });

  test("updates repoless Agent Profile and normalizes blank fields", async () => {
    const ownerTokenIdentifier = "user|agent-profile-update";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const { _id: threadId } = await viewer.mutation(api.chat.threads.createThread, {});

    await viewer.mutation(api.chat.threads.updateRepolessThreadAgentProfile, {
      threadId,
      agentEnabled: true,
      singleTurnEnabled: true,
      agentRole: "  Translation agent  ",
      agentInstructions: "  Translate Chinese into English.  ",
    });

    const updated = await t.run((ctx) => ctx.db.get(threadId));
    expect(updated?.singleTurnEnabled).toBe(true);
    expect(updated?.title).toBe("Translation agent");
    expect(updated?.agentRole).toBe("Translation agent");
    expect(updated?.agentInstructions).toBe("Translate Chinese into English.");
    expect(updated?.agentUpdatedAt).toEqual(expect.any(Number));

    await viewer.mutation(api.chat.threads.updateRepolessThreadAgentProfile, {
      threadId,
      agentEnabled: true,
      singleTurnEnabled: false,
      agentRole: " ",
      agentInstructions: "\n\t",
    });
    const cleared = await t.run((ctx) => ctx.db.get(threadId));
    expect(cleared?.singleTurnEnabled).toBe(false);
    expect(cleared?.title).toBe(NEW_THREAD_DEFAULT_TITLE);
    expect(cleared?.agentRole).toBeUndefined();
    expect(cleared?.agentInstructions).toBeUndefined();
  });

  test("rejects Agent Profile updates for repository-bound threads", async () => {
    const ownerTokenIdentifier = "user|agent-profile-repo";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier, "agent-profile-repo");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const { _id: threadId } = await viewer.mutation(api.chat.threads.createThread, { repositoryId });

    await expect(
      viewer.mutation(api.chat.threads.updateRepolessThreadAgentProfile, {
        threadId,
        agentEnabled: true,
        singleTurnEnabled: true,
        agentRole: "Translation agent",
      }),
    ).rejects.toThrow(/repoless/i);
  });

  test("turning single-turn on clears existing messages", async () => {
    const ownerTokenIdentifier = "user|agent-profile-reset";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const { _id: threadId } = await viewer.mutation(api.chat.threads.createThread, {});
    const messageId = await insertThreadMessage(t, {
      threadId,
      ownerTokenIdentifier,
      role: "assistant",
      content: "old answer",
    });
    await t.run(async (ctx) => {
      const jobId = await ctx.db.insert("jobs", {
        ownerTokenIdentifier,
        threadId,
        kind: "chat",
        status: "completed",
        stage: "completed",
        progress: 1,
        costCategory: "chat",
        triggerSource: "user",
      });
      await ctx.db.insert("messageToolCallEvents", {
        messageId,
        toolCallId: "tool-1",
        sequence: 0,
        type: "start",
        toolName: "read_file",
        inputSummary: "{}",
        occurredAt: Date.now(),
      });
      await ctx.db.insert("messageStreams", {
        threadId,
        jobId,
        assistantMessageId: messageId,
        ownerTokenIdentifier,
        compactedContent: "",
        compactedThroughSequence: -1,
        nextSequence: 0,
        startedAt: Date.now(),
        lastAppendedAt: Date.now(),
      });
    });

    await viewer.mutation(api.chat.threads.updateRepolessThreadAgentProfile, {
      threadId,
      agentEnabled: false,
      singleTurnEnabled: true,
    });

    const rows = await t.run(async (ctx) => ({
      messages: await ctx.db
        .query("messages")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .collect(),
      streams: await ctx.db
        .query("messageStreams")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .collect(),
      events: await ctx.db.query("messageToolCallEvents").collect(),
      thread: await ctx.db.get(threadId),
    }));
    expect(rows.messages).toHaveLength(0);
    expect(rows.streams).toHaveLength(0);
    expect(rows.events).toHaveLength(0);
    expect(rows.thread?.singleTurnResetPending).toBeUndefined();
  });

  test("single-turn send deletes previous messages and resets title generation gate", async () => {
    const ownerTokenIdentifier = "user|single-turn-send";
    const t = createTestConvex();
    await seedInternalAccess(t, ownerTokenIdentifier);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const { threadId } = await viewer.mutation(api.chat.send.sendMessageStartingNewThread, {
      content: "First question",
      mode: "discuss",
      singleTurnEnabled: true,
      agentRole: "Translation agent",
    });
    const createdThread = await t.run((ctx) => ctx.db.get(threadId));
    expect(createdThread?.title).toBe("Translation agent");

    await t.run(async (ctx) => {
      await ctx.db.patch(threadId, { lastAssistantMessageAt: Date.now() });
      const oldAssistant = await ctx.db
        .query("messages")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .filter((q) => q.eq(q.field("role"), "assistant"))
        .first();
      if (oldAssistant) {
        await ctx.db.patch(oldAssistant._id, { status: "completed", content: "First answer" });
      }
      const oldJob = await ctx.db
        .query("jobs")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .first();
      if (oldJob) {
        await ctx.db.patch(oldJob._id, { status: "completed", leaseExpiresAt: 0 });
      }
    });

    await viewer.mutation(api.chat.send.sendMessage, {
      threadId,
      content: "Second question",
      mode: "discuss",
    });

    const rows = await t.run(async (ctx) => ({
      thread: await ctx.db.get(threadId),
      messages: await ctx.db
        .query("messages")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .order("asc")
        .collect(),
    }));
    expect(rows.thread?.lastAssistantMessageAt).toBeUndefined();
    expect(rows.messages.map((message) => message.content)).toEqual(["Second question", ""]);
    expect(rows.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  test("single-turn send preserves previous messages when usage budget blocks the turn", async () => {
    const ownerTokenIdentifier = "user|single-turn-budget-block";
    const t = createTestConvex();
    await seedInternalAccess(t, ownerTokenIdentifier);
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const { _id: threadId } = await viewer.mutation(api.chat.threads.createThread, {});
    await t.run(async (ctx) => {
      await ctx.db.patch(threadId, { singleTurnEnabled: true });
      await ctx.db.insert("messages", {
        threadId,
        ownerTokenIdentifier,
        role: "user",
        status: "completed",
        mode: "discuss",
        content: "Previous question",
      });
      await ctx.db.insert("messages", {
        threadId,
        ownerTokenIdentifier,
        role: "assistant",
        status: "completed",
        mode: "discuss",
        content: "Previous answer",
      });
    });
    await viewer.mutation(api.lib.userCost.updateViewerUsageProfile, {
      cycleAnchorDay: 1,
      timeZone: "UTC",
      budgetUsd: 0.01,
      hardCapEnabled: true,
    });

    await expect(
      viewer.mutation(api.chat.send.sendMessage, {
        threadId,
        content: "Next question",
        mode: "discuss",
      }),
    ).rejects.toThrow("Usage budget reached");

    const rows = await t.run(async (ctx) => ({
      messages: await ctx.db
        .query("messages")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .order("asc")
        .collect(),
      jobs: await ctx.db.query("jobs").take(10),
      thread: await ctx.db.get(threadId),
    }));
    expect(rows.messages.map((message) => message.content)).toEqual(["Previous question", "Previous answer"]);
    expect(rows.jobs).toHaveLength(0);
    expect(rows.thread?.singleTurnResetPending).toBeUndefined();
  });

  test("single-turn send schedules background reset when previous messages exceed one pass", async () => {
    await withPausedConvexScheduler(async () => {
      const ownerTokenIdentifier = "user|single-turn-send-background-reset";
      const t = createTestConvex();
      await seedInternalAccess(t, ownerTokenIdentifier);
      const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
      const { _id: threadId } = await viewer.mutation(api.chat.threads.createThread, {});
      await t.run(async (ctx) => {
        await ctx.db.patch(threadId, { singleTurnEnabled: true });
        for (let index = 0; index < 501; index += 1) {
          await ctx.db.insert("messages", {
            threadId,
            ownerTokenIdentifier,
            role: "user",
            status: "completed",
            mode: "discuss",
            content: `Previous message ${index}`,
          });
        }
      });

      const result = await viewer.mutation(api.chat.send.sendMessage, {
        threadId,
        content: "Next question",
        mode: "discuss",
      });
      expect(result).toEqual({
        status: "singleTurnResetPending",
        message: "Previous messages are being cleared in background; try again later.",
      });

      const pendingRows = await t.run(async (ctx) => ({
        thread: await ctx.db.get(threadId),
        messageCount: (
          await ctx.db
            .query("messages")
            .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
            .collect()
        ).length,
      }));
      expect(pendingRows.thread?.singleTurnResetPending).toBe(true);
      expect(pendingRows.messageCount).toBe(1);

      await drainConvexScheduler(t);

      const resetRows = await t.run(async (ctx) => ({
        thread: await ctx.db.get(threadId),
        messageCount: (
          await ctx.db
            .query("messages")
            .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
            .collect()
        ).length,
      }));
      expect(resetRows.thread?.singleTurnResetPending).toBeUndefined();
      expect(resetRows.messageCount).toBe(0);
    });
  });

  test("disabling single-turn does not delete current messages", async () => {
    const ownerTokenIdentifier = "user|single-turn-disable";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const { _id: threadId } = await viewer.mutation(api.chat.threads.createThread, {});
    await insertThreadMessage(t, { threadId, ownerTokenIdentifier, role: "user", content: "keep me" });
    await viewer.mutation(api.chat.threads.updateRepolessThreadAgentProfile, {
      threadId,
      agentEnabled: false,
      singleTurnEnabled: true,
    });
    await insertThreadMessage(t, { threadId, ownerTokenIdentifier, role: "user", content: "current question" });

    await viewer.mutation(api.chat.threads.updateRepolessThreadAgentProfile, {
      threadId,
      agentEnabled: false,
      singleTurnEnabled: false,
    });

    const messages = await t.run((ctx) =>
      ctx.db
        .query("messages")
        .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
        .collect(),
    );
    expect(messages.map((message) => message.content)).toEqual(["current question"]);
  });
});

describe("listThreads", () => {
  test("orders repository threads pinned first, then recent, without duplicates", async () => {
    const ownerTokenIdentifier = "user|list-threads-ordering-contract";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier, "thread-ordering-contract");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const expected = await seedThreadListingOrderingContract(t, {
      ownerTokenIdentifier,
      repositoryId,
      mode: "library",
    });

    const threads = await viewer.query(api.chat.threads.listThreads, { repositoryId, mode: "library" });

    expect(threads.map((thread) => thread._id)).toEqual(expected);
  });

  test("repository thread list excludes owner-mismatched legacy rows", async () => {
    const ownerTokenIdentifier = "user|list-threads-owner";
    const intruderTokenIdentifier = "user|list-threads-intruder";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier, "thread-pollution");
    const owner = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const { _id: ownerThreadId } = await owner.mutation(api.chat.threads.createThread, { repositoryId });
    const foreignThreadId = await t.run(async (ctx) => {
      return await ctx.db.insert("threads", {
        repositoryId,
        ownerTokenIdentifier: intruderTokenIdentifier,
        title: "Injected thread",
        mode: "library",
        lastMessageAt: Date.now() + 1_000,
        pinnedAt: Date.now() + 1_000,
      });
    });

    const threads = await owner.query(api.chat.threads.listThreads, { repositoryId, mode: "library" });

    expect(threads.map((thread) => thread._id)).toContain(ownerThreadId);
    expect(threads.map((thread) => thread._id)).not.toContain(foreignThreadId);
    expect(threads.every((thread) => thread.ownerTokenIdentifier === ownerTokenIdentifier)).toBe(true);
  });
});

describe("listOwnedThreadIdsById", () => {
  test("rejects ownership probes over the 200 id limit", async () => {
    const ownerTokenIdentifier = "user|thread-probe-limit";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await expect(
      viewer.query(api.chat.threads.listOwnedThreadIdsById, {
        threadIds: Array.from({ length: 201 }, (_, index) => `not-a-convex-id-${index}`),
      }),
    ).rejects.toThrow("Too many thread ids to validate. Keep at most 200.");
  });

  test("returns only normalized active thread ids owned by the viewer", async () => {
    const ownerTokenIdentifier = "user|thread-probe-owner";
    const intruderTokenIdentifier = "user|thread-probe-intruder";
    const t = createTestConvex();
    const liveThreadId = await insertTestThread(t, {
      ownerTokenIdentifier,
      title: "Live probe thread",
    });
    const deletingThreadId = await insertTestThread(t, {
      ownerTokenIdentifier,
      title: "Deleting probe thread",
      deletionRequestedAt: Date.now(),
    });
    const foreignThreadId = await insertTestThread(t, {
      ownerTokenIdentifier: intruderTokenIdentifier,
      title: "Foreign probe thread",
    });
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const result = await viewer.query(api.chat.threads.listOwnedThreadIdsById, {
      threadIds: [liveThreadId, deletingThreadId, foreignThreadId, "not-a-convex-id", liveThreadId],
    });

    expect(result).toEqual([liveThreadId]);
  });

  test("includes archived owned threads because only deletion is filtered", async () => {
    const ownerTokenIdentifier = "user|thread-probe-archived";
    const t = createTestConvex();
    const archivedThreadId = await insertTestThread(t, {
      ownerTokenIdentifier,
      title: "Archived probe thread",
      archivedAt: Date.now(),
    });
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const result = await viewer.query(api.chat.threads.listOwnedThreadIdsById, {
      threadIds: [archivedThreadId],
    });

    expect(result).toEqual([archivedThreadId]);
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

  test("swap clears scoped Library Ask artifact context", async () => {
    const ownerTokenIdentifier = "user|set-thread-repo-swap-artifact-context";
    const t = createTestConvex();
    const repoA = await insertRepository(t, ownerTokenIdentifier, "swap-context-a");
    const repoB = await insertRepository(t, ownerTokenIdentifier, "swap-context-b");
    const artifactId = await insertTestArtifact(t, {
      repositoryId: repoA,
      ownerTokenIdentifier,
      kind: "architecture_overview",
      title: "Architecture",
      description: "s",
      contentMarkdown: "m",
    });
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const { _id: threadId } = await viewer.mutation(api.chat.threads.createLibraryAskThread, {
      repositoryId: repoA,
      artifactContext: [artifactId],
    });

    await viewer.mutation(api.chat.threads.setThreadRepository, {
      threadId,
      repositoryId: repoB,
    });

    const stored = await t.run((ctx) => ctx.db.get(threadId));
    expect(stored?.artifactContext).toBeUndefined();
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

describe("renameThread", () => {
  test("trims and persists a valid new title", async () => {
    const ownerTokenIdentifier = "user|rename-happy";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const { _id: threadId } = await viewer.mutation(api.chat.threads.createThread, {});
    await viewer.mutation(api.chat.threads.renameThread, {
      threadId,
      title: "   Auth Flow Overview   ",
    });

    const stored = await t.run((ctx) => ctx.db.get(threadId));
    expect(stored?.title).toBe("Auth Flow Overview");
  });

  test("rejects an empty title", async () => {
    const ownerTokenIdentifier = "user|rename-empty";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const { _id: threadId } = await viewer.mutation(api.chat.threads.createThread, {});
    await expect(viewer.mutation(api.chat.threads.renameThread, { threadId, title: "   " })).rejects.toThrow(
      /cannot be empty/i,
    );
  });

  test("rejects a title that exceeds the cap", async () => {
    const ownerTokenIdentifier = "user|rename-overflow";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const { _id: threadId } = await viewer.mutation(api.chat.threads.createThread, {});
    await expect(
      viewer.mutation(api.chat.threads.renameThread, {
        threadId,
        title: "x".repeat(201),
      }),
    ).rejects.toThrow(/at most 200/);
  });

  test("non-owner cannot rename someone else's thread", async () => {
    const ownerTokenIdentifier = "user|rename-owner";
    const intruderTokenIdentifier = "user|rename-intruder";
    const t = createTestConvex();
    const owner = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const intruder = t.withIdentity({ tokenIdentifier: intruderTokenIdentifier });

    const { _id: threadId } = await owner.mutation(api.chat.threads.createThread, {});

    await expect(intruder.mutation(api.chat.threads.renameThread, { threadId, title: "Hijacked" })).rejects.toThrow(
      /thread not found/i,
    );

    // The owner's title must be untouched after the failed intruder attempt.
    const stored = await t.run((ctx) => ctx.db.get(threadId));
    expect(stored?.title).not.toBe("Hijacked");
  });
});

describe("archiveThread", () => {
  test("archives a repoless chat thread and restore returns it to the active chat list", async () => {
    const ownerTokenIdentifier = "user|archive-repoless-chat";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const { _id: threadId } = await viewer.mutation(api.chat.threads.createThread, {});
    await viewer.mutation(api.chat.threads.setThreadPinned, { threadId, pinned: true });

    await viewer.mutation(api.chat.threads.archiveThread, { threadId });

    const storedAfterArchive = await t.run((ctx) => ctx.db.get(threadId));
    expect(typeof storedAfterArchive?.archivedAt).toBe("number");
    expect(storedAfterArchive?.pinnedAt).toBeUndefined();
    expect(storedAfterArchive?.archiveScopeKey).toBe("no_repository");

    const scopeAfterArchive = await t.run(async (ctx) => {
      return await ctx.db
        .query("archivedThreadScopes")
        .withIndex("by_ownerTokenIdentifier_and_scopeKey", (q) =>
          q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("scopeKey", "no_repository"),
        )
        .unique();
    });
    expect(scopeAfterArchive?.threadCount).toBe(1);
    expect(scopeAfterArchive?.lastThreadId).toBe(threadId);

    const activeAfterArchive = await viewer.query(api.chat.threads.listRepolessThreads, {});
    expect(activeAfterArchive.map((thread) => thread._id)).not.toContain(threadId);

    const archived = await viewer.query(api.chat.threads.listArchivedThreads, {
      paginationOpts: { numItems: 10, cursor: null },
    });
    expect(archived.page.map((thread) => thread._id)).toContain(threadId);

    await viewer.mutation(api.chat.threads.restoreThread, { threadId });

    const restored = await t.run((ctx) => ctx.db.get(threadId));
    expect(restored?.archivedAt).toBeUndefined();
    expect(restored?.archiveScopeKey).toBeUndefined();

    const scopeAfterRestore = await t.run(async (ctx) => {
      return await ctx.db
        .query("archivedThreadScopes")
        .withIndex("by_ownerTokenIdentifier_and_scopeKey", (q) =>
          q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("scopeKey", "no_repository"),
        )
        .unique();
    });
    expect(scopeAfterRestore).toBeNull();

    const activeAfterRestore = await viewer.query(api.chat.threads.listRepolessThreads, {});
    expect(activeAfterRestore.map((thread) => thread._id)).toContain(threadId);
  });

  test("archived threads reject active chat mutations", async () => {
    const ownerTokenIdentifier = "user|archive-reject-send";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const { _id: threadId } = await viewer.mutation(api.chat.threads.createThread, {});
    await viewer.mutation(api.chat.threads.archiveThread, { threadId });

    await expect(
      viewer.mutation(api.chat.send.sendMessage, {
        threadId,
        content: "This should not append to archived history.",
      }),
    ).rejects.toThrow(/thread not found/i);
    await expect(
      viewer.mutation(api.chat.threads.renameThread, {
        threadId,
        title: "Archived rename",
      }),
    ).rejects.toThrow(/thread not found/i);
  });

  test("archived thread listing can be scoped by repository or no-repository", async () => {
    const ownerTokenIdentifier = "user|archive-list-scope";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier, "archive-list-scope");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const repositoryThread = await viewer.mutation(api.chat.threads.createThread, { repositoryId, mode: "discuss" });
    const noRepositoryThread = await viewer.mutation(api.chat.threads.createThread, {});
    await viewer.mutation(api.chat.threads.archiveThread, { threadId: repositoryThread._id });
    await viewer.mutation(api.chat.threads.archiveThread, { threadId: noRepositoryThread._id });

    const repositoryPage = await viewer.query(api.chat.threads.listArchivedThreads, {
      repositoryId,
      paginationOpts: { numItems: 10, cursor: null },
    });
    const noRepositoryPage = await viewer.query(api.chat.threads.listArchivedThreads, {
      repositoryId: null,
      paginationOpts: { numItems: 10, cursor: null },
    });
    const scopes = await viewer.query(api.chat.threads.listArchivedThreadRepositoryScopes, {});

    expect(repositoryPage.page.map((thread) => thread._id)).toEqual([repositoryThread._id]);
    expect(noRepositoryPage.page.map((thread) => thread._id)).toEqual([noRepositoryThread._id]);
    expect(scopes).toEqual([
      { repositoryId: null, label: "No repository" },
      { repositoryId, label: "acme/archive-list-scope" },
    ]);
  });

  test("bulk archived thread restore and delete are scoped to the selected repository", async () => {
    const ownerTokenIdentifier = "user|archive-bulk-scope";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier, "archive-bulk-scope");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const repositoryThread = await viewer.mutation(api.chat.threads.createThread, { repositoryId, mode: "discuss" });
    const noRepositoryThread = await viewer.mutation(api.chat.threads.createThread, {});
    await viewer.mutation(api.chat.threads.archiveThread, { threadId: repositoryThread._id });
    await viewer.mutation(api.chat.threads.archiveThread, { threadId: noRepositoryThread._id });

    await viewer.mutation(api.chat.threads.restoreArchivedThreadsForRepository, { repositoryId });

    const afterRestoreRepository = await t.run((ctx) => ctx.db.get(repositoryThread._id));
    const afterRestoreNoRepository = await t.run((ctx) => ctx.db.get(noRepositoryThread._id));
    expect(afterRestoreRepository?.archivedAt).toBeUndefined();
    expect(afterRestoreNoRepository?.archivedAt).toBeTypeOf("number");

    await viewer.mutation(api.chat.threads.deleteArchivedThreadsForRepository, { repositoryId: null });

    const afterDeleteRepository = await t.run((ctx) => ctx.db.get(repositoryThread._id));
    const afterDeleteNoRepository = await t.run((ctx) => ctx.db.get(noRepositoryThread._id));
    const remainingScopes = await t.run(async (ctx) => {
      return await ctx.db
        .query("archivedThreadScopes")
        .withIndex("by_ownerTokenIdentifier_and_lastArchivedAt", (q) =>
          q.eq("ownerTokenIdentifier", ownerTokenIdentifier),
        )
        .collect();
    });
    expect(afterDeleteRepository).not.toBeNull();
    expect(afterDeleteNoRepository).toBeNull();
    expect(remainingScopes).toHaveLength(0);
  });

  test("repair job backfills legacy archived thread scopes without double-counting", async () => {
    const ownerTokenIdentifier = "user|archive-scope-repair";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier, "archive-scope-repair");
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    await t.run(async (ctx) => {
      await ctx.db.insert("threads", {
        ownerTokenIdentifier,
        repositoryId,
        title: "Legacy archived repo",
        mode: "discuss",
        lastMessageAt: Date.now(),
        archivedAt: Date.now(),
      });
      await ctx.db.insert("threads", {
        ownerTokenIdentifier,
        title: "Legacy archived no repo",
        mode: "discuss",
        lastMessageAt: Date.now(),
        archivedAt: Date.now() + 1_000,
      });
    });

    await t.mutation(internal.chat.archiveState.repairArchivedThreadScopes, {});
    await t.mutation(internal.chat.archiveState.repairArchivedThreadScopes, {});

    const scopes = await viewer.query(api.chat.threads.listArchivedThreadRepositoryScopes, {});
    const rows = await t.run(async (ctx) => {
      return await ctx.db
        .query("archivedThreadScopes")
        .withIndex("by_ownerTokenIdentifier_and_lastArchivedAt", (q) =>
          q.eq("ownerTokenIdentifier", ownerTokenIdentifier),
        )
        .collect();
    });

    expect(scopes).toEqual([
      { repositoryId: null, label: "No repository" },
      { repositoryId, label: "acme/archive-scope-repair" },
    ]);
    expect(rows.map((row) => row.threadCount).sort()).toEqual([1, 1]);
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

  test("orders repoless threads pinned first, then recent, without duplicates", async () => {
    const ownerTokenIdentifier = "user|list-repoless-ordering-contract";
    const t = createTestConvex();
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const expected = await seedThreadListingOrderingContract(t, {
      ownerTokenIdentifier,
    });

    const result = await viewer.query(api.chat.threads.listRepolessThreads, {});

    expect(result.map((thread) => thread._id)).toEqual(expected);
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
