/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { CHAT_MESSAGES_FIRST_PAGE_ARGS, MAX_CONTEXT_MESSAGES } from "./lib/constants";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("chat history ordering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-20T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("listMessagesPaginated returns descending pages and walks the cursor to exhaustion", async () => {
    // Server returns newest-first pages; the client reverses the
    // flattened result set into ascending order before rendering. This
    // test pins both halves of that contract:
    //   1. Each page from the server is in DESC creation-time order.
    //   2. Walking the cursor visits every message exactly once before
    //      `isDone` flips to true (no off-by-one at the tail).
    const ownerTokenIdentifier = "user|chat-history-paginated";
    const t = convexTest(schema, modules);
    const totalMessages = 25;
    const pageSize = 10;
    const { threadId, contents } = await seedThreadWithMessages(t, ownerTokenIdentifier, totalMessages);

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const collected: string[] = [];
    let cursor: string | null = null;
    let pageCount = 0;
    let lastIsDone = false;
    // Bound the loop defensively so a regression in cursor advancement
    // cannot turn this into an infinite test.
    for (let guard = 0; guard < 10; guard += 1) {
      const result: {
        page: Doc<"messages">[];
        isDone: boolean;
        continueCursor: string;
      } = await viewer.query(api.chat.threads.listMessagesPaginated, {
        threadId,
        paginationOpts: { numItems: pageSize, cursor },
      });
      pageCount += 1;
      // Each individual page is in descending order — the most recent
      // message in the page sits at index 0.
      for (let i = 1; i < result.page.length; i += 1) {
        expect(result.page[i]._creationTime).toBeLessThanOrEqual(result.page[i - 1]._creationTime);
      }
      collected.push(...result.page.map((m) => m.content));
      lastIsDone = result.isDone;
      if (result.isDone) break;
      cursor = result.continueCursor;
    }

    // 25 messages / 10 per page → 3 pages (10 + 10 + 5).
    expect(pageCount).toBe(3);
    expect(lastIsDone).toBe(true);
    // The concatenation of pages is newest-first across all pages.
    // Reversing matches the ascending order the seeder produced.
    expect([...collected].reverse()).toEqual(contents);
  });

  test("getReplyContext trims old messages and preserves the latest conversation", async () => {
    const ownerTokenIdentifier = "user|chat-history-context";
    const t = convexTest(schema, modules);
    const { threadId, latestUserMessageId, contents } = await seedThreadWithMessages(
      t,
      ownerTokenIdentifier,
      MAX_CONTEXT_MESSAGES + 5,
    );

    const context = await t.query(internal.chat.context.getReplyContext, {
      threadId,
      userMessageId: latestUserMessageId,
    });

    expect(context.messages).toHaveLength(MAX_CONTEXT_MESSAGES);
    expect(context.messages.map((message) => message.content)).toEqual(contents.slice(-MAX_CONTEXT_MESSAGES));
  });

  test("getReplyContext ignores an empty assistant placeholder message", async () => {
    const ownerTokenIdentifier = "user|chat-history-placeholder";
    const t = convexTest(schema, modules);
    const { repositoryId, threadId, latestUserMessageId } = await seedThreadWithMessages(t, ownerTokenIdentifier, 4);

    await t.run(async (ctx) => {
      await ctx.db.insert("messages", {
        repositoryId,
        threadId,
        ownerTokenIdentifier,
        role: "assistant",
        status: "streaming",
        mode: "discuss",
        content: "",
      });
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    // First (newest-first) page contains the streaming placeholder at the
    // head — the chat UI flips the array to ascending order at render
    // time, so the placeholder ends up at the *bottom* of the rendered
    // conversation. Anchoring on `page[0]` here matches that visual
    // expectation against the raw paginated response.
    const firstPage = await viewer.query(api.chat.threads.listMessagesPaginated, {
      threadId,
      paginationOpts: CHAT_MESSAGES_FIRST_PAGE_ARGS,
    });
    const context = await t.query(internal.chat.context.getReplyContext, {
      threadId,
      userMessageId: latestUserMessageId,
    });

    expect(firstPage.page.at(0)?.content).toBe("");
    expect(context.messages.at(-1)?.content).toBe("message-3");
  });

  test("listMessagesPaginated returns assistant replies from every mode the thread has been in", async () => {
    // Contract divergence: the cross-mode assistant filter only
    // applies to the LLM reply context (`getReplyContext`). The chat panel
    // still has to render every message the user can see in their thread,
    // including replies generated under a previous mode — otherwise
    // switching modes would visually erase part of the conversation, which
    // is the opposite of the desired UX. This test locks the UI side of
    // the contract so a future refactor that "unifies" the two paths
    // doesn't silently regress UI history.
    const ownerTokenIdentifier = "user|chat-history-cross-mode";
    const t = convexTest(schema, modules);

    const threadId = await t.run(async (ctx) => {
      const threadId = await ctx.db.insert("threads", {
        ownerTokenIdentifier,
        title: "Cross-mode UI thread",
        mode: "discuss",
        lastMessageAt: Date.now(),
      });

      // discuss-mode round followed by a library-mode round.
      await ctx.db.insert("messages", {
        threadId,
        ownerTokenIdentifier,
        role: "user",
        status: "completed",
        mode: "discuss",
        content: "discuss-question",
      });
      vi.advanceTimersByTime(1_000);
      await ctx.db.insert("messages", {
        threadId,
        ownerTokenIdentifier,
        role: "assistant",
        status: "completed",
        mode: "discuss",
        content: "discuss-answer",
      });
      vi.advanceTimersByTime(1_000);
      await ctx.db.insert("messages", {
        threadId,
        ownerTokenIdentifier,
        role: "user",
        status: "completed",
        mode: "library",
        content: "library-question",
      });
      vi.advanceTimersByTime(1_000);
      await ctx.db.insert("messages", {
        threadId,
        ownerTokenIdentifier,
        role: "assistant",
        status: "completed",
        mode: "library",
        content: "library-answer",
      });

      return threadId;
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const firstPage = await viewer.query(api.chat.threads.listMessagesPaginated, {
      threadId,
      paginationOpts: CHAT_MESSAGES_FIRST_PAGE_ARGS,
    });
    // Reverse the page to ascending order — the same transformation the
    // chat panel applies before rendering. Every message, including the
    // cross-mode `discuss` assistant reply, must surface to the UI.
    const messages = [...firstPage.page].reverse();
    expect(messages.map((message) => ({ role: message.role, mode: message.mode, content: message.content }))).toEqual([
      { role: "user", mode: "discuss", content: "discuss-question" },
      { role: "assistant", mode: "discuss", content: "discuss-answer" },
      { role: "user", mode: "library", content: "library-question" },
      { role: "assistant", mode: "library", content: "library-answer" },
    ]);
  });
});

async function seedThreadWithMessages(
  t: ReturnType<typeof convexTest>,
  ownerTokenIdentifier: string,
  messageCount: number,
) {
  return await t.run(async (ctx) => {
    const repositoryId = await ctx.db.insert("repositories", {
      ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: "https://github.com/acme/chat-history",
      sourceRepoFullName: "acme/chat-history",
      sourceRepoOwner: "acme",
      sourceRepoName: "chat-history",
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
    });

    const threadId = await ctx.db.insert("threads", {
      repositoryId,
      ownerTokenIdentifier,
      title: "History thread",
      mode: "discuss",
      lastMessageAt: Date.now(),
    });

    const contents: string[] = [];
    let latestUserMessageId: Id<"messages"> | undefined;
    for (let index = 0; index < messageCount; index += 1) {
      const content = `message-${index}`;
      contents.push(content);
      const role = index % 2 === 0 ? "user" : "assistant";
      const messageId = await ctx.db.insert("messages", {
        repositoryId,
        threadId,
        ownerTokenIdentifier,
        role,
        status: "completed",
        mode: "discuss",
        content,
      });
      if (role === "user") {
        latestUserMessageId = messageId;
      }
      vi.advanceTimersByTime(1_000);
    }

    if (!latestUserMessageId) {
      throw new Error("seedThreadWithMessages requires at least one user message; pass an even index 0 message.");
    }

    return { repositoryId, threadId, contents, latestUserMessageId };
  });
}
