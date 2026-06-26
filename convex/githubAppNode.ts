"use node";

import { v } from "convex/values";
import { action, internalAction, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import { createAppJwt, getInstallationAccessToken } from "./lib/githubAppAuthNode";
import { requireViewerIdentity } from "./lib/auth";
import { assertFeatureAccess } from "./lib/entitlements";
import { repoAccessCheckResultValidator, type RepoAccessCheckResult } from "./lib/functionResultSchemas";
import { parseGitHubUrl } from "./lib/github";
import { normalizeReturnToUrl } from "./lib/returnTo";

const GITHUB_INSTALLATION_REPOS_PAGE_LIMIT = 5;
const GITHUB_USER_INSTALLATIONS_PAGE_LIMIT = 10;
const GITHUB_REPO_SEARCH_QUERY_MAX_LENGTH = 256;
const GITHUB_AUTH_FETCH_TIMEOUT_MS = 10_000;

const installationUserVerificationResultValidator = v.union(
  v.object({ kind: v.literal("verified") }),
  v.object({ kind: v.literal("unauthorized"), message: v.string() }),
);

type GitHubAppOAuthCredentials = {
  clientId: string;
  clientSecret: string;
};

type GitHubUserAccessTokenResult =
  | {
      kind: "token";
      token: string;
    }
  | {
      kind: "oauth_error";
      message: string;
    };

function getGitHubAppOAuthCredentials(): GitHubAppOAuthCredentials {
  const clientId = process.env.GITHUB_APP_CLIENT_ID?.trim();
  const clientSecret = process.env.GITHUB_APP_CLIENT_SECRET?.trim();

  if (!clientId) {
    throw new Error("GITHUB_APP_CLIENT_ID is required. Set it in your Convex dashboard environment variables.");
  }
  if (!clientSecret) {
    throw new Error("GITHUB_APP_CLIENT_SECRET is required. Set it in your Convex dashboard environment variables.");
  }

  return { clientId, clientSecret };
}

function randomHex(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

async function createPkceCodeChallenge(codeVerifier: string): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return base64UrlEncodeBytes(new Uint8Array(hash));
}

function getNextLinkUrl(linkHeader: string | null): string | null {
  if (!linkHeader) {
    return null;
  }

  const links = linkHeader.split(",");
  for (const link of links) {
    const match = link.match(/<([^>]+)>;\s*rel="next"/);
    if (match) {
      return match[1] ?? null;
    }
  }

  return null;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMessage: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_AUTH_FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(timeoutMessage);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function exchangeGitHubAppUserCode(args: {
  code: string;
  codeVerifier?: string;
  redirectUri: string;
}): Promise<GitHubUserAccessTokenResult> {
  const { clientId, clientSecret } = getGitHubAppOAuthCredentials();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: args.code,
    redirect_uri: args.redirectUri,
  });

  if (args.codeVerifier) {
    body.set("code_verifier", args.codeVerifier);
  }

  const response = await fetchWithTimeout(
    "https://github.com/login/oauth/access_token",
    {
      method: "POST",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "systify",
      },
      body,
    },
    "GitHub user authorization token exchange timed out.",
  );

  const responseBody = await response.text();
  if (!response.ok) {
    throw new Error(`Failed to exchange GitHub user authorization code (${response.status}): ${responseBody}`);
  }

  const data = JSON.parse(responseBody) as {
    access_token?: unknown;
    error?: unknown;
    error_description?: unknown;
  };

  if (typeof data.error === "string") {
    return {
      kind: "oauth_error",
      message: typeof data.error_description === "string" ? data.error_description : data.error,
    };
  }

  if (typeof data.access_token !== "string" || data.access_token.length === 0) {
    return {
      kind: "oauth_error",
      message: "GitHub did not return a user access token.",
    };
  }

  return {
    kind: "token",
    token: data.access_token,
  };
}

async function gitHubUserCanAccessInstallation(userAccessToken: string, installationId: number): Promise<boolean> {
  let nextUrl: string | null = "https://api.github.com/user/installations?per_page=100";
  let pagesRead = 0;

  while (nextUrl && pagesRead < GITHUB_USER_INSTALLATIONS_PAGE_LIMIT) {
    pagesRead += 1;
    const response: Response = await fetchWithTimeout(
      nextUrl,
      {
        headers: {
          "Accept": "application/vnd.github.v3+json",
          "Authorization": `Bearer ${userAccessToken}`,
          "User-Agent": "systify",
        },
      },
      "GitHub installation verification timed out.",
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Failed to list GitHub installations accessible to user (${response.status}): ${body}`);
    }

    const data = (await response.json()) as {
      installations: Array<{ id: number }>;
    };

    if (data.installations.some((installation) => installation.id === installationId)) {
      return true;
    }

    nextUrl = getNextLinkUrl(response.headers.get("link"));
  }

  return false;
}

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
    await assertFeatureAccess(ctx, identity, "repoImport");

    const slug = process.env.GITHUB_APP_SLUG;
    if (!slug) {
      throw new Error("GITHUB_APP_SLUG is required. Set it in your Convex dashboard environment variables.");
    }
    getGitHubAppOAuthCredentials();

    await ctx.runMutation(internal.lib.rateLimit.consumeGitHubInstallInitiation, {
      ownerTokenIdentifier: identity.tokenIdentifier,
    });

    // Generate a CSRF state and PKCE verifier for the post-install user
    // authorization step that proves the GitHub user can see the installation.
    const state = randomHex(32);
    const githubCodeVerifier = randomHex(32);
    const githubCodeChallenge = await createPkceCodeChallenge(githubCodeVerifier);
    const normalizedReturnTo = args.returnTo ? normalizeReturnToUrl(args.returnTo) : undefined;

    // Store the state for later validation (10-minute expiry)
    await ctx.runMutation(internal.github.createOAuthState, {
      state,
      ownerTokenIdentifier: identity.tokenIdentifier,
      returnTo: normalizedReturnTo,
      githubCodeVerifier,
      githubCodeChallenge,
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
    await assertFeatureAccess(ctx, identity, "repoImport");
    const parsed = parseGitHubUrl(args.url);

    await ctx.runMutation(internal.lib.rateLimit.consumeGitHubRepoAccessCheck, {
      ownerTokenIdentifier: identity.tokenIdentifier,
    });

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
 * sandbox-grounded reply or Design Docs generation provisions a Daytona
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

export const verifyInstallationAccessWithGitHubUser = internalAction({
  args: {
    code: v.string(),
    codeVerifier: v.optional(v.string()),
    redirectUri: v.string(),
    installationId: v.number(),
  },
  returns: installationUserVerificationResultValidator,
  handler: async (_ctx, args) => {
    const tokenResult = await exchangeGitHubAppUserCode({
      code: args.code,
      codeVerifier: args.codeVerifier,
      redirectUri: args.redirectUri,
    });

    if (tokenResult.kind === "oauth_error") {
      return {
        kind: "unauthorized" as const,
        message: tokenResult.message,
      };
    }

    const canAccessInstallation = await gitHubUserCanAccessInstallation(tokenResult.token, args.installationId);
    if (!canAccessInstallation) {
      return {
        kind: "unauthorized" as const,
        message: "The authenticated GitHub user cannot access this GitHub App installation.",
      };
    }

    return { kind: "verified" as const };
  },
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
    await assertFeatureAccess(ctx, identity, "repoImport");

    await ctx.runMutation(internal.lib.rateLimit.consumeGitHubRepoList, {
      ownerTokenIdentifier: identity.tokenIdentifier,
    });

    const resolved = await resolveInstallationTokenForOwner(ctx, identity.tokenIdentifier);
    if (!resolved) {
      return { repos: [], totalCount: 0, hasMore: false };
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
    let pagesRead = 0;

    while (nextUrl && pagesRead < GITHUB_INSTALLATION_REPOS_PAGE_LIMIT) {
      pagesRead += 1;
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
      hasMore: nextUrl !== null,
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
    await assertFeatureAccess(ctx, identity, "repoImport");
    const query = args.query.trim();
    if (query.length < 2) {
      return { repos: [], totalCount: 0 };
    }
    if (query.length > GITHUB_REPO_SEARCH_QUERY_MAX_LENGTH) {
      throw new Error(`GitHub search query must be ${GITHUB_REPO_SEARCH_QUERY_MAX_LENGTH} characters or fewer.`);
    }

    await ctx.runMutation(internal.lib.rateLimit.consumeGitHubRepoSearch, {
      ownerTokenIdentifier: identity.tokenIdentifier,
    });

    const resolved = await resolveInstallationTokenForOwner(ctx, identity.tokenIdentifier);
    if (!resolved) {
      return { repos: [], totalCount: 0 };
    }
    const { token } = resolved;

    const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&sort=updated&order=desc&per_page=20`;

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
