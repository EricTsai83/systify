/**
 * Title autogen support — the non-Node half.
 *
 * Holds the helper `loadTitleGenContext` query and `patchThreadTitle`
 * mutation that bookend the LLM call. The Node-only action that owns the
 * `generateText` call lives in {@link ./titlesNode}: Convex's runtime
 * boundary disallows queries / mutations inside a `"use node"` module, so
 * the file split is the canonical workaround (same split as
 * `chat/generation.ts` → `chat/streaming.ts` and
 * `systemDesignNode.ts` → `systemDesign.ts`).
 *
 * See {@link ./titlesNode} for the autogen flow's high-level docs — this
 * module is only the database surface area.
 */

import { v } from "convex/values";
import type { Doc } from "../_generated/dataModel";
import { internalMutation, internalQuery } from "../_generated/server";
import { isDefaultTitle } from "../lib/threadDefaults";
import { buildUsageSourceId } from "../lib/usageAccounting";
import { settleUsageLifecycleInMutation } from "../lib/usageAccountingMutations";

export interface TitleGenContext {
  thread: Doc<"threads">;
  userMessage: Doc<"messages">;
  artifactTitles: string[];
}

export const loadTitleGenContext = internalQuery({
  args: {
    threadId: v.id("threads"),
    userMessageId: v.id("messages"),
  },
  handler: async (ctx, args): Promise<TitleGenContext | null> => {
    const thread = await ctx.db.get(args.threadId);
    const userMessage = await ctx.db.get(args.userMessageId);
    if (!thread || !userMessage) {
      return null;
    }

    // Library Ask threads carry an `artifactContext` scope filter. Surface
    // the artifact titles so the prompt can hint at "this is a question
    // about artifact X", which produces sharper titles than treating every
    // Library question as generic. Failure to load an artifact (e.g. it
    // was deleted between thread creation and now) silently degrades to
    // the no-context prompt branch — better than failing the whole title
    // pass over a missing row.
    const artifactTitles: string[] = [];
    if (thread.mode === "library" && thread.artifactContext && thread.artifactContext.length > 0) {
      for (const artifactId of thread.artifactContext) {
        const artifact = await ctx.db.get(artifactId);
        if (artifact) {
          artifactTitles.push(artifact.title);
        }
      }
    }

    return { thread, userMessage, artifactTitles };
  },
});

export const patchThreadTitle = internalMutation({
  args: {
    threadId: v.id("threads"),
    title: v.string(),
  },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    if (!thread) {
      return;
    }
    // Race guard: the user (or some other autogen pass) may have renamed
    // this thread while the LLM was running. A non-default title is a
    // signal that someone has committed an intent we don't want to
    // clobber, so silently skip the patch.
    if (!isDefaultTitle(thread)) {
      return;
    }
    await ctx.db.patch(args.threadId, { title: args.title });
  },
});

/** Compatibility shim for older internal callers; new title gen uses the lifecycle mutation directly. */
export const settleTitleGenCost = internalMutation({
  args: {
    threadId: v.id("threads"),
    userMessageId: v.id("messages"),
    costUsd: v.optional(v.number()),
    ownerTokenIdentifier: v.string(),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    cachedInputTokens: v.optional(v.number()),
    cacheWriteTokens: v.optional(v.number()),
    reasoningTokens: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const thread = await ctx.db.get(args.threadId);
    await settleUsageLifecycleInMutation(ctx, {
      sourceId: buildUsageSourceId.title(args.threadId, args.userMessageId),
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: thread?.repositoryId ?? null,
      feature: "titleGeneration",
      occurredAtMs: Date.now(),
      usage: {
        costUsd: args.costUsd,
        inputTokens: args.inputTokens,
        outputTokens: args.outputTokens,
        cachedInputTokens: args.cachedInputTokens,
        cacheWriteTokens: args.cacheWriteTokens,
        reasoningTokens: args.reasoningTokens,
      },
    });
  },
});
