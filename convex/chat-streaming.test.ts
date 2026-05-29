/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { api, internal } from "./_generated/api";
import { CASCADE_BATCH_SIZE, MESSAGE_STREAM_COMPACT_CHUNK_THRESHOLD } from "./lib/constants";
import schema from "./schema";

const modules = import.meta.glob("./**/*.ts");

describe("chat streaming lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("getActiveMessageStream reads the compacted prefix plus active tail", async () => {
    const ownerTokenIdentifier = "user|active-stream";
    const t = convexTest(schema, modules);
    const { threadId, streamId, assistantMessageId } = await createStreamingFixture(
      t,
      ownerTokenIdentifier,
      "active-stream",
    );
    const tailParts = Array.from({ length: CASCADE_BATCH_SIZE + 5 }, (_, index) => `chunk-${index}|`);

    await t.run(async (ctx) => {
      await ctx.db.patch(streamId, {
        compactedContent: "Hello ",
        compactedThroughSequence: 0,
        nextSequence: tailParts.length + 1,
      });
      for (const [index, part] of tailParts.entries()) {
        await ctx.db.insert("messageStreamChunks", {
          streamId,
          sequence: index + 1,
          text: part,
        });
      }
      await ctx.db.patch(assistantMessageId, {
        status: "streaming",
      });
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const activeStream = await viewer.query(api.chat.streaming.getActiveMessageStream, { threadId });

    expect(activeStream).toMatchObject({
      assistantMessageId,
      content: `Hello ${tailParts.join("")}`,
    });
  });

  test("appendAssistantStreamChunk refreshes the job lease once half the lease window has elapsed", async () => {
    const ownerTokenIdentifier = "user|stream-lease-refresh";
    const t = convexTest(schema, modules);
    const { jobId, assistantMessageId } = await createStreamingFixture(t, ownerTokenIdentifier, "stream-lease-refresh");

    // First chunk: stream.lastAppendedAt was set at fixture creation time
    // (now), so the threshold check sees a "recent refresh" and skips the
    // job patch — saving a write per chunk on short replies.
    const firstAppendAt = await t.run(async (ctx) => (await ctx.db.get(jobId))!.leaseExpiresAt!);
    await t.mutation(internal.chat.streaming.appendAssistantStreamChunk, {
      assistantMessageId,
      jobId,
      delta: "first",
    });
    const afterFirstAppend = await t.run(async (ctx) => (await ctx.db.get(jobId))!.leaseExpiresAt!);
    expect(afterFirstAppend).toBe(firstAppendAt);

    // Advance past half the lease window. Now stream.lastAppendedAt is older
    // than the threshold, so the next append must extend the lease.
    vi.advanceTimersByTime(6 * 60_000);
    await t.mutation(internal.chat.streaming.appendAssistantStreamChunk, {
      assistantMessageId,
      jobId,
      delta: "later",
    });
    const afterLateAppend = await t.run(async (ctx) => (await ctx.db.get(jobId))!.leaseExpiresAt!);
    expect(afterLateAppend).toBeGreaterThan(afterFirstAppend);
  });

  test("appendAssistantStreamChunk compacts the tail and finalizeAssistantReply writes once", async () => {
    const ownerTokenIdentifier = "user|stream-finalize";
    const t = convexTest(schema, modules);
    const { threadId, jobId, assistantMessageId, streamId } = await createStreamingFixture(
      t,
      ownerTokenIdentifier,
      "stream-finalize",
    );

    const compactedParts: string[] = [];
    for (let index = 0; index < MESSAGE_STREAM_COMPACT_CHUNK_THRESHOLD; index += 1) {
      const part = `chunk-${index}|`;
      compactedParts.push(part);
      await t.mutation(internal.chat.streaming.appendAssistantStreamChunk, {
        assistantMessageId,
        jobId,
        delta: part,
      });
    }

    const afterCompaction = await t.run(async (ctx) => ({
      stream: await ctx.db.get(streamId),
      tailChunks: await ctx.db
        .query("messageStreamChunks")
        .withIndex("by_streamId_and_sequence", (q) => q.eq("streamId", streamId))
        .take(20),
    }));

    expect(afterCompaction.stream?.compactedContent).toBe(compactedParts.join(""));
    expect(afterCompaction.stream?.compactedThroughSequence).toBe(MESSAGE_STREAM_COMPACT_CHUNK_THRESHOLD - 1);
    expect(afterCompaction.tailChunks).toHaveLength(0);

    await t.mutation(internal.chat.streaming.finalizeAssistantReply, {
      threadId,
      assistantMessageId,
      jobId,
      finalDelta: "done",
      inputTokens: 1200,
      outputTokens: 300,
      costUsd: 0.00036,
    });

    const finalized = await t.run(async (ctx) => ({
      message: await ctx.db.get(assistantMessageId),
      stream: await ctx.db.get(streamId),
      tailChunks: await ctx.db
        .query("messageStreamChunks")
        .withIndex("by_streamId_and_sequence", (q) => q.eq("streamId", streamId))
        .take(20),
      job: await ctx.db.get(jobId),
    }));

    expect(finalized.message?.status).toBe("completed");
    expect(finalized.message?.content).toBe(`${compactedParts.join("")}done`);
    expect(finalized.message?.estimatedInputTokens).toBe(1200);
    expect(finalized.message?.estimatedOutputTokens).toBe(300);
    expect(finalized.stream).toBeNull();
    expect(finalized.tailChunks).toHaveLength(0);
    expect(finalized.job?.status).toBe("completed");
    expect(finalized.job?.estimatedInputTokens).toBe(1200);
    expect(finalized.job?.estimatedOutputTokens).toBe(300);
    expect(finalized.job?.estimatedCostUsd).toBe(0.00036);
  });

  test("cancel before action start prevents queued job from moving to running", async () => {
    const ownerTokenIdentifier = "user|lifecycle-cancel-before-start";
    const t = convexTest(schema, modules);
    const { threadId, jobId, assistantMessageId } = await createStreamingFixture(
      t,
      ownerTokenIdentifier,
      "lifecycle-cancel-before-start",
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(jobId, {
        status: "queued",
        stage: "queued",
        progress: 0,
        startedAt: undefined,
      });
      await ctx.db.patch(assistantMessageId, {
        status: "pending",
      });
    });

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await viewer.mutation(api.chat.cancel.cancelInFlightReply, { threadId });
    const start = await t.mutation(internal.chat.streaming.markAssistantReplyRunning, {
      assistantMessageId,
      jobId,
    });

    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      message: await ctx.db.get(assistantMessageId),
    }));
    expect(start).toEqual({ started: false });
    expect(state.job?.status).toBe("cancelled");
    expect(state.message?.status).toBe("cancelled");
  });

  test("late completion after cancellation leaves the job and message cancelled", async () => {
    const ownerTokenIdentifier = "user|lifecycle-cancel-running";
    const t = convexTest(schema, modules);
    const { threadId, jobId, assistantMessageId, streamId } = await createStreamingFixture(
      t,
      ownerTokenIdentifier,
      "lifecycle-cancel-running",
    );

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    await viewer.mutation(api.chat.cancel.cancelInFlightReply, { threadId });
    await t.mutation(internal.chat.streaming.finalizeAssistantReply, {
      threadId,
      assistantMessageId,
      jobId,
      finalDelta: "late completion",
    });

    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      message: await ctx.db.get(assistantMessageId),
      stream: await ctx.db.get(streamId),
    }));
    expect(state.job?.status).toBe("cancelled");
    expect(state.message?.status).toBe("cancelled");
    expect(state.message?.content).toBe("");
    expect(state.stream).toBeNull();
  });

  test("late completion after stale recovery leaves the failed terminal state intact", async () => {
    const ownerTokenIdentifier = "user|lifecycle-stale-before-complete";
    const t = convexTest(schema, modules);
    const { threadId, jobId, assistantMessageId } = await createStreamingFixture(
      t,
      ownerTokenIdentifier,
      "lifecycle-stale-before-complete",
    );
    await t.mutation(internal.chat.streaming.appendAssistantStreamChunk, {
      assistantMessageId,
      jobId,
      delta: "partial answer",
    });
    await t.run(async (ctx) => {
      await ctx.db.patch(jobId, { leaseExpiresAt: Date.now() - 1 });
    });

    await t.mutation(internal.chat.streaming.recoverStaleChatJob, { jobId });
    await t.mutation(internal.chat.streaming.finalizeAssistantReply, {
      threadId,
      assistantMessageId,
      jobId,
      finalDelta: " late completion",
    });

    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      message: await ctx.db.get(assistantMessageId),
    }));
    expect(state.job?.status).toBe("failed");
    expect(state.message?.status).toBe("failed");
    expect(state.message?.content).toBe("partial answer");
  });

  test("failed job ignores a late assistant completion", async () => {
    const ownerTokenIdentifier = "user|lifecycle-failed-before-complete";
    const t = convexTest(schema, modules);
    const { threadId, jobId, assistantMessageId } = await createStreamingFixture(
      t,
      ownerTokenIdentifier,
      "lifecycle-failed-before-complete",
    );
    await t.mutation(internal.chat.streaming.failAssistantReply, {
      assistantMessageId,
      jobId,
      errorMessage: "upstream failed",
    });

    await t.mutation(internal.chat.streaming.finalizeAssistantReply, {
      threadId,
      assistantMessageId,
      jobId,
      finalDelta: "late completion",
    });

    const state = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      message: await ctx.db.get(assistantMessageId),
    }));
    expect(state.job?.status).toBe("failed");
    expect(state.message?.status).toBe("failed");
    expect(state.message?.content).toBe("upstream failed");
  });

  test("failAssistantReply preserves streamed content and removes stream state", async () => {
    const ownerTokenIdentifier = "user|stream-fail";
    const t = convexTest(schema, modules);
    const { jobId, assistantMessageId, streamId } = await createStreamingFixture(
      t,
      ownerTokenIdentifier,
      "stream-fail",
    );

    await t.mutation(internal.chat.streaming.appendAssistantStreamChunk, {
      assistantMessageId,
      jobId,
      delta: "partial ",
    });

    await t.mutation(internal.chat.streaming.failAssistantReply, {
      assistantMessageId,
      jobId,
      errorMessage: "stream failed",
      finalDelta: "tail",
    });

    const failed = await t.run(async (ctx) => ({
      message: await ctx.db.get(assistantMessageId),
      stream: await ctx.db.get(streamId),
      tailChunks: await ctx.db
        .query("messageStreamChunks")
        .withIndex("by_streamId_and_sequence", (q) => q.eq("streamId", streamId))
        .take(20),
    }));

    expect(failed.message?.status).toBe("failed");
    expect(failed.message?.content).toBe("partial tail");
    expect(failed.message?.errorMessage).toBe("stream failed");
    expect(failed.stream).toBeNull();
    expect(failed.tailChunks).toHaveLength(0);
  });

  test("appendAssistantStreamChunk throws when the stream state is missing", async () => {
    const ownerTokenIdentifier = "user|stream-missing";
    const t = convexTest(schema, modules);
    const { jobId, assistantMessageId, streamId } = await createStreamingFixture(
      t,
      ownerTokenIdentifier,
      "stream-missing",
    );

    await t.run(async (ctx) => {
      await ctx.db.delete(streamId);
    });

    await expect(
      t.mutation(internal.chat.streaming.appendAssistantStreamChunk, {
        assistantMessageId,
        jobId,
        delta: "orphaned chunk",
      }),
    ).rejects.toThrow(/messageStreamChunks.*compactMessageStreamTail/);
  });

  test("failAssistantReply still cleans up the job and stream when the assistant message is gone", async () => {
    const ownerTokenIdentifier = "user|stream-cleanup-without-message";
    const t = convexTest(schema, modules);
    const { jobId, assistantMessageId, streamId } = await createStreamingFixture(
      t,
      ownerTokenIdentifier,
      "stream-cleanup-without-message",
    );

    await t.mutation(internal.chat.streaming.appendAssistantStreamChunk, {
      assistantMessageId,
      jobId,
      delta: "partial ",
    });

    await t.run(async (ctx) => {
      await ctx.db.delete(assistantMessageId);
    });

    await t.mutation(internal.chat.streaming.failAssistantReply, {
      assistantMessageId,
      jobId,
      errorMessage: "stream failed after message delete",
      finalDelta: "tail",
    });

    const failed = await t.run(async (ctx) => ({
      job: await ctx.db.get(jobId),
      stream: await ctx.db.get(streamId),
      tailChunks: await ctx.db
        .query("messageStreamChunks")
        .withIndex("by_streamId_and_sequence", (q) => q.eq("streamId", streamId))
        .take(20),
    }));

    // The job must be released even when the assistant message is gone,
    // otherwise the per-thread in-flight gate would stay engaged until
    // recoverStaleChatJob fires.
    expect(failed.job?.status).toBe("failed");
    expect(failed.job?.errorMessage).toBe("stream failed after message delete");
    expect(failed.job?.leaseExpiresAt).toBeUndefined();
    expect(failed.stream).toBeNull();
    expect(failed.tailChunks).toHaveLength(0);
  });

  test("repository cascade cleanup removes active stream tables", async () => {
    const ownerTokenIdentifier = "user|repo-cascade";
    const t = convexTest(schema, modules);
    const { repositoryId, threadId, jobId, assistantMessageId, streamId } = await createStreamingFixture(
      t,
      ownerTokenIdentifier,
      "repo-cascade",
    );
    const chunkCount = CASCADE_BATCH_SIZE + 3;

    await t.run(async (ctx) => {
      await ctx.db.patch(streamId, {
        nextSequence: chunkCount,
      });
      for (let index = 0; index < chunkCount; index += 1) {
        await ctx.db.insert("messageStreamChunks", {
          streamId,
          sequence: index,
          text: `active-chunk-${index}|`,
        });
      }
    });

    await t.mutation(internal.repositories.cascadeDeleteRepository, {
      repositoryId,
    });

    const afterDelete = await t.run(async (ctx) => ({
      repository: await ctx.db.get(repositoryId),
      thread: await ctx.db.get(threadId),
      job: await ctx.db.get(jobId),
      assistantMessage: await ctx.db.get(assistantMessageId),
      stream: await ctx.db.get(streamId),
      tailChunks: await ctx.db
        .query("messageStreamChunks")
        .withIndex("by_streamId_and_sequence", (q) => q.eq("streamId", streamId))
        .take(20),
    }));

    expect(afterDelete.repository).toBeNull();
    expect(afterDelete.thread).toBeNull();
    expect(afterDelete.job).toBeNull();
    expect(afterDelete.assistantMessage).toBeNull();
    expect(afterDelete.stream).toBeNull();
    expect(afterDelete.tailChunks).toHaveLength(0);
  });
});

/**
 * Citation lint runs at terminal-state mutations and persists
 * the flagged-sentence ranges on `messages.unverifiedClaims`. The lint
 * is sandbox-only (the contract `[path:line]` + `Unverified:` is
 * teaching exclusive to the sandbox prompt) so non-sandbox replies must
 * never receive ranges, even when their content would otherwise look
 * flag-able to the lint.
 *
 * The tests pin three contracts:
 *
 *   1. `finalizeAssistantReply` writes ranges for sandbox replies whose
 *      content has unverified claim sentences, and omits the field
 *      entirely for non-sandbox replies and clean replies.
 *   2. `failAssistantReply` and `markAssistantReplyCancelled` apply the
 *      lint to *partial* content so the user sees the same highlights
 *      on a truncated reply they would have seen on a completed one.
 *   3. The lint output round-trips: `content.slice(start, end)` matches
 *      the flagged sentence text the renderer needs to wrap in `<mark>`.
 *      This is the same offset-alignment guarantee asserted in
 *      `citationLint.test.ts`, but pinned end-to-end through the
 *      mutation so a future refactor can't silently break the renderer
 *      contract.
 */
describe("citation lint integration", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("finalizeAssistantReply persists unverifiedClaims for sandbox replies with flagged sentences", async () => {
    const ownerTokenIdentifier = "user|lint-finalize-sandbox";
    const t = convexTest(schema, modules);
    const { threadId, jobId, assistantMessageId } = await createStreamingFixture(
      t,
      ownerTokenIdentifier,
      "lint-finalize-sandbox",
    );

    // Promote the fixture's assistant message by enabling sandbox
    // grounding — the fixture defaults to `discuss` for the existing
    // tests, but the citation lint only fires for sandbox replies and
    // is gated by `groundSandbox`. Patching `assistantMessageId` to set
    // `groundSandbox: true` post-fixture is the minimal mutation that
    // exercises the lint path.
    await t.run(async (ctx) => {
      await ctx.db.patch(assistantMessageId, { groundSandbox: true });
    });

    // Mix one cited sentence and one unverified sentence so the lint has
    // a clear signal to flag exactly one. The cited form `[path:line]`
    // is what the sandbox prompt teaches; we mirror it here so the
    // assertion proves both directions of the contract (cited → not
    // flagged; uncited prose → flagged).
    const finalContent =
      "The handler validates the payload [convex/api/foo.ts:12-30]. " +
      "Then it dispatches to a worker queue without retry semantics.";
    await t.mutation(internal.chat.streaming.finalizeAssistantReply, {
      threadId,
      assistantMessageId,
      jobId,
      finalDelta: finalContent,
    });

    const finalized = await t.run(async (ctx) => await ctx.db.get(assistantMessageId));

    expect(finalized?.status).toBe("completed");
    expect(finalized?.content).toBe(finalContent);
    expect(finalized?.unverifiedClaims).toHaveLength(1);
    // Round-trip the persisted offsets through the persisted content;
    // the renderer slices with these exact positions, so any drift
    // would produce a misaligned `<mark>` overlay in the chat bubble.
    const range = finalized!.unverifiedClaims![0];
    expect(finalContent.slice(range.start, range.end)).toBe(
      "Then it dispatches to a worker queue without retry semantics.",
    );
  });

  test("finalizeAssistantReply omits unverifiedClaims when every sandbox sentence is cited", async () => {
    // The lint returns `[]` and the streaming helper persists
    // `undefined` rather than an empty array — keeps the
    // widen-migrate-narrow contract honest (clean replies look
    // identical to pre-Plan-11 messages on the wire).
    const ownerTokenIdentifier = "user|lint-finalize-clean";
    const t = convexTest(schema, modules);
    const { threadId, jobId, assistantMessageId } = await createStreamingFixture(
      t,
      ownerTokenIdentifier,
      "lint-finalize-clean",
    );

    await t.run(async (ctx) => {
      await ctx.db.patch(assistantMessageId, { groundSandbox: true });
    });

    await t.mutation(internal.chat.streaming.finalizeAssistantReply, {
      threadId,
      assistantMessageId,
      jobId,
      finalDelta: "Every claim cites the source [convex/api/foo.ts:12-30].",
    });

    const finalized = await t.run(async (ctx) => await ctx.db.get(assistantMessageId));
    expect(finalized?.status).toBe("completed");
    expect(finalized?.unverifiedClaims).toBeUndefined();
  });

  test("finalizeAssistantReply does not lint replies without sandbox grounding even when content is flag-able", async () => {
    // Non-sandbox-grounded replies must skip the lint entirely. The lint's
    // contract (`[path:line]` + `Unverified:`) is taught only by the
    // sandbox-grounded prompt, so applying it to library / discuss-without-
    // sandbox-grounding would generate false positives on every
    // artifact-grounded sentence (the library prompt teaches `[A#]`, which
    // is not a `[path:line]` shape).
    for (const mode of ["discuss", "library"] as const) {
      const ownerTokenIdentifier = `user|lint-finalize-${mode}`;
      const t = convexTest(schema, modules);
      const { threadId, jobId, assistantMessageId } = await createStreamingFixture(
        t,
        ownerTokenIdentifier,
        `lint-finalize-${mode}`,
      );

      await t.run(async (ctx) => {
        await ctx.db.patch(assistantMessageId, { mode, groundSandbox: false });
      });

      // Same flag-able prose as the sandbox-positive test — the lint
      // would happily flag it, but the gate must skip on
      // `groundSandbox !== true`.
      await t.mutation(internal.chat.streaming.finalizeAssistantReply, {
        threadId,
        assistantMessageId,
        jobId,
        finalDelta: "Then it dispatches to a worker queue without retry semantics.",
      });

      const finalized = await t.run(async (ctx) => await ctx.db.get(assistantMessageId));
      expect(finalized?.unverifiedClaims, `${mode} reply should not be linted`).toBeUndefined();
    }
  });

  test("failAssistantReply runs the lint on partial sandbox content", async () => {
    // A sandbox reply that produced 50% of an unverified sentence
    // before the upstream errored should still surface the highlight.
    // This guards the parity contract: a failed bubble in sandbox mode
    // looks like a completed bubble for the partial content the user
    // can read.
    const ownerTokenIdentifier = "user|lint-fail-sandbox";
    const t = convexTest(schema, modules);
    const { jobId, assistantMessageId } = await createStreamingFixture(t, ownerTokenIdentifier, "lint-fail-sandbox");

    await t.run(async (ctx) => {
      await ctx.db.patch(assistantMessageId, { groundSandbox: true });
    });

    // Stream partial content first so the lint sees a non-empty
    // `streamSnapshot.content` at fail time.
    await t.mutation(internal.chat.streaming.appendAssistantStreamChunk, {
      assistantMessageId,
      jobId,
      delta: "The handler kicks off a background queue without any retry policy.",
    });

    await t.mutation(internal.chat.streaming.failAssistantReply, {
      assistantMessageId,
      jobId,
      errorMessage: "upstream rate-limited",
      finalDelta: "",
    });

    const failed = await t.run(async (ctx) => await ctx.db.get(assistantMessageId));
    expect(failed?.status).toBe("failed");
    expect(failed?.unverifiedClaims).toHaveLength(1);
    const range = failed!.unverifiedClaims![0];
    expect(failed!.content.slice(range.start, range.end)).toBe(
      "The handler kicks off a background queue without any retry policy.",
    );
  });

  test("markAssistantReplyCancelled runs the lint on partial sandbox content", async () => {
    // Same parity rationale as the fail path: a user who clicks Stop
    // mid-reply still wants the unverified-claim highlights for the
    // partial content they chose to keep.
    const ownerTokenIdentifier = "user|lint-cancel-sandbox";
    const t = convexTest(schema, modules);
    const { jobId, assistantMessageId } = await createStreamingFixture(t, ownerTokenIdentifier, "lint-cancel-sandbox");

    await t.run(async (ctx) => {
      await ctx.db.patch(assistantMessageId, { groundSandbox: true });
    });

    await t.mutation(internal.chat.streaming.appendAssistantStreamChunk, {
      assistantMessageId,
      jobId,
      delta: "The retry policy doubles the backoff on every transient error.",
    });

    await t.mutation(internal.chat.streaming.markAssistantReplyCancelled, {
      assistantMessageId,
      jobId,
      reason: "Cancelled by user.",
    });

    const cancelled = await t.run(async (ctx) => await ctx.db.get(assistantMessageId));
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.unverifiedClaims).toHaveLength(1);
    const range = cancelled!.unverifiedClaims![0];
    expect(cancelled!.content.slice(range.start, range.end)).toBe(
      "The retry policy doubles the backoff on every transient error.",
    );
  });

  test("markAssistantReplyCancelled omits unverifiedClaims when no partial content was streamed", async () => {
    // Stop arrived before any token was generated → `streamedContent`
    // is empty → bubble shows the reason text → no claims to lint.
    // The persisted field must stay `undefined` so the renderer does
    // not try to highlight inside the system-generated reason text.
    const ownerTokenIdentifier = "user|lint-cancel-empty";
    const t = convexTest(schema, modules);
    const { jobId, assistantMessageId } = await createStreamingFixture(t, ownerTokenIdentifier, "lint-cancel-empty");

    await t.run(async (ctx) => {
      await ctx.db.patch(assistantMessageId, { groundSandbox: true });
    });

    await t.mutation(internal.chat.streaming.markAssistantReplyCancelled, {
      assistantMessageId,
      jobId,
      reason: "Cancelled by user.",
    });

    const cancelled = await t.run(async (ctx) => await ctx.db.get(assistantMessageId));
    expect(cancelled?.status).toBe("cancelled");
    expect(cancelled?.unverifiedClaims).toBeUndefined();
    expect(cancelled?.content).toBe("Cancelled by user.");
  });

  test("recoverStaleChatJob runs the lint on partial sandbox content", async () => {
    // Same parity rationale as the fail / cancel paths: a sandbox reply
    // that streamed partial prose before its lease expired must surface
    // the same unverified-claim highlights the user would have seen on
    // a clean fail. The recovery mutation is the third terminal-state
    // entry point; without this test a future refactor could silently
    // skip the lint here while leaving the other two paths covered.
    const ownerTokenIdentifier = "user|lint-recover-sandbox";
    const t = convexTest(schema, modules);
    const { jobId, assistantMessageId } = await createStreamingFixture(t, ownerTokenIdentifier, "lint-recover-sandbox");

    await t.run(async (ctx) => {
      await ctx.db.patch(assistantMessageId, { groundSandbox: true });
    });

    // Stream partial content first so `streamSnapshot.content` is
    // non-empty when the recovery runs the lint.
    await t.mutation(internal.chat.streaming.appendAssistantStreamChunk, {
      assistantMessageId,
      jobId,
      delta: "The handler dispatches to the worker queue without any retry policy.",
    });

    // Push the job lease into the past so the recovery actually fires
    // (the mutation no-ops on a still-leased job).
    await t.run(async (ctx) => {
      await ctx.db.patch(jobId, { leaseExpiresAt: Date.now() - 1 });
    });

    await t.mutation(internal.chat.streaming.recoverStaleChatJob, {
      jobId,
    });

    const recovered = await t.run(async (ctx) => await ctx.db.get(assistantMessageId));
    expect(recovered?.status).toBe("failed");
    expect(recovered?.content).toBe("The handler dispatches to the worker queue without any retry policy.");
    expect(recovered?.unverifiedClaims).toHaveLength(1);
    const range = recovered!.unverifiedClaims![0];
    expect(recovered!.content.slice(range.start, range.end)).toBe(
      "The handler dispatches to the worker queue without any retry policy.",
    );
  });
});

/**
 * Tool-call ticker / persisted trace.
 *
 * The flow under test:
 *   1. `appendAssistantToolCallEvent` writes `start` and `end` rows keyed
 *      by `toolCallId`.
 *   2. `getMessageToolCallEvents` (the live subscription) returns folded
 *      entries with explicit `state` so the UI doesn't have to
 *      reverse-engineer it.
 *   3. `finalizeAssistantReply` folds the events into `messages.toolCalls`
 *      (paired by `toolCallId`, preserving multiple calls of the same
 *      tool) and drains the events table in the same transaction.
 *   4. `failAssistantReply` and the cascade deletes drain orphan events
 *      so the live subscription never points at a missing parent.
 */
describe("chat tool-call event lifecycle", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-23T00:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("getMessageToolCallEvents reflects start → end → drained transitions", async () => {
    const ownerTokenIdentifier = "user|tool-events";
    const t = convexTest(schema, modules);
    const { threadId, jobId, assistantMessageId } = await createStreamingFixture(
      t,
      ownerTokenIdentifier,
      "tool-events",
    );
    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });

    // Empty until the action emits any events.
    const initial = await viewer.query(api.chat.streaming.getMessageToolCallEvents, {
      assistantMessageId,
    });
    expect(initial).toEqual([]);

    // Step 1: a tool call starts. `getMessageToolCallEvents` should now
    // surface a single running entry — the ticker can paint immediately
    // even before the tool finishes.
    await t.mutation(internal.chat.streaming.appendAssistantToolCallEvent, {
      assistantMessageId,
      jobId,
      toolCallId: "call-1",
      type: "start",
      toolName: "read_file",
      inputSummary: '{"path":"convex/chat/send.ts"}',
      occurredAt: Date.now(),
    });
    const running = await viewer.query(api.chat.streaming.getMessageToolCallEvents, {
      assistantMessageId,
    });
    expect(running).toEqual([
      expect.objectContaining({
        toolCallId: "call-1",
        toolName: "read_file",
        inputSummary: '{"path":"convex/chat/send.ts"}',
        outputSummary: "",
        state: "running",
      }),
    ]);

    // Step 2: tool result arrives. Same toolCallId pairs `end` with the
    // existing `start`, lifting the entry to `completed` with output.
    vi.advanceTimersByTime(1234);
    await t.mutation(internal.chat.streaming.appendAssistantToolCallEvent, {
      assistantMessageId,
      jobId,
      toolCallId: "call-1",
      type: "end",
      toolName: "read_file",
      inputSummary: '{"path":"convex/chat/send.ts"}',
      outputSummary: '{"ok":true,"content":"export const send = ..."}',
      occurredAt: Date.now(),
    });
    const completed = await viewer.query(api.chat.streaming.getMessageToolCallEvents, {
      assistantMessageId,
    });
    expect(completed).toEqual([
      expect.objectContaining({
        toolCallId: "call-1",
        state: "completed",
      }),
    ]);
    expect(completed?.[0].endedAt).toBeGreaterThan(completed?.[0].startedAt ?? 0);

    // Step 3: finalize. Events drain in the same transaction the message
    // is patched, so the next subscription tick returns the empty list and
    // `messages.toolCalls` becomes the source of truth for the UI.
    await t.mutation(internal.chat.streaming.finalizeAssistantReply, {
      threadId,
      assistantMessageId,
      jobId,
      finalDelta: "Reading the send file confirms the lease wiring.",
    });

    const afterFinalize = await t.run(async (ctx) => ({
      message: await ctx.db.get(assistantMessageId),
      events: await ctx.db
        .query("messageToolCallEvents")
        .withIndex("by_messageId_and_sequence", (q) => q.eq("messageId", assistantMessageId))
        .take(10),
    }));
    expect(afterFinalize.events).toHaveLength(0);
    expect(afterFinalize.message?.toolCalls).toEqual([
      expect.objectContaining({
        toolCallId: "call-1",
        toolName: "read_file",
        outputSummary: '{"ok":true,"content":"export const send = ..."}',
      }),
    ]);

    const draining = await viewer.query(api.chat.streaming.getMessageToolCallEvents, {
      assistantMessageId,
    });
    expect(draining).toEqual([]);
  });

  test("finalizeAssistantReply preserves multiple distinct calls of the same tool name", async () => {
    // Regression guard against the previous "group by toolName" fold: two
    // `read_file` calls in one reply must produce two `messages.toolCalls`
    // entries, in execution order, paired by their distinct toolCallIds.
    const ownerTokenIdentifier = "user|tool-events-multi";
    const t = convexTest(schema, modules);
    const { threadId, jobId, assistantMessageId } = await createStreamingFixture(
      t,
      ownerTokenIdentifier,
      "tool-events-multi",
    );

    const t0 = Date.now();
    await t.mutation(internal.chat.streaming.appendAssistantToolCallEvent, {
      assistantMessageId,
      jobId,
      toolCallId: "call-a",
      type: "start",
      toolName: "read_file",
      inputSummary: '{"path":"convex/chat/send.ts"}',
      occurredAt: t0,
    });
    await t.mutation(internal.chat.streaming.appendAssistantToolCallEvent, {
      assistantMessageId,
      jobId,
      toolCallId: "call-a",
      type: "end",
      toolName: "read_file",
      inputSummary: '{"path":"convex/chat/send.ts"}',
      outputSummary: '{"ok":true,"path":"convex/chat/send.ts"}',
      occurredAt: t0 + 500,
    });
    await t.mutation(internal.chat.streaming.appendAssistantToolCallEvent, {
      assistantMessageId,
      jobId,
      toolCallId: "call-b",
      type: "start",
      toolName: "read_file",
      inputSummary: '{"path":"convex/chat/streaming.ts"}',
      occurredAt: t0 + 600,
    });
    await t.mutation(internal.chat.streaming.appendAssistantToolCallEvent, {
      assistantMessageId,
      jobId,
      toolCallId: "call-b",
      type: "end",
      toolName: "read_file",
      inputSummary: '{"path":"convex/chat/streaming.ts"}',
      outputSummary: '{"ok":true,"path":"convex/chat/streaming.ts"}',
      occurredAt: t0 + 1100,
    });

    await t.mutation(internal.chat.streaming.finalizeAssistantReply, {
      threadId,
      assistantMessageId,
      jobId,
      finalDelta: "ok",
    });

    const finalized = await t.run(async (ctx) => ctx.db.get(assistantMessageId));
    expect(finalized?.toolCalls).toHaveLength(2);
    expect(finalized?.toolCalls?.[0]).toMatchObject({
      toolCallId: "call-a",
      toolName: "read_file",
      inputSummary: '{"path":"convex/chat/send.ts"}',
    });
    expect(finalized?.toolCalls?.[1]).toMatchObject({
      toolCallId: "call-b",
      toolName: "read_file",
      inputSummary: '{"path":"convex/chat/streaming.ts"}',
    });
  });

  test("failAssistantReply persists partial tool calls and drains orphan events", async () => {
    // The model can crash mid-tool: a `start` event lands but the matching
    // `end` never arrives because the action's outer catch fires first.
    // The user should still see "what was running" via a partial entry,
    // and the events table must not leak.
    const ownerTokenIdentifier = "user|tool-events-partial";
    const t = convexTest(schema, modules);
    const { jobId, assistantMessageId } = await createStreamingFixture(t, ownerTokenIdentifier, "tool-events-partial");

    await t.mutation(internal.chat.streaming.appendAssistantToolCallEvent, {
      assistantMessageId,
      jobId,
      toolCallId: "call-orphan",
      type: "start",
      toolName: "read_file",
      inputSummary: '{"path":"convex/chat/send.ts"}',
      occurredAt: Date.now(),
    });

    await t.mutation(internal.chat.streaming.failAssistantReply, {
      assistantMessageId,
      jobId,
      errorMessage: "Sandbox archived mid-call.",
    });

    const failed = await t.run(async (ctx) => ({
      message: await ctx.db.get(assistantMessageId),
      events: await ctx.db
        .query("messageToolCallEvents")
        .withIndex("by_messageId_and_sequence", (q) => q.eq("messageId", assistantMessageId))
        .take(10),
    }));
    expect(failed.events).toHaveLength(0);
    expect(failed.message?.toolCalls).toEqual([
      expect.objectContaining({
        toolCallId: "call-orphan",
        toolName: "read_file",
        outputSummary: "",
      }),
    ]);
    // Partial entry: `endedAt` collapses to `startedAt`, which the UI
    // renders as "interrupted".
    expect(failed.message?.toolCalls?.[0].endedAt).toBe(failed.message?.toolCalls?.[0].startedAt);
  });

  test("recoverStaleChatJob folds and drains tool-call events on stale recovery", async () => {
    const ownerTokenIdentifier = "user|tool-events-stale";
    const t = convexTest(schema, modules);
    const { jobId, assistantMessageId } = await createStreamingFixture(t, ownerTokenIdentifier, "tool-events-stale");

    await t.mutation(internal.chat.streaming.appendAssistantToolCallEvent, {
      assistantMessageId,
      jobId,
      toolCallId: "call-stale",
      type: "start",
      toolName: "list_dir",
      inputSummary: '{"path":"convex/"}',
      occurredAt: Date.now(),
    });

    // Push the job lease into the past so recoverStaleChatJob actually fires.
    await t.run(async (ctx) => {
      await ctx.db.patch(jobId, { leaseExpiresAt: Date.now() - 1 });
    });

    await t.mutation(internal.chat.streaming.recoverStaleChatJob, {
      jobId,
    });

    const recovered = await t.run(async (ctx) => ({
      message: await ctx.db.get(assistantMessageId),
      events: await ctx.db
        .query("messageToolCallEvents")
        .withIndex("by_messageId_and_sequence", (q) => q.eq("messageId", assistantMessageId))
        .take(10),
    }));
    expect(recovered.events).toHaveLength(0);
    expect(recovered.message?.status).toBe("failed");
    expect(recovered.message?.toolCalls).toEqual([
      expect.objectContaining({
        toolCallId: "call-stale",
        toolName: "list_dir",
      }),
    ]);
  });

  test("recoverStaleChatJob runs the lint on partial sandbox content", async () => {
    // A sandbox reply that stalled mid-stream should still surface the
    // unverified-claim highlights for the partial content the user can read.
    // This mirrors the parity contract in the fail/cancel paths: a recovered
    // bubble in sandbox mode looks like a completed bubble for the partial
    // content that was streamed before the job lease expired.
    const ownerTokenIdentifier = "user|lint-recovery-sandbox";
    const t = convexTest(schema, modules);
    const { jobId, assistantMessageId } = await createStreamingFixture(
      t,
      ownerTokenIdentifier,
      "lint-recovery-sandbox",
    );

    await t.run(async (ctx) => {
      await ctx.db.patch(assistantMessageId, { groundSandbox: true });
    });

    // Stream partial content before the job stalls, so the lint sees a
    // non-empty `streamSnapshot.content` at recovery time.
    await t.mutation(internal.chat.streaming.appendAssistantStreamChunk, {
      assistantMessageId,
      jobId,
      delta: "The cache bypasses the database without any invalidation logic.",
    });

    // Push the job lease into the past so recoverStaleChatJob actually fires.
    await t.run(async (ctx) => {
      await ctx.db.patch(jobId, { leaseExpiresAt: Date.now() - 1 });
    });

    await t.mutation(internal.chat.streaming.recoverStaleChatJob, {
      jobId,
    });

    const recovered = await t.run(async (ctx) => await ctx.db.get(assistantMessageId));
    expect(recovered?.status).toBe("failed");
    expect(recovered?.unverifiedClaims).toHaveLength(1);
    // Round-trip the persisted offsets through the persisted content;
    // same offset-alignment guarantee as in the fail/cancel paths.
    const range = recovered!.unverifiedClaims![0];
    expect(recovered!.content.slice(range.start, range.end)).toBe(
      "The cache bypasses the database without any invalidation logic.",
    );
  });

  test("appendAssistantToolCallEvent character-caps oversized summaries", async () => {
    const ownerTokenIdentifier = "user|tool-events-cap";
    const t = convexTest(schema, modules);
    const { jobId, assistantMessageId } = await createStreamingFixture(t, ownerTokenIdentifier, "tool-events-cap");

    const oversized = "x".repeat(2000);
    await t.mutation(internal.chat.streaming.appendAssistantToolCallEvent, {
      assistantMessageId,
      jobId,
      toolCallId: "call-cap",
      type: "end",
      toolName: "run_shell",
      inputSummary: oversized,
      outputSummary: oversized,
      occurredAt: Date.now(),
    });

    const events = await t.run(async (ctx) =>
      ctx.db
        .query("messageToolCallEvents")
        .withIndex("by_messageId_and_sequence", (q) => q.eq("messageId", assistantMessageId))
        .take(10),
    );
    expect(events).toHaveLength(1);
    // Cap is `TOOL_CALL_EVENT_SUMMARY_MAX_CHARS = 600`. We don't reimport
    // the constant here so the test stays robust to bumps; we just assert
    // that truncation happened.
    expect(events[0].inputSummary.length).toBeLessThan(oversized.length);
    expect(events[0].outputSummary?.length).toBeLessThan(oversized.length);
    expect(events[0].inputSummary.endsWith("…[truncated]")).toBe(true);
  });

  test("repository cascade-delete drains tool-call events for child messages", async () => {
    const ownerTokenIdentifier = "user|tool-events-cascade";
    const t = convexTest(schema, modules);
    const { repositoryId, jobId, assistantMessageId } = await createStreamingFixture(
      t,
      ownerTokenIdentifier,
      "tool-events-cascade",
    );

    await t.mutation(internal.chat.streaming.appendAssistantToolCallEvent, {
      assistantMessageId,
      jobId,
      toolCallId: "call-cascade",
      type: "start",
      toolName: "read_file",
      inputSummary: '{"path":"a.ts"}',
      occurredAt: Date.now(),
    });

    await t.mutation(internal.repositories.cascadeDeleteRepository, {
      repositoryId,
    });

    const orphans = await t.run(async (ctx) =>
      ctx.db
        .query("messageToolCallEvents")
        .withIndex("by_messageId_and_sequence", (q) => q.eq("messageId", assistantMessageId))
        .take(10),
    );
    expect(orphans).toHaveLength(0);
  });

  test("getMessageToolCallEvents fences cross-tenant access", async () => {
    const ownerTokenIdentifier = "user|tool-events-owner";
    const otherTokenIdentifier = "user|tool-events-stranger";
    const t = convexTest(schema, modules);
    const { jobId, assistantMessageId } = await createStreamingFixture(t, ownerTokenIdentifier, "tool-events-fence");

    await t.mutation(internal.chat.streaming.appendAssistantToolCallEvent, {
      assistantMessageId,
      jobId,
      toolCallId: "call-fenced",
      type: "start",
      toolName: "read_file",
      inputSummary: '{"path":"x.ts"}',
      occurredAt: Date.now(),
    });

    // The owner sees the running event…
    const ownerView = await t
      .withIdentity({ tokenIdentifier: ownerTokenIdentifier })
      .query(api.chat.streaming.getMessageToolCallEvents, { assistantMessageId });
    expect(ownerView).toHaveLength(1);

    // …but a different identity gets `null` (not an error, so the UI can
    // call this at thread-load time without crashing on partial snapshots).
    const strangerView = await t
      .withIdentity({ tokenIdentifier: otherTokenIdentifier })
      .query(api.chat.streaming.getMessageToolCallEvents, { assistantMessageId });
    expect(strangerView).toBeNull();
  });

  /**
   * Reasoning trace plumbing (Plan: Phase 2). Covers:
   *
   *   - `appendAssistantReasoningDelta` accumulates into `liveReasoning`.
   *   - `markReasoningStarted` stamps the start timestamp once.
   *   - `markReasoningEnded` records the end and the surrounding
   *     `getActiveMessageStream` query surfaces both for the UI.
   *   - `finalizeAssistantReply` copies `liveReasoning` →
   *     `messages.reasoning` and computes `reasoningDurationMs` from the
   *     stamped timestamps.
   *   - `markAssistantReplyCancelled` preserves whatever reasoning was
   *     captured before the cancel landed (no data loss on partial).
   */
  test("reasoning deltas append into liveReasoning and stamp start / end", async () => {
    const ownerTokenIdentifier = "user|reasoning-stream";
    const t = convexTest(schema, modules);
    const { threadId, jobId, assistantMessageId, streamId } = await createStreamingFixture(
      t,
      ownerTokenIdentifier,
      "reasoning-stream",
    );

    await t.mutation(internal.chat.streaming.markReasoningStarted, {
      assistantMessageId,
      jobId,
      occurredAt: 1_000,
    });
    await t.mutation(internal.chat.streaming.appendAssistantReasoningDelta, {
      assistantMessageId,
      jobId,
      delta: "Thinking about ",
    });
    await t.mutation(internal.chat.streaming.appendAssistantReasoningDelta, {
      assistantMessageId,
      jobId,
      delta: "the approach.",
    });
    // Second `markReasoningStarted` is a no-op so total duration includes
    // the whole reasoning window.
    await t.mutation(internal.chat.streaming.markReasoningStarted, {
      assistantMessageId,
      jobId,
      occurredAt: 5_000,
    });
    await t.mutation(internal.chat.streaming.markReasoningEnded, {
      assistantMessageId,
      jobId,
      occurredAt: 6_500,
    });

    const stream = await t.run(async (ctx) => ctx.db.get(streamId));
    expect(stream?.liveReasoning).toBe("Thinking about the approach.");
    expect(stream?.reasoningStartedAt).toBe(1_000);
    expect(stream?.reasoningEndedAt).toBe(6_500);

    const viewer = t.withIdentity({ tokenIdentifier: ownerTokenIdentifier });
    const active = await viewer.query(api.chat.streaming.getActiveMessageStream, { threadId });
    expect(active).toMatchObject({
      reasoning: "Thinking about the approach.",
      reasoningStartedAt: 1_000,
      reasoningEndedAt: 6_500,
    });
  });

  test("finalizeAssistantReply copies reasoning to messages.reasoning and computes duration", async () => {
    const ownerTokenIdentifier = "user|reasoning-finalize";
    const t = convexTest(schema, modules);
    const { threadId, jobId, assistantMessageId, streamId } = await createStreamingFixture(
      t,
      ownerTokenIdentifier,
      "reasoning-finalize",
    );

    await t.mutation(internal.chat.streaming.markReasoningStarted, {
      assistantMessageId,
      jobId,
      occurredAt: 1_000,
    });
    await t.mutation(internal.chat.streaming.appendAssistantReasoningDelta, {
      assistantMessageId,
      jobId,
      delta: "Reasoned through the dependency graph.",
    });
    await t.mutation(internal.chat.streaming.markReasoningEnded, {
      assistantMessageId,
      jobId,
      occurredAt: 4_200,
    });

    await t.mutation(internal.chat.streaming.finalizeAssistantReply, {
      threadId,
      assistantMessageId,
      jobId,
      finalDelta: "Done.",
    });

    const state = await t.run(async (ctx) => ({
      message: await ctx.db.get(assistantMessageId),
      stream: await ctx.db.get(streamId),
    }));
    expect(state.message?.reasoning).toBe("Reasoned through the dependency graph.");
    expect(state.message?.reasoningDurationMs).toBe(3_200);
    // Stream row is dropped on finalize — `liveReasoning` doesn't outlive
    // the durable `messages.reasoning` copy.
    expect(state.stream).toBeNull();
  });

  test("non-reasoning replies leave messages.reasoning unset on finalize", async () => {
    const ownerTokenIdentifier = "user|reasoning-absent";
    const t = convexTest(schema, modules);
    const { threadId, jobId, assistantMessageId } = await createStreamingFixture(
      t,
      ownerTokenIdentifier,
      "reasoning-absent",
    );

    await t.mutation(internal.chat.streaming.appendAssistantStreamChunk, {
      assistantMessageId,
      jobId,
      delta: "Text-only reply.",
    });
    await t.mutation(internal.chat.streaming.finalizeAssistantReply, {
      threadId,
      assistantMessageId,
      jobId,
      finalDelta: "",
    });

    const message = await t.run(async (ctx) => ctx.db.get(assistantMessageId));
    expect(message?.reasoning).toBeUndefined();
    expect(message?.reasoningDurationMs).toBeUndefined();
  });

  test("markAssistantReplyCancelled preserves partial reasoning captured before the cancel", async () => {
    const ownerTokenIdentifier = "user|reasoning-cancel";
    const t = convexTest(schema, modules);
    const { jobId, assistantMessageId } = await createStreamingFixture(t, ownerTokenIdentifier, "reasoning-cancel");

    await t.mutation(internal.chat.streaming.markReasoningStarted, {
      assistantMessageId,
      jobId,
      occurredAt: 100,
    });
    await t.mutation(internal.chat.streaming.appendAssistantReasoningDelta, {
      assistantMessageId,
      jobId,
      delta: "Halfway through reasoning when the user clicked Stop.",
    });

    await t.mutation(internal.chat.streaming.markAssistantReplyCancelled, {
      assistantMessageId,
      jobId,
      finalDelta: undefined,
      reason: "Cancelled by user.",
    });

    const message = await t.run(async (ctx) => ctx.db.get(assistantMessageId));
    expect(message?.status).toBe("cancelled");
    expect(message?.reasoning).toBe("Halfway through reasoning when the user clicked Stop.");
    // `reasoningEndedAt` was never stamped — duration falls back to
    // `now - reasoningStartedAt`, which is positive regardless of the
    // exact `Date.now()` reading inside the mutation. Assert >= 0
    // rather than a specific value so the test isn't fake-timer-sensitive.
    expect(message?.reasoningDurationMs).toBeGreaterThanOrEqual(0);
  });

  test("appendAssistantReasoningDelta refreshes the job lease once half the lease window has elapsed", async () => {
    const ownerTokenIdentifier = "user|reasoning-lease-refresh";
    const t = convexTest(schema, modules);
    const { jobId, assistantMessageId } = await createStreamingFixture(
      t,
      ownerTokenIdentifier,
      "reasoning-lease-refresh",
    );

    // First delta: stream.lastAppendedAt was set at fixture creation time
    // (now), so the half-window check sees a "recent refresh" and skips
    // the job patch — same per-flush savings the text + tool paths apply.
    const firstAppendAt = await t.run(async (ctx) => (await ctx.db.get(jobId))!.leaseExpiresAt!);
    await t.mutation(internal.chat.streaming.appendAssistantReasoningDelta, {
      assistantMessageId,
      jobId,
      delta: "early reasoning",
    });
    const afterFirstAppend = await t.run(async (ctx) => (await ctx.db.get(jobId))!.leaseExpiresAt!);
    expect(afterFirstAppend).toBe(firstAppendAt);

    // Advance past half the lease window. Now stream.lastAppendedAt is
    // older than the threshold, so the next reasoning delta must extend
    // the lease — otherwise a long reasoning trace (5+ minutes of pure
    // thinking) would let the initial lease expire mid-stream and
    // `recoverStaleChatJob` would mark a healthy job stale.
    vi.advanceTimersByTime(6 * 60_000);
    await t.mutation(internal.chat.streaming.appendAssistantReasoningDelta, {
      assistantMessageId,
      jobId,
      delta: "still reasoning",
    });
    const afterLateAppend = await t.run(async (ctx) => (await ctx.db.get(jobId))!.leaseExpiresAt!);
    expect(afterLateAppend).toBeGreaterThan(afterFirstAppend);
  });
});

async function createStreamingFixture(t: ReturnType<typeof convexTest>, ownerTokenIdentifier: string, slug: string) {
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
      color: "blue",
      lastAccessedAt: Date.now(),
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
      status: "running",
      stage: "generating_reply",
      progress: 0.5,
      costCategory: "chat",
      triggerSource: "user",
      startedAt: Date.now(),
      leaseExpiresAt: Date.now() + 60_000,
    });

    await ctx.db.insert("messages", {
      repositoryId,
      threadId,
      jobId,
      ownerTokenIdentifier,
      role: "user",
      status: "completed",
      mode: "discuss",
      content: "How does this work?",
    });

    const assistantMessageId = await ctx.db.insert("messages", {
      repositoryId,
      threadId,
      jobId,
      ownerTokenIdentifier,
      role: "assistant",
      status: "streaming",
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
