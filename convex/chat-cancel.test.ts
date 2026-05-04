/// <reference types="vite/client" />

/**
 * Plan 07 — `cancelInFlightReply` mutation + `markAssistantReplyCancelled`
 * finalize variant.
 *
 * The interaction model under test:
 *
 *   1. The user clicks Stop while the assistant message is `streaming`. The
 *      public `cancelInFlightReply` mutation is the synchronous front-half:
 *      it flips the message + job to `cancelled` so the UI can react before
 *      the streaming action even notices.
 *   2. The streaming action's polling task observes `job.status ===
 *      "cancelled"` via `getJobCancellationStatus`, fires its abort
 *      controller, and runs `markAssistantReplyCancelled` to persist the
 *      partial content and drain tool-call events. This is the back-half.
 *
 * The two halves must be safely composable in any order — the action might
 * already have raced past finalize, or might race in *after*
 * `cancelInFlightReply` has already flipped the status. Both arms of those
 * races are exercised below.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("cancelInFlightReply (Plan 07)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("flips the active chat job and the streaming assistant message to 'cancelled'", async () => {
    const ownerTokenIdentifier = "user|cancel-active";
    const t = convexTest(schema, modules);
    const { threadId, jobId, assistantMessageId } = await createCancelFixture(t, ownerTokenIdentifier, "cancel-active");

    const result = await t
      .withIdentity({ tokenIdentifier: ownerTokenIdentifier })
      .mutation(api.chat.cancel.cancelInFlightReply, { threadId });

    expect(result).toMatchObject({
      cancelled: true,
      jobId,
      assistantMessageId,
    });

    const after = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      message: await ctx.db.get(assistantMessageId),
    }));

    // Job: cancelled status, lease released, completedAt stamped, error
    // message reflecting the user-initiated stop.
    expect(after.job?.status).toBe("cancelled");
    expect(after.job?.stage).toBe("cancelled");
    expect(after.job?.leaseExpiresAt).toBeUndefined();
    expect(after.job?.completedAt).toBeDefined();
    expect(after.job?.errorMessage).toBe("Cancelled by user.");

    // Message: cancelled status with errorMessage so the UI can render
    // "Cancelled by user." beneath whatever partial content was already
    // streamed. Content stays untouched here — the action's
    // `markAssistantReplyCancelled` is what folds in the final partial.
    expect(after.message?.status).toBe("cancelled");
    expect(after.message?.errorMessage).toBe("Cancelled by user.");
  });

  test("returns { cancelled: false } when no chat job is currently active", async () => {
    // Race: the user clicks Stop just as the reply finalized. We must NOT
    // overwrite a `completed` job back to `cancelled`, and the mutation
    // must succeed (not throw) so the UI's standard error toast does not
    // fire on a benign race.
    const ownerTokenIdentifier = "user|cancel-no-active";
    const t = convexTest(schema, modules);
    const { threadId, jobId, assistantMessageId } = await createCancelFixture(
      t,
      ownerTokenIdentifier,
      "cancel-no-active",
      { jobStatus: "completed", messageStatus: "completed" },
    );

    const result = await t
      .withIdentity({ tokenIdentifier: ownerTokenIdentifier })
      .mutation(api.chat.cancel.cancelInFlightReply, { threadId });

    expect(result).toEqual({ cancelled: false });

    // Neither row was touched — the message stays `completed` with no
    // bogus error message and the job remains `completed`.
    const after = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      message: await ctx.db.get(assistantMessageId),
    }));
    expect(after.job?.status).toBe("completed");
    expect(after.message?.status).toBe("completed");
    expect(after.message?.errorMessage).toBeUndefined();
  });

  test("rejects callers who do not own the thread without disclosing existence", async () => {
    const ownerTokenIdentifier = "user|cancel-owner";
    const otherTokenIdentifier = "user|cancel-stranger";
    const t = convexTest(schema, modules);
    const { threadId, jobId } = await createCancelFixture(t, ownerTokenIdentifier, "cancel-cross-tenant");

    await expect(
      t
        .withIdentity({ tokenIdentifier: otherTokenIdentifier })
        .mutation(api.chat.cancel.cancelInFlightReply, { threadId }),
    ).rejects.toThrow(/Thread not found/);

    // The job must remain untouched; a cross-tenant caller cannot be
    // allowed to disrupt another user's reply.
    const after = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(after?.status).toBe("running");
  });

  test("rejects unauthenticated callers", async () => {
    const ownerTokenIdentifier = "user|cancel-auth";
    const t = convexTest(schema, modules);
    const { threadId } = await createCancelFixture(t, ownerTokenIdentifier, "cancel-auth");

    await expect(t.mutation(api.chat.cancel.cancelInFlightReply, { threadId })).rejects.toThrow(/sign in/);
  });

  test("is idempotent against a previous cancel — re-running is a no-op", async () => {
    // The action and `cancelInFlightReply` race; either may run first. The
    // second runner of `cancelInFlightReply` must observe "no active job"
    // and return cleanly.
    const ownerTokenIdentifier = "user|cancel-idempotent";
    const t = convexTest(schema, modules);
    const { threadId, jobId } = await createCancelFixture(t, ownerTokenIdentifier, "cancel-idempotent");

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    const first = await viewer.mutation(api.chat.cancel.cancelInFlightReply, { threadId });
    expect(first).toMatchObject({ cancelled: true, jobId });

    const second = await viewer.mutation(api.chat.cancel.cancelInFlightReply, { threadId });
    expect(second).toEqual({ cancelled: false });
  });
});

describe("getJobCancellationStatus (Plan 07)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("reports `cancelled: false` while the job is running", async () => {
    const ownerTokenIdentifier = "user|cancel-status-running";
    const t = convexTest(schema, modules);
    const { jobId } = await createCancelFixture(t, ownerTokenIdentifier, "cancel-status-running");

    const status = await t.query(internal.chat.streaming.getJobCancellationStatus, { jobId });
    expect(status).toEqual({ cancelled: false, jobMissing: false });
  });

  test("reports `cancelled: true` once cancelInFlightReply flipped the job", async () => {
    const ownerTokenIdentifier = "user|cancel-status-cancelled";
    const t = convexTest(schema, modules);
    const { threadId, jobId } = await createCancelFixture(t, ownerTokenIdentifier, "cancel-status-cancelled");

    await t
      .withIdentity({ tokenIdentifier: ownerTokenIdentifier })
      .mutation(api.chat.cancel.cancelInFlightReply, { threadId });

    const status = await t.query(internal.chat.streaming.getJobCancellationStatus, { jobId });
    expect(status).toEqual({ cancelled: true, jobMissing: false });
  });

  test("reports `jobMissing: true` if the job was deleted out from under us", async () => {
    // Concurrent thread cascade can delete the job before the polling
    // action gets there. The query must surface that as `jobMissing`
    // rather than silently returning `cancelled: false` (which would
    // mislead the action into proceeding with finalize).
    const ownerTokenIdentifier = "user|cancel-status-missing";
    const t = convexTest(schema, modules);
    const { jobId } = await createCancelFixture(t, ownerTokenIdentifier, "cancel-status-missing");

    await t.run(async (ctx) => {
      await ctx.db.delete(jobId);
    });

    const status = await t.query(internal.chat.streaming.getJobCancellationStatus, { jobId });
    expect(status).toEqual({ cancelled: false, jobMissing: true });
  });
});

describe("markAssistantReplyCancelled (Plan 07)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("preserves the streamed prefix + final delta, drains streams, releases job lease", async () => {
    const ownerTokenIdentifier = "user|cancel-finalize";
    const t = convexTest(schema, modules);
    const { jobId, assistantMessageId, streamId } = await createCancelFixture(
      t,
      ownerTokenIdentifier,
      "cancel-finalize",
    );

    // Stream a few chunks so the partial-content path exercises the
    // streamSnapshot read; this is the user-visible payoff of cancellation
    // (not throwing away whatever the model already produced).
    await t.mutation(internal.chat.streaming.appendAssistantStreamChunk, {
      assistantMessageId,
      jobId,
      delta: "I started reading the ",
    });
    await t.mutation(internal.chat.streaming.appendAssistantStreamChunk, {
      assistantMessageId,
      jobId,
      delta: "send.ts file ",
    });

    // Action's tail-end pendingDelta — characters below the flush threshold
    // that hadn't been persisted yet. The cancel finalize variant is the
    // single owner of "fold pendingDelta into the durable content".
    await t.mutation(internal.chat.streaming.markAssistantReplyCancelled, {
      assistantMessageId,
      jobId,
      finalDelta: "and saw the lease",
    });

    const after = await t.run(async (ctx) => ({
      message: await ctx.db.get(assistantMessageId),
      job: await ctx.db.get(jobId),
      stream: await ctx.db.get(streamId),
      tailChunks: await ctx.db
        .query("messageStreamChunks")
        .withIndex("by_streamId_and_sequence", (q) => q.eq("streamId", streamId))
        .take(10),
    }));

    expect(after.message?.status).toBe("cancelled");
    expect(after.message?.content).toBe("I started reading the send.ts file and saw the lease");
    expect(after.message?.errorMessage).toBe("Cancelled by user.");

    // Job is in the terminal `cancelled` state with no lingering lease for
    // recoverStaleChatJob to touch.
    expect(after.job?.status).toBe("cancelled");
    expect(after.job?.stage).toBe("cancelled");
    expect(after.job?.leaseExpiresAt).toBeUndefined();
    expect(after.job?.completedAt).toBeDefined();

    // Stream + chunks fully torn down — same lifecycle invariant as
    // finalize / fail.
    expect(after.stream).toBeNull();
    expect(after.tailChunks).toHaveLength(0);
  });

  test("drains in-flight tool-call events so the live ticker stops painting 'running'", async () => {
    // Plan 06 invariant: events visible iff message is in non-terminal
    // state. The cancel finalize variant must drain like finalize / fail
    // do, otherwise the ticker would briefly resurrect a "running" entry
    // after the bubble already flipped to "Cancelled".
    const ownerTokenIdentifier = "user|cancel-tool-events";
    const t = convexTest(schema, modules);
    const { jobId, assistantMessageId } = await createCancelFixture(t, ownerTokenIdentifier, "cancel-tool-events");

    // A tool call that started but never produced a result before the
    // user clicked Stop. The fold maps this to `endedAt === startedAt`
    // (interrupted) on the persisted trace.
    await t.mutation(internal.chat.streaming.appendAssistantToolCallEvent, {
      assistantMessageId,
      jobId,
      toolCallId: "call-cancel-1",
      type: "start",
      toolName: "read_file",
      inputSummary: '{"path":"convex/chat/send.ts"}',
      occurredAt: Date.now(),
    });

    await t.mutation(internal.chat.streaming.markAssistantReplyCancelled, {
      assistantMessageId,
      jobId,
      finalDelta: "interrupted before completion",
    });

    const after = await t.run(async (ctx) => ({
      message: await ctx.db.get(assistantMessageId),
      events: await ctx.db
        .query("messageToolCallEvents")
        .withIndex("by_messageId_and_sequence", (q) => q.eq("messageId", assistantMessageId))
        .take(10),
    }));

    // Events drained, persisted trace shape preserved on the message row.
    expect(after.events).toHaveLength(0);
    expect(after.message?.toolCalls).toEqual([
      expect.objectContaining({
        toolCallId: "call-cancel-1",
        toolName: "read_file",
        inputSummary: '{"path":"convex/chat/send.ts"}',
      }),
    ]);
    // Interrupted entries collapse to start === end so the UI can render
    // "interrupted" without re-deriving state from missing fields.
    expect(after.message?.toolCalls?.[0].endedAt).toBe(after.message?.toolCalls?.[0].startedAt);
  });

  test("uses an empty-content fallback so the bubble never renders blank", async () => {
    // Worst case: cancel arrived before the model emitted any text and no
    // partial delta exists. The bubble must still render meaningful copy
    // — failure path uses the same fallback for the same reason.
    const ownerTokenIdentifier = "user|cancel-empty";
    const t = convexTest(schema, modules);
    const { jobId, assistantMessageId } = await createCancelFixture(t, ownerTokenIdentifier, "cancel-empty");

    await t.mutation(internal.chat.streaming.markAssistantReplyCancelled, {
      assistantMessageId,
      jobId,
    });

    const message = await t.run(async (ctx) => ctx.db.get(assistantMessageId));
    expect(message?.status).toBe("cancelled");
    expect(message?.content).toBe("Cancelled by user.");
  });

  test("survives a missing assistant message — clears the job lease anyway", async () => {
    // Concurrent thread / repo cascade can delete the assistant message
    // mid-stream. The mutation must still release the job's lease so the
    // per-thread in-flight gate clears (matching `failAssistantReply`'s
    // behavior on the same edge).
    const ownerTokenIdentifier = "user|cancel-message-missing";
    const t = convexTest(schema, modules);
    const { jobId, assistantMessageId } = await createCancelFixture(t, ownerTokenIdentifier, "cancel-message-missing");

    await t.run(async (ctx) => {
      await ctx.db.delete(assistantMessageId);
    });

    await t.mutation(internal.chat.streaming.markAssistantReplyCancelled, {
      assistantMessageId,
      jobId,
      finalDelta: "tail that won't land",
    });

    const job = await t.run(async (ctx) => ctx.db.get(jobId));
    expect(job?.status).toBe("cancelled");
    expect(job?.leaseExpiresAt).toBeUndefined();
    expect(job?.errorMessage).toBe("Cancelled by user.");
  });

  test("is idempotent when called after cancelInFlightReply already flipped the rows", async () => {
    // Common path: `cancelInFlightReply` writes status synchronously, the
    // action picks it up on the next poll and runs this mutation. Double
    // status writes must remain consistent — final state is `cancelled`,
    // partial content is correctly folded in.
    const ownerTokenIdentifier = "user|cancel-double";
    const t = convexTest(schema, modules);
    const { threadId, jobId, assistantMessageId } = await createCancelFixture(t, ownerTokenIdentifier, "cancel-double");

    await t.mutation(internal.chat.streaming.appendAssistantStreamChunk, {
      assistantMessageId,
      jobId,
      delta: "first chunk ",
    });

    await t
      .withIdentity({ tokenIdentifier: ownerTokenIdentifier })
      .mutation(api.chat.cancel.cancelInFlightReply, { threadId });

    await t.mutation(internal.chat.streaming.markAssistantReplyCancelled, {
      assistantMessageId,
      jobId,
      finalDelta: "tail",
    });

    const after = await t.run(async (ctx) => ({
      message: await ctx.db.get(assistantMessageId),
      job: await ctx.db.get(jobId),
    }));
    expect(after.message?.status).toBe("cancelled");
    expect(after.message?.content).toBe("first chunk tail");
    expect(after.message?.errorMessage).toBe("Cancelled by user.");
    expect(after.job?.status).toBe("cancelled");
    expect(after.job?.leaseExpiresAt).toBeUndefined();
  });

  test("accepts a custom reason when the cancellation is system-initiated", async () => {
    // Plan 09's fallback path will reuse this mutation with a system-level
    // reason ("Daytona unreachable, falling back…"). The reason is the
    // single field the UI surfaces, so the mutation must respect the
    // override rather than always saying "Cancelled by user.".
    const ownerTokenIdentifier = "user|cancel-reason";
    const t = convexTest(schema, modules);
    const { jobId, assistantMessageId } = await createCancelFixture(t, ownerTokenIdentifier, "cancel-reason");

    await t.mutation(internal.chat.streaming.markAssistantReplyCancelled, {
      assistantMessageId,
      jobId,
      reason: "Cancelled because the daily quota was exceeded.",
    });

    const message = await t.run(async (ctx) => ctx.db.get(assistantMessageId));
    expect(message?.status).toBe("cancelled");
    expect(message?.errorMessage).toBe("Cancelled because the daily quota was exceeded.");
    expect(message?.content).toBe("Cancelled because the daily quota was exceeded.");
  });
});

/**
 * Mirrors `chat-streaming.test.ts:createStreamingFixture` but exposes
 * configurable initial states for the message + job so we can exercise the
 * "no active job" race ahead of cancellation. Keeping a separate fixture
 * factory (rather than parameterizing the existing one) avoids cross-test
 * coupling — Plan 06 tests should not have to think about Plan 07 status
 * values.
 */
async function createCancelFixture(
  t: ReturnType<typeof convexTest>,
  ownerTokenIdentifier: string,
  slug: string,
  options: {
    jobStatus?: "queued" | "running" | "completed" | "failed" | "cancelled";
    messageStatus?: "pending" | "streaming" | "completed" | "failed" | "cancelled";
  } = {},
) {
  const { jobStatus = "running", messageStatus = "streaming" } = options;
  return await t.run(async (ctx) => {
    const repositoryId = await ctx.db.insert("repositories", {
      ownerTokenIdentifier,
      sourceHost: "github",
      sourceUrl: `https://github.com/acme/${slug}`,
      sourceRepoFullName: `acme/${slug}`,
      sourceRepoOwner: "acme",
      sourceRepoName: slug,
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
      title: `${slug} thread`,
      mode: "discuss",
      lastMessageAt: Date.now(),
    });

    const jobId = await ctx.db.insert("jobs", {
      repositoryId,
      ownerTokenIdentifier,
      threadId,
      kind: "chat",
      status: jobStatus,
      stage: jobStatus === "completed" ? "completed" : "generating_reply",
      progress: jobStatus === "completed" ? 1 : 0.5,
      costCategory: "chat",
      triggerSource: "user",
      startedAt: Date.now(),
      // Active jobs need a live lease so `cancelInFlightReply`'s active-job
      // lookup finds them; finalized jobs have no lease.
      leaseExpiresAt: jobStatus === "running" || jobStatus === "queued" ? Date.now() + 60_000 : undefined,
    });

    await ctx.db.insert("messages", {
      repositoryId,
      threadId,
      jobId,
      ownerTokenIdentifier,
      role: "user",
      status: "completed",
      mode: "discuss",
      content: "Tell me about send.ts.",
    });

    const assistantMessageId = await ctx.db.insert("messages", {
      repositoryId,
      threadId,
      jobId,
      ownerTokenIdentifier,
      role: "assistant",
      status: messageStatus,
      mode: "discuss",
      content: "",
    });

    const streamId = await ctx.db.insert("messageStreams", {
      repositoryId,
      threadId,
      jobId,
      assistantMessageId,
      ownerTokenIdentifier,
      compactedContent: "",
      compactedThroughSequence: -1,
      nextSequence: 0,
      startedAt: Date.now(),
      lastAppendedAt: Date.now(),
    });

    return { repositoryId, threadId, jobId, assistantMessageId, streamId };
  });
}
