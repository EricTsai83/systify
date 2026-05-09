import { v } from "convex/values";
import { internal } from "./_generated/api";
import { action, internalMutation, internalQuery } from "./_generated/server";

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

    // Fetch the repo record to get owner/repo/branch
    const repo: RepoForCheck | null = await ctx.runQuery(internal.githubCheck.getRepoForCheck, {
      repositoryId: args.repositoryId,
    });
    if (!repo) return;

    // Verify ownership: caller must own this repo
    if (identity.tokenIdentifier !== repo.ownerTokenIdentifier) {
      throw new Error("Not authorized to check this repository.");
    }

    // Must have been synced at least once, must not be mid-sync, archived, or deleting
    if (!repo.lastSyncedCommitSha || !repo.defaultBranch) return;
    if (repo.deletionRequestedAt) return;
    if (repo.archivedAt) return;
    if (repo.importStatus === "queued" || repo.importStatus === "running") return;

    // Throttle: skip if we checked within the last 60 seconds
    if (repo.lastCheckedForUpdatesAt && Date.now() - repo.lastCheckedForUpdatesAt < 60_000) {
      return;
    }

    // Always use authenticated GitHub API (5,000 req/hr per user) when
    // possible, regardless of whether the repo is public or private.
    let githubToken: string | undefined;
    const installationId = await ctx.runQuery(internal.github.getInstallationIdForOwner, {
      ownerTokenIdentifier: repo.ownerTokenIdentifier,
    });

    if (installationId) {
      try {
        githubToken = await ctx.runAction(internal.githubAppNode.getInstallationToken, {
          installationId,
        });
      } catch (error) {
        // Non-fatal — fall back to unauthenticated (60 req/hr).
        console.warn("[github-check] Failed to get GitHub token:", error instanceof Error ? error.message : error);
      }
    }

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
