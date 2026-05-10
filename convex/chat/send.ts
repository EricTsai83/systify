import { v } from "convex/values";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import type { MutationCtx } from "../_generated/server";
import { mutation } from "../_generated/server";
import { requireViewerIdentity } from "../lib/auth";
import { requireActiveRepositoryForOwner } from "../lib/repositoryAccess";
import {
  CHAT_JOB_LEASE_MS,
  assertSandboxDailyCostBudget,
  consumeChatGlobalRateLimit,
  consumeChatRateLimit,
  getLeaseRetryAfterMs,
  getSandboxReplyEstimateCents,
  isLeaseActive,
  throwOperationAlreadyInProgress,
} from "../lib/rateLimit";
import { getSandboxFeatureGate } from "../lib/sandboxFeatureFlag";

async function getActiveChatJobForThread(ctx: MutationCtx, threadId: Id<"threads">, now: number) {
  const queuedJob = await ctx.db
    .query("jobs")
    .withIndex("by_threadId_and_kind_and_status_and_leaseExpiresAt", (q) =>
      q.eq("threadId", threadId).eq("kind", "chat").eq("status", "queued").gte("leaseExpiresAt", now),
    )
    .first();
  if (queuedJob && isLeaseActive(queuedJob.leaseExpiresAt, now)) {
    return queuedJob;
  }

  const runningJob = await ctx.db
    .query("jobs")
    .withIndex("by_threadId_and_kind_and_status_and_leaseExpiresAt", (q) =>
      q.eq("threadId", threadId).eq("kind", "chat").eq("status", "running").gte("leaseExpiresAt", now),
    )
    .first();
  if (runningJob && isLeaseActive(runningJob.leaseExpiresAt, now)) {
    return runningJob;
  }

  return null;
}

export const sendMessage = mutation({
  args: {
    threadId: v.id("threads"),
    content: v.string(),
    mode: v.optional(
      v.union(v.literal("discuss"), v.literal("docs"), v.literal("sandbox"), v.literal("ask"), v.literal("lab")),
    ),
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
      repository = await requireActiveRepositoryForOwner(ctx, {
        repositoryId: thread.repositoryId,
        ownerTokenIdentifier: identity.tokenIdentifier,
        notFoundMessage: "Thread not found.",
        archivedMessage: "This repository is archived. Restore it to continue chatting.",
      });
    }

    const mode = args.mode ?? thread.mode;

    // Mirror the resolver's preconditions on the write path. The UI
    // disabled-mode tooltips also encode these, but a direct mutation caller
    // (or a UI race where the user picked `sandbox` and then the sandbox
    // expired before they hit Send) needs the same gate enforced server-side.
    //
    // Three-mode restructure: `ask` (Library Ask) and `lab` (sandbox synonym)
    // join the repo-required set. Ask cannot retrieve chunks without a repo;
    // Lab cannot provision a sandbox without a repo.
    if ((mode === "docs" || mode === "sandbox" || mode === "ask" || mode === "lab") && !repository) {
      throw new Error(`'${mode}' mode requires an attached repository.`);
    }
    // Lab is the new persisted literal; treat it as sandbox for gate /
    // sandbox-ready checks until Phase 3 narrows `sandbox` away.
    if (mode === "sandbox" || mode === "lab") {
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

    // Plan 10 — daily-cost-cap pre-check, sandbox-only.
    //
    // Order matters: this fires *before* the per-owner / global chat
    // rate limits because (a) a quota-exceeded error is a more
    // user-actionable signal than "too many requests" and (b) the
    // structured `SANDBOX_DAILY_CAP_EXCEEDED` error code carries a
    // precise reset timestamp the UI uses to render a countdown,
    // whereas a rate-limited request would advise generic retry. The
    // resolver / threadContext also disables sandbox mode preemptively
    // when the cap is reached, but the write-path check is necessary
    // for two reasons:
    //
    //   1. A stale UI tab that loaded before the user hit their cap
    //      could still queue a sandbox send.
    //   2. The reactive resolver subscribes to *peek* values which
    //      can momentarily race with concurrent settlements; only the
    //      mutation-context check is authoritative.
    //
    // Discuss / docs sends skip this entirely — they bill against
    // the cheaper `chat` cost category and aren't subject to the
    // sandbox cap.
    // Three-mode restructure: `lab` shares the cost-cap budget with the
    // legacy `sandbox` literal — both consume the same Daytona compute
    // category.
    if (mode === "sandbox" || mode === "lab") {
      await assertSandboxDailyCostBudget(ctx, {
        ownerTokenIdentifier: identity.tokenIdentifier,
        workspaceId: thread.workspaceId ?? null,
        estimateCents: getSandboxReplyEstimateCents(),
      });
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
      // Sandbox / Lab modes are the only ones that consume Daytona
      // compute, so they bill against the `deep_analysis` cost category.
      // `discuss`, `docs`, and `ask` all stay on the standard `chat`
      // category — Ask runs entirely on chunk retrieval + LLM, no
      // sandbox.
      costCategory: mode === "sandbox" || mode === "lab" ? "deep_analysis" : "chat",
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
