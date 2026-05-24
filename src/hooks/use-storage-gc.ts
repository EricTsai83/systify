import { useEffect } from "react";
import { listKeysByPrefix, removeKey } from "@/lib/storage";

const WORKSPACE_SCOPED_PREFIXES = [
  "systify.library.tabs.",
  "systify.library.askTabs.",
  "systify.composer.draft.workspace.",
] as const;

const REPOSITORY_SCOPED_PREFIX = "systify.folderNav.open.";

const COMPOSER_DRAFT_THREAD_PREFIX = "systify.composer.draft.thread.";

/**
 * Garbage-collect localStorage keys whose owning workspace, repository, or
 * thread no longer exists. Runs whenever the live id sets change — both on
 * initial load and on subscription-driven deletion pushes from other tabs /
 * devices.
 *
 * Pass `null` while the upstream Convex query is still loading so we don't
 * mistakenly wipe everything as "orphan".
 *
 * `systify.activeWorkspaceId` is intentionally NOT handled here. The
 * fallback effect in `RepositoryShell` already resets the active id to a
 * surviving workspace when its target disappears; this hook only sweeps
 * the *scoped* keys (per-workspace tab strips, per-repo folder nav state,
 * per-thread / per-workspace composer drafts) that would otherwise
 * accumulate indefinitely.
 *
 * Thread-scoped sweep cap trade-off: `liveThreadIds` is bounded by the
 * `listAllOwnerThreadIds` query (1000 most-recent threads). Beyond that
 * cap, drafts for genuinely old threads get reaped as orphans — an
 * acceptable trade-off versus a full table scan on every subscription
 * tick.
 */
export function useStorageGC({
  liveWorkspaceIds,
  liveRepositoryIds,
  liveThreadIds,
}: {
  liveWorkspaceIds: ReadonlySet<string> | null;
  liveRepositoryIds: ReadonlySet<string> | null;
  liveThreadIds?: ReadonlySet<string> | null;
}): void {
  useEffect(() => {
    if (!liveWorkspaceIds) return;
    for (const prefix of WORKSPACE_SCOPED_PREFIXES) {
      for (const key of listKeysByPrefix(prefix)) {
        // Workspace-scoped keys may carry additional path segments after the
        // workspace id (composer drafts add `.{mode}`, tabs use the
        // raw id). Slice the prefix, then read up to the first `.` to
        // extract the workspace segment.
        const suffix = key.slice(prefix.length);
        const workspaceId = suffix.split(".")[0];
        if (!workspaceId || !liveWorkspaceIds.has(workspaceId)) removeKey(key);
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

  useEffect(() => {
    if (!liveThreadIds) return;
    for (const key of listKeysByPrefix(COMPOSER_DRAFT_THREAD_PREFIX)) {
      const threadId = key.slice(COMPOSER_DRAFT_THREAD_PREFIX.length);
      if (!threadId || !liveThreadIds.has(threadId)) removeKey(key);
    }
  }, [liveThreadIds]);
}
