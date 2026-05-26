import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, type ReactMutation } from "convex/react";
import type { NavigateFunction } from "react-router-dom";
import { api } from "../../../convex/_generated/api";
import type { Doc } from "../../../convex/_generated/dataModel";
import { applyTouchWorkspaceOptimistic } from "@/lib/workspace-mutations";
import { readString, removeKey, writeString } from "@/lib/storage";
import type { WorkspaceId } from "@/lib/types";
import { DEFAULT_AUTHENTICATED_PATH, workspacePath } from "@/route-paths";

const ACTIVE_WORKSPACE_STORAGE_KEY = "systify.activeWorkspaceId";

export interface WorkspacePersistence {
  /** Subscription to all viewer workspaces; `undefined` while loading. */
  workspaces: Doc<"workspaces">[] | undefined;
  /** Subscription to the viewer's persisted preferences; `undefined` while loading. */
  viewerPreferences:
    | { lastActiveWorkspaceId: WorkspaceId | null; lastActiveWorkspaceUpdatedAt: number | null }
    | null
    | undefined;
  /**
   * Wrapped `touchWorkspace` mutation: the optimistic update keeps the local
   * query cache aligned with the user's intent during the in-flight window,
   * which eliminates the DB-wins effect's "bounce back" race on rapid switches.
   */
  touchWorkspace: ReactMutation<typeof api.workspaces.touchWorkspace>;
  /** First-paint workspace id (localStorage cache + fallback selection). */
  activeWorkspaceId: WorkspaceId | null;
  /** `urlWorkspaceId ?? activeWorkspaceId` — the canonical current workspace. */
  currentWorkspaceId: WorkspaceId | null;
  /** Resolved workspace row for `currentWorkspaceId`, or `null`. */
  currentWorkspace: Doc<"workspaces"> | null;
  /** Workspace switch via URL navigation — the rest of the system follows. */
  handleSwitchWorkspace: (workspaceId: WorkspaceId) => void;
}

/**
 * Workspace state plumbing for the RepositoryShell. The DB
 * (`userPreferences.lastActiveWorkspaceId`) is the source of truth;
 * localStorage is a first-paint cache so we render without flashing
 * before Convex hydrates. The hook owns:
 *
 *   1. `activeWorkspaceId` state + localStorage mirror.
 *   2. DB-wins reconciliation — adopt the canonical workspace id whenever
 *      `viewerPreferences` lands on a value that disagrees with local state.
 *      This is also the cross-tab live-sync path.
 *   3. Fallback selection — pick the most-recent workspace when neither the
 *      cache nor the DB has a live one, then seed the DB so future loads
 *      converge instantly.
 *   4. URL → state sync — when the URL carries a `:workspaceId`, treat it
 *      as canonical and pull active state + DB preference into agreement.
 *      Stale URL ids bounce to `DEFAULT_AUTHENTICATED_PATH` instead of
 *      adopting and oscillating with the fallback effect.
 *
 * Returns derived `currentWorkspaceId` / `currentWorkspace` for callers so
 * the URL-vs-state precedence lives in exactly one place.
 *
 * See `docs/workspace-persistence-system-design.md` for the full reasoning.
 */
export function useWorkspacePersistence({
  urlWorkspaceId,
  navigate,
}: {
  urlWorkspaceId: WorkspaceId | null;
  navigate: NavigateFunction;
}): WorkspacePersistence {
  const workspaces = useQuery(api.workspaces.listWorkspaces);
  const viewerPreferences = useQuery(api.userPreferences.getViewerPreferences);
  const baseTouchWorkspace = useMutation(api.workspaces.touchWorkspace);
  const touchWorkspace = useMemo(
    () => baseTouchWorkspace.withOptimisticUpdate(applyTouchWorkspaceOptimistic),
    [baseTouchWorkspace],
  );

  // First-paint cache. Rendering with this avoids a one-frame flicker before
  // `viewerPreferences` arrives. The cache is *only* trusted until the DB
  // value lands; after that, the DB wins on conflict.
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<WorkspaceId | null>(() => {
    const stored = readString(ACTIVE_WORKSPACE_STORAGE_KEY);
    return stored ? (stored as WorkspaceId) : null;
  });

  // Mirror every active-workspace change back into localStorage so the
  // first-paint cache stays warm for the next load.
  useEffect(() => {
    if (activeWorkspaceId) {
      writeString(ACTIVE_WORKSPACE_STORAGE_KEY, activeWorkspaceId);
    } else {
      removeKey(ACTIVE_WORKSPACE_STORAGE_KEY);
    }
  }, [activeWorkspaceId]);

  // DB-wins reconciliation. Cross-tab pushes flow through here too: a switch
  // on another tab updates `viewerPreferences` via Convex's subscription,
  // this effect observes the diff, and adopts the new value live.
  useEffect(() => {
    if (workspaces === undefined || viewerPreferences === undefined) return;
    const dbWorkspaceId = viewerPreferences?.lastActiveWorkspaceId ?? null;
    if (!dbWorkspaceId) return;
    const dbWorkspaceExists = workspaces.some((ws) => ws._id === dbWorkspaceId);
    if (!dbWorkspaceExists) return;
    if (dbWorkspaceId !== activeWorkspaceId) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveWorkspaceId(dbWorkspaceId);
    }
  }, [workspaces, viewerPreferences, activeWorkspaceId]);

  // Auto-select the most recent workspace if none is active or the active
  // one no longer exists. Seed the DB preference too so cross-device
  // convergence works even for users who never explicitly switch.
  useEffect(() => {
    if (!workspaces || workspaces.length === 0) return;
    if (viewerPreferences === undefined) return;
    const activeExists = workspaces.some((ws) => ws._id === activeWorkspaceId);
    if (activeExists) return;
    const fallback = workspaces[0]._id;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveWorkspaceId(fallback);
    if (viewerPreferences?.lastActiveWorkspaceId !== fallback) {
      void touchWorkspace({ workspaceId: fallback }).catch(() => {});
    }
  }, [workspaces, viewerPreferences, activeWorkspaceId, touchWorkspace]);

  // URL → state sync. Validate the URL id before adopting (stale ids would
  // oscillate with the fallback effect), then mirror into active state and
  // DB preference. The DB-wins reconciliation effect above still runs in
  // parallel for the cross-tab path.
  useEffect(() => {
    if (urlWorkspaceId === null) return;
    if (workspaces === undefined) return;
    const urlWorkspaceExists = workspaces.some((ws) => ws._id === urlWorkspaceId);
    if (!urlWorkspaceExists) {
      void navigate(DEFAULT_AUTHENTICATED_PATH, { replace: true });
      return;
    }
    if (urlWorkspaceId === activeWorkspaceId) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveWorkspaceId(urlWorkspaceId);
    void touchWorkspace({ workspaceId: urlWorkspaceId }).catch(() => {});
  }, [urlWorkspaceId, activeWorkspaceId, touchWorkspace, workspaces, navigate]);

  const handleSwitchWorkspace = useCallback(
    (workspaceId: WorkspaceId) => {
      // Navigate to the workspace landing — the URL-driven sync effect
      // mirrors the new id into `activeWorkspaceId` (and the DB preference
      // via `touchWorkspace`) for us. Going through the URL keeps switches
      // flicker-free: the TopBar resolves the new repo synchronously from
      // `urlWorkspaceId` instead of waiting on `getThreadContext`.
      void navigate(workspacePath(workspaceId));
    },
    [navigate],
  );

  const currentWorkspaceId: WorkspaceId | null = urlWorkspaceId ?? activeWorkspaceId;
  const currentWorkspace = useMemo(
    () => (currentWorkspaceId ? (workspaces?.find((ws) => ws._id === currentWorkspaceId) ?? null) : null),
    [workspaces, currentWorkspaceId],
  );

  return {
    workspaces,
    viewerPreferences,
    touchWorkspace,
    activeWorkspaceId,
    currentWorkspaceId,
    currentWorkspace,
    handleSwitchWorkspace,
  };
}
