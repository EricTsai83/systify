import { useEffect } from "react";
import { listKeysByPrefix, removeKey } from "@/lib/storage";

const REPOSITORY_SCOPED_PREFIXES = [
  "systify.library.tabs.",
  "systify.library.askTabs.",
  "systify.composer.draft.repository.",
  "systify.folderNav.open.",
] as const;

const COMPOSER_DRAFT_THREAD_PREFIX = "systify.composer.draft.thread.";
const ACTIVE_REPOSITORY_STORAGE_KEY = "systify.activeRepositoryId";

/**
 * Garbage-collect localStorage keys whose owning repository or thread no
 * longer exists. Runs whenever the live id sets change — both on initial
 * load and on subscription-driven deletion pushes from other tabs / devices.
 *
 * Pass `null` while the upstream Convex query is still loading so we don't
 * mistakenly wipe everything as "orphan".
 *
 * `systify.activeRepositoryId` is a first-paint cache only, so a stale
 * value is cleared as soon as the live repository id set is known.
 */
export function useStorageGC({
  liveRepositoryIds,
  liveThreadIds,
}: {
  liveRepositoryIds: ReadonlySet<string> | null;
  liveThreadIds?: ReadonlySet<string> | null;
}): void {
  useEffect(() => {
    if (!liveRepositoryIds) return;
    for (const prefix of REPOSITORY_SCOPED_PREFIXES) {
      for (const key of listKeysByPrefix(prefix)) {
        const suffix = key.slice(prefix.length);
        const repositoryId = suffix.split(".")[0];
        if (!repositoryId || !liveRepositoryIds.has(repositoryId)) removeKey(key);
      }
    }
    const activeRepositoryId = window.localStorage.getItem(ACTIVE_REPOSITORY_STORAGE_KEY);
    if (activeRepositoryId && !liveRepositoryIds.has(activeRepositoryId)) {
      removeKey(ACTIVE_REPOSITORY_STORAGE_KEY);
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
