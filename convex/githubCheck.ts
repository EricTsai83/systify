import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery } from "./_generated/server";
import { consumeGitHubRemoteUpdateRateLimit } from "./lib/rateLimit";

// ---------------------------------------------------------------------------
// Public action — called by the frontend on visibility-change / repo-switch
// ---------------------------------------------------------------------------

/**
 * Lightweight check: hits the GitHub Git refs endpoint (~200 bytes response)
 * to see if the remote default branch has moved since our last sync.
 *
 * Stores the result on the repository doc so the reactive subscription
 * automatically pushes `hasRemoteUpdates` to every connected client.
 */
export const checkForUpdates = action({
  args: {
    repositoryId: v.id("repositories"),
  },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not authenticated.");

    const repo: RepoForCheck | null = await ctx.runMutation(internal.githubCheck.reserveRemoteUpdateCheck, {
      repositoryId: args.repositoryId,
      ownerTokenIdentifier: identity.tokenIdentifier,
    });
    if (!repo) return;

    // Always use authenticated GitHub API (5,000 req/hr per user) when
    // possible, regardless of whether the repo is public or private.
    let githubToken: string | undefined;
    try {
      const resolved = await ctx.runAction(internal.githubAppNode.getInstallationTokenForOwner, {
        ownerTokenIdentifier: repo.ownerTokenIdentifier,
      });
      githubToken = resolved?.token;
    } catch (error) {
      // Non-fatal — fall back to unauthenticated (60 req/hr).
      console.warn("[github-check] Failed to get GitHub token:", error instanceof Error ? error.message : error);
    }

    if (!repo.defaultBranch) return;
    const sha = await fetchLatestRemoteSha(repo.owner, repo.repo, repo.defaultBranch, githubToken);
    if (!sha) return;

    await ctx.runMutation(internal.githubCheck.updateRemoteSha, {
      repositoryId: args.repositoryId,
      latestRemoteSha: sha,
    });
  },
});

// ---------------------------------------------------------------------------
// Internal helpers (query + mutation) — not exposed to clients
// ---------------------------------------------------------------------------

type RepoForCheck = {
  owner: string;
  repo: string;
  defaultBranch: string | null;
  lastSyncedCommitSha: string | null;
  lastCheckedForUpdatesAt: number | null;
  importStatus: string;
  deletionRequestedAt: number | null;
  archivedAt: number | null;
  ownerTokenIdentifier: string;
  accessMode: "public" | "private";
};

export const getRepoForCheck = internalQuery({
  args: { repositoryId: v.id("repositories") },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) return null;
    return {
      owner: repo.sourceRepoOwner,
      repo: repo.sourceRepoName,
      defaultBranch: repo.defaultBranch ?? null,
      lastSyncedCommitSha: repo.lastSyncedCommitSha ?? null,
      lastCheckedForUpdatesAt: repo.lastCheckedForUpdatesAt ?? null,
      importStatus: repo.importStatus,
      deletionRequestedAt: repo.deletionRequestedAt ?? null,
      archivedAt: repo.archivedAt ?? null,
      ownerTokenIdentifier: repo.ownerTokenIdentifier,
      accessMode: repo.accessMode,
    };
  },
});

export const reserveRemoteUpdateCheck = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    ownerTokenIdentifier: v.string(),
  },
  handler: async (ctx, args): Promise<RepoForCheck | null> => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) return null;

    if (args.ownerTokenIdentifier !== repo.ownerTokenIdentifier) {
      throw new Error("Not authorized to check this repository.");
    }

    if (!repo.lastSyncedCommitSha || !repo.defaultBranch) return null;
    if (repo.deletionRequestedAt) return null;
    if (repo.archivedAt) return null;
    if (repo.importStatus === "queued" || repo.importStatus === "running") return null;

    const now = Date.now();
    if (repo.lastCheckedForUpdatesAt && now - repo.lastCheckedForUpdatesAt < 60_000) {
      return null;
    }

    await consumeGitHubRemoteUpdateRateLimit(ctx, repo.ownerTokenIdentifier);
    await ctx.db.patch(args.repositoryId, {
      lastCheckedForUpdatesAt: now,
    });

    return {
      owner: repo.sourceRepoOwner,
      repo: repo.sourceRepoName,
      defaultBranch: repo.defaultBranch ?? null,
      lastSyncedCommitSha: repo.lastSyncedCommitSha ?? null,
      lastCheckedForUpdatesAt: now,
      importStatus: repo.importStatus,
      deletionRequestedAt: repo.deletionRequestedAt ?? null,
      archivedAt: repo.archivedAt ?? null,
      ownerTokenIdentifier: repo.ownerTokenIdentifier,
      accessMode: repo.accessMode,
    };
  },
});

export const updateRemoteSha = internalMutation({
  args: {
    repositoryId: v.id("repositories"),
    latestRemoteSha: v.string(),
  },
  handler: async (ctx, args) => {
    const repo = await ctx.db.get(args.repositoryId);
    if (!repo) return;
    await ctx.db.patch(args.repositoryId, {
      latestRemoteSha: args.latestRemoteSha,
      lastCheckedForUpdatesAt: Date.now(),
    });
  },
});

// ---------------------------------------------------------------------------
// GitHub API helper
// ---------------------------------------------------------------------------

/**
 * Fetches the latest commit SHA for a branch using the Git refs endpoint.
 * Uses authentication token if provided (5000 req/hour) for private repos,
 * falls back to 60 req/hour for public repos without token.
 */
async function fetchLatestRemoteSha(
  owner: string,
  repo: string,
  branch: string,
  token?: string,
): Promise<string | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/git/ref/heads/${branch}`;

  try {
    const headers: HeadersInit = {
      "Accept": "application/vnd.github.v3+json",
      "User-Agent": "systify",
    };

    if (token) {
      headers.Authorization = `token ${token}`;
    }

    const response = await fetch(url, { headers });

    if (!response.ok) {
      console.warn(`[github-check] ${owner}/${repo}#${branch}: ${response.status} ${response.statusText}`);
      return null;
    }

    const data = (await response.json()) as { object?: { sha?: string } };
    return data.object?.sha ?? null;
  } catch (error) {
    console.warn("[github-check] Network error:", error instanceof Error ? error.message : error);
    return null;
  }
}
