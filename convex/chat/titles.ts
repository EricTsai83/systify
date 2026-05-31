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
import { costUsdToCents } from "../lib/llmPricing";
import { consumeSandboxDailyCost } from "../lib/rateLimit";
import { isDefaultTitle } from "../lib/threadDefaults";

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

/**
 * Settle the daily sandbox-cost cap for a title-gen LLM call. The Node
 * action that owns the `generateViaGateway` call cannot reach mutation
 * helpers directly, so the settlement is wrapped here and invoked via
 * `ctx.runMutation` from {@link ./titlesNode}.
 *
 * Looks up the thread to recover `repositoryId`; a deleted thread degrades
 * to user-only settlement (mirrors {@link ./streaming}'s pattern). The
 * `costUsdToCents` short-circuit on `undefined` / non-positive amounts is
 * idempotent inside `consumeSandboxDailyCost`, so the call site can
 * forward `undefined` cost without branching first.
 */
export const settleTitleGenCost = internalMutation({
  args: {
    threadId: v.id("threads"),
    costUsd: v.optional(v.number()),
    ownerTokenIdentifier: v.string(),
  },
  handler: async (ctx, args) => {
    const cents = costUsdToCents(args.costUsd);
    if (cents === undefined || cents <= 0) {
      return;
    }
    const thread = await ctx.db.get(args.threadId);
    const repositoryId = thread?.repositoryId ?? null;
    await consumeSandboxDailyCost(ctx, {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId,
      cents,
    });
  },
});
