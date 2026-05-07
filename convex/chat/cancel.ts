/**
 * Plan 07 — owner-initiated cancellation of an in-flight chat reply.
 *
 * The user-facing contract:
 *
 *   1. While a reply streams, the chat panel renders Stop in place of Send.
 *   2. Clicking Stop calls `cancelInFlightReply(threadId)`.
 *   3. Within ~1 lease-poll tick (≤ `CANCELLATION_POLL_INTERVAL_MS`,
 *      see `convex/chat/generation.ts`) the streaming action notices the
 *      cancellation, aborts its `streamText` request, persists whatever
 *      partial content was already streamed, and the message bubble
 *      transitions to status `"cancelled"` with content = partial reply +
 *      "Cancelled by user." in `errorMessage`.
 *
 * Why this mutation flips the assistant message *immediately* (instead of
 * only flipping the job and waiting for the action to react):
 *
 *   - The UI must give instant feedback. Without an immediate status flip,
 *     the user could click Stop and watch the message keep streaming for a
 *     second before the bubble transitions, which feels broken.
 *   - The streaming action is cooperative: it polls
 *     `getJobCancellationStatus` and aborts its own `streamText` request.
 *     Flipping the message status here makes the cancel observable in the
 *     reactive UI even if the action is currently mid-tool-call (Daytona
 *     SDK does not support mid-flight kill, so the in-flight tool runs to
 *     completion — but the user sees "Cancelled" in the bubble immediately
 *     and the action stops issuing further tool calls / text deltas as
 *     soon as the polling window catches up).
 *
 * Why no lease check: the spec calls this out explicitly — the owner is
 * cancelling their own reply, so there is no concurrent-writer hazard the
 * lease would protect against. We still take the per-thread ownership check
 * via `requireViewerIdentity` so a different identity can't poke at someone
 * else's stream.
 */

import { v } from "convex/values";
import { mutation } from "../_generated/server";
import { requireViewerIdentity } from "../lib/auth";
import { cancelActiveJob } from "../jobLifecycle";
import { logInfo } from "../lib/observability";
import { isLeaseActive } from "../lib/rateLimit";

export const cancelInFlightReply = mutation({
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
      // Same fence as `listMessages` / `sendMessage` — return the same
      // "Thread not found" error so the existence of the thread is not
      // disclosed to non-owners.
      throw new Error("Thread not found.");
    }

    if (thread.repositoryId) {
      const repository = await ctx.db.get(thread.repositoryId);
      if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
        throw new Error("Thread not found.");
      }
    }

    const now = Date.now();

    // Active chat job lookup mirrors `chat/send.ts:getActiveChatJobForThread`,
    // but intentionally skips the lease predicate: owners may cancel their own
    // stale-looking reply even when the worker has stopped refreshing its lease.
    const runningJob = await ctx.db
      .query("jobs")
      .withIndex("by_threadId_and_kind_and_status_and_leaseExpiresAt", (q) =>
        q.eq("threadId", args.threadId).eq("kind", "chat").eq("status", "running"),
      )
      .order("desc")
      .first();
    const queuedJob = await ctx.db
      .query("jobs")
      .withIndex("by_threadId_and_kind_and_status_and_leaseExpiresAt", (q) =>
        q.eq("threadId", args.threadId).eq("kind", "chat").eq("status", "queued"),
      )
      .order("desc")
      .first();

    const activeJob = runningJob ?? queuedJob;

    if (!activeJob) {
      // No-op race: the user clicked Stop just as the reply finalized (or
      // already failed / cancelled). Returning a structured `null` lets the
      // frontend render the post-cancel state idempotently — no toast, no
      // error — since the desired end state ("not streaming") is already
      // reached.
      logInfo("chat", "cancel_no_active_job", {
        threadId: args.threadId,
        ownerTokenIdentifier: identity.tokenIdentifier,
      });
      return { cancelled: false as const };
    }

    // Find the assistant message that belongs to this job. We use the
    // `by_jobId` index (defined for cleanup paths in Plan 06) and filter
    // role=assistant in memory — there is at most one assistant message per
    // chat job by construction (`chat/send.ts` inserts exactly one), so the
    // list is bounded at 2 (one user + one assistant message share `jobId`).
    const jobMessages = await ctx.db
      .query("messages")
      .withIndex("by_jobId", (q) => q.eq("jobId", activeJob._id))
      .take(4);
    const assistantMessage = jobMessages.find((entry) => entry.role === "assistant");

    if (assistantMessage) {
      // Idempotent: if a previous cancel call (or the stream action itself)
      // already flipped this row, skip the patch. The action's
      // `markAssistantReplyCancelled` will re-run later with the partial
      // content; this mutation only races to give the UI an immediate
      // update.
      if (assistantMessage.status === "streaming" || assistantMessage.status === "pending") {
        await ctx.db.patch(assistantMessage._id, {
          status: "cancelled",
          errorMessage: "Cancelled by user.",
        });
      }
    }

    // Flip the job last so the action's `getJobCancellationStatus` poll
    // observes a fully consistent view — by the time it sees `status:
    // cancelled` on the job, the message row is already in `cancelled`
    // state. Clearing the lease prevents `recoverStaleChatJob` from later
    // stomping on top of `markAssistantReplyCancelled`.
    const cancelledJob = await cancelActiveJob(ctx, {
      jobId: activeJob._id,
      expectedKind: "chat",
      progress: Math.max(activeJob.progress, 0.99),
      completedAt: now,
      errorMessage: "Cancelled by user.",
    });
    if (!cancelledJob) {
      return { cancelled: false as const };
    }

    logInfo("chat", "cancel_in_flight_reply", {
      threadId: args.threadId,
      jobId: activeJob._id,
      assistantMessageId: assistantMessage?._id,
      jobStatusBefore: activeJob.status,
      hadActiveLease: isLeaseActive(activeJob.leaseExpiresAt, now),
      ownerTokenIdentifier: identity.tokenIdentifier,
    });

    return {
      cancelled: true as const,
      jobId: activeJob._id,
      assistantMessageId: assistantMessage?._id,
    };
  },
});
