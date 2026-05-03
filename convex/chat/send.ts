import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import { requireViewerIdentity } from "../lib/auth";
import {
  CHAT_JOB_LEASE_MS,
  consumeChatGlobalRateLimit,
  consumeChatRateLimit,
  getLeaseRetryAfterMs,
  isLeaseActive,
  throwOperationAlreadyInProgress,
} from "../lib/rateLimit";
import { getSandboxFeatureGate } from "../lib/sandboxFeatureFlag";

async function getActiveChatJobForThread(ctx: MutationCtx, threadId: Id<"threads">, now: number) {
  const jobs = await ctx.db
    .query("jobs")
    .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
    .order("desc")
    .take(25);

  return jobs.find(
    (job) =>
      job.kind === "chat" &&
      (job.status === "queued" || job.status === "running") &&
      isLeaseActive(job.leaseExpiresAt, now),
  );
}

export const sendMessage = mutation({
  args: {
    threadId: v.id("threads"),
    content: v.string(),
    mode: v.optional(v.union(v.literal("discuss"), v.literal("docs"), v.literal("sandbox"))),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const thread = await ctx.db.get(args.threadId);
    if (!thread) {
      throw new Error("Thread not found.");
    }

    if (thread.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Thread not found.");
    }

    let repository: Doc<"repositories"> | null = null;
    if (thread.repositoryId) {
      repository = await ctx.db.get(thread.repositoryId);
      if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
        throw new Error("Thread not found.");
      }
    }

    const mode = args.mode ?? thread.mode;

    // Mirror the resolver's preconditions on the write path. The UI
    // disabled-mode tooltips also encode these, but a direct mutation caller
    // (or a UI race where the user picked `sandbox` and then the sandbox
    // expired before they hit Send) needs the same gate enforced server-side.
    if ((mode === "docs" || mode === "sandbox") && !repository) {
      throw new Error(`'${mode}' mode requires an attached repository.`);
    }
    if (mode === "sandbox") {
      // Plan 04: re-check the feature gate at the write boundary. The
      // selector already disables sandbox mode for viewers outside the
      // allowlist, but a stale UI / a bypassed selector / a direct mutation
      // call would otherwise still queue a sandbox-mode reply. The gate
      // result is a value (not a throw) so we can surface a tooltip-quality
      // message verbatim.
      const sandboxGate = getSandboxFeatureGate(identity.tokenIdentifier);
      if (!sandboxGate.enabled) {
        throw new Error(sandboxGate.tooltip);
      }
      // `repository` is guaranteed non-null by the previous check, but TS
      // can't narrow across the `||` without restating it.
      const repo = repository!;
      const sandbox = repo.latestSandboxId ? await ctx.db.get(repo.latestSandboxId) : null;
      if (!sandbox || sandbox.status !== "ready") {
        throw new Error("'sandbox' mode requires the repository's sandbox to be in 'ready' state.");
      }
    }

    const trimmedContent = args.content.trim();
    if (!trimmedContent) {
      throw new Error("Message content cannot be empty.");
    }

    const now = Date.now();
    const activeJob = await getActiveChatJobForThread(ctx, args.threadId, now);

    if (activeJob) {
      throwOperationAlreadyInProgress(
        "threadChatInFlight",
        "An assistant reply is already in progress for this thread.",
        getLeaseRetryAfterMs(activeJob.leaseExpiresAt, now),
      );
    }

    await consumeChatRateLimit(ctx, identity.tokenIdentifier);
    await consumeChatGlobalRateLimit(ctx);

    const jobId = await ctx.db.insert("jobs", {
      repositoryId: thread.repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      sandboxId: repository?.latestSandboxId,
      threadId: args.threadId,
      kind: "chat",
      status: "queued",
      stage: "queued",
      progress: 0,
      // Sandbox mode is the only one that consumes Daytona compute, so it
      // bills against the `deep_analysis` cost category. `discuss` and `docs`
      // both stay on the standard `chat` category.
      costCategory: mode === "sandbox" ? "deep_analysis" : "chat",
      triggerSource: "user",
      leaseExpiresAt: now + CHAT_JOB_LEASE_MS,
    });

    const userMessageId = await ctx.db.insert("messages", {
      repositoryId: thread.repositoryId,
      threadId: args.threadId,
      jobId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      role: "user",
      status: "completed",
      mode,
      content: trimmedContent,
    });

    const assistantMessageId = await ctx.db.insert("messages", {
      repositoryId: thread.repositoryId,
      threadId: args.threadId,
      jobId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      role: "assistant",
      status: "pending",
      mode,
      content: "",
    });

    await ctx.db.insert("messageStreams", {
      repositoryId: thread.repositoryId,
      threadId: args.threadId,
      jobId,
      assistantMessageId,
      ownerTokenIdentifier: identity.tokenIdentifier,
      compactedContent: "",
      compactedThroughSequence: -1,
      nextSequence: 0,
      startedAt: now,
      lastAppendedAt: now,
    });

    await ctx.db.patch(args.threadId, {
      mode,
      lastMessageAt: now,
    });

    await ctx.scheduler.runAfter(0, internal.chat.generation.generateAssistantReply, {
      threadId: args.threadId,
      userMessageId,
      assistantMessageId,
      jobId,
    });

    return {
      jobId,
      userMessageId,
      assistantMessageId,
    };
  },
});
