import { internal } from "../_generated/api";
import type { Id, TableNames } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { logWarn } from "./observability";
import {
  REPOSITORY_OWNED_DATA_DRAIN_ADAPTERS,
  type RepositoryOwnedDataDrainAdapterKey,
  type RepositoryOwnedDataDrainContext,
} from "./repositoryOwnedDataAdapters";

const REPOSITORY_DELETE_RETRY_MS = 5_000;
export const REPOSITORY_DELETE_MAX_SANDBOX_CLEANUP_RETRIES = 24;

const REPOSITORY_OWNED_DATA_JOBS_ORDER = 60;
const REPOSITORY_OWNED_DATA_FINAL_ORDER = 70;
const REPOSITORY_OWNED_DATA_RETRY_PRIORITY: Record<RepositoryOwnedDataRetryPolicy, number> = {
  none: 0,
  immediate: 1,
  sandboxCleanup: 2,
};

export type RepositoryOwnedDataGraph =
  | "threadGraph"
  | "ownerViewerState"
  | "repositoryContentState"
  | "sandboxLocalState"
  | "jobs"
  | "repositoryRoot"
  | "retainedAuditData";

export type RepositoryOwnedDataDisposition = "delete" | "patch" | "retain";
export type RepositoryOwnedDataRetryPolicy = "none" | "immediate" | "sandboxCleanup";

export interface RepositoryOwnedDataLifecycleRegistryEntry {
  table: TableNames;
  graph: RepositoryOwnedDataGraph;
  disposition: RepositoryOwnedDataDisposition;
  adapterKey?: RepositoryOwnedDataDrainAdapterKey;
  order: number;
  retryPolicy: RepositoryOwnedDataRetryPolicy;
  cleanupPath: string;
}

export const REPOSITORY_OWNED_DATA_LIFECYCLE_REGISTRY = [
  {
    table: "messageToolCallEvents",
    graph: "threadGraph",
    disposition: "delete",
    adapterKey: "threadGraph",
    order: 10,
    retryPolicy: "immediate",
    cleanupPath: "drain by messageId before messages",
  },
  {
    table: "messages",
    graph: "threadGraph",
    disposition: "delete",
    adapterKey: "threadGraph",
    order: 10,
    retryPolicy: "immediate",
    cleanupPath: "drain by threadId",
  },
  {
    table: "messageStreamChunks",
    graph: "threadGraph",
    disposition: "delete",
    adapterKey: "threadGraph",
    order: 10,
    retryPolicy: "immediate",
    cleanupPath: "drain by streamId before messageStreams",
  },
  {
    table: "messageStreams",
    graph: "threadGraph",
    disposition: "delete",
    adapterKey: "threadGraph",
    order: 10,
    retryPolicy: "immediate",
    cleanupPath: "drain by threadId",
  },
  {
    table: "threads",
    graph: "threadGraph",
    disposition: "delete",
    adapterKey: "threadGraph",
    order: 10,
    retryPolicy: "immediate",
    cleanupPath: "drain by repositoryId after child chat state",
  },
  {
    table: "threadShares",
    graph: "threadGraph",
    disposition: "delete",
    adapterKey: "threadGraph",
    order: 10,
    retryPolicy: "immediate",
    cleanupPath: "drain by repositoryId",
  },
  {
    table: "chatHistoryGroups",
    graph: "threadGraph",
    disposition: "delete",
    adapterKey: "threadGraph",
    order: 10,
    retryPolicy: "immediate",
    cleanupPath: "drain by repositoryId",
  },
  {
    table: "archivedThreadScopes",
    graph: "threadGraph",
    disposition: "delete",
    adapterKey: "threadGraph",
    order: 10,
    retryPolicy: "immediate",
    cleanupPath: "drain by repositoryId",
  },
  {
    table: "artifactViews",
    graph: "ownerViewerState",
    disposition: "delete",
    adapterKey: "ownerViewerState",
    order: 20,
    retryPolicy: "immediate",
    cleanupPath: "drain by ownerTokenIdentifier and repositoryId",
  },
  {
    table: "repositoryViewerBootstraps",
    graph: "ownerViewerState",
    disposition: "delete",
    adapterKey: "ownerViewerState",
    order: 20,
    retryPolicy: "immediate",
    cleanupPath: "drain by ownerTokenIdentifier and repositoryId",
  },
  {
    table: "userPreferences",
    graph: "ownerViewerState",
    disposition: "patch",
    adapterKey: "clearOwnerViewerPreference",
    order: REPOSITORY_OWNED_DATA_FINAL_ORDER,
    retryPolicy: "none",
    cleanupPath: "clear lastActiveRepositoryId when it matches repositoryId",
  },
  {
    table: "artifactChunks",
    graph: "repositoryContentState",
    disposition: "delete",
    adapterKey: "repositoryContentState",
    order: 30,
    retryPolicy: "immediate",
    cleanupPath: "drain by repositoryId before artifacts",
  },
  {
    table: "artifacts",
    graph: "repositoryContentState",
    disposition: "delete",
    adapterKey: "repositoryContentState",
    order: 30,
    retryPolicy: "immediate",
    cleanupPath: "drain through deleteArtifactWrite by threadId/repositoryId",
  },
  {
    table: "artifactVersions",
    graph: "repositoryContentState",
    disposition: "delete",
    adapterKey: "repositoryContentState",
    order: 30,
    retryPolicy: "immediate",
    cleanupPath: "drain by artifactId before deleting each artifact, including HTML storage blobs",
  },
  {
    table: "artifactFolders",
    graph: "repositoryContentState",
    disposition: "delete",
    adapterKey: "repositoryContentState",
    order: 30,
    retryPolicy: "immediate",
    cleanupPath: "drain by repositoryId",
  },
  {
    table: "artifactDrafts",
    graph: "repositoryContentState",
    disposition: "delete",
    adapterKey: "repositoryContentState",
    order: 30,
    retryPolicy: "immediate",
    cleanupPath: "drain by repositoryId",
  },
  {
    table: "repoChunks",
    graph: "repositoryContentState",
    disposition: "delete",
    adapterKey: "repositoryContentState",
    order: 30,
    retryPolicy: "immediate",
    cleanupPath: "drain by repositoryId",
  },
  {
    table: "repoFiles",
    graph: "repositoryContentState",
    disposition: "delete",
    adapterKey: "repositoryContentState",
    order: 30,
    retryPolicy: "immediate",
    cleanupPath: "drain by repositoryId",
  },
  {
    table: "imports",
    graph: "repositoryContentState",
    disposition: "delete",
    adapterKey: "repositoryContentState",
    order: 30,
    retryPolicy: "immediate",
    cleanupPath: "drain by repositoryId",
  },
  {
    table: "systemDesignKindRuns",
    graph: "repositoryContentState",
    disposition: "delete",
    adapterKey: "repositoryContentState",
    order: 30,
    retryPolicy: "immediate",
    cleanupPath: "drain by repositoryId",
  },
  {
    table: "sandboxSessions",
    graph: "sandboxLocalState",
    disposition: "delete",
    adapterKey: "sandboxSessions",
    order: 40,
    retryPolicy: "immediate",
    cleanupPath: "drain by repositoryId",
  },
  {
    table: "sandboxes",
    graph: "sandboxLocalState",
    disposition: "delete",
    adapterKey: "sandboxes",
    order: 50,
    retryPolicy: "sandboxCleanup",
    cleanupPath: "delete only archived rows; otherwise wait or mark failed after retry exhaustion",
  },
  {
    table: "sandboxRemoteObservations",
    graph: "sandboxLocalState",
    disposition: "patch",
    adapterKey: "sandboxes",
    order: 50,
    retryPolicy: "sandboxCleanup",
    cleanupPath: "detach sandboxId and repositoryId when the archived sandbox row is deleted",
  },
  {
    table: "jobs",
    graph: "jobs",
    disposition: "delete",
    adapterKey: "jobs",
    order: REPOSITORY_OWNED_DATA_JOBS_ORDER,
    retryPolicy: "immediate",
    cleanupPath: "drain by repositoryId only after sandbox cleanup is no longer pending",
  },
  {
    table: "repositories",
    graph: "repositoryRoot",
    disposition: "delete",
    adapterKey: "repositoryRoot",
    order: REPOSITORY_OWNED_DATA_FINAL_ORDER + 10,
    retryPolicy: "none",
    cleanupPath: "delete last, after all child batches and sandbox cleanup are complete",
  },
  {
    table: "sandboxToolCallLog",
    graph: "retainedAuditData",
    disposition: "retain",
    adapterKey: undefined,
    order: REPOSITORY_OWNED_DATA_FINAL_ORDER + 20,
    retryPolicy: "none",
    cleanupPath: "retained for compliance/debug audit; 90-day TTL is the only cleanup path",
  },
] as const satisfies readonly RepositoryOwnedDataLifecycleRegistryEntry[];

interface RepositoryOwnedDataAdapterExecution {
  adapterKey: RepositoryOwnedDataDrainAdapterKey;
  retryPolicy: RepositoryOwnedDataRetryPolicy;
}

function higherPriorityRetryPolicy(
  left: RepositoryOwnedDataRetryPolicy,
  right: RepositoryOwnedDataRetryPolicy,
): RepositoryOwnedDataRetryPolicy {
  return REPOSITORY_OWNED_DATA_RETRY_PRIORITY[right] > REPOSITORY_OWNED_DATA_RETRY_PRIORITY[left] ? right : left;
}

function getRepositoryOwnedDataExecutionGroups(): Map<number, RepositoryOwnedDataAdapterExecution[]> {
  const groups = new Map<number, RepositoryOwnedDataAdapterExecution[]>();
  for (const entry of REPOSITORY_OWNED_DATA_LIFECYCLE_REGISTRY) {
    if (!entry.adapterKey) {
      continue;
    }
    const group = groups.get(entry.order) ?? [];
    const adapterExecution = group.find((candidate) => candidate.adapterKey === entry.adapterKey);
    if (adapterExecution) {
      adapterExecution.retryPolicy = higherPriorityRetryPolicy(adapterExecution.retryPolicy, entry.retryPolicy);
    } else {
      group.push({
        adapterKey: entry.adapterKey,
        retryPolicy: entry.retryPolicy,
      });
    }
    groups.set(entry.order, group);
  }
  return groups;
}

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
  const drainContext: RepositoryOwnedDataDrainContext = {
    repositoryId: args.repositoryId,
    ownerTokenIdentifier: repositoryBeforeCleanup?.ownerTokenIdentifier ?? null,
    sandboxCleanupRetryExhausted,
    maxSandboxCleanupRetries: REPOSITORY_DELETE_MAX_SANDBOX_CLEANUP_RETRIES,
  };
  let retryPolicy: RepositoryOwnedDataRetryPolicy = waitingOnSandboxCleanup ? "sandboxCleanup" : "none";

  const executionGroups = [...getRepositoryOwnedDataExecutionGroups().entries()].sort(
    ([leftOrder], [rightOrder]) => leftOrder - rightOrder,
  );
  for (const [order, adapters] of executionGroups) {
    if (order === REPOSITORY_OWNED_DATA_JOBS_ORDER && waitingOnSandboxCleanup) {
      continue;
    }
    if (order >= REPOSITORY_OWNED_DATA_FINAL_ORDER && (more || waitingOnSandboxCleanup)) {
      continue;
    }

    for (const { adapterKey, retryPolicy: adapterRetryPolicy } of adapters) {
      const adapter = REPOSITORY_OWNED_DATA_DRAIN_ADAPTERS[adapterKey];
      const result = await adapter(ctx, drainContext);
      more = result.more || more;
      waitingOnSandboxCleanup = result.waitingOnSandboxCleanup || waitingOnSandboxCleanup;
      if (result.more || result.waitingOnSandboxCleanup) {
        retryPolicy = higherPriorityRetryPolicy(retryPolicy, adapterRetryPolicy);
      }

      const nonArchivedSandboxCount = result.nonArchivedSandboxCount ?? 0;
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
    }
  }

  if (more || waitingOnSandboxCleanup) {
    await ctx.scheduler.runAfter(
      retryPolicy === "sandboxCleanup" ? REPOSITORY_DELETE_RETRY_MS : 0,
      internal.repositories.cascadeDeleteRepository,
      { repositoryId: args.repositoryId },
    );
    return;
  }
}
