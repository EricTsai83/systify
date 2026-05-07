const SANDBOX_NAME_PREFIX = "architect";
const MAX_DAYTONA_SANDBOX_NAME_LENGTH = 63;
const FALLBACK_LABEL = "repo";

export function buildSandboxName(options: { repositoryKey: string; repositoryId: string; sandboxId?: string }) {
  const stableIdSegment = normalizeSegment(options.sandboxId ?? options.repositoryId) || FALLBACK_LABEL;
  const reservedLength = SANDBOX_NAME_PREFIX.length + 1 + stableIdSegment.length + 1;
  const humanLabelMaxLength = Math.max(MAX_DAYTONA_SANDBOX_NAME_LENGTH - reservedLength, 1);
  const humanLabel = truncateSegment(normalizeSegment(options.repositoryKey), humanLabelMaxLength) || FALLBACK_LABEL;

  return `${SANDBOX_NAME_PREFIX}-${humanLabel}-${stableIdSegment}`;
}

function normalizeSegment(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function truncateSegment(value: string, maxLength: number) {
  return value.slice(0, maxLength).replace(/-+$/g, "");
}
