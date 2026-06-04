const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);

export type ParsedGitHubUrl = {
  normalizedUrl: string;
  owner: string;
  repo: string;
  fullName: string;
  branch?: string;
};

export function parseGitHubUrl(input: string): ParsedGitHubUrl {
  const trimmed = input.trim();
  const sshMatch = /^git@github\.com:(.+?)\/(.+?)(?:\.git)?$/i.exec(trimmed);

  if (sshMatch) {
    const owner = sshMatch[1];
    const repo = sanitizeRepoName(sshMatch[2]);
    return {
      normalizedUrl: `https://github.com/${owner}/${repo}`,
      owner,
      repo,
      fullName: `${owner}/${repo}`,
    };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("Please enter a valid GitHub repository URL.");
  }

  if (!GITHUB_HOSTS.has(url.hostname)) {
    throw new Error("Only github.com repositories are supported in this MVP.");
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new Error("Please enter a repository URL like https://github.com/owner/repo.");
  }

  const owner = segments[0];
  const repo = sanitizeRepoName(segments[1]);
  const branch = segments[2] === "tree" && segments.length === 4 ? segments[3] : undefined;

  return {
    normalizedUrl: `https://github.com/${owner}/${repo}`,
    owner,
    repo,
    fullName: `${owner}/${repo}`,
    branch,
  };
}

export function makeRepositoryTitle(repoFullName: string) {
  return repoFullName.split("/").slice(-1)[0] ?? repoFullName;
}

function sanitizeRepoName(name: string) {
  return name.replace(/\.git$/i, "");
}
