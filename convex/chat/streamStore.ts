import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { CASCADE_BATCH_SIZE, MESSAGE_STREAM_COMPACT_CHUNK_THRESHOLD } from "../lib/constants";

type DbCtx = Pick<QueryCtx, "db"> | Pick<MutationCtx, "db">;

export async function getMessageStreamByThread(ctx: DbCtx, threadId: Id<"threads">) {
  const streams = await ctx.db
    .query("messageStreams")
    .withIndex("by_threadId", (q) => q.eq("threadId", threadId))
    .order("desc")
    .take(5);

  return streams[0] ?? null;
}

export async function getMessageStreamByAssistantMessageId(ctx: DbCtx, assistantMessageId: Id<"messages">) {
  return await ctx.db
    .query("messageStreams")
    .withIndex("by_assistantMessageId", (q) => q.eq("assistantMessageId", assistantMessageId))
    .unique();
}

export async function getMessageStreamByJobId(ctx: DbCtx, jobId: Id<"jobs">) {
  return await ctx.db
    .query("messageStreams")
    .withIndex("by_jobId", (q) => q.eq("jobId", jobId))
    .unique();
}

export async function loadMessageStreamSnapshot(ctx: DbCtx, assistantMessageId: Id<"messages">) {
  const stream = await getMessageStreamByAssistantMessageId(ctx, assistantMessageId);
  if (!stream) {
    return null;
  }

  const tailChunks = await loadAllStreamTailChunks(ctx, stream);

  return {
    stream,
    tailChunks,
    content: `${stream.compactedContent}${tailChunks.map((chunk) => chunk.text).join("")}`,
  };
}

export async function loadAllStreamTailChunks(ctx: DbCtx, stream: Doc<"messageStreams">) {
  const tailChunks: Doc<"messageStreamChunks">[] = [];
  let cursor = stream.compactedThroughSequence;
  while (true) {
    const batch = await ctx.db
      .query("messageStreamChunks")
      .withIndex("by_streamId_and_sequence", (q) => q.eq("streamId", stream._id).gt("sequence", cursor))
      .take(CASCADE_BATCH_SIZE);
    if (batch.length === 0) {
      break;
    }
    tailChunks.push(...batch);
    cursor = batch[batch.length - 1]!.sequence;
    if (batch.length < CASCADE_BATCH_SIZE) {
      break;
    }
  }

  return tailChunks;
}

async function loadStreamTailChunks(
  ctx: DbCtx,
  stream: Doc<"messageStreams">,
  limit: number = MESSAGE_STREAM_COMPACT_CHUNK_THRESHOLD,
) {
  return await ctx.db
    .query("messageStreamChunks")
    .withIndex("by_streamId_and_sequence", (q) =>
      q.eq("streamId", stream._id).gt("sequence", stream.compactedThroughSequence),
    )
    .take(limit);
}

export async function compactMessageStreamTail(ctx: MutationCtx, streamId: Id<"messageStreams">) {
  const stream = await ctx.db.get(streamId);
  if (!stream) {
    return;
  }

  const pendingChunkCount = stream.nextSequence - (stream.compactedThroughSequence + 1);
  if (pendingChunkCount < MESSAGE_STREAM_COMPACT_CHUNK_THRESHOLD) {
    return;
  }

  const tailChunks = await loadStreamTailChunks(ctx, stream);
  if (tailChunks.length < MESSAGE_STREAM_COMPACT_CHUNK_THRESHOLD) {
    return;
  }

  const lastSequence = tailChunks[tailChunks.length - 1]?.sequence;
  if (typeof lastSequence !== "number") {
    return;
  }

  await ctx.db.patch(streamId, {
    compactedContent: `${stream.compactedContent}${tailChunks.map((chunk) => chunk.text).join("")}`,
    compactedThroughSequence: lastSequence,
    lastAppendedAt: Date.now(),
  });

  for (const chunk of tailChunks) {
    await ctx.db.delete(chunk._id);
  }
}

/**
 * Fully drain a stream's chunks and delete its header. Returns the number of
 * chunk rows actually deleted so callers can budget across multiple streams
 * without overflowing a single mutation's read/write limits. This function is
 * idempotent: calling it again on an already-deleted stream is a no-op (the
 * `ctx.db.delete(streamId)` would throw, so we guard it).
 */
export async function deleteMessageStreamState(ctx: MutationCtx, streamId: Id<"messageStreams">): Promise<number> {
  let drainedCount = 0;
  while (true) {
    const chunks = await ctx.db
      .query("messageStreamChunks")
      .withIndex("by_streamId_and_sequence", (q) => q.eq("streamId", streamId))
      .take(CASCADE_BATCH_SIZE);
    for (const chunk of chunks) {
      await ctx.db.delete(chunk._id);
    }
    drainedCount += chunks.length;
    if (chunks.length < CASCADE_BATCH_SIZE) {
      break;
    }
  }

  const stream = await ctx.db.get(streamId);
  if (stream) {
    await ctx.db.delete(streamId);
  }
  return drainedCount;
}
