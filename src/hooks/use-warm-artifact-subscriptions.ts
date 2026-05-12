import { useMemo } from "react";
import { useQueries } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { ArtifactId, FolderId } from "@/lib/types";

/**
 * Hold Convex subscriptions open for `artifactIds` (and their `folderIds`)
 * so switching between Library tabs is instantaneous and stays
 * live-reactive.
 *
 * Convex's `useQuery` re-subscribes from scratch when its args change,
 * returning `undefined` until the server responds — that gap is the
 * `EditorSkeleton` flash users see when switching tabs. By subscribing
 * in parallel at a parent level via `useQueries`, the data for these
 * artifacts is already on the client. When `LibraryEditor`'s `useQuery`
 * mounts with the same `(query, args)` it shares the same ref-counted
 * subscription and returns the value synchronously.
 *
 * This is *not* a cache — every entry is a real, server-pushed
 * subscription, so server-side edits stream in normally with no stale
 * read risk. The cost is `artifactIds.length + folderIds.length` extra
 * subscriptions; the Library tab strip already caps `openArtifactIds`
 * at `MAX_OPEN_TABS`, so the working set is bounded for free.
 *
 * Both `artifacts.getById` and `artifactFolders.getById` are warmed
 * because the editor renders both together (breadcrumb + body) —
 * warming only the artifact would still let the breadcrumb pop on
 * switch.
 */
export function useWarmArtifactSubscriptions(artifactIds: readonly ArtifactId[], folderIds: readonly FolderId[]): void {
  const queries = useMemo(() => {
    const map: Record<
      string,
      | { query: typeof api.artifacts.getById; args: { artifactId: ArtifactId } }
      | { query: typeof api.artifactFolders.getById; args: { folderId: FolderId } }
    > = {};
    for (const artifactId of artifactIds) {
      map[`artifact:${artifactId}`] = {
        query: api.artifacts.getById,
        args: { artifactId },
      };
    }
    for (const folderId of folderIds) {
      map[`folder:${folderId}`] = {
        query: api.artifactFolders.getById,
        args: { folderId },
      };
    }
    return map;
  }, [artifactIds, folderIds]);

  useQueries(queries);
}
