"use node";

import { createPrivateKey, sign, type KeyObject } from "node:crypto";

type GitHubAppCredentials = {
  appId: string;
  privateKey: KeyObject;
};

let cachedGitHubAppCredentials: GitHubAppCredentials | null = null;

/**
 * Creates a short-lived RS256 JWT for authenticating as the GitHub App.
 *
 * The JWT is valid for 10 minutes (GitHub's maximum). It is used to call
 * the GitHub API as the App itself (e.g. to create installation access tokens).
 *
 * Requires env vars: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY (raw PEM).
 */
export function createAppJwt(): string {
  const { appId, privateKey } = getGitHubAppCredentials();
  const now = Math.floor(Date.now() / 1000);

  const encodedHeader = base64UrlEncodeJson({ alg: "RS256", typ: "JWT" });
  const encodedPayload = base64UrlEncodeJson({
    iat: now - 60,
    exp: now + 10 * 60,
    iss: appId,
  });
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");

  return `${signingInput}.${signature}`;
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
      `GITHUB_APP_PRIVATE_KEY is not a valid PEM private key: ${
        error instanceof Error ? error.message : "Unknown error."
      }`,
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

function base64UrlEncodeJson(value: Record<string, string | number>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

/**
 * Requests an installation access token from GitHub. These tokens are valid
 * for 1 hour and can be used to read/write resources that the installation
 * has been granted access to.
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
