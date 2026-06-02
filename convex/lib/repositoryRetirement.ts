import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import type { MutationCtx } from "../_generated/server";
import { requireOwnedDoc } from "./ownedDocs";
import { isRepositoryArchived, isRepositoryDeleting } from "./repositoryAccess";

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
  await ctx.runMutation(internal.ops.scheduleRepositorySandboxCleanup, {
    repositoryId: args.repositoryId,
  });
  await ctx.scheduler.runAfter(0, internal.repositories.cascadeDeleteRepository, {
    repositoryId: args.repositoryId,
  });
}
