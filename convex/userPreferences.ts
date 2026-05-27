import { query } from "./_generated/server";
import { requireViewerIdentity } from "./lib/auth";
import { loadViewerPreferences } from "./lib/userPreferences";

/**
 * Public read API for the viewer's per-user preferences. Today this only
 * surfaces the cross-device "current repository" so the frontend can
 * converge to the same selection on a fresh browser; the table is the
 * canonical source of truth and the localStorage cache in
 * `use-repository-persistence.ts` is only a first-paint accelerator.
 *
 * Returns `null` when the viewer has never written a preference yet so the
 * caller can distinguish "no preference recorded" from "preference points
 * at a deleted repository" (which surfaces as `lastActiveRepositoryId:
 * null` inside the returned object).
 */
export const getViewerPreferences = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireViewerIdentity(ctx);
    return await loadViewerPreferences(ctx, identity.tokenIdentifier);
  },
});
