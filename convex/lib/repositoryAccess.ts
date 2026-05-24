import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireViewerIdentity } from "./auth";

type RepositoryReadCtx = QueryCtx | MutationCtx;

type RepositoryStateFields = {
  deletionRequestedAt?: number;
  archivedAt?: number;
};

type RepositoryFreshnessFields = {
  latestRemoteSha?: string;
  lastSyncedCommitSha?: string;
};

const DEFAULT_REPOSITORY_NOT_FOUND_MESSAGE = "Repository not found.";
const DEFAULT_REPOSITORY_ARCHIVED_MESSAGE = "Repository is archived. Restore it to continue.";

export function isRepositoryDeleting(repository: RepositoryStateFields | null | undefined) {
  return typeof repository?.deletionRequestedAt === "number";
}

export function isRepositoryArchived(repository: RepositoryStateFields | null | undefined) {
  return !!repository && typeof repository.archivedAt === "number" && !isRepositoryDeleting(repository);
}

export function isActiveRepository(repository: RepositoryStateFields | null | undefined) {
  return !!repository && !isRepositoryDeleting(repository) && !isRepositoryArchived(repository);
}

export function hasRemoteUpdates(repository: RepositoryFreshnessFields | null | undefined): boolean {
  return (
    !!repository?.latestRemoteSha &&
    !!repository.lastSyncedCommitSha &&
    repository.latestRemoteSha !== repository.lastSyncedCommitSha
  );
}

export async function requireActiveRepository(
  ctx: RepositoryReadCtx,
  args: {
    repositoryId: Id<"repositories">;
    notFoundMessage?: string;
    archivedMessage?: string;
  },
): Promise<Doc<"repositories">> {
  const repository = await ctx.db.get(args.repositoryId);
  if (!repository || isRepositoryDeleting(repository)) {
    throw new Error(args.notFoundMessage ?? DEFAULT_REPOSITORY_NOT_FOUND_MESSAGE);
  }
  if (isRepositoryArchived(repository)) {
    throw new Error(args.archivedMessage ?? DEFAULT_REPOSITORY_ARCHIVED_MESSAGE);
  }

  return repository;
}

export async function requireActiveRepositoryForOwner(
  ctx: RepositoryReadCtx,
  args: {
    repositoryId: Id<"repositories">;
    ownerTokenIdentifier: string;
    notFoundMessage?: string;
    archivedMessage?: string;
  },
): Promise<Doc<"repositories">> {
  const repository = await requireActiveRepository(ctx, args);
  if (repository.ownerTokenIdentifier !== args.ownerTokenIdentifier) {
    throw new Error(args.notFoundMessage ?? DEFAULT_REPOSITORY_NOT_FOUND_MESSAGE);
  }

  return repository;
}

export async function requireActiveRepositoryForViewer(
  ctx: RepositoryReadCtx,
  args: {
    repositoryId: Id<"repositories">;
    notFoundMessage?: string;
    archivedMessage?: string;
  },
): Promise<{
  identity: Awaited<ReturnType<typeof requireViewerIdentity>>;
  repository: Doc<"repositories">;
}> {
  const identity = await requireViewerIdentity(ctx);
  const repository = await requireActiveRepositoryForOwner(ctx, {
    repositoryId: args.repositoryId,
    ownerTokenIdentifier: identity.tokenIdentifier,
    notFoundMessage: args.notFoundMessage,
    archivedMessage: args.archivedMessage,
  });

  return { identity, repository };
}

/**
 * Returns the repository if accessible to the viewer, allowing archived rows
 * through. Returns `null` for missing, permanent-delete-pending, or
 * non-owner repositories so the UI can render an inline empty state instead
 * of crashing on a thrown error.
 */
export async function loadAccessibleRepositoryForViewer(
  ctx: RepositoryReadCtx,
  args: { repositoryId: Id<"repositories"> },
): Promise<{
  identity: Awaited<ReturnType<typeof requireViewerIdentity>>;
  repository: Doc<"repositories"> | null;
}> {
  const identity = await requireViewerIdentity(ctx);
  const repository = await ctx.db.get(args.repositoryId);
  if (!repository || isRepositoryDeleting(repository) || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
    return { identity, repository: null };
  }
  return { identity, repository };
}
