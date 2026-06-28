import { useEffect } from "react";
import { useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import { LOCAL_EDITOR_REPOSITORY_STORAGE_PREFIX } from "@/lib/local-editor";
import { listKeysByPrefix, readString, removeKey } from "@/lib/storage";

const REPOSITORY_SCOPED_PREFIXES = [
  "systify.library.tabs.",
  "systify.library.askTabs.",
  "systify.composer.draft.repository.",
  "systify.folderNav.open.",
  LOCAL_EDITOR_REPOSITORY_STORAGE_PREFIX,
] as const;

const COMPOSER_DRAFT_THREAD_PREFIX = "systify.composer.draft.thread.";
const ACTIVE_REPOSITORY_STORAGE_KEY = "systify.activeRepositoryId";
const LEGACY_ARTIFACT_PANEL_OPEN_KEY = "systify.artifactPanel.open";
export const STORAGE_GC_ID_PROBE_LIMIT = 200;

/**
 * Collect only ids that actually appear in localStorage. Server validation is
 * therefore bounded by browser cache size, not by the viewer's repository or
 * thread history.
 */
export function collectStorageGCRepositoryIds(): string[] {
  const ids = new Set<string>();
  for (const prefix of REPOSITORY_SCOPED_PREFIXES) {
    for (const key of listKeysByPrefix(prefix)) {
      const suffix = key.slice(prefix.length);
      const repositoryId = suffix.split(".")[0];
      if (repositoryId) ids.add(repositoryId);
    }
  }

  const activeRepositoryId = readString(ACTIVE_REPOSITORY_STORAGE_KEY);
  if (activeRepositoryId) ids.add(activeRepositoryId);
  return [...ids].sort().slice(0, STORAGE_GC_ID_PROBE_LIMIT);
}

export function collectStorageGCThreadIds(): string[] {
  const ids = new Set<string>();
  for (const key of listKeysByPrefix(COMPOSER_DRAFT_THREAD_PREFIX)) {
    const threadId = key.slice(COMPOSER_DRAFT_THREAD_PREFIX.length);
    if (threadId) ids.add(threadId);
  }
  return [...ids].sort().slice(0, STORAGE_GC_ID_PROBE_LIMIT);
}

export function sweepRepositoryStorage(
  collectedRepositoryIds: ReadonlySet<string>,
  liveRepositoryIds: ReadonlySet<string>,
): void {
  removeKey(LEGACY_ARTIFACT_PANEL_OPEN_KEY);
  for (const prefix of REPOSITORY_SCOPED_PREFIXES) {
    for (const key of listKeysByPrefix(prefix)) {
      const suffix = key.slice(prefix.length);
      const repositoryId = suffix.split(".")[0];
      if (repositoryId && collectedRepositoryIds.has(repositoryId) && !liveRepositoryIds.has(repositoryId)) {
        removeKey(key);
      }
    }
  }
  const activeRepositoryId = readString(ACTIVE_REPOSITORY_STORAGE_KEY);
  if (
    activeRepositoryId &&
    collectedRepositoryIds.has(activeRepositoryId) &&
    !liveRepositoryIds.has(activeRepositoryId)
  ) {
    removeKey(ACTIVE_REPOSITORY_STORAGE_KEY);
  }
}

export function sweepThreadStorage(collectedThreadIds: ReadonlySet<string>, liveThreadIds: ReadonlySet<string>): void {
  for (const key of listKeysByPrefix(COMPOSER_DRAFT_THREAD_PREFIX)) {
    const threadId = key.slice(COMPOSER_DRAFT_THREAD_PREFIX.length);
    if (threadId && collectedThreadIds.has(threadId) && !liveThreadIds.has(threadId)) removeKey(key);
  }
}

/**
 * Garbage-collect localStorage keys whose owning repository or thread no
 * longer exists. The hook validates only ids already present in localStorage,
 * so initial shell mount no longer subscribes to full owner repository/thread
 * id lists.
 */
export function useStorageGC(): void {
  const repositoryIds = collectStorageGCRepositoryIds();
  const threadIds = collectStorageGCThreadIds();
  const hasRepositoryIds = repositoryIds.length > 0;
  const hasThreadIds = threadIds.length > 0;
  const liveRepositoryIds = useQuery(
    api.repositoryPreferences.listOwnedRepositoryIdsById,
    hasRepositoryIds ? { repositoryIds } : "skip",
  );
  const liveThreadIds = useQuery(api.chat.threads.listOwnedThreadIdsById, hasThreadIds ? { threadIds } : "skip");

  useEffect(() => {
    removeKey(LEGACY_ARTIFACT_PANEL_OPEN_KEY);
  }, []);

  useEffect(() => {
    if (!hasRepositoryIds) return;
    if (liveRepositoryIds === undefined) return;
    sweepRepositoryStorage(new Set(repositoryIds), new Set(liveRepositoryIds));
  }, [hasRepositoryIds, liveRepositoryIds, repositoryIds]);

  useEffect(() => {
    if (!hasThreadIds) return;
    if (liveThreadIds === undefined) return;
    sweepThreadStorage(new Set(threadIds), new Set(liveThreadIds));
  }, [hasThreadIds, liveThreadIds, threadIds]);
}
