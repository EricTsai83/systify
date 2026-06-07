import { v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import { requireViewerIdentity } from "./lib/auth";
import { ensureViewerAccessProfile, getViewerAccess, getViewerAccessByOwnerTokenIdentifier } from "./lib/entitlements";

export const getSelf = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireViewerIdentity(ctx);
    return await getViewerAccess(ctx, identity);
  },
});

export const ensureSelf = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireViewerIdentity(ctx);
    return await ensureViewerAccessProfile(ctx, identity);
  },
});

export const getByOwnerTokenIdentifier = internalQuery({
  args: {
    ownerTokenIdentifier: v.string(),
    email: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    return await getViewerAccessByOwnerTokenIdentifier(ctx, {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      email: args.email ?? null,
    });
  },
});
