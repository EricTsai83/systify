import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { CASCADE_BATCH_SIZE, MAX_TOOL_CALL_EVENTS_PER_MESSAGE } from "./constants";
import { logWarn } from "./observability";
import { clearLastActiveRepositoryIfMatches } from "./userPreferences";

const REPOSITORY_DELETE_RETRY_MS = 5_000;
const REPOSITORY_DELETE_MAX_SANDBOX_CLEANUP_RETRIES = 24;
const STREAM_CHUNK_DRAIN_PASS_LIMIT = 8;
const CASCADE_SAFE_READ_LIMIT = 30_000;
const CASCADE_SAFE_WRITE_LIMIT = 15_000;

interface CascadeBudget {
  reads: number;
  writes: number;
}

function canReadBatch(budget: CascadeBudget, size = CASCADE_BATCH_SIZE): boolean {
  return budget.reads + size <= CASCADE_SAFE_READ_LIMIT;
}

function canWriteBatch(budget: CascadeBudget, size = CASCADE_BATCH_SIZE): boolean {
  return budget.writes + size <= CASCADE_SAFE_WRITE_LIMIT;
}

function canStartBatch(budget: CascadeBudget, size = CASCADE_BATCH_SIZE): boolean {
  return canReadBatch(budget, size) && canWriteBatch(budget, size);
}

async function drainToolCallEventsByMessageId(
  ctx: MutationCtx,
  messageId: Id<"messages">,
  budget: CascadeBudget,
): Promise<boolean> {
  while (canStartBatch(budget, MAX_TOOL_CALL_EVENTS_PER_MESSAGE)) {
    const events = await ctx.db
      .query("messageToolCallEvents")
      .withIndex("by_messageId_and_sequence", (q) => q.eq("messageId", messageId))
      .take(MAX_TOOL_CALL_EVENTS_PER_MESSAGE);
    budget.reads += events.length;
    for (const event of events) {
      await ctx.db.delete(event._id);
      budget.writes += 1;
    }
    if (events.length < MAX_TOOL_CALL_EVENTS_PER_MESSAGE) {
      return true;
    }
  }
  return false;
}

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
  const budget: CascadeBudget = { reads: 0, writes: 0 };
  if (!canStartBatch(budget)) {
    return true;
  }
  const threads = await ctx.db
    .query("threads")
    .withIndex("by_repositoryId_and_lastMessageAt", (q) => q.eq("repositoryId", repositoryId))
    .take(CASCADE_BATCH_SIZE);
  budget.reads += threads.length;

  for (const thread of threads) {
    if (!canStartBatch(budget)) {
      return true;
    }
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_threadId", (q) => q.eq("threadId", thread._id))
      .take(CASCADE_BATCH_SIZE);
    budget.reads += msgs.length;
    let messagesDrained = true;
    for (const msg of msgs) {
      if (!canWriteBatch(budget, 1)) {
        return true;
      }
      const toolCallEventsDrained = await drainToolCallEventsByMessageId(ctx, msg._id, budget);
      if (!toolCallEventsDrained) {
        messagesDrained = false;
        more = true;
        break;
      }
      if (!canWriteBatch(budget, 1)) {
        return true;
      }
      await ctx.db.delete(msg._id);
      budget.writes += 1;
    }

    if (!canStartBatch(budget)) {
      return true;
    }
    const streams = await ctx.db
      .query("messageStreams")
      .withIndex("by_threadId", (q) => q.eq("threadId", thread._id))
      .take(CASCADE_BATCH_SIZE);
    budget.reads += streams.length;
    let streamChunksDrained = true;
    for (const stream of streams) {
      let streamChunksFullyDrained = false;
      for (let pass = 0; pass < STREAM_CHUNK_DRAIN_PASS_LIMIT; pass += 1) {
        if (!canStartBatch(budget)) {
          return true;
        }
        const streamChunks = await ctx.db
          .query("messageStreamChunks")
          .withIndex("by_streamId_and_sequence", (q) => q.eq("streamId", stream._id))
          .take(CASCADE_BATCH_SIZE);
        budget.reads += streamChunks.length;
        for (const chunk of streamChunks) {
          await ctx.db.delete(chunk._id);
          budget.writes += 1;
        }
        if (streamChunks.length < CASCADE_BATCH_SIZE) {
          streamChunksFullyDrained = true;
          break;
        }
      }
      if (streamChunksFullyDrained) {
        if (!canWriteBatch(budget, 1)) {
          return true;
        }
        await ctx.db.delete(stream._id);
        budget.writes += 1;
      } else {
        streamChunksDrained = false;
        more = true;
      }
    }
    if (streams.length === CASCADE_BATCH_SIZE) more = true;

    let artifactsDrained = true;
    for (let pass = 0; pass < STREAM_CHUNK_DRAIN_PASS_LIMIT; pass += 1) {
      if (!canStartBatch(budget)) {
        return true;
      }
      const artifacts = await ctx.db
        .query("artifacts")
        .withIndex("by_threadId", (q) => q.eq("threadId", thread._id))
        .take(CASCADE_BATCH_SIZE);
      budget.reads += artifacts.length;
      for (const artifact of artifacts) {
        await ctx.db.delete(artifact._id);
        budget.writes += 1;
      }
      if (artifacts.length === CASCADE_BATCH_SIZE) {
        artifactsDrained = false;
        continue;
      } else {
        artifactsDrained = true;
        break;
      }
    }
    if (!artifactsDrained) {
      more = true;
    }

    if (
      msgs.length < CASCADE_BATCH_SIZE &&
      messagesDrained &&
      streams.length < CASCADE_BATCH_SIZE &&
      streamChunksDrained &&
      artifactsDrained
    ) {
      if (!canWriteBatch(budget, 1)) {
        return true;
      }
      await ctx.db.delete(thread._id);
      budget.writes += 1;
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
  const repositoryBeforeCleanup = await ctx.db.get(args.repositoryId);
  const sandboxCleanupAttempts = repositoryBeforeCleanup?.repositoryDeleteSandboxCleanupAttempts ?? 0;
  const sandboxCleanupRetryExhausted = sandboxCleanupAttempts >= REPOSITORY_DELETE_MAX_SANDBOX_CLEANUP_RETRIES;
  const cleanupState: { pendingCleanupCount: number } = sandboxCleanupRetryExhausted
    ? { pendingCleanupCount: 0 }
    : await ctx.runMutation(internal.ops.scheduleRepositorySandboxCleanup, {
        repositoryId: args.repositoryId,
      });
  let more = false;
  let waitingOnSandboxCleanup = !sandboxCleanupRetryExhausted && cleanupState.pendingCleanupCount > 0;

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
  let nonArchivedSandboxCount = 0;
  for (const sandbox of sandboxes) {
    if (sandbox.status === "archived") {
      await ctx.db.delete(sandbox._id);
    } else if (sandboxCleanupRetryExhausted) {
      nonArchivedSandboxCount += 1;
      await ctx.db.patch(sandbox._id, {
        status: "failed",
        lastErrorMessage: `Repository deletion sandbox cleanup exceeded ${REPOSITORY_DELETE_MAX_SANDBOX_CLEANUP_RETRIES} retries.`,
      });
    } else {
      waitingOnSandboxCleanup = true;
    }
  }
  if (sandboxes.length === CASCADE_BATCH_SIZE) more = true;

  if (sandboxCleanupRetryExhausted && nonArchivedSandboxCount > 0) {
    const failureMessage = `Repository deletion stopped after ${REPOSITORY_DELETE_MAX_SANDBOX_CLEANUP_RETRIES} sandbox cleanup retries.`;
    await ctx.db.patch(args.repositoryId, {
      repositoryDeleteFailedAt: Date.now(),
      repositoryDeleteFailureMessage: failureMessage,
    });
    logWarn("repositories", "repository_delete_sandbox_cleanup_retry_exhausted", {
      repositoryId: args.repositoryId,
      pendingCleanupCount: nonArchivedSandboxCount,
      attempts: sandboxCleanupAttempts,
    });
    return;
  }

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
