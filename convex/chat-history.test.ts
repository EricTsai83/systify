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
