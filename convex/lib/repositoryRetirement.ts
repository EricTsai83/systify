import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { cancelActiveJob } from "./jobs";
import { requireOwnedDoc } from "./ownedDocs";
import { isRepositoryArchived, isRepositoryDeleting } from "./repositoryAccess";

const REPOSITORY_GENERATION_CANCEL_BATCH_SIZE = 50;
const REPOSITORY_GENERATION_CANCEL_KINDS = ["system_design", "artifact_draft"] as const satisfies ReadonlyArray<
  Doc<"jobs">["kind"]
>;
const REPOSITORY_GENERATION_CANCEL_STATUSES = ["queued", "running"] as const satisfies ReadonlyArray<
  Doc<"jobs">["status"]
>;

export async function archiveOwnedRepository(
  ctx: MutationCtx,
  args: { repositoryId: Id<"repositories"> },
): Promise<void> {
  const { doc: repository } = await requireOwnedDoc(ctx, args.repositoryId, {
    notFoundMessage: "Repository not found.",
  });

  if (isRepositoryDeleting(repository)) {
    throw new Error("Repository is being deleted and cannot be archived.");
  }
  if (isRepositoryArchived(repository)) {
    return;
  }

  await ctx.db.patch(args.repositoryId, { archivedAt: Date.now() });
  await cancelRepositoryGenerationJobs(ctx, {
    repositoryId: args.repositoryId,
    reason: "Repository was archived.",
  });
  await ctx.runMutation(internal.ops.scheduleRepositorySandboxCleanup, {
    repositoryId: args.repositoryId,
  });
}

export async function restoreOwnedRepository(
  ctx: MutationCtx,
  args: { repositoryId: Id<"repositories"> },
): Promise<void> {
  const { doc: repository } = await requireOwnedDoc(ctx, args.repositoryId, {
    notFoundMessage: "Repository not found.",
  });

  if (isRepositoryDeleting(repository)) {
    throw new Error("Repository is being deleted and cannot be restored.");
  }
  if (!isRepositoryArchived(repository)) {
    return;
  }

  await ctx.db.patch(args.repositoryId, { archivedAt: undefined });
}

export async function requestRepositoryDeletion(
  ctx: MutationCtx,
  args: { repositoryId: Id<"repositories"> },
): Promise<void> {
  const { doc: repository } = await requireOwnedDoc(ctx, args.repositoryId, {
    notFoundMessage: "Repository not found.",
  });

  if (isRepositoryDeleting(repository)) {
    return;
  }
  if (!isRepositoryArchived(repository)) {
    throw new Error("Archive the repository before deleting it permanently.");
  }

  await ctx.db.patch(args.repositoryId, { deletionRequestedAt: Date.now() });
  await cancelRepositoryGenerationJobs(ctx, {
    repositoryId: args.repositoryId,
    reason: "Repository deletion was requested.",
  });
  await ctx.runMutation(internal.ops.scheduleRepositorySandboxCleanup, {
    repositoryId: args.repositoryId,
  });
  await ctx.scheduler.runAfter(0, internal.repositories.cascadeDeleteRepository, {
    repositoryId: args.repositoryId,
  });
}

export async function cancelRepositoryGenerationJobs(
  ctx: MutationCtx,
  args: { repositoryId: Id<"repositories">; reason: string },
): Promise<boolean> {
  let hasMore = false;
  const now = Date.now();

  for (const kind of REPOSITORY_GENERATION_CANCEL_KINDS) {
    for (const status of REPOSITORY_GENERATION_CANCEL_STATUSES) {
      const jobs = await ctx.db
        .query("jobs")
        .withIndex("by_repositoryId_and_kind_and_status_and_leaseExpiresAt", (q) =>
          q.eq("repositoryId", args.repositoryId).eq("kind", kind).eq("status", status),
        )
        .take(REPOSITORY_GENERATION_CANCEL_BATCH_SIZE);

      for (const job of jobs) {
        await cancelActiveJob(ctx, {
          jobId: job._id,
          expectedKind: kind,
          completedAt: now,
          errorMessage: args.reason,
          outputSummary: args.reason,
        });
      }
      hasMore = hasMore || jobs.length === REPOSITORY_GENERATION_CANCEL_BATCH_SIZE;
    }
  }

  if (hasMore) {
    await ctx.scheduler.runAfter(0, internal.repositories.cancelRepositoryGenerationJobs, {
      repositoryId: args.repositoryId,
      reason: args.reason,
    });
  }

  return hasMore;
}
