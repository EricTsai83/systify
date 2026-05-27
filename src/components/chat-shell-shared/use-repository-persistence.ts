import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, type ReactMutation } from "convex/react";
import type { NavigateFunction } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { applyTouchRepositoryOptimistic } from "@/lib/repository-mutations";
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
  const viewerPreferences = useQuery(api.userPreferences.getViewerPreferences);
  const baseTouchRepository = useMutation(api.repositoryPreferences.touchRepository);
  const touchRepository = useMemo(
    () => baseTouchRepository.withOptimisticUpdate(applyTouchRepositoryOptimistic),
    [baseTouchRepository],
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

  // DB-wins reconciliation. Cross-tab pushes flow through here too.
  useEffect(() => {
    if (repositories === undefined || viewerPreferences === undefined) return;
    const dbRepositoryId = viewerPreferences?.lastActiveRepositoryId ?? null;
    if (!dbRepositoryId) return;
    const dbRepositoryExists = repositories.some((repo) => repo._id === dbRepositoryId);
    if (!dbRepositoryExists) return;
    if (dbRepositoryId !== activeRepositoryId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveRepositoryId(dbRepositoryId);
    }
  }, [repositories, viewerPreferences, activeRepositoryId]);

  // Auto-select the most recent repository if none is active or the active
  // one no longer exists. Seed the DB preference too.
  useEffect(() => {
    if (!repositories || repositories.length === 0) return;
    if (viewerPreferences === undefined) return;
    const activeExists = repositories.some((repo) => repo._id === activeRepositoryId);
    if (activeExists) return;
    const fallback = repositories[0]._id;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveRepositoryId(fallback);
    if (viewerPreferences?.lastActiveRepositoryId !== fallback) {
      void touchRepository({ repositoryId: fallback }).catch((err) => {
        console.error(`touchRepository failed for fallback repositoryId=${fallback}`, err);
      });
    }
  }, [repositories, viewerPreferences, activeRepositoryId, touchRepository]);

  // URL → state sync.
  useEffect(() => {
    if (urlRepositoryId === null) return;
    if (repositories === undefined) return;
    const urlRepositoryExists = repositories.some((repo) => repo._id === urlRepositoryId);
    if (!urlRepositoryExists) {
      void navigate(DEFAULT_AUTHENTICATED_PATH, { replace: true });
      return;
    }
    if (urlRepositoryId === activeRepositoryId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveRepositoryId(urlRepositoryId);
    void touchRepository({ repositoryId: urlRepositoryId }).catch((err) => {
      console.error(`touchRepository failed for urlRepositoryId=${urlRepositoryId}`, err);
    });
  }, [urlRepositoryId, activeRepositoryId, touchRepository, repositories, navigate]);

  const handleSwitchRepository = useCallback(
    (repositoryId: RepositoryId) => {
      void navigate(repositoryPath(repositoryId));
    },
    [navigate],
  );

  const currentRepositoryId: RepositoryId | null = urlRepositoryId ?? activeRepositoryId;
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
