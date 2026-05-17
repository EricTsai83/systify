import { useEffect } from "react";
import { listKeysByPrefix, removeKey } from "@/lib/storage";

const WORKSPACE_SCOPED_PREFIXES = ["systify.library.tabs.", "systify.library.askTabs."] as const;

const REPOSITORY_SCOPED_PREFIX = "systify.folderNav.open.";

/**
 * Garbage-collect localStorage keys whose owning workspace or repository no
 * longer exists. Runs whenever the live id sets change — both on initial
 * load and on subscription-driven deletion pushes from other tabs / devices.
 *
 * Pass `null` while the upstream Convex query is still loading so we don't
 * mistakenly wipe everything as "orphan".
 *
 * `systify.activeWorkspaceId` is intentionally NOT handled here. The
 * fallback effect in `RepositoryShell` already resets the active id to a
 * surviving workspace when its target disappears; this hook only sweeps
 * the *scoped* keys (per-workspace tab strips, per-repo folder nav state)
 * that would otherwise accumulate indefinitely.
 */
export function useStorageGC({
  liveWorkspaceIds,
  liveRepositoryIds,
}: {
  liveWorkspaceIds: ReadonlySet<string> | null;
  liveRepositoryIds: ReadonlySet<string> | null;
}): void {
  useEffect(() => {
    if (!liveWorkspaceIds) return;
    for (const prefix of WORKSPACE_SCOPED_PREFIXES) {
      for (const key of listKeysByPrefix(prefix)) {
        const workspaceId = key.slice(prefix.length);
        if (!liveWorkspaceIds.has(workspaceId)) removeKey(key);
      }
    }
  }, [liveWorkspaceIds]);

  useEffect(() => {
    if (!liveRepositoryIds) return;
    for (const key of listKeysByPrefix(REPOSITORY_SCOPED_PREFIX)) {
      // Key shape: systify.folderNav.open.{repoId}.{nodeId}
      const suffix = key.slice(REPOSITORY_SCOPED_PREFIX.length);
      const repoId = suffix.split(".")[0];
      if (!repoId || !liveRepositoryIds.has(repoId)) removeKey(key);
    }
  }, [liveRepositoryIds]);
}
