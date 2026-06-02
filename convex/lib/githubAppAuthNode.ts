type GitHubAppCredentials = {
  appId: string;
  privateKeyPem: string;
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
export async function createAppJwt(): Promise<string> {
  const { appId, privateKeyPem } = getGitHubAppCredentials();
  const now = Math.floor(Date.now() / 1000);

  const encodedHeader = base64UrlEncodeJson({ alg: "RS256", typ: "JWT" });
  const encodedPayload = base64UrlEncodeJson({
    iat: now - 60,
    exp: now + 10 * 60,
    iss: appId,
  });
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const privateKey = await importPrivateKey(privateKeyPem);
  const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, new TextEncoder().encode(signingInput));

  return `${signingInput}.${base64UrlEncodeBytes(new Uint8Array(signature))}`;
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

  cachedGitHubAppCredentials = {
    appId,
    privateKeyPem,
  };

  return cachedGitHubAppCredentials;
}

function normalizePem(value: string): string {
  return value.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
}

function looksLikePemPrivateKey(value: string): boolean {
  return /^-----BEGIN (RSA )?PRIVATE KEY-----/.test(value);
}

function base64UrlEncodeJson(value: Record<string, string | number>): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function pemToPrivateKeyDer(pem: string): ArrayBuffer {
  const label = pem.startsWith("-----BEGIN RSA PRIVATE KEY-----") ? "RSA PRIVATE KEY" : "PRIVATE KEY";
  const base64 = pem.replace(`-----BEGIN ${label}-----`, "").replace(`-----END ${label}-----`, "").replace(/\s/g, "");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  if (label === "PRIVATE KEY") {
    return toArrayBuffer(bytes);
  }
  return wrapPkcs1RsaPrivateKeyAsPkcs8(bytes);
}

async function importPrivateKey(privateKeyPem: string): Promise<CryptoKey> {
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      pemToPrivateKeyDer(privateKeyPem),
      {
        name: "RSASSA-PKCS1-v1_5",
        hash: "SHA-256",
      },
      false,
      ["sign"],
    );
  } catch (error) {
    throw new Error(
      `GITHUB_APP_PRIVATE_KEY is not a valid PEM private key: ${
        error instanceof Error ? error.message : "Unknown error."
      }`,
    );
  }
}

function wrapPkcs1RsaPrivateKeyAsPkcs8(pkcs1Der: Uint8Array): ArrayBuffer {
  const version = Uint8Array.from([0x02, 0x01, 0x00]);
  const rsaEncryptionAlgorithmIdentifier = Uint8Array.from([
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00,
  ]);
  const privateKey = derWrap(0x04, pkcs1Der);
  return toArrayBuffer(derWrap(0x30, concatBytes([version, rsaEncryptionAlgorithmIdentifier, privateKey])));
}

function derWrap(tag: number, value: Uint8Array): Uint8Array {
  return concatBytes([Uint8Array.from([tag, ...encodeDerLength(value.length)]), value]);
}

function encodeDerLength(length: number): number[] {
  if (length < 0x80) {
    return [length];
  }

  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

function concatBytes(chunks: Uint8Array[]): Uint8Array {
  const totalLength = chunks.reduce((total, chunk) => total + chunk.length, 0);
  const bytes = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

/**
 * Requests an installation access token from GitHub. These tokens are valid
 * for 1 hour and can be used to read/write resources that the installation
 * has been granted access to.
 */
export async function getInstallationAccessToken(installationId: number): Promise<string> {
  const appJwt = await createAppJwt();

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
