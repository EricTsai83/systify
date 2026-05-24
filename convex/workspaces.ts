import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireViewerIdentity } from "./lib/auth";
import { chatModeValidator, type ChatMode } from "./lib/chatMode";
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
 * Mark `workspaceId` as the viewer's currently active workspace, optionally
 * recording which mode (discuss / library / lab) the user just landed in
 * inside that workspace.
 *
 * This single mutation owns three writes that must move together:
 *
 * - bump `workspaces.lastAccessedAt` so the sidebar's recency ordering and
 *   the "most recent workspace" fallback both reflect the latest touch
 * - when `mode` is supplied, persist it as `workspaces.lastMode` so the
 *   next `/chat` → `/w/:wid` → mode-canonical-URL redirect lands the user
 *   back in the mode they were last using inside this workspace (instead
 *   of the workspace's structural default — the cross-session "I was in
 *   discuss, why am I in library?" surprise this argument fixes)
 * - upsert `userPreferences.lastActiveWorkspaceId` so a fresh browser /
 *   device converges to the same selection on next load
 *
 * `mode` is intentionally optional. Callers that only know the workspace
 * changed (URL → state sync on first paint) omit it so the stored mode is
 * not clobbered with whatever the *previous* workspace was showing;
 * callers that observe a settled mode URL (`/w/:wid/discuss`,
 * `/w/:wid/library`, `/w/:wid/lab`) pass it so the workspace remembers
 * the user's pick.
 *
 * Atomicity matters: keeping all writes inside one Convex transaction is
 * what makes the DB the canonical source of truth instead of a best-effort
 * shadow of localStorage. See
 * `docs/workspace-persistence-system-design.md` for the full reasoning.
 */
export const touchWorkspace = mutation({
  args: {
    workspaceId: v.id("workspaces"),
    mode: v.optional(chatModeValidator),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const workspace = await ctx.db.get(args.workspaceId);
    if (!workspace || workspace.ownerTokenIdentifier !== identity.tokenIdentifier) {
      throw new Error("Workspace not found.");
    }
    // Skip the `lastMode` field entirely when the caller didn't pass one,
    // or when the supplied mode already matches what's stored.
    // `ctx.db.patch` interprets `undefined` as "leave this field alone" for
    // optional fields, so the conditional both narrows the patch object to
    // only what actually changed (easier to grep when auditing workspace
    // mutations) and short-circuits redundant writes when the optimistic
    // update has already converged the client cache on the same value the
    // server holds.
    const patch: { lastAccessedAt: number; lastMode?: ChatMode } = {
      lastAccessedAt: Date.now(),
    };
    if (args.mode !== undefined && args.mode !== workspace.lastMode) {
      patch.lastMode = args.mode;
    }
    await ctx.db.patch(args.workspaceId, patch);
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
