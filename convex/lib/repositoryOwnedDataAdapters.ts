import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { drainArchivedThreadScopesByRepositoryId } from "../chat/archiveState";
import { drainHistoryGroupsByRepositoryId, drainThreadSharesByRepositoryId } from "../chat/historyState";
import { CASCADE_BATCH_SIZE, MAX_TOOL_CALL_EVENTS_PER_MESSAGE } from "./constants";
import { deleteArtifactWrite } from "./artifactWrites";
import { clearLastActiveRepositoryIfMatches } from "./userPreferences";

const STREAM_CHUNK_DRAIN_PASS_LIMIT = 8;
const CASCADE_SAFE_READ_LIMIT = 30_000;
const CASCADE_SAFE_WRITE_LIMIT = 15_000;

interface CascadeBudget {
  reads: number;
  writes: number;
}

export interface DrainRepositorySandboxesResult {
  more: boolean;
  nonArchivedSandboxCount: number;
  waitingOnSandboxCleanup: boolean;
}

export interface RepositoryOwnedDataDrainContext {
  repositoryId: Id<"repositories">;
  ownerTokenIdentifier: string | null;
  sandboxCleanupRetryExhausted: boolean;
  maxSandboxCleanupRetries: number;
}

export interface RepositoryOwnedDataDrainResult {
  more: boolean;
  nonArchivedSandboxCount?: number;
  waitingOnSandboxCleanup?: boolean;
}

type RepositoryOwnedDataDrainAdapter = (
  ctx: MutationCtx,
  args: RepositoryOwnedDataDrainContext,
) => Promise<RepositoryOwnedDataDrainResult>;

function more(moreRemaining: boolean): RepositoryOwnedDataDrainResult {
  return { more: moreRemaining };
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
  for (const doc of docs) await deleteArtifactWrite(ctx, doc._id);
  return docs.length === CASCADE_BATCH_SIZE;
}

async function drainArtifactChunksByRepositoryId(ctx: MutationCtx, repositoryId: Id<"repositories">): Promise<boolean> {
  const docs = await ctx.db
    .query("artifactChunks")
    .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
    .take(CASCADE_BATCH_SIZE);
  for (const doc of docs) await ctx.db.delete(doc._id);
  return docs.length === CASCADE_BATCH_SIZE;
}

async function drainArtifactFoldersByRepositoryId(
  ctx: MutationCtx,
  repositoryId: Id<"repositories">,
): Promise<boolean> {
  const docs = await ctx.db
    .query("artifactFolders")
    .withIndex("by_repositoryId", (q) => q.eq("repositoryId", repositoryId))
    .take(CASCADE_BATCH_SIZE);
  for (const doc of docs) await ctx.db.delete(doc._id);
  return docs.length === CASCADE_BATCH_SIZE;
}

async function drainArtifactDraftsByRepositoryId(ctx: MutationCtx, repositoryId: Id<"repositories">): Promise<boolean> {
  const docs = await ctx.db
    .query("artifactDrafts")
    .withIndex("by_repositoryId_and_status", (q) => q.eq("repositoryId", repositoryId))
    .take(CASCADE_BATCH_SIZE);
  for (const doc of docs) {
    if ((doc.outputFormat ?? "markdown") === "html" && doc.htmlStorageId) {
      await ctx.storage.delete(doc.htmlStorageId);
    }
    await ctx.db.delete(doc._id);
  }
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

async function drainSystemDesignKindRunsByRepositoryId(
  ctx: MutationCtx,
  repositoryId: Id<"repositories">,
): Promise<boolean> {
  const docs = await ctx.db
    .query("systemDesignKindRuns")
    .withIndex("by_repositoryId_and_kind", (q) => q.eq("repositoryId", repositoryId))
    .take(CASCADE_BATCH_SIZE);
  for (const doc of docs) await ctx.db.delete(doc._id);
  return docs.length === CASCADE_BATCH_SIZE;
}

async function drainSandboxSessionsByRepositoryId(
  ctx: MutationCtx,
  repositoryId: Id<"repositories">,
): Promise<boolean> {
  const docs = await ctx.db
    .query("sandboxSessions")
    .withIndex("by_repositoryId_and_startedAt", (q) => q.eq("repositoryId", repositoryId))
    .take(CASCADE_BATCH_SIZE);
  for (const doc of docs) await ctx.db.delete(doc._id);
  return docs.length === CASCADE_BATCH_SIZE;
}

async function detachSandboxRemoteObservation(ctx: MutationCtx, remoteId: string): Promise<void> {
  if (remoteId === "") {
    return;
  }

  const observation = await ctx.db
    .query("sandboxRemoteObservations")
    .withIndex("by_remoteId", (q) => q.eq("remoteId", remoteId))
    .unique();
  if (!observation) {
    return;
  }

  await ctx.db.patch(observation._id, {
    sandboxId: undefined,
    repositoryId: undefined,
    discoveryStatus: "ignored",
    confirmAfterAt: undefined,
    lastWebhookAt: Date.now(),
  });
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
        await deleteArtifactWrite(ctx, artifact._id);
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

async function drainRepositoryThreadGraph(
  ctx: MutationCtx,
  args: { repositoryId: Id<"repositories"> },
): Promise<boolean> {
  let more = false;
  more = (await drainThreadsByRepositoryId(ctx, args.repositoryId)) || more;
  more = (await drainThreadSharesByRepositoryId(ctx, args.repositoryId)) || more;
  more = (await drainHistoryGroupsByRepositoryId(ctx, args.repositoryId)) || more;
  more = (await drainArchivedThreadScopesByRepositoryId(ctx, args.repositoryId)) || more;
  return more;
}

async function drainRepositoryOwnerViewerState(
  ctx: MutationCtx,
  args: { ownerTokenIdentifier: string; repositoryId: Id<"repositories"> },
): Promise<boolean> {
  let more = false;
  more = (await drainArtifactViewsByRepository(ctx, args)) || more;
  more = (await drainRepositoryViewerBootstrapsByRepository(ctx, args)) || more;
  return more;
}

async function drainRepositoryContentState(
  ctx: MutationCtx,
  args: { repositoryId: Id<"repositories"> },
): Promise<boolean> {
  let more = false;
  more = (await drainArtifactChunksByRepositoryId(ctx, args.repositoryId)) || more;
  more = (await drainArtifactsByRepositoryId(ctx, args.repositoryId)) || more;
  more = (await drainArtifactFoldersByRepositoryId(ctx, args.repositoryId)) || more;
  more = (await drainArtifactDraftsByRepositoryId(ctx, args.repositoryId)) || more;
  more = (await drainRepoChunksByRepositoryId(ctx, args.repositoryId)) || more;
  more = (await drainRepoFilesByRepositoryId(ctx, args.repositoryId)) || more;
  more = (await drainImportsByRepositoryId(ctx, args.repositoryId)) || more;
  more = (await drainSystemDesignKindRunsByRepositoryId(ctx, args.repositoryId)) || more;
  return more;
}

async function drainRepositorySandboxSessions(
  ctx: MutationCtx,
  args: { repositoryId: Id<"repositories"> },
): Promise<boolean> {
  return await drainSandboxSessionsByRepositoryId(ctx, args.repositoryId);
}

async function drainRepositorySandboxes(
  ctx: MutationCtx,
  args: {
    repositoryId: Id<"repositories">;
    sandboxCleanupRetryExhausted: boolean;
    maxSandboxCleanupRetries: number;
  },
): Promise<DrainRepositorySandboxesResult> {
  const sandboxes = await ctx.db
    .query("sandboxes")
    .withIndex("by_repositoryId", (q) => q.eq("repositoryId", args.repositoryId))
    .order("desc")
    .take(CASCADE_BATCH_SIZE);
  let nonArchivedSandboxCount = 0;
  let waitingOnSandboxCleanup = false;

  for (const sandbox of sandboxes) {
    if (sandbox.status === "archived") {
      await detachSandboxRemoteObservation(ctx, sandbox.remoteId);
      await ctx.db.delete(sandbox._id);
    } else if (args.sandboxCleanupRetryExhausted) {
      nonArchivedSandboxCount += 1;
      await ctx.db.patch(sandbox._id, {
        status: "failed",
        lastErrorMessage: `Repository deletion sandbox cleanup exceeded ${args.maxSandboxCleanupRetries} retries.`,
      });
    } else {
      waitingOnSandboxCleanup = true;
    }
  }

  return {
    more: sandboxes.length === CASCADE_BATCH_SIZE,
    nonArchivedSandboxCount,
    waitingOnSandboxCleanup,
  };
}

async function drainRepositoryJobs(ctx: MutationCtx, args: { repositoryId: Id<"repositories"> }): Promise<boolean> {
  return await drainJobsByRepositoryId(ctx, args.repositoryId);
}

async function drainRepositoryOwnerViewerStateIfOwnerKnown(
  ctx: MutationCtx,
  args: RepositoryOwnedDataDrainContext,
): Promise<RepositoryOwnedDataDrainResult> {
  if (!args.ownerTokenIdentifier) {
    return more(false);
  }
  return more(
    await drainRepositoryOwnerViewerState(ctx, {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      repositoryId: args.repositoryId,
    }),
  );
}

async function clearRepositoryOwnerViewerPreference(
  ctx: MutationCtx,
  args: RepositoryOwnedDataDrainContext,
): Promise<RepositoryOwnedDataDrainResult> {
  if (!args.ownerTokenIdentifier) {
    return more(false);
  }
  await clearLastActiveRepositoryIfMatches(ctx, {
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    repositoryId: args.repositoryId,
  });
  return more(false);
}

async function deleteRepositoryRoot(
  ctx: MutationCtx,
  args: RepositoryOwnedDataDrainContext,
): Promise<RepositoryOwnedDataDrainResult> {
  const repository = await ctx.db.get(args.repositoryId);
  if (repository) {
    await ctx.db.delete(args.repositoryId);
  }
  return more(false);
}

export const REPOSITORY_OWNED_DATA_DRAIN_ADAPTERS = {
  threadGraph: async (ctx, args) => more(await drainRepositoryThreadGraph(ctx, args)),
  ownerViewerState: drainRepositoryOwnerViewerStateIfOwnerKnown,
  clearOwnerViewerPreference: clearRepositoryOwnerViewerPreference,
  repositoryContentState: async (ctx, args) => more(await drainRepositoryContentState(ctx, args)),
  sandboxSessions: async (ctx, args) => more(await drainRepositorySandboxSessions(ctx, args)),
  sandboxes: async (ctx, args) => {
    const result = await drainRepositorySandboxes(ctx, {
      repositoryId: args.repositoryId,
      sandboxCleanupRetryExhausted: args.sandboxCleanupRetryExhausted,
      maxSandboxCleanupRetries: args.maxSandboxCleanupRetries,
    });
    return result;
  },
  jobs: async (ctx, args) => more(await drainRepositoryJobs(ctx, args)),
  repositoryRoot: deleteRepositoryRoot,
} satisfies Record<string, RepositoryOwnedDataDrainAdapter>;

export type RepositoryOwnedDataDrainAdapterKey = keyof typeof REPOSITORY_OWNED_DATA_DRAIN_ADAPTERS;
