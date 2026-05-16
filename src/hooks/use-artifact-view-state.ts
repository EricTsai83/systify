import { useCallback, useEffect, useMemo } from "react";
import { useMutation, useQuery } from "convex/react";
import type { OptimisticLocalStore } from "convex/browser";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import type { ArtifactId, ArtifactListItem, RepositoryId } from "@/lib/types";

/**
 * Per-viewer view state for the Library navigator's "changed since you
 * last looked" dot.
 *
 * State lives in Convex so it follows the viewer across devices and
 * survives storage clears. Two tables cooperate:
 *
 *   - `artifactViews` — one row per (viewer, artifact) recording when
 *     the viewer last activated the artifact. Driven by `markViewed`.
 *   - `repositoryViewerBootstraps` — one row per (viewer, repository)
 *     recording when the viewer first saw the Library. Driven by
 *     `ensureRepositoryBootstrap`, fired automatically here on first
 *     mount. Becomes the floor below which artifacts are treated as
 *     "already seen", which prevents long-lived repos from flooding
 *     the navigator with dots the first time the feature is used.
 */

export interface ArtifactViewState {
  /** True when the artifact's most recent change post-dates the viewer's last activation. */
  isUnseen: (artifact: Pick<ArtifactListItem, "_id" | "_creationTime" | "updatedAt">) => boolean;
  /** Fire-and-forget mark-as-viewed. Idempotent and optimistically applied. */
  markViewed: (artifactId: ArtifactId) => void;
}

/**
 * Optimistic update for `markViewed`. Defined at module scope so the
 * function reference is stable across renders — the per-render
 * `useMemo` keys off the base mutation alone.
 */
function applyMarkViewedOptimistic(
  store: OptimisticLocalStore,
  args: { artifactId: Id<"artifacts">; repositoryId: Id<"repositories"> },
) {
  const queryArgs = { repositoryId: args.repositoryId };
  const existing = store.getQuery(api.artifactViews.listViewStateByRepository, queryArgs);
  if (!existing) return;
  if ((existing.views[args.artifactId] ?? 0) >= Date.now()) return;
  store.setQuery(api.artifactViews.listViewStateByRepository, queryArgs, {
    ...existing,
    views: { ...existing.views, [args.artifactId]: Date.now() },
  });
}

export function useArtifactViewState(repositoryId: RepositoryId | null): ArtifactViewState {
  // `"skip"` keeps the no-repo Home surface from opening a useless
  // subscription, while letting downstream surfaces (chat right rail)
  // share the same hook signature as the Library shell.
  const state = useQuery(api.artifactViews.listViewStateByRepository, repositoryId ? { repositoryId } : "skip");
  const baseMarkViewed = useMutation(api.artifactViews.markViewed);
  const ensureBootstrap = useMutation(api.artifactViews.ensureRepositoryBootstrap);
  const markViewedMutation = useMemo(
    () => baseMarkViewed.withOptimisticUpdate(applyMarkViewedOptimistic),
    [baseMarkViewed],
  );

  // First time this viewer ever opens this repo's Library, the server
  // returns `bootstrapPending: true` with a placeholder bootstrap. We
  // immediately write the real anchor so subsequent renders (and other
  // devices) compute `isUnseen` against the correct floor. The
  // mutation is idempotent, so concurrent mounts, StrictMode
  // double-invokes, and the query re-firing on commit all resolve to
  // the same row.
  useEffect(() => {
    if (!repositoryId || !state?.bootstrapPending) return;
    void ensureBootstrap({ repositoryId });
  }, [repositoryId, state?.bootstrapPending, ensureBootstrap]);

  const isUnseen = useCallback(
    (artifact: Pick<ArtifactListItem, "_id" | "_creationTime" | "updatedAt">) => {
      // Suppress dots while the bootstrap row is being written — the
      // `bootstrap` field is a placeholder in that window and would
      // light up every post-import row before the real anchor lands.
      // Also suppress during the initial subscription resolve and the
      // no-repo Home surface (state === undefined in both cases).
      if (state === undefined || state.bootstrapPending) return false;
      const lastChanged = Math.max(artifact._creationTime, artifact.updatedAt ?? 0);
      const viewedAt = state.views[artifact._id] ?? state.bootstrap;
      return lastChanged > viewedAt;
    },
    [state],
  );

  const markViewed = useCallback(
    (artifactId: ArtifactId) => {
      if (!repositoryId) return;
      void markViewedMutation({ artifactId, repositoryId });
    },
    [markViewedMutation, repositoryId],
  );

  return useMemo(() => ({ isUnseen, markViewed }), [isUnseen, markViewed]);
}
