/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { MAX_CONTEXT_MESSAGES, MAX_VISIBLE_MESSAGES } from "./lib/constants";
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

  test("listMessages returns the most recent messages in chronological order", async () => {
    const ownerTokenIdentifier = "user|chat-history-list";
    const t = convexTest(schema, modules);
    const { threadId, contents } = await seedThreadWithMessages(t, ownerTokenIdentifier, MAX_VISIBLE_MESSAGES + 5);

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const messages = await viewer.query(api.chat.threads.listMessages, { threadId });

    expect(messages).toHaveLength(MAX_VISIBLE_MESSAGES);
    expect(messages.map((message) => message.content)).toEqual(contents.slice(-MAX_VISIBLE_MESSAGES));
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
    const messages = await viewer.query(api.chat.threads.listMessages, { threadId });
    const context = await t.query(internal.chat.context.getReplyContext, {
      threadId,
      userMessageId: latestUserMessageId,
    });

    expect(messages.at(-1)?.content).toBe("");
    expect(context.messages.at(-1)?.content).toBe("message-3");
  });

  test("listMessages returns assistant replies from every mode the thread has been in", async () => {
    // Plan 03 contract divergence: the cross-mode assistant filter only
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

      // discuss-mode round followed by a sandbox-mode round.
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
        mode: "lab",
        content: "sandbox-question",
      });
      vi.advanceTimersByTime(1_000);
      await ctx.db.insert("messages", {
        threadId,
        ownerTokenIdentifier,
        role: "assistant",
        status: "completed",
        mode: "lab",
        content: "sandbox-answer",
      });

      return threadId;
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const messages = await viewer.query(api.chat.threads.listMessages, { threadId });

    // Every message — including the cross-mode `discuss` assistant reply —
    // is visible to the UI, in chronological order.
    expect(messages.map((message) => ({ role: message.role, mode: message.mode, content: message.content }))).toEqual([
      { role: "user", mode: "discuss", content: "discuss-question" },
      { role: "assistant", mode: "discuss", content: "discuss-answer" },
      { role: "user", mode: "lab", content: "sandbox-question" },
      { role: "assistant", mode: "lab", content: "sandbox-answer" },
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
