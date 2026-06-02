"use node";

import { v } from "convex/values";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { createAppJwt, getInstallationAccessToken } from "./lib/githubAppAuthNode";
import { requireViewerIdentity } from "./lib/auth";
import { repoAccessCheckResultValidator, type RepoAccessCheckResult } from "./lib/functionResultSchemas";
import { parseGitHubUrl } from "./lib/github";
import { normalizeReturnToUrl } from "./lib/returnTo";

// ---------------------------------------------------------------------------
// Installation token for owner — single front door for "give me a usable
// GitHub token for this owner". Absorbs the (lookup installation → fetch
// token) dance that every Node and V8 caller used to repeat.
// ---------------------------------------------------------------------------

/**
 * Node-runtime helper. Returns `null` when the owner has no active GitHub App
 * installation, so callers can decide whether to fail loudly (private repo
 * access required) or fall back (unauthenticated public read).
 */
export async function resolveInstallationTokenForOwner(
  ctx: ActionCtx,
  ownerTokenIdentifier: string,
): Promise<{ installationId: number; token: string } | null> {
  const installationId: number | null = await ctx.runQuery(internal.github.getInstallationIdForOwner, {
    ownerTokenIdentifier,
  });
  if (!installationId) {
    return null;
  }
  const token = await getInstallationAccessToken(installationId);
  return { installationId, token };
}

/**
 * V8-callable wrapper. V8 mutations / actions reach the Node-only token
 * fetch through `ctx.runAction(internal.githubAppNode.getInstallationTokenForOwner, ...)`.
 */
export const getInstallationTokenForOwner = internalAction({
  args: {
    ownerTokenIdentifier: v.string(),
  },
  handler: async (ctx, args) => await resolveInstallationTokenForOwner(ctx, args.ownerTokenIdentifier),
});

// ---------------------------------------------------------------------------
// Initiate GitHub App installation (public action)
// ---------------------------------------------------------------------------

/**
 * Generates a random state value, persists it for CSRF protection, and returns
 * the URL to redirect the user to GitHub's App installation page.
 *
 * The user selects which repositories the App can access on GitHub's native UI.
 * After installation, GitHub redirects back to our callback with the
 * installation_id and state.
 */
export const initiateGitHubInstall = action({
  args: {
    returnTo: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);

    const slug = process.env.GITHUB_APP_SLUG;
    if (!slug) {
      throw new Error("GITHUB_APP_SLUG is required. Set it in your Convex dashboard environment variables.");
    }

    // Generate a cryptographically random state parameter
    const stateBytes = new Uint8Array(32);
    crypto.getRandomValues(stateBytes);
    const state = Array.from(stateBytes, (b) => b.toString(16).padStart(2, "0")).join("");
    const normalizedReturnTo = args.returnTo ? normalizeReturnToUrl(args.returnTo) : undefined;

    // Store the state for later validation (10-minute expiry)
    await ctx.runMutation(internal.github.createOAuthState, {
      state,
      ownerTokenIdentifier: identity.tokenIdentifier,
      returnTo: normalizedReturnTo,
    });

    const url = `https://github.com/apps/${slug}/installations/new?state=${state}`;
    return url;
  },
});

// ---------------------------------------------------------------------------
// Public action: verify repo access before import (early permission check)
// ---------------------------------------------------------------------------

/**
 * Public action called by the frontend before `createRepositoryImport`.
 *
 * Verifies that the authenticated user's GitHub App installation can access
 * the target repository. Throws immediately with a user-friendly message
 * when access is denied so the UI can show the error *before* any import
 * records or sandbox resources are created.
 */
/**
 * Single GitHub-side probe for "can the installation read this repository?"
 *
 * Plain async function (not a Convex action) so both the user-facing
 * `verifyRepoAccess` and the internal `checkRepoAccess` can call it without
 * paying an extra `ctx.runAction` round-trip. Pure return shape — no throws —
 * so the user-facing wrapper can map it onto its throw contract while internal
 * callers consume the discriminated union directly.
 */
async function fetchRepoAccessFromGitHub(args: {
  installationId: number;
  owner: string;
  repo: string;
}): Promise<RepoAccessCheckResult> {
  const token = await getInstallationAccessToken(args.installationId);

  const response = await fetch(`https://api.github.com/repos/${args.owner}/${args.repo}`, {
    headers: {
      "Accept": "application/vnd.github.v3+json",
      "Authorization": `token ${token}`,
      "User-Agent": "systify",
    },
  });

  if (response.ok) {
    const data = (await response.json()) as {
      private: boolean;
      full_name: string;
      default_branch: string;
    };
    return {
      accessible: true,
      isPrivate: data.private,
      fullName: data.full_name,
      defaultBranch: data.default_branch,
    };
  }

  if (response.status === 404 || response.status === 403) {
    return {
      accessible: false,
      message:
        `Repository "${args.owner}/${args.repo}" is not accessible. ` +
        `Make sure it is included in your GitHub App installation. ` +
        `Go to GitHub Settings → Applications → Configure to update your repository selection.`,
    };
  }

  const body = await response.text();
  return {
    accessible: false,
    message: `GitHub API error (${response.status}): ${body}`,
  };
}

export const verifyRepoAccess = action({
  args: {
    url: v.string(),
  },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);
    const parsed = parseGitHubUrl(args.url);

    const installationId: number | null = await ctx.runQuery(internal.github.getInstallationIdForOwner, {
      ownerTokenIdentifier: identity.tokenIdentifier,
    });

    if (!installationId) {
      throw new Error("No active GitHub App installation found. Please connect your GitHub account first.");
    }

    const result = await fetchRepoAccessFromGitHub({ installationId, owner: parsed.owner, repo: parsed.repo });
    if (!result.accessible) {
      throw new Error(result.message);
    }
    return { accessible: true as const };
  },
});

// ---------------------------------------------------------------------------
// Check repo access (internal action)
// ---------------------------------------------------------------------------

/**
 * Verifies that the GitHub App installation has access to a specific repository.
 *
 * Returns { accessible: true, ... } or { accessible: false, message: "..." }.
 *
 * Used as the early-exit access probe by the import pipeline (before the
 * GitHub-API snapshot fetch) and by `ensureSandboxReady` (before any
 * sandbox-grounded reply or System Design generation provisions a Daytona
 * sandbox).
 */
export const checkRepoAccess = internalAction({
  args: {
    installationId: v.number(),
    owner: v.string(),
    repo: v.string(),
  },
  returns: repoAccessCheckResultValidator,
  handler: async (_ctx, args) => fetchRepoAccessFromGitHub(args),
});

// ---------------------------------------------------------------------------
// List accessible repos for the installation (public action)
// ---------------------------------------------------------------------------

/**
 * Lists repositories that the GitHub App installation can access.
 * Returns up to `perPage` repos (default 100). Useful for showing
 * the user which repos are currently authorised.
 */
export const listInstallationRepos = action({
  args: {},
  handler: async (ctx) => {
    const identity = await requireViewerIdentity(ctx);

    const resolved = await resolveInstallationTokenForOwner(ctx, identity.tokenIdentifier);
    if (!resolved) {
      return { repos: [], totalCount: 0 };
    }
    const { token } = resolved;

    const allRepos: Array<{
      full_name: string;
      private: boolean;
      default_branch: string;
      description: string | null;
      html_url: string;
      updated_at: string;
      owner: { avatar_url: string; login: string };
    }> = [];
    let totalCount = 0;
    let nextUrl: string | null = "https://api.github.com/installation/repositories?per_page=100";

    while (nextUrl) {
      const response: Response = await fetch(nextUrl, {
        headers: {
          "Accept": "application/vnd.github.v3+json",
          "Authorization": `token ${token}`,
          "User-Agent": "systify",
        },
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`Failed to list installation repos (${response.status}): ${body}`);
      }

      const data = (await response.json()) as {
        total_count: number;
        repositories: typeof allRepos;
      };

      totalCount = data.total_count;
      allRepos.push(...data.repositories);

      // Parse the Link header for pagination
      const linkHeader = response.headers.get("link");
      nextUrl = null;
      if (linkHeader) {
        const links = linkHeader.split(",");
        for (const link of links) {
          const match = link.match(/<([^>]+)>;\s*rel="next"/);
          if (match) {
            nextUrl = match[1];
            break;
          }
        }
      }
    }

    return {
      repos: allRepos.map((r) => ({
        fullName: r.full_name,
        isPrivate: r.private,
        defaultBranch: r.default_branch,
        description: r.description,
        htmlUrl: r.html_url,
        updatedAt: r.updated_at,
        ownerAvatarUrl: r.owner.avatar_url,
      })),
      totalCount,
    };
  },
});

// ---------------------------------------------------------------------------
// Search GitHub repositories (public action)
// ---------------------------------------------------------------------------

/**
 * Searches GitHub repositories using the GitHub Search API.
 *
 * Uses the installation access token so results include all public repos
 * plus private repos the installation has been granted access to.
 *
 * Rate limit: 30 requests/minute for the Search API. The frontend
 * debounces calls (500ms) so normal usage stays well within limits.
 */
export const searchGitHubRepos = action({
  args: { query: v.string() },
  handler: async (ctx, args) => {
    const identity = await requireViewerIdentity(ctx);

    const resolved = await resolveInstallationTokenForOwner(ctx, identity.tokenIdentifier);
    if (!resolved) {
      return { repos: [], totalCount: 0 };
    }
    const { token } = resolved;

    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(args.query)}&sort=updated&order=desc&per_page=20`;

    const response = await fetch(url, {
      headers: {
        "Accept": "application/vnd.github.v3+json",
        "Authorization": `token ${token}`,
        "User-Agent": "systify",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub search failed (${response.status}): ${body}`);
    }

    const data = (await response.json()) as {
      total_count: number;
      items: Array<{
        full_name: string;
        private: boolean;
        default_branch: string;
        description: string | null;
        html_url: string;
        updated_at: string;
        owner: { avatar_url: string; login: string };
      }>;
    };

    return {
      repos: data.items.map((r) => ({
        fullName: r.full_name,
        isPrivate: r.private,
        defaultBranch: r.default_branch,
        description: r.description,
        htmlUrl: r.html_url,
        updatedAt: r.updated_at,
        ownerAvatarUrl: r.owner.avatar_url,
      })),
      totalCount: data.total_count,
    };
  },
});

// ---------------------------------------------------------------------------
// Fetch installation details (internal action)
// ---------------------------------------------------------------------------

/**
 * Calls the GitHub API to fetch installation details (account login, type,
 * repository selection). Used by the HTTP callback after a successful install.
 */
export const fetchInstallationDetails = internalAction({
  args: {
    installationId: v.number(),
  },
  handler: async (_ctx, args) => {
    const appJwt = await createAppJwt();

    const response = await fetch(`https://api.github.com/app/installations/${args.installationId}`, {
      headers: {
        "Accept": "application/vnd.github.v3+json",
        "Authorization": `Bearer ${appJwt}`,
        "User-Agent": "systify",
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to fetch installation details (${response.status}): ${body}`);
    }

    const data = (await response.json()) as {
      account: {
        login: string;
        type: string;
      };
      repository_selection: string;
    };

    return {
      accountLogin: data.account.login,
      accountType: data.account.type as "User" | "Organization",
      repositorySelection: data.repository_selection as "all" | "selected",
    };
  },
});
