import { v } from "convex/values";
import { internalMutation, query } from "../_generated/server";
import { requireViewerIdentity } from "../lib/auth";
import { CHAT_JOB_LEASE_MS } from "../lib/rateLimit";
import { logWarn } from "../lib/observability";
import {
  compactMessageStreamTail,
  deleteMessageStreamState,
  getMessageStreamByThread,
  getMessageStreamByAssistantMessageId,
  getMessageStreamByJobId,
  loadAllStreamTailChunks,
  loadMessageStreamSnapshot,
} from "./streamStore";

const STALE_CHAT_JOB_ERROR_MESSAGE = "The assistant reply stalled and was automatically marked as failed.";

export const getActiveMessageStream = query({
  args: {
    threadId: v.id("threads"),
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

    if (thread.repositoryId) {
      const repository = await ctx.db.get(thread.repositoryId);
      if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
        throw new Error("Thread not found.");
      }
    }

    const stream = await getMessageStreamByThread(ctx, args.threadId);
    if (!stream) {
      return null;
    }

    const assistantMessage = await ctx.db.get(stream.assistantMessageId);
    if (!assistantMessage || assistantMessage.status !== "streaming") {
      return null;
    }

    const tailChunks = await loadAllStreamTailChunks(ctx, stream);

    return {
      assistantMessageId: stream.assistantMessageId,
      content: `${stream.compactedContent}${tailChunks.map((chunk) => chunk.text).join("")}`,
      startedAt: stream.startedAt,
      lastAppendedAt: stream.lastAppendedAt,
    };
  },
});

export const markAssistantReplyRunning = internalMutation({
  args: {
    assistantMessageId: v.id("messages"),
    jobId: v.id("jobs"),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.patch(args.assistantMessageId, {
      status: "streaming",
    });
    await ctx.db.patch(args.jobId, {
      status: "running",
      stage: "generating_reply",
      progress: 0.15,
      startedAt: now,
      leaseExpiresAt: now + CHAT_JOB_LEASE_MS,
    });
  },
});

export const appendAssistantStreamChunk = internalMutation({
  args: {
    assistantMessageId: v.id("messages"),
    jobId: v.id("jobs"),
    delta: v.string(),
  },
  handler: async (ctx, args) => {
    if (!args.delta) {
      return;
    }

    const stream = await getMessageStreamByAssistantMessageId(ctx, args.assistantMessageId);
    if (!stream) {
      logWarn("chat", "assistant_stream_missing_for_chunk_append", {
        assistantMessageId: args.assistantMessageId,
        deltaLength: args.delta.length,
        hint: "messageStreamChunks append skipped before compactMessageStreamTail",
      });
      throw new Error(
        "Missing message stream while appending assistant delta: messageStreamChunks append aborted before compactMessageStreamTail.",
      );
    }

    const now = Date.now();
    await ctx.db.insert("messageStreamChunks", {
      streamId: stream._id,
      sequence: stream.nextSequence,
      text: args.delta,
    });
    await ctx.db.patch(stream._id, {
      nextSequence: stream.nextSequence + 1,
      lastAppendedAt: now,
    });

    // Refresh job lease so long streams don't get marked stale by
    // recoverStaleChatJob mid-flight. We piggy-back the previous
    // `stream.lastAppendedAt` (which is updated in lockstep with the lease in
    // markAssistantReplyRunning and on each successful append) as a free
    // proxy for "when did we last refresh the lease?". If less than half a
    // lease window has passed we skip the write — at the per-flush cadence
    // (~once per STREAM_FLUSH_THRESHOLD chars) this saves one job patch per
    // chunk for the typical sub-minute reply while still guaranteeing the
    // lease is renewed well before it expires on long-running streams.
    const leaseRefreshDeadline = now - Math.floor(CHAT_JOB_LEASE_MS / 2);
    if (stream.lastAppendedAt <= leaseRefreshDeadline) {
      await ctx.db.patch(args.jobId, {
        leaseExpiresAt: now + CHAT_JOB_LEASE_MS,
      });
    }

    await compactMessageStreamTail(ctx, stream._id);
  },
});

export const finalizeAssistantReply = internalMutation({
  args: {
    threadId: v.id("threads"),
    assistantMessageId: v.id("messages"),
    jobId: v.id("jobs"),
    finalDelta: v.string(),
    inputTokens: v.optional(v.number()),
    outputTokens: v.optional(v.number()),
    costUsd: v.optional(v.number()),
    /**
     * Plan 02 citation map: numbered `[A#] → artifactId` entries for the
     * artifacts that ended up in the prompt. Optional so non-docs replies
     * (and pre-Plan-02 messages) keep the field unset rather than written as
     * an empty array — the frontend treats both as "no resolvable citations".
     */
    citationMap: v.optional(
      v.array(
        v.object({
          index: v.number(),
          artifactId: v.id("artifacts"),
        }),
      ),
    ),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const message = await ctx.db.get(args.assistantMessageId);
    const streamSnapshot = await loadMessageStreamSnapshot(ctx, args.assistantMessageId);

    try {
      if (message) {
        const finalContent = `${streamSnapshot?.content ?? message.content}${args.finalDelta}`;
        await ctx.db.patch(args.assistantMessageId, {
          content: finalContent,
          status: "completed",
          errorMessage: undefined,
          estimatedInputTokens: args.inputTokens,
          estimatedOutputTokens: args.outputTokens,
          citationMap: args.citationMap,
        });
        // The thread may have been deleted while we were streaming. Patching a
        // missing doc throws and would roll back the whole mutation (so the
        // job lease and persisted stream state would never be cleared). Wrap
        // it so the rest of the cleanup still runs.
        try {
          await ctx.db.patch(args.threadId, {
            lastAssistantMessageAt: now,
            lastMessageAt: now,
          });
        } catch (error) {
          logWarn("chat", "finalize_thread_patch_failed", {
            threadId: args.threadId,
            jobId: args.jobId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else {
        logWarn("chat", "finalize_assistant_message_missing", {
          assistantMessageId: args.assistantMessageId,
          jobId: args.jobId,
        });
      }

      // Always release the job lease so the per-thread in-flight gate clears,
      // even when the assistant message has been deleted (e.g. concurrent
      // thread or repository deletion). If the message is gone we can't
      // deliver the reply, so mark the job as failed instead of completed.
      if (message) {
        await ctx.db.patch(args.jobId, {
          status: "completed",
          stage: "completed",
          progress: 1,
          completedAt: now,
          outputSummary: "Assistant reply generated.",
          estimatedInputTokens: args.inputTokens,
          estimatedOutputTokens: args.outputTokens,
          estimatedCostUsd: args.costUsd,
          leaseExpiresAt: undefined,
        });
      } else {
        await ctx.db.patch(args.jobId, {
          status: "failed",
          stage: "failed",
          progress: 1,
          completedAt: now,
          errorMessage: "Assistant message was deleted before the reply could be persisted.",
          leaseExpiresAt: undefined,
        });
      }
    } finally {
      // Always remove persisted stream state on completion. Note: Convex
      // mutations are transactional, so if any write above throws the
      // transaction rolls back and this cleanup is reverted along with the
      // rest of the writes (recoverStaleChatJob will retry from the lease).
      // Keeping the cleanup in `finally` documents the intent and protects
      // against future refactors that wrap individual writes in try/catch.
      if (streamSnapshot) {
        await deleteMessageStreamState(ctx, streamSnapshot.stream._id);
      }
    }
  },
});

export const failAssistantReply = internalMutation({
  args: {
    assistantMessageId: v.id("messages"),
    jobId: v.id("jobs"),
    errorMessage: v.string(),
    finalDelta: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    const streamSnapshot = await loadMessageStreamSnapshot(ctx, args.assistantMessageId);
    const message = await ctx.db.get(args.assistantMessageId);

    try {
      if (message) {
        const streamedContent = `${streamSnapshot?.content ?? message.content}${args.finalDelta ?? ""}`;
        await ctx.db.patch(args.assistantMessageId, {
          status: "failed",
          errorMessage: args.errorMessage,
          content: streamedContent || args.errorMessage,
        });
      } else {
        logWarn("chat", "fail_assistant_message_missing", {
          assistantMessageId: args.assistantMessageId,
          jobId: args.jobId,
        });
      }

      // Always fail the job and release its lease, regardless of whether the
      // assistant message still exists. Otherwise the in-flight gate would
      // stay engaged until the lease expires and recoverStaleChatJob fires.
      await ctx.db.patch(args.jobId, {
        status: "failed",
        stage: "failed",
        progress: 1,
        completedAt: now,
        errorMessage: args.errorMessage,
        leaseExpiresAt: undefined,
      });
    } finally {
      if (streamSnapshot) {
        await deleteMessageStreamState(ctx, streamSnapshot.stream._id);
      }
    }
  },
});

export const recoverStaleChatJob = internalMutation({
  args: {
    jobId: v.id("jobs"),
    errorMessage: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const job = await ctx.db.get(args.jobId);
    const now = Date.now();
    if (
      !job ||
      job.kind !== "chat" ||
      (job.status !== "queued" && job.status !== "running") ||
      typeof job.leaseExpiresAt !== "number" ||
      job.leaseExpiresAt > now
    ) {
      return;
    }

    const message = args.errorMessage ?? STALE_CHAT_JOB_ERROR_MESSAGE;
    const jobMessages = await ctx.db
      .query("messages")
      .withIndex("by_jobId", (q) => q.eq("jobId", args.jobId))
      .take(10);
    const assistantMessage = jobMessages.find((entry) => entry.role === "assistant");
    const stream = await getMessageStreamByJobId(ctx, args.jobId);
    const streamSnapshot =
      assistantMessage && stream ? await loadMessageStreamSnapshot(ctx, assistantMessage._id) : null;

    if (assistantMessage) {
      await ctx.db.patch(assistantMessage._id, {
        status: "failed",
        errorMessage: message,
        content: streamSnapshot?.content || message,
      });
    }

    await ctx.db.patch(args.jobId, {
      status: "failed",
      stage: "failed",
      progress: 1,
      completedAt: now,
      errorMessage: message,
      leaseExpiresAt: undefined,
    });

    if (stream) {
      await deleteMessageStreamState(ctx, stream._id);
    }
  },
});
