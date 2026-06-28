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
  let cursor = 0;
  for (const codeRange of findMarkdownCodeRanges(content)) {
    parseCodeFileCitationsInProse(content.slice(cursor, codeRange.start), citations);
    cursor = codeRange.end;
  }
  parseCodeFileCitationsInProse(content.slice(cursor), citations);

  return citations;
}

function findMarkdownCodeRanges(content: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let index = 0;

  while (index < content.length) {
    const fencedRange = readFencedCodeRange(content, index);
    if (fencedRange) {
      ranges.push(fencedRange);
      index = fencedRange.end;
      continue;
    }

    const inlineRange = readBacktickCodeSpanRange(content, index);
    if (inlineRange) {
      ranges.push(inlineRange);
      index = inlineRange.end;
      continue;
    }

    index += 1;
  }

  return ranges;
}

function readFencedCodeRange(content: string, index: number): { start: number; end: number } | null {
  const lineStart = content.lastIndexOf("\n", index - 1) + 1;
  if (lineStart !== index) {
    return null;
  }

  const openerMatch = /^( {0,3})(`{3,}|~{3,})[^\n]*(?:\n|$)/.exec(content.slice(index));
  if (!openerMatch) {
    return null;
  }

  const delimiter = openerMatch[2] ?? "";
  const marker = delimiter[0] ?? "";
  const minLength = delimiter.length;
  const searchStart = index + openerMatch[0].length;
  const closerRegex = new RegExp(`^ {0,3}\\${marker}{${minLength},}[^\\n]*(?:\\n|$)`, "gm");
  closerRegex.lastIndex = searchStart;
  const closerMatch = closerRegex.exec(content);
  if (!closerMatch) {
    return { start: index, end: content.length };
  }
  return { start: index, end: closerMatch.index + closerMatch[0].length };
}

function readBacktickCodeSpanRange(content: string, index: number): { start: number; end: number } | null {
  if (content[index] !== "`") {
    return null;
  }

  const openerMatch = /^`+/.exec(content.slice(index));
  const delimiter = openerMatch?.[0] ?? "";
  if (!delimiter) {
    return null;
  }

  const closeIndex = content.indexOf(delimiter, index + delimiter.length);
  if (closeIndex === -1) {
    return null;
  }
  return { start: index, end: closeIndex + delimiter.length };
}

function parseCodeFileCitationsInProse(content: string, citations: CodeFileCitation[]): void {
  for (const match of content.matchAll(CODE_FILE_CITATION_REGEX)) {
    const rawToken = match[0];
    const path = match[1] ?? "";
    const startLine = Number.parseInt(match[2] ?? "", 10);
    const parsedEndLine = match[3] === undefined ? startLine : Number.parseInt(match[3], 10);
    if (!isValidCodeCitationPath(path, rawToken)) {
      continue;
    }
    if (!isValidLineRange(startLine, parsedEndLine)) {
      continue;
    }
    citations.push({
      path,
      startLine,
      endLine: parsedEndLine,
      rawToken,
    });
  }
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
  const normalizedRef = args.ref.trim();
  if (!normalizedRef) {
    return null;
  }
  const normalizedPath = stripLeadingSlashes(args.path);
  if (!normalizedPath || hasParentPathSegment(normalizedPath) || !isValidLineRange(args.startLine, args.endLine)) {
    return null;
  }
  const anchor = args.startLine === args.endLine ? `#L${args.startLine}` : `#L${args.startLine}-L${args.endLine}`;
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/blob/${encodePathPreservingSlashes(
    normalizedRef,
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
  if (hasParentPathSegment(stripLeadingSlashes(path))) {
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

function isValidLineRange(startLine: number, endLine: number): boolean {
  return Number.isSafeInteger(startLine) && Number.isSafeInteger(endLine) && startLine >= 1 && endLine >= startLine;
}

function encodePathPreservingSlashes(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}
