import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireViewerIdentity } from "./auth";

type RepositoryReadCtx = QueryCtx | MutationCtx;

const DEFAULT_REPOSITORY_NOT_FOUND_MESSAGE = "Repository not found.";

export function isRepositoryDeleting(repository: { deletionRequestedAt?: number } | null | undefined) {
  return typeof repository?.deletionRequestedAt === "number";
}

export function isActiveRepository(repository: { deletionRequestedAt?: number } | null | undefined) {
  return !!repository && !isRepositoryDeleting(repository);
}

export async function requireActiveRepository(
  ctx: RepositoryReadCtx,
  args: {
    repositoryId: Id<"repositories">;
    notFoundMessage?: string;
  },
): Promise<Doc<"repositories">> {
  const repository = await ctx.db.get(args.repositoryId);
  if (!repository || isRepositoryDeleting(repository)) {
    throw new Error(args.notFoundMessage ?? DEFAULT_REPOSITORY_NOT_FOUND_MESSAGE);
  }

  return repository;
}

export async function requireActiveRepositoryForOwner(
  ctx: RepositoryReadCtx,
  args: {
    repositoryId: Id<"repositories">;
    ownerTokenIdentifier: string;
    notFoundMessage?: string;
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
  });

  return { identity, repository };
}
