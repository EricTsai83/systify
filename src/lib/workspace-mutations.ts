import type { OptimisticLocalStore } from "convex/browser";
import type { Id } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import type { ChatMode } from "@/lib/types";

/**
 * Optimistic mirror for `api.workspaces.touchWorkspace`.
 *
 * Shared between the workspace shell (`repository-shell.tsx`) and the
 * Library page (`library.tsx`) so both navigation surfaces converge on the
 * same client cache shape the moment the user picks a workspace or settles
 * on a service mode — without the Library page needing to import the
 * 1000-line RepositoryShell just to reuse one helper.
 *
 * Updates the three pieces of state the real mutation touches:
 *
 *   1. `userPreferences.lastActiveWorkspaceId` — keeps the canonical
 *      "current workspace" pointer aligned with the user's intent so the
 *      reconciliation effect in `RepositoryShell` doesn't see a stale DB
 *      preference and try to override the just-picked workspace.
 *   2. `workspaces.lastAccessedAt` (with a re-sort) — snaps the sidebar's
 *      most-recent ordering into place immediately. The DB index is
 *      descending on `lastAccessedAt`, so we sort the same way.
 *   3. `workspaces.lastMode` (when provided) — lets the Tier 2
 *      workspace-landing redirect read the user's just-picked mode on the
 *      same render without waiting for the server roundtrip. Without this,
 *      a fast Archive → back round-trip would still race the network and
 *      send the user to the workspace's structural default mode on first
 *      paint, then re-redirect once the server-side update propagated.
 *
 * Defined as a `function` (not an arrow) so the `Date.now()` call stays a
 * runtime concern rather than memoisation-time impurity, and the function
 * reference is stable across renders for `withOptimisticUpdate`.
 */
export function applyTouchWorkspaceOptimistic(
  store: OptimisticLocalStore,
  args: { workspaceId: Id<"workspaces">; mode?: ChatMode },
) {
  const now = Date.now();

  for (const { args: queryArgs } of store.getAllQueries(api.userPreferences.getViewerPreferences)) {
    store.setQuery(api.userPreferences.getViewerPreferences, queryArgs, {
      lastActiveWorkspaceId: args.workspaceId,
      lastActiveWorkspaceUpdatedAt: now,
    });
  }

  for (const { args: queryArgs, value } of store.getAllQueries(api.workspaces.listWorkspaces)) {
    if (value === undefined) continue;
    const updated = value
      .map((ws) =>
        ws._id === args.workspaceId
          ? {
              ...ws,
              lastAccessedAt: now,
              ...(args.mode !== undefined ? { lastMode: args.mode } : {}),
            }
          : ws,
      )
      .sort((a, b) => b.lastAccessedAt - a.lastAccessedAt);
    store.setQuery(api.workspaces.listWorkspaces, queryArgs, updated);
  }
}
