/// <reference types="vite/client" />

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { api } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

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
        mode: "sandbox",
        lastMessageAt: Date.now(),
      });
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await viewer.mutation(api.chat.threads.setThreadRepository, {
      threadId,
      repositoryId: null,
    });
    const emptyThreadId = await viewer.mutation(api.chat.threads.createThread, {});

    const { detachedThread, emptyThread } = await t.run(async (ctx) => ({
      detachedThread: await ctx.db.get(threadId),
      emptyThread: await ctx.db.get(emptyThreadId),
    }));

    expect(detachedThread?.repositoryId).toBeUndefined();
    expect(detachedThread?.mode).toBe("discuss");
    expect(emptyThread?.mode).toBe("discuss");
    expect(detachedThread?.mode).toBe(emptyThread?.mode);
  });

  test("createThread defaults to ask when a repository is attached", async () => {
    const ownerTokenIdentifier = "user|chat-default-attached-mode";
    const t = convexTest(schema, modules);
    const repositoryId = await insertRepository(t, ownerTokenIdentifier);

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const threadId = await viewer.mutation(api.chat.threads.createThread, { repositoryId });

    const thread = await t.run(async (ctx) => await ctx.db.get(threadId));
    expect(thread?.mode).toBe("ask");
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
    // Attaching a repo must lift the thread out of `discuss` and into the
    // post-restructure artifact-grounded mode, mirroring createThread so the
    // persisted mode stays in lockstep with Phase 3's no-new-docs invariant.
    expect(thread?.mode).toBe("ask");
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
    await viewer.mutation(api.chat.threads.setThreadRepository, {
      threadId,
      repositoryId: repositoryBId,
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
