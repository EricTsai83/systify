import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireViewerIdentity } from "./lib/auth";
import {
  CUSTOM_INSTRUCTIONS_MAX_LENGTH,
  USER_TRAIT_MAX_LENGTH,
  USER_TRAITS_MAX_COUNT,
  loadViewerPreferences,
  upsertViewerCustomization,
} from "./lib/userPreferences";

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

export const updateViewerCustomization = mutation({
  args: {
    traits: v.array(v.string()),
    customInstructions: v.string(),
  },
  handler: async (ctx, args) => {
    if (args.traits.length > USER_TRAITS_MAX_COUNT * 2) {
      throw new Error(`Too many traits. Keep at most ${USER_TRAITS_MAX_COUNT} traits.`);
    }
    for (const trait of args.traits) {
      if (trait.length > USER_TRAIT_MAX_LENGTH * 2) {
        throw new Error(`Traits must be ${USER_TRAIT_MAX_LENGTH} characters or fewer.`);
      }
    }
    if (args.customInstructions.length > CUSTOM_INSTRUCTIONS_MAX_LENGTH * 2) {
      throw new Error(`Custom instructions must be ${CUSTOM_INSTRUCTIONS_MAX_LENGTH} characters or fewer.`);
    }

    const identity = await requireViewerIdentity(ctx);
    await upsertViewerCustomization(ctx, {
      ownerTokenIdentifier: identity.tokenIdentifier,
      preferences: {
        traits: args.traits,
        customInstructions: args.customInstructions,
      },
    });
  },
});
