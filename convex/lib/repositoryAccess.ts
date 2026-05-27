import type { Doc, Id } from "../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../_generated/server";
import { requireViewerIdentity } from "./auth";
import { loadOwnedDoc, requireOwnedDoc } from "./ownedDocs";

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

type ViewerIdentity = Awaited<ReturnType<typeof requireViewerIdentity>>;

/**
 * Strict, viewer-driven gate for repository-backed entry points. Resolves
 * ownership through {@link requireOwnedDoc} and then layers the
 * repository-specific state invariants (`deletionRequestedAt`,
 * `archivedAt`) on top. Throws `notFoundMessage` for a missing /
 * non-owned / tombstoned row and `archivedMessage` for an archived one —
 * the missing/non-owned cases share an error shape so the existence of a
 * stranger's repository is not leaked.
 */
export async function requireActiveRepositoryForViewer(
  ctx: RepositoryReadCtx,
  args: {
    repositoryId: Id<"repositories">;
    notFoundMessage?: string;
    archivedMessage?: string;
  },
): Promise<{ identity: ViewerIdentity; repository: Doc<"repositories"> }> {
  const notFoundMessage = args.notFoundMessage ?? DEFAULT_REPOSITORY_NOT_FOUND_MESSAGE;
  const { identity, doc: repository } = await requireOwnedDoc(ctx, args.repositoryId, { notFoundMessage });
  if (isRepositoryDeleting(repository)) {
    throw new Error(notFoundMessage);
  }
  if (isRepositoryArchived(repository)) {
    throw new Error(args.archivedMessage ?? DEFAULT_REPOSITORY_ARCHIVED_MESSAGE);
  }
  return { identity, repository };
}

/**
 * Soft, viewer-driven repository read. Returns `{ identity, repository: null }`
 * for missing, permanent-delete-pending, or non-owner repositories so the
 * UI can render an inline empty state instead of crashing on a thrown
 * error. Archived rows are returned so the UI can render the archived
 * state — the strict variant is the one that rejects archived.
 */
export async function loadAccessibleRepositoryForViewer(
  ctx: RepositoryReadCtx,
  args: { repositoryId: Id<"repositories"> },
): Promise<{
  identity: ViewerIdentity;
  repository: Doc<"repositories"> | null;
}> {
  const { identity, doc: repository } = await loadOwnedDoc(ctx, args.repositoryId);
  if (!repository || isRepositoryDeleting(repository)) {
    return { identity, repository: null };
  }
  return { identity, repository };
}
