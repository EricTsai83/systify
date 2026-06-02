"use node";

import { getInstallationAccessToken } from "./lib/githubAppAuthNode";
import { createRepoFileRecords, shouldReadFile, type RepositorySnapshot } from "./lib/repoAnalysis";
import { MAX_LISTED_FILES } from "./lib/constants";
import { logWarn } from "./lib/observability";

const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "systify";

const IGNORED_PATH_PREFIXES = [".git/", "node_modules/", "dist/", "build/", ".next/", ".turbo/"] as const;

const MANIFEST_PATHS = ["package.json", "pyproject.toml", "Cargo.toml"] as const;

const MAX_BLOB_FETCH_BYTES = 1_000_000;
const IMPORTANT_FILE_FETCH_LIMIT = 12;
const MAX_FILE_CONTENT_CHARS = 20_000;

const RETRYABLE_STATUS_CODES = new Set([429, 500, 502, 503, 504]);
const REQUEST_MAX_ATTEMPTS = 3;
const REQUEST_BASE_BACKOFF_MS = 500;

export type GitHubRepoMetadata = {
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
};

export type FetchedRepositorySnapshot = {
  snapshot: RepositorySnapshot;
  commitSha: string;
  branch: string;
  metadata: GitHubRepoMetadata;
};

type RawTreeEntry = {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size?: number;
};

/**
 * Builds a `RepositorySnapshot` for an import without provisioning a sandbox.
 *
 * The pipeline issues three GitHub API calls (repo metadata, branch head,
 * full recursive tree) plus a bounded fan-out of blob reads for README,
 * package manifests, and the heuristic "important" files. Returns the
 * `RepositorySnapshot` shape that every downstream consumer
 * (`buildRepositoryManifest`, `createChunkRecords`, the System Design
 * heuristics) reads from.
 *
 * Failure semantics:
 *   - Metadata / branch head / tree fetches throw on error — these are the
 *     load-bearing reads, and a partial snapshot here is worse than a clean
 *     failure with a Reference ID.
 *   - Per-blob content fetches are best-effort; a transient 404/500 on one
 *     file just drops that file's content from the snapshot so the rest of
 *     the import can still publish.
 */
export async function fetchRepositorySnapshot(args: {
  installationId: number;
  owner: string;
  repo: string;
  preferredBranch?: string;
}): Promise<FetchedRepositorySnapshot> {
  const token = await getInstallationAccessToken(args.installationId);

  const metadata = await fetchRepoMetadata(token, args.owner, args.repo);
  const branch = args.preferredBranch?.trim() || metadata.defaultBranch;

  const { commitSha, treeSha } = await fetchBranchHead(token, args.owner, args.repo, branch);

  const tree = await fetchTree(token, args.owner, args.repo, treeSha);
  const filtered = filterTree(tree);

  const blobByPath = new Map<string, { sha: string; size?: number }>();
  for (const entry of filtered) {
    if (entry.type === "blob") {
      blobByPath.set(entry.path, { sha: entry.sha, size: entry.size });
    }
  }

  const fileNodes = createRepoFileRecords(
    filtered
      .filter((entry) => entry.type === "blob" || entry.type === "tree")
      .map((entry) => ({
        path: entry.path,
        fileType: entry.type === "blob" ? "file" : "dir",
        sizeBytes: entry.size ?? 0,
      })),
  );

  const readmePath = fileNodes.find(
    (file) => file.fileType === "file" && /(^|\/)readme(\.[^.]+)?$/i.test(file.path),
  )?.path;

  // Heuristic "files worth chunking" — same selection rule the sandbox path
  // used (`shouldReadFile`), capped to keep blob fetches predictable.
  const importantPaths = fileNodes
    .filter((file) => file.fileType === "file" && shouldReadFile(file.path))
    .sort((left, right) => Number(right.path.includes("README")) - Number(left.path.includes("README")))
    .map((file) => file.path)
    .slice(0, IMPORTANT_FILE_FETCH_LIMIT);

  // README + manifests + important files, deduplicated. Manifests come from a
  // fixed allowlist but only fetch when they actually live in the tree, so a
  // repo without `pyproject.toml` skips that request entirely.
  const contentPaths = new Set<string>();
  if (readmePath) contentPaths.add(readmePath);
  for (const path of importantPaths) contentPaths.add(path);
  for (const path of MANIFEST_PATHS) {
    if (blobByPath.has(path)) contentPaths.add(path);
  }

  const contentEntries = await Promise.all(
    Array.from(contentPaths).map(async (path) => {
      const blob = blobByPath.get(path);
      if (!blob) return null;
      if (blob.size !== undefined && blob.size > MAX_BLOB_FETCH_BYTES) {
        logWarn("github_repo_fetcher", "blob_skipped_oversize", {
          owner: args.owner,
          repo: args.repo,
          path,
          sizeBytes: blob.size,
        });
        return null;
      }
      try {
        const content = await fetchBlobContent(token, args.owner, args.repo, blob.sha);
        return { path, content };
      } catch (error) {
        logWarn("github_repo_fetcher", "blob_fetch_failed", {
          owner: args.owner,
          repo: args.repo,
          path,
          message: error instanceof Error ? error.message : String(error),
        });
        return null;
      }
    }),
  );

  const contentByPath = new Map<string, string>();
  for (const entry of contentEntries) {
    if (entry) contentByPath.set(entry.path, entry.content);
  }

  const importantFileContents = importantPaths
    .map((path) => {
      const content = contentByPath.get(path);
      return content !== undefined ? { path, content } : null;
    })
    .filter((entry): entry is { path: string; content: string } => entry !== null);

  const snapshot: RepositorySnapshot = {
    readmePath,
    readmeContent: readmePath ? contentByPath.get(readmePath) : undefined,
    packageJsonContent: contentByPath.get("package.json"),
    pyprojectContent: contentByPath.get("pyproject.toml"),
    cargoTomlContent: contentByPath.get("Cargo.toml"),
    importantFileContents,
    files: fileNodes,
  };

  return {
    snapshot,
    commitSha,
    branch,
    metadata,
  };
}

async function fetchRepoMetadata(token: string, owner: string, repo: string): Promise<GitHubRepoMetadata> {
  const data = await githubGet<{
    full_name: string;
    default_branch: string;
    private: boolean;
  }>(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`);
  return {
    fullName: data.full_name,
    defaultBranch: data.default_branch,
    isPrivate: data.private,
  };
}

async function fetchBranchHead(
  token: string,
  owner: string,
  repo: string,
  branch: string,
): Promise<{ commitSha: string; treeSha: string }> {
  // `/commits/{ref}` accepts a branch / tag / SHA and returns the head commit
  // along with its tree SHA — one round trip instead of `git/ref` + `commits`.
  const data = await githubGet<{
    sha: string;
    commit: { tree: { sha: string } };
  }>(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(branch)}`);
  return { commitSha: data.sha, treeSha: data.commit.tree.sha };
}

async function fetchTree(token: string, owner: string, repo: string, treeSha: string): Promise<RawTreeEntry[]> {
  const data = await githubGet<{
    tree: RawTreeEntry[];
    truncated: boolean;
  }>(
    token,
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
  );
  if (data.truncated) {
    // GitHub returns truncated:true when the tree has >100k entries or the
    // response would exceed 7MB. We surface the warning so operators can spot
    // it in logs, but proceed with the partial tree — the import is best-
    // effort for very large monorepos.
    logWarn("github_repo_fetcher", "tree_truncated", {
      owner,
      repo,
      treeSha,
      treeSize: data.tree.length,
    });
  }
  return data.tree;
}

async function fetchBlobContent(token: string, owner: string, repo: string, sha: string): Promise<string> {
  const data = await githubGet<{
    content: string;
    encoding: "base64" | "utf-8";
  }>(token, `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(sha)}`);
  const decoded = data.encoding === "base64" ? Buffer.from(data.content, "base64").toString("utf8") : data.content;
  return decoded.slice(0, MAX_FILE_CONTENT_CHARS);
}

function filterTree(tree: RawTreeEntry[]): RawTreeEntry[] {
  const filtered: RawTreeEntry[] = [];
  for (const entry of tree) {
    if (filtered.length >= MAX_LISTED_FILES) break;
    if (entry.type === "commit") continue;
    if (isIgnoredPath(entry.path)) continue;
    filtered.push(entry);
  }
  return filtered;
}

function isIgnoredPath(path: string): boolean {
  for (const prefix of IGNORED_PATH_PREFIXES) {
    const exactDir = prefix.slice(0, -1);
    if (path === exactDir) return true;
    if (path.startsWith(prefix)) return true;
  }
  return false;
}

async function githubGet<T>(token: string, path: string): Promise<T> {
  const url = `${GITHUB_API_BASE}${path}`;

  let lastError: Error | null = null;
  for (let attempt = 1; attempt <= REQUEST_MAX_ATTEMPTS; attempt += 1) {
    const response = await fetch(url, {
      headers: {
        "Accept": "application/vnd.github.v3+json",
        "Authorization": `token ${token}`,
        "User-Agent": USER_AGENT,
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
      },
    });

    if (response.ok) {
      return (await response.json()) as T;
    }

    const body = await response.text().catch(() => "");
    const truncatedBody = body.slice(0, 500);
    const error = new Error(`GitHub API GET ${path} failed (${response.status}): ${truncatedBody}`);
    lastError = error;

    if (attempt >= REQUEST_MAX_ATTEMPTS || !RETRYABLE_STATUS_CODES.has(response.status)) {
      throw error;
    }

    const retryAfterHeader = response.headers.get("retry-after");
    const retryAfterMs = retryAfterHeader ? Number.parseInt(retryAfterHeader, 10) * 1000 : 0;
    const backoffMs = Math.max(
      Number.isFinite(retryAfterMs) ? retryAfterMs : 0,
      REQUEST_BASE_BACKOFF_MS * 2 ** (attempt - 1),
    );
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
  }

  // Defensive — loop always either returns or throws inside the body.
  throw lastError ?? new Error(`GitHub API GET ${path} exhausted retries.`);
}
