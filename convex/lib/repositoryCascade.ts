import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { drainMessageToolCallEvents } from "../chat/toolCallEventStore";
import { CASCADE_BATCH_SIZE } from "./constants";
import { clearLastActiveRepositoryIfMatches } from "./userPreferences";

const REPOSITORY_DELETE_RETRY_MS = 5_000;
const STREAM_CHUNK_DRAIN_PASS_LIMIT = 8;

async function drainArtifactsByRepositoryId(ctx: MutationCtx, repositoryId: Id<"repositories">): Promise<boolean> {
  const docs = await ctx.db
    .query("artifacts")
    .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
    .take(CASCADE_BATCH_SIZE);
  for (const doc of docs) await ctx.db.delete(doc._id);
  return docs.length === CASCADE_BATCH_SIZE;
}

async function drainRepoChunksByRepositoryId(ctx: MutationCtx, repositoryId: Id<"repositories">): Promise<boolean> {
  const docs = await ctx.db
    .query("repoChunks")
    .withIndex("by_repositoryId_and_path", (q) => q.eq("repositoryId", repositoryId))
    .take(CASCADE_BATCH_SIZE);
  for (const doc of docs) await ctx.db.delete(doc._id);
  return docs.length === CASCADE_BATCH_SIZE;
}

async function drainRepoFilesByRepositoryId(ctx: MutationCtx, repositoryId: Id<"repositories">): Promise<boolean> {
  const docs = await ctx.db
    .query("repoFiles")
    .withIndex("by_repositoryId_and_path", (q) => q.eq("repositoryId", repositoryId))
    .take(CASCADE_BATCH_SIZE);
  for (const doc of docs) await ctx.db.delete(doc._id);
  return docs.length === CASCADE_BATCH_SIZE;
}

async function drainImportsByRepositoryId(ctx: MutationCtx, repositoryId: Id<"repositories">): Promise<boolean> {
  const docs = await ctx.db
    .query("imports")
    .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
    .take(CASCADE_BATCH_SIZE);
  for (const doc of docs) await ctx.db.delete(doc._id);
  return docs.length === CASCADE_BATCH_SIZE;
}

async function drainJobsByRepositoryId(ctx: MutationCtx, repositoryId: Id<"repositories">): Promise<boolean> {
  const docs = await ctx.db
    .query("jobs")
    .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
    .take(CASCADE_BATCH_SIZE);
  for (const doc of docs) await ctx.db.delete(doc._id);
  return docs.length === CASCADE_BATCH_SIZE;
}

async function drainArtifactViewsByRepository(
  ctx: MutationCtx,
  args: { ownerTokenIdentifier: string; repositoryId: Id<"repositories"> },
): Promise<boolean> {
  const docs = await ctx.db
    .query("artifactViews")
    .withIndex("by_ownerTokenIdentifier_and_repositoryId", (q) =>
      q.eq("ownerTokenIdentifier", args.ownerTokenIdentifier).eq("repositoryId", args.repositoryId),
    )
    .take(CASCADE_BATCH_SIZE);
  for (const doc of docs) await ctx.db.delete(doc._id);
  return docs.length === CASCADE_BATCH_SIZE;
}

async function drainRepositoryViewerBootstrapsByRepository(
  ctx: MutationCtx,
  args: { ownerTokenIdentifier: string; repositoryId: Id<"repositories"> },
): Promise<boolean> {
  const docs = await ctx.db
    .query("repositoryViewerBootstraps")
    .withIndex("by_ownerTokenIdentifier_and_repositoryId", (q) =>
      q.eq("ownerTokenIdentifier", args.ownerTokenIdentifier).eq("repositoryId", args.repositoryId),
    )
    .take(CASCADE_BATCH_SIZE);
  for (const doc of docs) await ctx.db.delete(doc._id);
  return docs.length === CASCADE_BATCH_SIZE;
}

async function drainThreadsByRepositoryId(ctx: MutationCtx, repositoryId: Id<"repositories">): Promise<boolean> {
  let more = false;
  const threads = await ctx.db
    .query("threads")
    .withIndex("by_repositoryId_and_lastMessageAt", (q) => q.eq("repositoryId", repositoryId))
    .take(CASCADE_BATCH_SIZE);

  for (const thread of threads) {
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_threadId", (q) => q.eq("threadId", thread._id))
      .take(CASCADE_BATCH_SIZE);
    for (const msg of msgs) {
      await drainMessageToolCallEvents(ctx, msg._id);
      await ctx.db.delete(msg._id);
    }

    const streams = await ctx.db
      .query("messageStreams")
      .withIndex("by_threadId", (q) => q.eq("threadId", thread._id))
      .take(CASCADE_BATCH_SIZE);
    let streamChunksDrained = true;
    for (const stream of streams) {
      let streamChunksFullyDrained = false;
      for (let pass = 0; pass < STREAM_CHUNK_DRAIN_PASS_LIMIT; pass += 1) {
        const streamChunks = await ctx.db
          .query("messageStreamChunks")
          .withIndex("by_streamId_and_sequence", (q) => q.eq("streamId", stream._id))
          .take(CASCADE_BATCH_SIZE);
        for (const chunk of streamChunks) await ctx.db.delete(chunk._id);
        if (streamChunks.length < CASCADE_BATCH_SIZE) {
          streamChunksFullyDrained = true;
          break;
        }
      }
      if (streamChunksFullyDrained) {
        await ctx.db.delete(stream._id);
      } else {
        streamChunksDrained = false;
        more = true;
      }
    }
    if (streams.length === CASCADE_BATCH_SIZE) more = true;

    let artifactsDrained = true;
    let artifactMore = false;
    for (let pass = 0; pass < STREAM_CHUNK_DRAIN_PASS_LIMIT; pass += 1) {
      const artifacts = await ctx.db
        .query("artifacts")
        .withIndex("by_threadId", (q) => q.eq("threadId", thread._id))
        .take(CASCADE_BATCH_SIZE);
      for (const artifact of artifacts) await ctx.db.delete(artifact._id);
      if (artifacts.length === CASCADE_BATCH_SIZE) {
        artifactMore = true;
      } else {
        artifactsDrained = true;
        break;
      }
    }
    if (artifactMore) {
      artifactsDrained = false;
      more = true;
    }

    if (
      msgs.length < CASCADE_BATCH_SIZE &&
      streams.length < CASCADE_BATCH_SIZE &&
      streamChunksDrained &&
      artifactsDrained
    ) {
      await ctx.db.delete(thread._id);
    } else {
      more = true;
    }
  }

  return more || threads.length === CASCADE_BATCH_SIZE;
}

export async function runRepositoryCascadeDelete(
  ctx: MutationCtx,
  args: { repositoryId: Id<"repositories"> },
): Promise<void> {
  const cleanupState: { pendingCleanupCount: number } = await ctx.runMutation(
    internal.ops.scheduleRepositorySandboxCleanup,
    { repositoryId: args.repositoryId },
  );
  let more = false;
  let waitingOnSandboxCleanup = cleanupState.pendingCleanupCount > 0;

  more = (await drainThreadsByRepositoryId(ctx, args.repositoryId)) || more;

  const repository = await ctx.db.get(args.repositoryId);
  if (repository) {
    more =
      (await drainArtifactViewsByRepository(ctx, {
        ownerTokenIdentifier: repository.ownerTokenIdentifier,
        repositoryId: args.repositoryId,
      })) || more;
    more =
      (await drainRepositoryViewerBootstrapsByRepository(ctx, {
        ownerTokenIdentifier: repository.ownerTokenIdentifier,
        repositoryId: args.repositoryId,
      })) || more;
  }

  more = (await drainArtifactsByRepositoryId(ctx, args.repositoryId)) || more;
  more = (await drainRepoChunksByRepositoryId(ctx, args.repositoryId)) || more;
  more = (await drainRepoFilesByRepositoryId(ctx, args.repositoryId)) || more;
  more = (await drainImportsByRepositoryId(ctx, args.repositoryId)) || more;

  const sandboxes = await ctx.db
    .query("sandboxes")
    .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repositoryId))
    .order("desc")
    .take(CASCADE_BATCH_SIZE);
  for (const sandbox of sandboxes) {
    if (sandbox.status === "archived") {
      await ctx.db.delete(sandbox._id);
    } else {
      waitingOnSandboxCleanup = true;
    }
  }
  if (sandboxes.length === CASCADE_BATCH_SIZE) more = true;

  if (!waitingOnSandboxCleanup) {
    more = (await drainJobsByRepositoryId(ctx, args.repositoryId)) || more;
  }

  if (more || waitingOnSandboxCleanup) {
    await ctx.scheduler.runAfter(
      waitingOnSandboxCleanup ? REPOSITORY_DELETE_RETRY_MS : 0,
      internal.repositories.cascadeDeleteRepository,
      { repositoryId: args.repositoryId },
    );
    return;
  }

  const finalRepository = await ctx.db.get(args.repositoryId);
  if (finalRepository) {
    await clearLastActiveRepositoryIfMatches(ctx, {
      ownerTokenIdentifier: finalRepository.ownerTokenIdentifier,
      repositoryId: args.repositoryId,
    });
    await ctx.db.delete(args.repositoryId);
  }
}
