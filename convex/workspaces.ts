import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireViewerIdentity } from "./lib/auth";
import { clearLastActiveWorkspaceIfMatches, upsertLastActiveWorkspace } from "./lib/userPreferences";
import { ensureHomeWorkspace, ensureRepositoryWorkspace } from "./lib/workspaces";

export const listWorkspaces = query({
  args: {},
  handler: async (ctx) => {
    const identity = await requireViewerIdentity(ctx);
    return await ctx.db
      .query("workspaces")
      .withIndex("by_ownerTokenIdentifier_and_lastAccessedAt", (q) =>
        q.eq("ownerTokenIdentifier", identity.tokenIdentifier),
      )
      .order("desc")
      .take(20);
  },
});

export const createWorkspace = mutation({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);

    const repository = await ctx.db.get(args.repositoryId);
    if (!repository || repository.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Repository not found.");
    }

    return await ensureRepositoryWorkspace(ctx, {
      repositoryId: args.repositoryId,
      name: repository.sourceRepoFullName,
      ownerTokenIdentifier: identity.tokenIdentifier,
    });
  },
});

export const deleteWorkspace = mutation({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace || workspace.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Workspace not found.");
    }

    // The default workspace (no bound repository) cannot be deleted.
    if (!workspace.repositoryId) {
      throw new Error("The default workspace cannot be deleted.");
    }

    const threads = await ctx.db
      .query("threads")
      .withIndex("by_workspaceId_and_lastMessageAt", (q) => q.eq("workspaceId", args.workspaceId))
      .take(1);
    if (threads.length > 0) {
      throw new Error("Repository workspaces with conversations cannot be deleted.");
    }

    await clearLastActiveWorkspaceIfMatches(ctx, {
      ownerTokenIdentifier: identity.tokenIdentifier,
      workspaceId: args.workspaceId,
    });
    await ctx.db.delete(args.workspaceId);
  },
});

/**
 * Mark `workspaceId` as the viewer's currently active workspace.
 *
 * This single mutation owns two writes that must move together:
 *
 * - bump `workspaces.lastAccessedAt` so the sidebar's recency ordering and
 *   the "most recent workspace" fallback both reflect the latest touch
 * - upsert `userPreferences.lastActiveWorkspaceId` so a fresh browser /
 *   device converges to the same selection on next load
 *
 * Atomicity matters: keeping both writes inside one Convex transaction is
 * what makes the DB the canonical source of truth instead of a best-effort
 * shadow of localStorage. See
 * `docs/workspace-persistence-system-design.md` for the full reasoning.
 */
export const touchWorkspace = mutation({
  args: {
    workspaceId: v.id("workspaces"),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace || workspace.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Workspace not found.");
    }
    await ctx.db.patch(args.workspaceId, { lastAccessedAt: Date.now() });
    await upsertLastActiveWorkspace(ctx, {
      ownerTokenIdentifier: identity.tokenIdentifier,
      workspaceId: args.workspaceId,
    });
  },
});

/**
 * Bootstrap a default workspace for new users. Creates a single "Home"
 * workspace that is not tied to any repository — the standard landing
 * workspace every user starts with after onboarding.
 *
 * Idempotent: also repairs legacy "General" or duplicate no-repo workspaces
 * so Home stays the one repo-free workspace.
 */
export const initializeWorkspaces = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireViewerIdentity(ctx);
    return await ensureHomeWorkspace(ctx, identity.tokenIdentifier);
  },
});
