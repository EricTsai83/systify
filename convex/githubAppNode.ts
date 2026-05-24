"use node";

import { v } from "convex/values";
import jwt from "jsonwebtoken";
import { createPrivateKey, type KeyObject } from "node:crypto";
import { action, internalAction } from "./_generated/server";
import { internal } from "./_generated/api";
import { requireViewerIdentity } from "./lib/auth";
import { parseGitHubUrl } from "./lib/github";
import { normalizeReturnToUrl } from "./lib/returnTo";

// ---------------------------------------------------------------------------
// GitHub App JWT helper
// ---------------------------------------------------------------------------

/**
 * Creates a short-lived RS256 JWT for authenticating as the GitHub App.
 *
 * The JWT is valid for 10 minutes (GitHub's maximum). It is used to call
 * the GitHub API as the App itself (e.g. to create installation access tokens).
 *
 * Requires env vars: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY (raw PEM).
 */
type GitHubAppCredentials = {
  appId: string;
  privateKey: KeyObject;
};

let cachedGitHubAppCredentials: GitHubAppCredentials | null = null;

function createAppJwt(): string {
  const { appId, privateKey } = getGitHubAppCredentials();
  const now = Math.floor(Date.now() / 1000);

  return jwt.sign(
    {
      iat: now - 60, // issued 60s in the past to allow clock drift
      exp: now + 10 * 60, // expires in 10 minutes
      iss: appId,
    },
    privateKey,
    { algorithm: "RS256" },
  );
}

function getGitHubAppCredentials(): GitHubAppCredentials {
  if (cachedGitHubAppCredentials) {
    return cachedGitHubAppCredentials;
  }

  const appId = process.env.GITHUB_APP_ID?.trim();
  const configuredPrivateKey = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!appId) {
    throw new Error("GITHUB_APP_ID is required. Set it in your Convex dashboard environment variables.");
  }
  if (!configuredPrivateKey?.trim()) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY is required. Set it as the raw PEM private key in your Convex dashboard environment variables.",
    );
  }

  const privateKeyPem = normalizePem(configuredPrivateKey);
  if (!looksLikePemPrivateKey(privateKeyPem)) {
    throw new Error(
      "GITHUB_APP_PRIVATE_KEY must be the raw PEM private key, including the BEGIN/END PRIVATE KEY lines.",
    );
  }
  let privateKey: KeyObject;

  try {
    privateKey = createPrivateKey({
      key: privateKeyPem,
      format: "pem",
    });
  } catch (error) {
    throw new Error(
      `GITHUB_APP_PRIVATE_KEY is not a valid PEM private key: ${error instanceof Error ? error.message : "Unknown error."}`,
    );
  }

  cachedGitHubAppCredentials = {
    appId,
    privateKey,
  };

  return cachedGitHubAppCredentials;
}

function normalizePem(value: string): string {
  return value.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
}

function looksLikePemPrivateKey(value: string): boolean {
  return /^-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/.test(value);
}

// ---------------------------------------------------------------------------
// Installation access token helper
// ---------------------------------------------------------------------------

/**
 * Requests an installation access token from GitHub. These tokens are valid
 * for 1 hour and can be used to read/write resources that the installation
 * has been granted access to.
 *
 * This is a plain async function so callers in the same Node runtime can
 * call it directly (avoiding an unnecessary ctx.runAction round-trip).
 */
export async function getInstallationAccessToken(installationId: number): Promise<string> {
  const appJwt = createAppJwt();

  const response = await fetch(`https://api.github.com/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    headers: {
      "Accept": "application/vnd.github.v3+json",
      "Authorization": `Bearer ${appJwt}`,
      "User-Agent": "systify",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Failed to get installation access token (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { token: string };
  return data.token;
}

// ---------------------------------------------------------------------------
// Internal action: cross-runtime wrapper for getInstallationAccessToken
// ---------------------------------------------------------------------------

/**
 * Wrapper action so V8-runtime modules (e.g. githubCheck.ts) can obtain an
 * installation token via ctx.runAction.
 */
export const getInstallationToken = internalAction({
  args: {
    installationId: v.number(),
  },
  handler: async (_ctx, args) => {
    return await getInstallationAccessToken(args.installationId);
  },
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
}): Promise<
  | { accessible: true; isPrivate: boolean; fullName: string; defaultBranch: string }
  | { accessible: false; message: string }
> {
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
 * GitHub-API snapshot fetch) and by `ensureSandboxReady` (before any Lab /
 * System Design provisions a Daytona sandbox).
 */
export const checkRepoAccess = internalAction({
  args: {
    installationId: v.number(),
    owner: v.string(),
    repo: v.string(),
  },
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

    const installationId: number | null = await ctx.runQuery(internal.github.getInstallationIdForOwner, {
      ownerTokenIdentifier: identity.tokenIdentifier,
    });

    if (!installationId) {
      return { repos: [], totalCount: 0 };
    }

    const token = await getInstallationAccessToken(installationId);

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

    const installationId: number | null = await ctx.runQuery(internal.github.getInstallationIdForOwner, {
      ownerTokenIdentifier: identity.tokenIdentifier,
    });

    if (!installationId) {
      return { repos: [], totalCount: 0 };
    }

    const token = await getInstallationAccessToken(installationId);

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
    const appJwt = createAppJwt();

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
