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

async function insertRepository(
  t: ReturnType<typeof convexTest>,
  ownerTokenIdentifier: string,
): Promise<Id<"repositories">> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("repositories", {
      ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: "https://github.com/acme/widget",
      sourceRepoFullName: "acme/widget",
      sourceRepoOwner: "acme",
      sourceRepoName: "widget",
      defaultBranch: "main",
      visibility: "private",
      accessMode: "private",
      importStatus: "completed",
      detectedLanguages: [],
      packageManagers: [],
      entrypoints: [],
      fileCount: 0,
    });
  });
}

async function insertWorkspaceWithRepository(
  t: ReturnType<typeof convexTest>,
  ownerTokenIdentifier: string,
  repositoryId: Id<"repositories">,
): Promise<Id<"workspaces">> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("workspaces", {
      ownerTokenIdentifier,
      repositoryId,
      name: "acme/widget",
      color: "blue",
      lastAccessedAt: Date.now(),
    });
  });
}

async function insertHomeWorkspace(
  t: ReturnType<typeof convexTest>,
  ownerTokenIdentifier: string,
): Promise<Id<"workspaces">> {
  return await t.run(async (ctx) => {
    return await ctx.db.insert("workspaces", {
      ownerTokenIdentifier,
      name: "Home",
      color: "blue",
      lastAccessedAt: Date.now(),
    });
  });
}

describe("chat thread defaults", () => {
  test("repo-less createThread and detach converge on the same persisted default mode", async () => {
    const ownerTokenIdentifier = "user|chat-default-mode";
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, ownerTokenIdentifier);

    const threadId = await t.run(async (ctx) => {
      return await ctx.db.insert("threads", {
        repositoryId,
        ownerTokenIdentifier,
        title: "Grounded thread",
        mode: "lab",
        lastMessageAt: Date.now(),
      });
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await viewer.mutation(api.chat.threads.setThreadRepository, {
      threadId,
      repositoryId: null,
    });
    const empty = await viewer.mutation(api.chat.threads.createThread, {});

    const { detachedThread, emptyThread } = await t.run(async (ctx) => ({
      detachedThread: await ctx.db.get(threadId),
      emptyThread: await ctx.db.get(empty._id),
    }));

    expect(detachedThread?.repositoryId).toBeUndefined();
    expect(detachedThread?.mode).toBe("discuss");
    expect(empty.mode).toBe("discuss");
    expect(emptyThread?.mode).toBe("discuss");
    expect(detachedThread?.mode).toBe(emptyThread?.mode);
  });

  test("createThread defaults to library when a repository is attached", async () => {
    const ownerTokenIdentifier = "user|chat-default-attached-mode";
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, ownerTokenIdentifier);

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const created = await viewer.mutation(api.chat.threads.createThread, { repositoryId });

    const thread = await t.run(async (ctx) => await ctx.db.get(created._id));
    expect(created.mode).toBe("library");
    expect(thread?.mode).toBe("library");
    expect(thread?.repositoryId).toBe(repositoryId);
  });

  test("setThreadRepository moves a repo-less thread out of discuss into the repo default mode", async () => {
    const ownerTokenIdentifier = "user|chat-attach-mode";
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, ownerTokenIdentifier);

    // Start from a repo-less thread that's in `discuss` (the no-repo default).
    const threadId = await t.run(async (ctx) => {
      return await ctx.db.insert("threads", {
        ownerTokenIdentifier,
        title: "Free-form thread",
        mode: "discuss",
        lastMessageAt: Date.now(),
      });
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await viewer.mutation(api.chat.threads.setThreadRepository, { threadId, repositoryId });

    const thread = await t.run(async (ctx) => await ctx.db.get(threadId));
    expect(thread?.repositoryId).toBe(repositoryId);
    // Attaching a repo lifts the thread out of `discuss` into the repo
    // default (`library`), mirroring createThread.
    expect(thread?.mode).toBe("library");
  });

  test("setThreadRepository preserves the user-chosen mode when swapping between repositories", async () => {
    const ownerTokenIdentifier = "user|chat-swap-mode";
    const t = convexTest(schema, modules);
    const repositoryAId = await insertRepository(t, ownerTokenIdentifier);
    // Second repo, distinct sourceUrl so insertRepository's hard-coded slug
    // doesn't collide with the first.
    const repositoryBId = await t.run(async (ctx) => {
      return await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/widget-fork",
        sourceRepoFullName: "acme/widget-fork",
        sourceRepoOwner: "acme",
        sourceRepoName: "widget-fork",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
      });
    });

    // Thread is attached to repo A and the user explicitly chose `discuss`
    // (allowed by the resolver when a repo+sandbox is bound). A repo-A →
    // repo-B swap must not silently override that choice.
    const threadId = await t.run(async (ctx) => {
      return await ctx.db.insert("threads", {
        repositoryId: repositoryAId,
        ownerTokenIdentifier,
        title: "Already grounded",
        mode: "discuss",
        lastMessageAt: Date.now(),
      });
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const swapOut = await viewer.mutation(api.chat.threads.setThreadRepository, {
      threadId,
      repositoryId: repositoryBId,
    });

    expect(swapOut).toMatchObject({
      repositoryId: repositoryBId,
      swappedFromRepositoryId: repositoryAId,
    });

    const thread = await t.run(async (ctx) => await ctx.db.get(threadId));
    expect(thread?.repositoryId).toBe(repositoryBId);
    // Mode is preserved: only the repo/workspace pointer changed.
    expect(thread?.mode).toBe("discuss");
  });

  test("createThread rejects mismatched workspace and repository ids", async () => {
    const ownerTokenIdentifier = "user|chat-workspace-mismatch";
    const t = convexTest(schema, modules);
    const workspaceRepositoryId = await insertRepository(t, ownerTokenIdentifier);
    const otherRepositoryId = await t.run(async (ctx) => {
      return await ctx.db.insert("repositories", {
        ownerTokenIdentifier,
        sourceHost: "github",
        sourceUrl: "https://github.com/acme/other-widget",
        sourceRepoFullName: "acme/other-widget",
        sourceRepoOwner: "acme",
        sourceRepoName: "other-widget",
        defaultBranch: "main",
        visibility: "private",
        accessMode: "private",
        importStatus: "completed",
        detectedLanguages: [],
        packageManagers: [],
        entrypoints: [],
        fileCount: 0,
      });
    });
    const workspaceId = await t.run(async (ctx) => {
      return await ctx.db.insert("workspaces", {
        ownerTokenIdentifier,
        repositoryId: workspaceRepositoryId,
        name: "acme/widget",
        color: "blue",
        lastAccessedAt: Date.now(),
      });
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await expect(
      viewer.mutation(api.chat.threads.createThread, {
        workspaceId,
        repositoryId: otherRepositoryId,
      }),
    ).rejects.toThrow("Thread repository must match the workspace repository.");
  });
});

describe("sendMessageStartingNewThread", () => {
  test("happy path: creates a thread, user + assistant messages, job, and stream in one transaction", async () => {
    const ownerTokenIdentifier = "user|lazy-first-send-happy";
    const t = createTestConvex();
    const homeWorkspaceId = await insertHomeWorkspace(t, ownerTokenIdentifier);

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const result = await viewer.mutation(api.chat.send.sendMessageStartingNewThread, {
      workspaceId: homeWorkspaceId,
      content: "hello world",
      mode: "discuss",
    });

    expect(result.mode).toBe("discuss");
    expect(typeof result.threadId).toBe("string");
    expect(typeof result.userMessageId).toBe("string");
    expect(typeof result.assistantMessageId).toBe("string");
    expect(typeof result.jobId).toBe("string");

    await t.run(async (ctx) => {
      const thread = await ctx.db.get(result.threadId);
      expect(thread?.workspaceId).toBe(homeWorkspaceId);
      expect(thread?.mode).toBe("discuss");
      expect(thread?.title).toBe("New design conversation");

      const userMessage = await ctx.db.get(result.userMessageId);
      expect(userMessage?.role).toBe("user");
      expect(userMessage?.content).toBe("hello world");
      expect(userMessage?.mode).toBe("discuss");

      const assistantMessage = await ctx.db.get(result.assistantMessageId);
      expect(assistantMessage?.role).toBe("assistant");
      expect(assistantMessage?.status).toBe("pending");

      const job = await ctx.db.get(result.jobId);
      expect(job?.kind).toBe("chat");
      expect(job?.status).toBe("queued");
      expect(job?.threadId).toBe(result.threadId);

      const streams = await ctx.db
        .query("messageStreams")
        .withIndex("by_threadId", (q) => q.eq("threadId", result.threadId))
        .collect();
      expect(streams).toHaveLength(1);
      expect(streams[0]?.assistantMessageId).toBe(result.assistantMessageId);
    });
  });

  test("library mode without an attached repository throws", async () => {
    const ownerTokenIdentifier = "user|lazy-library-no-repo";
    const t = createTestConvex();
    const homeWorkspaceId = await insertHomeWorkspace(t, ownerTokenIdentifier);

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await expect(
      viewer.mutation(api.chat.send.sendMessageStartingNewThread, {
        workspaceId: homeWorkspaceId,
        content: "anything",
        mode: "library",
      }),
    ).rejects.toThrow("'library' mode requires an attached repository.");
  });

  test("a different viewer cannot start a thread in someone else's workspace", async () => {
    const ownerTokenIdentifier = "user|lazy-owner";
    const intruderIdentifier = "user|lazy-intruder";
    const t = createTestConvex();
    const homeWorkspaceId = await insertHomeWorkspace(t, ownerTokenIdentifier);

    const intruder = t.withIdentity({ tokenIdentifier: intruderIdentifier });
    await expect(
      intruder.mutation(api.chat.send.sendMessageStartingNewThread, {
        workspaceId: homeWorkspaceId,
        content: "trying",
        mode: "discuss",
      }),
    ).rejects.toThrow("Workspace not found.");
  });

  test("empty content is rejected without inserting a thread", async () => {
    const ownerTokenIdentifier = "user|lazy-empty-content";
    const t = createTestConvex();
    const homeWorkspaceId = await insertHomeWorkspace(t, ownerTokenIdentifier);

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await expect(
      viewer.mutation(api.chat.send.sendMessageStartingNewThread, {
        workspaceId: homeWorkspaceId,
        content: "   ",
        mode: "discuss",
      }),
    ).rejects.toThrow("Message content cannot be empty.");

    const threads = await t.run(
      async (ctx) =>
        await ctx.db
          .query("threads")
          .withIndex("by_workspaceId_and_lastMessageAt", (q) => q.eq("workspaceId", homeWorkspaceId))
          .collect(),
    );
    expect(threads).toHaveLength(0);
  });

  test("lab mode without a repo workspace throws and leaves no orphan thread", async () => {
    const ownerTokenIdentifier = "user|lazy-lab-no-repo";
    const t = createTestConvex();
    const homeWorkspaceId = await insertHomeWorkspace(t, ownerTokenIdentifier);

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await expect(
      viewer.mutation(api.chat.send.sendMessageStartingNewThread, {
        workspaceId: homeWorkspaceId,
        content: "lab attempt",
        mode: "lab",
      }),
    ).rejects.toThrow("'lab' mode requires an attached repository.");

    const threads = await t.run(
      async (ctx) =>
        await ctx.db
          .query("threads")
          .withIndex("by_workspaceId_and_lastMessageAt", (q) => q.eq("workspaceId", homeWorkspaceId))
          .collect(),
    );
    expect(threads).toHaveLength(0);
  });

  test("created thread inherits the workspace's repository when one is attached", async () => {
    const ownerTokenIdentifier = "user|lazy-with-repo";
    const t = createTestConvex();
    const repositoryId = await insertRepository(t, ownerTokenIdentifier);
    const workspaceId = await insertWorkspaceWithRepository(t, ownerTokenIdentifier, repositoryId);
    // Library Ask eligibility requires at least one artifact in the workspace's
    // repo. Seed a minimal artifact so the `library` mode eligibility check
    // doesn't reject the send.
    await t.run(async (ctx) => {
      await ctx.db.insert("artifacts", {
        repositoryId,
        ownerTokenIdentifier,
        kind: "architecture_overview",
        title: "seed",
        summary: "seed",
        contentMarkdown: "seed",
        source: "heuristic",
        version: 1,
      });
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const result = await viewer.mutation(api.chat.send.sendMessageStartingNewThread, {
      workspaceId,
      content: "library question",
      mode: "library",
    });

    expect(result.mode).toBe("library");
    await t.run(async (ctx) => {
      const thread = await ctx.db.get(result.threadId);
      expect(thread?.repositoryId).toBe(repositoryId);
      expect(thread?.title).toBe("widget chat");
    });
  });
});
