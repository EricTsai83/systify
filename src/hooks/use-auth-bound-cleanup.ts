import { useEffect, useRef } from "react";
import { useAuth } from "@workos-inc/authkit-react";
import { listKeysByPrefix, removeKey } from "@/lib/storage";

const COMPOSER_DRAFT_PREFIX = "systify.composer.draft.";

/**
 * Detect logout / account switch and clear per-viewer localStorage that would
 * otherwise leak across users on the same machine.
 *
 * Tracks the WorkOS user id between renders; when it transitions from a
 * non-null id to a different id (or to `null`), every key under
 * `systify.composer.draft.*` is removed. The prefix sweep is the right
 * granularity: thread- and workspace-scoped draft keys both live under it,
 * so both forms get drained on the same transition.
 *
 * `isLoading: true` windows are ignored. AuthKit briefly sets `isLoading`
 * during silent refresh and may transiently report `user = null` in the
 * same render — wiping drafts on that window would surprise the user.
 *
 * The composer-draft prefix is the only sweep target today. Other forms of
 * per-user-tied localStorage (e.g. library tabs) are keyed by workspace id
 * and are reaped by `useStorageGC` once the workspace ids change for the
 * new viewer.
 */
export function useAuthBoundCleanup(): void {
  const { user, isLoading } = useAuth();
  const previousUserIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (isLoading) return;
    const currentUserId = user?.id ?? null;
    const previousUserId = previousUserIdRef.current;
    if (previousUserId !== null && previousUserId !== currentUserId) {
      for (const key of listKeysByPrefix(COMPOSER_DRAFT_PREFIX)) {
        removeKey(key);
      }
    }
    previousUserIdRef.current = currentUserId;
  }, [user?.id, isLoading]);
}
