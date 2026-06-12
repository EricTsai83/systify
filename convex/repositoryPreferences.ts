import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import type { Id } from "./_generated/dataModel";
import { requireViewerIdentity } from "./lib/auth";
import { chatModeValidator, type ChatMode } from "./lib/chatMode";
import { requireOwnedDoc } from "./lib/ownedDocs";
import { upsertLastActiveRepository } from "./lib/userPreferences";

const OWNER_REPOSITORY_ID_PROBE_LIMIT = 200;

/**
 * Repository sidebar selector listing — the 20 most recently accessed
 * repositories for the viewer, ordered by `lastAccessedAt` desc.
 *
 * Powers the bottom-of-sidebar dropdown (`RepositorySelector`) and the
 * "most recent repository" fallback in `use-repository-persistence`.
 * Repositories that haven't been touched since Deploy A (their
 * `lastAccessedAt` is `undefined`) sort below touched ones — the
 * descending-on-undefined Convex semantics already do the right thing
 * here, so no client-side coercion is needed.
 */
export const listRepositoriesForSwitcher = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireViewerIdentity(ctx);
    return await ctx.db
      .query("repositories")
      .withIndex("by_ownerTokenIdentifier_and_lastAccessedAt", (q) =>
        q.eq("ownerTokenIdentifier", identity.tokenIdentifier),
      )
      .order("desc")
      .take(20);
  },
});

/**
 * Bounded ownership probe for client-side caches that already have candidate
 * repository ids (URL state, first-paint localStorage, and id-scoped
 * localStorage GC). This keeps the read set proportional to the local cache
 * surface instead of the viewer's total repository count.
 */
export const listOwnedRepositoryIdsById = query({
  args: {
    repositoryIds: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<Id<"repositories">[]> => {
    if (args.repositoryIds.length > OWNER_REPOSITORY_ID_PROBE_LIMIT) {
      throw new Error(`Too many repository ids to validate. Keep at most ${OWNER_REPOSITORY_ID_PROBE_LIMIT}.`);
    }

    const identity = await requireViewerIdentity(ctx);
    const uniqueIds = new Set<Id<"repositories">>();
    for (const rawId of args.repositoryIds) {
      const repositoryId = ctx.db.normalizeId("repositories", rawId);
      if (!repositoryId || uniqueIds.has(repositoryId)) {
        continue;
      }
      const repository = await ctx.db.get(repositoryId);
      if (repository?.ownerTokenIdentifier === identity.tokenIdentifier) {
        uniqueIds.add(repositoryId);
      }
    }
    return [...uniqueIds];
  },
});

/**
 * Mark `repositoryId` as the viewer's currently active repository,
 * optionally recording which mode (discuss / library) the user just
 * landed in inside that repository.
 *
 * This single mutation owns three writes that must move together:
 *
 * - bump `repositories.lastAccessedAt` so the sidebar's recency ordering
 *   and the "most recent repository" fallback both reflect the latest
 *   touch.
 * - when `mode` is supplied, persist it as `repositories.lastMode` so the
 *   next repository-landing redirect lands the user back in the mode they
 *   were last using inside this repository.
 * - upsert `userPreferences.lastActiveRepositoryId` so a fresh browser /
 *   device converges to the same selection on next load.
 *
 * `mode` is intentionally optional. Callers that only know the repository
 * changed (URL → state sync on first paint) omit it so the stored mode is
 * not clobbered with whatever the *previous* repository was showing;
 * callers that observe a settled mode URL (`/r/:rid/discuss`,
 * `/r/:rid/library`) pass it so the repository remembers the user's pick.
 *
 * Atomicity matters: keeping all writes inside one Convex transaction is
 * what makes the DB the canonical source of truth instead of a
 * best-effort shadow of localStorage.
 */
export const touchRepository = mutation({
  args: {
    repositoryId: v.id("repositories"),
    mode: v.optional(chatModeValidator),
  },
  handler: async (ctx, args) => {
    const { identity, doc: repository } = await requireOwnedDoc(ctx, args.repositoryId, {
      notFoundMessage: "Repository not found.",
    });
    const patch: { lastAccessedAt: number; lastMode?: ChatMode } = {
      lastAccessedAt: Date.now(),
    };
    if (args.mode !== undefined && args.mode !== repository.lastMode) {
      patch.lastMode = args.mode;
    }
    await ctx.db.patch(args.repositoryId, patch);
    await upsertLastActiveRepository(ctx, {
      ownerTokenIdentifier: identity.tokenIdentifier,
      repositoryId: args.repositoryId,
    });
  },
});
