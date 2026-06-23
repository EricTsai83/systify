import { internal } from "../_generated/api";
import type { Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { clearLastActiveRepositoryIfMatches } from "./userPreferences";
import { logWarn } from "./observability";
import {
  drainRepositoryContentState,
  drainRepositoryJobs,
  drainRepositoryOwnerViewerState,
  drainRepositorySandboxes,
  drainRepositorySandboxSessions,
  drainRepositoryThreadGraph,
} from "./repositoryOwnedDataAdapters";

const REPOSITORY_DELETE_RETRY_MS = 5_000;
export const REPOSITORY_DELETE_MAX_SANDBOX_CLEANUP_RETRIES = 24;

export type RepositoryOwnedDataGraph =
  | "threadGraph"
  | "ownerViewerState"
  | "repositoryContentState"
  | "sandboxLocalState"
  | "jobs"
  | "repositoryRoot"
  | "retainedAuditData";

export type RepositoryOwnedDataDisposition = "delete" | "patch" | "retain";

export interface RepositoryOwnedDataLifecycleRegistryEntry {
  table: TableNames;
  graph: RepositoryOwnedDataGraph;
  disposition: RepositoryOwnedDataDisposition;
  cleanupPath: string;
}

export const REPOSITORY_OWNED_DATA_LIFECYCLE_REGISTRY = [
  {
    table: "messageToolCallEvents",
    graph: "threadGraph",
    disposition: "delete",
    cleanupPath: "drain by messageId before messages",
  },
  {
    table: "messages",
    graph: "threadGraph",
    disposition: "delete",
    cleanupPath: "drain by threadId",
  },
  {
    table: "messageStreamChunks",
    graph: "threadGraph",
    disposition: "delete",
    cleanupPath: "drain by streamId before messageStreams",
  },
  {
    table: "messageStreams",
    graph: "threadGraph",
    disposition: "delete",
    cleanupPath: "drain by threadId",
  },
  {
    table: "threads",
    graph: "threadGraph",
    disposition: "delete",
    cleanupPath: "drain by repositoryId after child chat state",
  },
  {
    table: "threadShares",
    graph: "threadGraph",
    disposition: "delete",
    cleanupPath: "drain by repositoryId",
  },
  {
    table: "chatHistoryGroups",
    graph: "threadGraph",
    disposition: "delete",
    cleanupPath: "drain by repositoryId",
  },
  {
    table: "archivedThreadScopes",
    graph: "threadGraph",
    disposition: "delete",
    cleanupPath: "drain by repositoryId",
  },
  {
    table: "artifactViews",
    graph: "ownerViewerState",
    disposition: "delete",
    cleanupPath: "drain by ownerTokenIdentifier and repositoryId",
  },
  {
    table: "repositoryViewerBootstraps",
    graph: "ownerViewerState",
    disposition: "delete",
    cleanupPath: "drain by ownerTokenIdentifier and repositoryId",
  },
  {
    table: "userPreferences",
    graph: "ownerViewerState",
    disposition: "patch",
    cleanupPath: "clear lastActiveRepositoryId when it matches repositoryId",
  },
  {
    table: "artifactChunks",
    graph: "repositoryContentState",
    disposition: "delete",
    cleanupPath: "drain by repositoryId before artifacts",
  },
  {
    table: "artifacts",
    graph: "repositoryContentState",
    disposition: "delete",
    cleanupPath: "drain through deleteArtifactWrite by threadId/repositoryId",
  },
  {
    table: "artifactVersions",
    graph: "repositoryContentState",
    disposition: "delete",
    cleanupPath: "drain by artifactId before deleting each artifact, including HTML storage blobs",
  },
  {
    table: "artifactFolders",
    graph: "repositoryContentState",
    disposition: "delete",
    cleanupPath: "drain by repositoryId",
  },
  {
    table: "artifactDrafts",
    graph: "repositoryContentState",
    disposition: "delete",
    cleanupPath: "drain by repositoryId",
  },
  {
    table: "repoChunks",
    graph: "repositoryContentState",
    disposition: "delete",
    cleanupPath: "drain by repositoryId",
  },
  {
    table: "repoFiles",
    graph: "repositoryContentState",
    disposition: "delete",
    cleanupPath: "drain by repositoryId",
  },
  {
    table: "imports",
    graph: "repositoryContentState",
    disposition: "delete",
    cleanupPath: "drain by repositoryId",
  },
  {
    table: "systemDesignKindRuns",
    graph: "repositoryContentState",
    disposition: "delete",
    cleanupPath: "drain by repositoryId",
  },
  {
    table: "sandboxSessions",
    graph: "sandboxLocalState",
    disposition: "delete",
    cleanupPath: "drain by repositoryId",
  },
  {
    table: "sandboxes",
    graph: "sandboxLocalState",
    disposition: "delete",
    cleanupPath: "delete only archived rows; otherwise wait or mark failed after retry exhaustion",
  },
  {
    table: "sandboxRemoteObservations",
    graph: "sandboxLocalState",
    disposition: "patch",
    cleanupPath: "detach sandboxId and repositoryId when the archived sandbox row is deleted",
  },
  {
    table: "jobs",
    graph: "jobs",
    disposition: "delete",
    cleanupPath: "drain by repositoryId only after sandbox cleanup is no longer pending",
  },
  {
    table: "repositories",
    graph: "repositoryRoot",
    disposition: "delete",
    cleanupPath: "delete last, after all child batches and sandbox cleanup are complete",
  },
  {
    table: "sandboxToolCallLog",
    graph: "retainedAuditData",
    disposition: "retain",
    cleanupPath: "retained for compliance/debug audit; 90-day TTL is the only cleanup path",
  },
] as const satisfies readonly RepositoryOwnedDataLifecycleRegistryEntry[];

export async function runRepositoryOwnedDataLifecycleDelete(
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

  more = (await drainRepositoryThreadGraph(ctx, args)) || more;

  const repository = await ctx.db.get(args.repositoryId);
  if (repository) {
    more =
      (await drainRepositoryOwnerViewerState(ctx, {
        ownerTokenIdentifier: repository.ownerTokenIdentifier,
        repositoryId: args.repositoryId,
      })) || more;
  }

  more = (await drainRepositoryContentState(ctx, args)) || more;
  more = (await drainRepositorySandboxSessions(ctx, args)) || more;

  const sandboxDrain = await drainRepositorySandboxes(ctx, {
    repositoryId: args.repositoryId,
    sandboxCleanupRetryExhausted,
    maxSandboxCleanupRetries: REPOSITORY_DELETE_MAX_SANDBOX_CLEANUP_RETRIES,
  });
  more = sandboxDrain.more || more;
  waitingOnSandboxCleanup = sandboxDrain.waitingOnSandboxCleanup || waitingOnSandboxCleanup;

  if (sandboxCleanupRetryExhausted && sandboxDrain.nonArchivedSandboxCount > 0) {
    const failureMessage = `Repository deletion stopped after ${REPOSITORY_DELETE_MAX_SANDBOX_CLEANUP_RETRIES} sandbox cleanup retries.`;
    await ctx.db.patch(args.repositoryId, {
      repositoryDeleteFailedAt: Date.now(),
      repositoryDeleteFailureMessage: failureMessage,
    });
    logWarn("repositories", "repository_delete_sandbox_cleanup_retry_exhausted", {
      repositoryId: args.repositoryId,
      pendingCleanupCount: sandboxDrain.nonArchivedSandboxCount,
      attempts: sandboxCleanupAttempts,
    });
    return;
  }

  if (!waitingOnSandboxCleanup) {
    more = (await drainRepositoryJobs(ctx, args)) || more;
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
