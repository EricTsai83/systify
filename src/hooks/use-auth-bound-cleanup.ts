import { useEffect, useRef } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { listKeysByPrefix, readString, removeKey, writeString } from "@/lib/storage";

const COMPOSER_DRAFT_PREFIX = "systify.composer.draft.";
// Persisted across browser sessions so a hard reload (or a second user
// opening the same browser after the first closed it without signing
// out) can still detect a cross-session account switch and clear stale
// drafts. An in-memory ref alone would forget the previous user id every
// time the tab is closed.
const COMPOSER_LAST_AUTH_USER_KEY = "systify.composer.lastAuthUser";

/**
 * Detect logout / account switch and clear per-viewer localStorage that would
 * otherwise leak across users on the same machine.
 *
 * Tracks the WorkOS user id between renders **and across browser sessions**
 * (the last-seen id is mirrored to localStorage under
 * `systify.composer.lastAuthUser`); when it transitions from a non-null id
 * to a different id (or to `null`), every key under
 * `systify.composer.draft.*` is removed. The prefix sweep is the right
 * granularity: thread- and repository-scoped draft keys both live under it,
 * so both forms get drained on the same transition.
 *
 * `isLoading: true` windows are ignored. AuthKit briefly sets `isLoading`
 * during silent refresh and may transiently report `user = null` in the
 * same render — wiping drafts on that window would surprise the user.
 *
 * The composer-draft prefix is the only sweep target today. Other forms of
 * per-user-tied localStorage (e.g. library tabs) are keyed by repository id
 * and are reaped by `useStorageGC` once the repository ids change for the
 * new viewer.
 */
export function useAuthBoundCleanup(): void {
  const { user, isLoading } = useAuth();
  // `undefined` sentinel marks "not yet seeded from storage"; once seeded
  // the value mirrors the persisted id (`null` when no prior session).
  const previousUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    if (isLoading) return;
    const currentUserId = user?.id ?? null;
    if (previousUserIdRef.current === undefined) {
      previousUserIdRef.current = readString(COMPOSER_LAST_AUTH_USER_KEY);
    }
    const previousUserId = previousUserIdRef.current;
    if (previousUserId !== null && previousUserId !== currentUserId) {
      for (const key of listKeysByPrefix(COMPOSER_DRAFT_PREFIX)) {
        removeKey(key);
      }
    }
    previousUserIdRef.current = currentUserId;
    if (currentUserId !== null) {
      writeString(COMPOSER_LAST_AUTH_USER_KEY, currentUserId);
    } else {
      removeKey(COMPOSER_LAST_AUTH_USER_KEY);
    }
  }, [user?.id, isLoading]);
}
