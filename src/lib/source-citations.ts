export type CodeFileCitation = {
  path: string;
  startLine: number;
  endLine: number;
  rawToken: string;
};

export type CodeFileSource = {
  path: string;
  basename: string;
  ranges: Array<{ startLine: number; endLine: number }>;
  rawTokens: string[];
};

export type RepositorySourceLinkArgs = {
  sourceRepoFullName: string;
  ref: string;
  path: string;
  startLine: number;
  endLine: number;
};

const CODE_FILE_CITATION_REGEX = /\[([^[\]\s]+):(\d+)(?:-(\d+))?\]/g;

export function parseCodeFileCitations(content: string): CodeFileCitation[] {
  const citations: CodeFileCitation[] = [];
  for (const match of content.matchAll(CODE_FILE_CITATION_REGEX)) {
    const rawToken = match[0];
    const path = match[1] ?? "";
    const startLine = Number.parseInt(match[2] ?? "", 10);
    const parsedEndLine = match[3] === undefined ? startLine : Number.parseInt(match[3], 10);
    if (!isValidCodeCitationPath(path, rawToken)) {
      continue;
    }
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(parsedEndLine)) {
      continue;
    }
    citations.push({
      path,
      startLine,
      endLine: parsedEndLine,
      rawToken,
    });
  }
  return citations;
}

export function parseCodeFileSources(content: string): CodeFileSource[] {
  const groups = new Map<string, CodeFileSource>();
  for (const citation of parseCodeFileCitations(content)) {
    const existing = groups.get(citation.path);
    const source =
      existing ??
      ({
        path: citation.path,
        basename: basenameForPath(citation.path),
        ranges: [],
        rawTokens: [],
      } satisfies CodeFileSource);
    if (!source.ranges.some((range) => range.startLine === citation.startLine && range.endLine === citation.endLine)) {
      source.ranges.push({ startLine: citation.startLine, endLine: citation.endLine });
    }
    if (!source.rawTokens.includes(citation.rawToken)) {
      source.rawTokens.push(citation.rawToken);
    }
    groups.set(citation.path, source);
  }
  return [...groups.values()];
}

export function formatCodeFileRanges(ranges: ReadonlyArray<{ startLine: number; endLine: number }>): string {
  return ranges
    .map((range) =>
      range.startLine === range.endLine ? String(range.startLine) : `${range.startLine}-${range.endLine}`,
    )
    .join(", ");
}

export function buildGitHubSourceUrl(args: RepositorySourceLinkArgs): string | null {
  const [owner, repo, ...extra] = args.sourceRepoFullName.split("/");
  if (!owner || !repo || extra.length > 0) {
    return null;
  }
  const normalizedPath = stripLeadingSlashes(args.path);
  if (!normalizedPath || hasParentPathSegment(normalizedPath)) {
    return null;
  }
  const anchor = args.startLine === args.endLine ? `#L${args.startLine}` : `#L${args.startLine}-L${args.endLine}`;
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${encodePathPreservingSlashes(
    args.ref,
  )}/${encodePathPreservingSlashes(normalizedPath)}${anchor}`;
}

function isValidCodeCitationPath(path: string, rawToken: string): boolean {
  if (!path) {
    return false;
  }
  if (path.includes("://") || rawToken.includes("://")) {
    return false;
  }
  if (/^A\d+$/.test(path)) {
    return false;
  }
  return true;
}

function basenameForPath(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function stripLeadingSlashes(path: string): string {
  return path.replace(/^\/+/, "");
}

function hasParentPathSegment(path: string): boolean {
  return path.split("/").some((segment) => segment === "..");
}

function encodePathPreservingSlashes(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
