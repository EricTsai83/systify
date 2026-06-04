import { v } from "convex/values";
import { query, mutation, internalMutation, internalQuery, type QueryCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";
import { requireViewerIdentity } from "./lib/auth";
import { logWarn } from "./lib/observability";

// ---------------------------------------------------------------------------
// Public query: GitHub connection status for the current user
// ---------------------------------------------------------------------------

export const getGitHubConnectionStatus = query({
  args: {},
  handler: async (ctx) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) {
      return {
        isConnected: false as const,
        installationId: null,
        accountLogin: null,
        repositorySelection: null,
        installationStatus: null,
      };
    }

    const currentInstallations = await getCurrentInstallationsForOwner(ctx, identity.tokenIdentifier);
    const activeInstallation = currentInstallations.find((installation) => installation.status === "active");
    const suspendedInstallation = currentInstallations.find((installation) => installation.status === "suspended");

    if (activeInstallation) {
      return {
        isConnected: true as const,
        installationId: activeInstallation.installationId,
        accountLogin: activeInstallation.accountLogin,
        repositorySelection: activeInstallation.repositorySelection,
        installationStatus: activeInstallation.status,
      };
    }

    if (suspendedInstallation) {
      return {
        isConnected: false as const,
        installationId: suspendedInstallation.installationId,
        accountLogin: suspendedInstallation.accountLogin,
        repositorySelection: suspendedInstallation.repositorySelection,
        installationStatus: suspendedInstallation.status,
      };
    }

    return {
      isConnected: false as const,
      installationId: null,
      accountLogin: null,
      repositorySelection: null,
      installationStatus: null,
    };
  },
});

// ---------------------------------------------------------------------------
// Internal mutations for the OAuth state flow (CSRF protection)
// ---------------------------------------------------------------------------

export const createOAuthState = internalMutation({
  args: {
    state: v.string(),
    ownerTokenIdentifier: v.string(),
    returnTo: v.optional(v.string()),
    githubCodeVerifier: v.optional(v.string()),
    githubCodeChallenge: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const now = Date.now();
    await ctx.db.insert("githubOAuthStates", {
      state: args.state,
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      ...(args.returnTo ? { returnTo: args.returnTo } : {}),
      ...(args.githubCodeVerifier ? { githubCodeVerifier: args.githubCodeVerifier } : {}),
      ...(args.githubCodeChallenge ? { githubCodeChallenge: args.githubCodeChallenge } : {}),
      createdAt: now,
      expiresAt: now + 10 * 60 * 1000, // 10-minute expiry
      consumed: false,
    });
  },
});

export const getOAuthReturnToByState = internalQuery({
  args: {
    state: v.string(),
  },
  handler: async (ctx, args) => {
    const stateDoc = await ctx.db
      .query("githubOAuthStates")
      .withIndex("by_state", (q) => q.eq("state", args.state))
      .first();

    return stateDoc?.returnTo ?? null;
  },
});

export const consumeOAuthState = internalMutation({
  args: {
    state: v.string(),
  },
  handler: async (ctx, args) => {
    const stateDoc = await ctx.db
      .query("githubOAuthStates")
      .withIndex("by_state", (q) => q.eq("state", args.state))
      .first();

    if (!stateDoc) {
      throw new Error("Invalid state parameter.");
    }
    if (stateDoc.consumed) {
      throw new Error("State already consumed.");
    }
    if (stateDoc.expiresAt < Date.now()) {
      throw new Error("State expired.");
    }

    await ctx.db.patch(stateDoc._id, { consumed: true });
    return {
      ownerTokenIdentifier: stateDoc.ownerTokenIdentifier,
      returnTo: stateDoc.returnTo ?? null,
    };
  },
});

function requireUsableOAuthState(stateDoc: Doc<"githubOAuthStates"> | null): Doc<"githubOAuthStates"> {
  if (!stateDoc) {
    throw new Error("Invalid state parameter.");
  }
  if (stateDoc.consumed) {
    throw new Error("State already consumed.");
  }
  if (stateDoc.expiresAt < Date.now()) {
    throw new Error("State expired.");
  }
  return stateDoc;
}

export const prepareInstallationUserAuthorization = internalMutation({
  args: {
    state: v.string(),
    installationId: v.number(),
  },
  handler: async (ctx, args) => {
    const stateDoc = requireUsableOAuthState(
      await ctx.db
        .query("githubOAuthStates")
        .withIndex("by_state", (q) => q.eq("state", args.state))
        .first(),
    );

    if (stateDoc.pendingInstallationId !== undefined && stateDoc.pendingInstallationId !== args.installationId) {
      throw new Error("Installation callback does not match the pending GitHub authorization state.");
    }
    if (!stateDoc.githubCodeVerifier || !stateDoc.githubCodeChallenge) {
      throw new Error("GitHub authorization state is incomplete. Please restart the GitHub connection flow.");
    }

    const now = Date.now();
    await ctx.db.patch(stateDoc._id, {
      pendingInstallationId: args.installationId,
      githubUserAuthorizationStartedAt: now,
    });

    return {
      returnTo: stateDoc.returnTo ?? null,
      githubCodeChallenge: stateDoc.githubCodeChallenge,
    };
  },
});

export const consumeOAuthStateForInstallationVerification = internalMutation({
  args: {
    state: v.string(),
    callbackInstallationId: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const stateDoc = requireUsableOAuthState(
      await ctx.db
        .query("githubOAuthStates")
        .withIndex("by_state", (q) => q.eq("state", args.state))
        .first(),
    );

    const installationId = stateDoc.pendingInstallationId ?? args.callbackInstallationId;
    if (installationId === undefined) {
      throw new Error("GitHub authorization completed without an installation to verify.");
    }
    if (stateDoc.pendingInstallationId !== undefined && args.callbackInstallationId !== undefined) {
      if (stateDoc.pendingInstallationId !== args.callbackInstallationId) {
        throw new Error("GitHub authorization callback does not match the pending installation.");
      }
    }
    if (!stateDoc.githubCodeVerifier) {
      throw new Error("GitHub authorization state is incomplete. Please restart the GitHub connection flow.");
    }
    if (stateDoc.githubUserAuthorizationStartedAt === undefined) {
      throw new Error("GitHub user authorization was not started. Please restart the GitHub connection flow.");
    }

    await ctx.db.patch(stateDoc._id, { consumed: true });

    return {
      ownerTokenIdentifier: stateDoc.ownerTokenIdentifier,
      returnTo: stateDoc.returnTo ?? null,
      installationId,
      githubCodeVerifier: stateDoc.githubCodeVerifier,
    };
  },
});

// ---------------------------------------------------------------------------
// Internal mutation: clean up expired OAuth states
// ---------------------------------------------------------------------------

const OAUTH_CLEANUP_BATCH_SIZE = 50;

export const cleanupExpiredOAuthStates = internalMutation({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query("githubOAuthStates")
      .withIndex("by_expiresAt", (q) => q.lt("expiresAt", now))
      .take(OAUTH_CLEANUP_BATCH_SIZE);

    for (const doc of expired) {
      await ctx.db.delete(doc._id);
    }

    // If we hit the batch limit, schedule another run to continue.
    if (expired.length >= OAUTH_CLEANUP_BATCH_SIZE) {
      await ctx.scheduler.runAfter(0, internal.github.cleanupExpiredOAuthStates, {});
    }

    return { deleted: expired.length };
  },
});

// ---------------------------------------------------------------------------
// Internal mutations for installation lifecycle
// ---------------------------------------------------------------------------

type CurrentInstallationStatus = "active" | "suspended";

const CURRENT_INSTALLATION_STATUSES: CurrentInstallationStatus[] = ["active", "suspended"];
const INSTALLATION_LIFECYCLE_SCAN_LIMIT = 100;

function isCurrentInstallation(row: Doc<"githubInstallations">): boolean {
  return row.status === "active" || row.status === "suspended";
}

async function getInstallationsByInstallationIdAndStatus(
  ctx: Pick<QueryCtx, "db">,
  installationId: number,
  status: CurrentInstallationStatus,
): Promise<Doc<"githubInstallations">[]> {
  const rows = await ctx.db
    .query("githubInstallations")
    .withIndex("by_installationId_and_status", (q) => q.eq("installationId", installationId).eq("status", status))
    .take(INSTALLATION_LIFECYCLE_SCAN_LIMIT + 1);
  if (rows.length > INSTALLATION_LIFECYCLE_SCAN_LIMIT) {
    throw new Error(
      "Too many current GitHub installation rows for installation id; refusing truncated lifecycle scan.",
    );
  }
  return rows;
}

async function getCurrentInstallationsForInstallationId(
  ctx: Pick<QueryCtx, "db">,
  installationId: number,
): Promise<Doc<"githubInstallations">[]> {
  const rows: Doc<"githubInstallations">[] = [];
  for (const status of CURRENT_INSTALLATION_STATUSES) {
    rows.push(...(await getInstallationsByInstallationIdAndStatus(ctx, installationId, status)));
  }
  return rows;
}

async function getInstallationsByOwnerAndStatus(
  ctx: Pick<QueryCtx, "db">,
  ownerTokenIdentifier: string,
  status: CurrentInstallationStatus,
): Promise<Doc<"githubInstallations">[]> {
  const rows = await ctx.db
    .query("githubInstallations")
    .withIndex("by_ownerTokenIdentifier_and_status", (q) =>
      q.eq("ownerTokenIdentifier", ownerTokenIdentifier).eq("status", status),
    )
    .take(INSTALLATION_LIFECYCLE_SCAN_LIMIT + 1);
  if (rows.length > INSTALLATION_LIFECYCLE_SCAN_LIMIT) {
    throw new Error("Too many current GitHub installation rows for owner; refusing truncated lifecycle scan.");
  }
  return rows;
}

async function getCurrentInstallationsForOwner(
  ctx: Pick<QueryCtx, "db">,
  ownerTokenIdentifier: string,
): Promise<Doc<"githubInstallations">[]> {
  const rows: Doc<"githubInstallations">[] = [];
  for (const status of CURRENT_INSTALLATION_STATUSES) {
    rows.push(...(await getInstallationsByOwnerAndStatus(ctx, ownerTokenIdentifier, status)));
  }
  return rows;
}

export const saveInstallation = internalMutation({
  args: {
    ownerTokenIdentifier: v.string(),
    installationId: v.number(),
    accountLogin: v.string(),
    accountType: v.union(v.literal("User"), v.literal("Organization")),
    repositorySelection: v.union(v.literal("all"), v.literal("selected")),
  },
  handler: async (ctx, args) => {
    const currentInstallationRows = await getCurrentInstallationsForInstallationId(ctx, args.installationId);

    const foreignCurrent = currentInstallationRows.find(
      (installation) => installation.ownerTokenIdentifier !== args.ownerTokenIdentifier,
    );
    if (foreignCurrent) {
      return {
        kind: "conflict" as const,
        existingInstallationId: foreignCurrent.installationId,
        existingAccountLogin: foreignCurrent.accountLogin,
      };
    }

    const currentInstallationsForOwner = await getCurrentInstallationsForOwner(ctx, args.ownerTokenIdentifier);
    const conflictingCurrent = currentInstallationsForOwner.find(
      (installation) => installation.installationId !== args.installationId,
    );
    if (conflictingCurrent) {
      return {
        kind: "conflict" as const,
        existingInstallationId: conflictingCurrent.installationId,
        existingAccountLogin: conflictingCurrent.accountLogin,
      };
    }

    const ownedInstallationRows = await ctx.db
      .query("githubInstallations")
      .withIndex("by_ownerTokenIdentifier_and_installationId", (q) =>
        q.eq("ownerTokenIdentifier", args.ownerTokenIdentifier).eq("installationId", args.installationId),
      )
      .order("desc")
      .take(INSTALLATION_LIFECYCLE_SCAN_LIMIT);

    const existingOwnedInstallation =
      ownedInstallationRows.find(isCurrentInstallation) ??
      ownedInstallationRows.find((installation) => installation.status === "deleted");

    const now = Date.now();
    if (existingOwnedInstallation) {
      await ctx.db.patch(existingOwnedInstallation._id, {
        installationId: args.installationId,
        accountLogin: args.accountLogin,
        accountType: args.accountType,
        repositorySelection: args.repositorySelection,
        status: "active",
        connectedAt: now,
        suspendedAt: undefined,
        deletedAt: undefined,
      });

      return {
        kind: "connected" as const,
        installationId: args.installationId,
      };
    }

    await ctx.db.insert("githubInstallations", {
      ownerTokenIdentifier: args.ownerTokenIdentifier,
      installationId: args.installationId,
      accountLogin: args.accountLogin,
      accountType: args.accountType,
      status: "active",
      repositorySelection: args.repositorySelection,
      connectedAt: now,
    });

    return {
      kind: "connected" as const,
      installationId: args.installationId,
    };
  },
});

export const markInstallationSuspended = internalMutation({
  args: {
    installationId: v.number(),
  },
  handler: async (ctx, args) => {
    const installations = await getInstallationsByInstallationIdAndStatus(ctx, args.installationId, "active");

    const now = Date.now();
    for (const installation of installations) {
      await ctx.db.patch(installation._id, {
        status: "suspended",
        suspendedAt: now,
      });
    }
  },
});

export const markInstallationDeleted = internalMutation({
  args: {
    installationId: v.number(),
  },
  handler: async (ctx, args) => {
    const installations = await getCurrentInstallationsForInstallationId(ctx, args.installationId);

    const now = Date.now();
    for (const installation of installations) {
      await ctx.db.patch(installation._id, {
        status: "deleted",
        deletedAt: now,
      });
    }
  },
});

export const markInstallationActive = internalMutation({
  args: {
    installationId: v.number(),
  },
  handler: async (ctx, args) => {
    const currentInstallations = await getCurrentInstallationsForInstallationId(ctx, args.installationId);
    const currentOwners = new Set(currentInstallations.map((installation) => installation.ownerTokenIdentifier));
    if (currentOwners.size > 1) {
      logWarn("github", "installation_unsuspend_ambiguous_current_projection", {
        installationId: args.installationId,
        currentOwnerCount: currentOwners.size,
        currentRowCount: currentInstallations.length,
      });
      return;
    }

    for (const installation of currentInstallations) {
      if (installation.status !== "suspended") {
        continue;
      }
      await ctx.db.patch(installation._id, {
        status: "active",
        suspendedAt: undefined,
      });
    }
  },
});

// ---------------------------------------------------------------------------
// Internal query: get installationId for a given owner
// ---------------------------------------------------------------------------

export const getInstallationIdForOwner = internalQuery({
  args: {
    ownerTokenIdentifier: v.string(),
  },
  handler: async (ctx, args) => {
    const installation = await ctx.db
      .query("githubInstallations")
      .withIndex("by_ownerTokenIdentifier_and_status", (q) =>
        q.eq("ownerTokenIdentifier", args.ownerTokenIdentifier).eq("status", "active"),
      )
      .first();

    if (!installation) {
      return null;
    }

    return installation.installationId;
  },
});

// ---------------------------------------------------------------------------
// Public mutation: user-initiated disconnect
// ---------------------------------------------------------------------------

export const disconnectGitHub = mutation({
  args: {},
  handler: async (ctx) => {
    const identity = await requireViewerIdentity(ctx);

    const installations = await getCurrentInstallationsForOwner(ctx, identity.tokenIdentifier);
    const now = Date.now();
    for (const installation of installations) {
      await ctx.db.patch(installation._id, {
        status: "deleted",
        deletedAt: now,
      });
    }
  },
});
