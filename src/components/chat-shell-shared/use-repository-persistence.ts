import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, type ReactMutation } from "convex/react";
import type { NavigateFunction } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { applyTouchRepositoryOptimistic } from "@/lib/repository-mutations";
import { resolveRepositorySelection } from "@/lib/repository-selection";
import { readString, removeKey, writeString } from "@/lib/storage";
import type { RepositoryId } from "@/lib/types";
import { DEFAULT_AUTHENTICATED_PATH, repositoryPath } from "@/route-paths";

const ACTIVE_REPOSITORY_STORAGE_KEY = "systify.activeRepositoryId";

export interface RepositoryPersistence {
  /** Subscription to all viewer repositories (recency-sorted top 20); `undefined` while loading. */
  repositories: Doc<"repositories">[] | undefined;
  /** Subscription to the viewer's persisted preferences; `undefined` while loading. */
  viewerPreferences:
    | { lastActiveRepositoryId: RepositoryId | null; lastActiveRepositoryUpdatedAt: number | null }
    | null
    | undefined;
  /**
   * Wrapped `touchRepository` mutation: the optimistic update keeps the local
   * query cache aligned with the user's intent during the in-flight window,
   * eliminating the DB-wins effect's "bounce back" race on rapid switches.
   */
  touchRepository: ReactMutation<typeof api.repositoryPreferences.touchRepository>;
  /** First-paint repository id (localStorage cache + fallback selection). */
  activeRepositoryId: RepositoryId | null;
  /** `urlRepositoryId ?? activeRepositoryId` — the canonical current repository. */
  currentRepositoryId: RepositoryId | null;
  /** Resolved repository row for `currentRepositoryId`, or `null`. */
  currentRepository: Doc<"repositories"> | null;
  /** Repository switch via URL navigation — the rest of the system follows. */
  handleSwitchRepository: (repositoryId: RepositoryId) => void;
}

/**
 * Repository state plumbing for the RepositoryShell. The DB
 * (`userPreferences.lastActiveRepositoryId`) is the source of truth;
 * localStorage is a first-paint cache so we render without flashing
 * before Convex hydrates. The hook owns:
 *
 *   1. `activeRepositoryId` state + localStorage mirror.
 *   2. DB-wins reconciliation — adopt the canonical repository id whenever
 *      `viewerPreferences` lands on a value that disagrees with local state.
 *   3. Fallback selection — pick the most-recent repository when neither the
 *      cache nor the DB has a live one, then seed the DB so future loads
 *      converge instantly.
 *   4. URL → state sync — when the URL carries a `:repositoryId`, treat it
 *      as canonical and pull active state + DB preference into agreement.
 *      Stale URL ids bounce to `DEFAULT_AUTHENTICATED_PATH`.
 */
export function useRepositoryPersistence({
  urlRepositoryId,
  navigate,
}: {
  urlRepositoryId: RepositoryId | null;
  navigate: NavigateFunction;
}): RepositoryPersistence {
  const repositories = useQuery(api.repositoryPreferences.listRepositoriesForSwitcher);
  const ownerRepositoryIds = useQuery(api.repositoryPreferences.listAllOwnerRepositoryIds);
  const viewerPreferences = useQuery(api.userPreferences.getViewerPreferences);
  const baseTouchRepository = useMutation(api.repositoryPreferences.touchRepository);
  const touchRepository = useMemo(
    () => baseTouchRepository.withOptimisticUpdate(applyTouchRepositoryOptimistic),
    [baseTouchRepository],
  );

  const ownerRepositoryIdSet = useMemo(
    () => (ownerRepositoryIds ? new Set(ownerRepositoryIds as ReadonlyArray<RepositoryId>) : null),
    [ownerRepositoryIds],
  );

  const [activeRepositoryId, setActiveRepositoryId] = useState<RepositoryId | null>(() => {
    const stored = readString(ACTIVE_REPOSITORY_STORAGE_KEY);
    return stored ? (stored as RepositoryId) : null;
  });

  useEffect(() => {
    if (activeRepositoryId) {
      writeString(ACTIVE_REPOSITORY_STORAGE_KEY, activeRepositoryId);
    } else {
      removeKey(ACTIVE_REPOSITORY_STORAGE_KEY);
    }
  }, [activeRepositoryId]);

  const resolvedSelection = useMemo(() => {
    if (repositories === undefined || viewerPreferences === undefined || ownerRepositoryIdSet === null) {
      return null;
    }
    return resolveRepositorySelection({
      urlRepositoryId,
      activeRepositoryId,
      dbRepositoryId: viewerPreferences?.lastActiveRepositoryId ?? null,
      switcherRepositoryIds: repositories.map((repo) => repo._id),
      ownerRepositoryIds: ownerRepositoryIdSet,
    });
  }, [activeRepositoryId, ownerRepositoryIdSet, repositories, urlRepositoryId, viewerPreferences]);

  useEffect(() => {
    if (!resolvedSelection) return;
    for (const command of resolvedSelection.commands) {
      switch (command.kind) {
        case "setActiveRepository":
          // eslint-disable-next-line react-hooks/set-state-in-effect
          setActiveRepositoryId(command.repositoryId);
          break;
        case "touchRepository":
          void touchRepository({ repositoryId: command.repositoryId }).catch((err) => {
            console.error(`touchRepository failed for repositoryId=${command.repositoryId}`, err);
          });
          break;
        case "navigateDefault":
          void navigate(DEFAULT_AUTHENTICATED_PATH, { replace: command.replace });
          break;
      }
    }
  }, [navigate, resolvedSelection, touchRepository]);

  const handleSwitchRepository = useCallback(
    (repositoryId: RepositoryId) => {
      void navigate(repositoryPath(repositoryId));
    },
    [navigate],
  );

  const currentRepositoryId: RepositoryId | null =
    resolvedSelection?.currentRepositoryId ?? urlRepositoryId ?? activeRepositoryId;
  const currentRepository = useMemo(
    () => (currentRepositoryId ? (repositories?.find((repo) => repo._id === currentRepositoryId) ?? null) : null),
    [repositories, currentRepositoryId],
  );

  return {
    repositories,
    viewerPreferences,
    touchRepository,
    activeRepositoryId,
    currentRepositoryId,
    currentRepository,
    handleSwitchRepository,
  };
}
