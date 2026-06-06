import type { OptimisticLocalStore } from "convex/browser";
import type { Id } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import type { ChatMode } from "@/lib/types";

/**
 * Optimistic mirror for `api.repositoryPreferences.touchRepository`.
 *
 * Shared between the repository shell (`repository-shell.tsx`) and the
 * Library page (`library.tsx`) so both navigation surfaces converge on
 * the same client cache shape the moment the user picks a repository or
 * settles on a service mode.
 *
 * Updates the three pieces of state the real mutation touches:
 *
 *   1. `userPreferences.lastActiveRepositoryId` — keeps the canonical
 *      "current repository" pointer aligned with the user's intent so
 *      reconciliation effects in the shell don't see a stale DB
 *      preference and try to override the just-picked repository.
 *   2. `repositories.lastAccessedAt` (with a re-sort) — snaps the
 *      sidebar's most-recent ordering into place immediately.
 *   3. `repositories.lastMode` (when provided) — lets the redirect ladder
 *      read the user's just-picked mode on the same render without
 *      waiting for the server roundtrip.
 *
 * Defined as a `function` (not an arrow) so the `Date.now()` call stays
 * a runtime concern rather than memoisation-time impurity, and the
 * function reference is stable across renders for `withOptimisticUpdate`.
 */
export function applyTouchRepositoryOptimistic(
  store: OptimisticLocalStore,
  args: { repositoryId: Id<"repositories">; mode?: ChatMode },
) {
  const now = Date.now();

  for (const { args: queryArgs, value } of store.getAllQueries(api.userPreferences.getViewerPreferences)) {
    if (value === undefined) continue;
    store.setQuery(api.userPreferences.getViewerPreferences, queryArgs, {
      traits: value?.traits ?? [],
      customInstructions: value?.customInstructions ?? "",
      customizationUpdatedAt: value?.customizationUpdatedAt ?? null,
      lastActiveRepositoryId: args.repositoryId,
      lastActiveRepositoryUpdatedAt: now,
    });
  }

  for (const { args: queryArgs, value } of store.getAllQueries(api.repositoryPreferences.listRepositoriesForSwitcher)) {
    if (value === undefined) continue;
    const updated = value
      .map((repo) =>
        repo._id === args.repositoryId
          ? {
              ...repo,
              lastAccessedAt: now,
              ...(args.mode !== undefined ? { lastMode: args.mode } : {}),
            }
          : repo,
      )
      .sort((a, b) => (b.lastAccessedAt ?? 0) - (a.lastAccessedAt ?? 0));
    store.setQuery(api.repositoryPreferences.listRepositoriesForSwitcher, queryArgs, updated);
  }
}
