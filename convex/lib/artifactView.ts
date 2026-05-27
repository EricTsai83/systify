import type { Doc } from "../_generated/dataModel";
import type { QueryCtx } from "../_generated/server";

/**
 * Freshness band derived from `artifacts.lastVerifiedAt`. The bands are
 * the only thing the Library UI surfaces — the raw timestamp is also
 * returned on the view for cases that need it (cost ticker, audit), but
 * the band is what drives the navigator pill colour.
 *
 *   - `fresh`       — verified within `ARTIFACT_FRESHNESS_AGING_DAYS`.
 *   - `aging`       — verified inside the aging window but past `fresh`.
 *   - `stale`       — verified past `ARTIFACT_FRESHNESS_STALE_DAYS`.
 *   - `unverified`  — no sandbox-grounded verification recorded yet.
 */
export type ArtifactFreshness = "fresh" | "aging" | "stale" | "unverified";

const DEFAULT_FRESHNESS_AGING_DAYS = 7;
const DEFAULT_FRESHNESS_STALE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function readPositiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Pure freshness derivation. `lastVerifiedAt` is the only signal — unset
 * collapses to `unverified` regardless of `_creationTime`, because
 * Library must not imply that snapshots match live code based on row
 * recency alone.
 */
export function computeFreshness(args: { lastVerifiedAt?: number; now: number }): ArtifactFreshness {
  if (args.lastVerifiedAt === undefined) {
    return "unverified";
  }
  const ageDays = Math.max(0, (args.now - args.lastVerifiedAt) / MS_PER_DAY);
  const agingDays = readPositiveNumberEnv("ARTIFACT_FRESHNESS_AGING_DAYS", DEFAULT_FRESHNESS_AGING_DAYS);
  const staleDays = readPositiveNumberEnv("ARTIFACT_FRESHNESS_STALE_DAYS", DEFAULT_FRESHNESS_STALE_DAYS);
  if (ageDays <= agingDays) return "fresh";
  if (ageDays <= staleDays) return "aging";
  return "stale";
}

/**
 * Coarse drift signal: true when the artifact was anchored to a specific
 * import revision (`alignedImportCommitSha`) and that revision differs
 * from the repository's latest import SHA. Pure — the latest SHA is
 * resolved once per query by {@link resolveLatestImportSha}.
 */
export function hasImportSnapshotDrift(
  artifact: Pick<Doc<"artifacts">, "alignedImportCommitSha">,
  latestImportSha: string | undefined,
): boolean {
  if (!artifact.alignedImportCommitSha || !latestImportSha) {
    return false;
  }
  return artifact.alignedImportCommitSha !== latestImportSha;
}

/**
 * Resolves the commit SHA of a repository's most recent import. Returns
 * `undefined` when the repo has never completed an import, or the import
 * row predates commit-SHA tracking — callers treat that as "no drift
 * signal available" rather than "drifted".
 *
 * The latest import is a per-query constant, so this is resolved once
 * per repository-scoped listing and the result is threaded to
 * {@link hasImportSnapshotDrift} for each artifact. Resolving it per
 * artifact would re-read the same import row up to N times in a list.
 */
export async function resolveLatestImportSha(
  ctx: QueryCtx,
  repository: Doc<"repositories">,
): Promise<string | undefined> {
  if (!repository.latestImportId) {
    return undefined;
  }
  const latestImport = await ctx.db.get(repository.latestImportId);
  return latestImport?.commitSha;
}

interface ArtifactViewOpts {
  now: number;
  /**
   * Latest-import SHA from {@link resolveLatestImportSha}. When supplied,
   * the view sets `importDriftFromLatestSync: true` whenever
   * `hasImportSnapshotDrift` fires. Omit on single-artifact reads that
   * don't load the repository.
   */
  latestImportSha?: string;
}

/**
 * Full-fat artifact view: the row plus computed `freshness` and an
 * optional `importDriftFromLatestSync` marker. Used by reads that need
 * the markdown body — `artifacts.getById` (single artifact) and
 * `artifacts.listByRepositoryWithFreshness` (full list).
 *
 * Bundling freshness into the view shape means callers cannot forget
 * to compute it: any future read entry point that wants the artifact
 * shape goes through this helper and inherits the same band rule.
 */
export function toArtifactView(artifact: Doc<"artifacts">, opts: ArtifactViewOpts) {
  return {
    ...artifact,
    freshness: computeFreshness({ lastVerifiedAt: artifact.lastVerifiedAt, now: opts.now }),
    ...(hasImportSnapshotDrift(artifact, opts.latestImportSha) ? { importDriftFromLatestSync: true as const } : {}),
  };
}

/**
 * Metadata-only artifact view (omits `contentMarkdown`). Used by the
 * Library navigator's `listMetadataByRepositoryWithFreshness` query —
 * the navigator never renders the markdown body, and pulling it would
 * blow up the reactive query's read payload and trigger spurious
 * invalidations on every body edit.
 *
 * Same freshness / drift bundling as {@link toArtifactView} so both
 * shapes stay in lockstep when the rule evolves.
 */
export function toArtifactMetadataView(artifact: Doc<"artifacts">, opts: ArtifactViewOpts) {
  return {
    _id: artifact._id,
    _creationTime: artifact._creationTime,
    repositoryId: artifact.repositoryId,
    threadId: artifact.threadId,
    jobId: artifact.jobId,
    kind: artifact.kind,
    title: artifact.title,
    summary: artifact.summary,
    source: artifact.source,
    version: artifact.version,
    folderId: artifact.folderId,
    lastVerifiedAt: artifact.lastVerifiedAt,
    chunkingStatus: artifact.chunkingStatus,
    lastChunkedAt: artifact.lastChunkedAt,
    lastChunkedVersion: artifact.lastChunkedVersion,
    updatedAt: artifact.updatedAt,
    freshness: computeFreshness({ lastVerifiedAt: artifact.lastVerifiedAt, now: opts.now }),
    ...(hasImportSnapshotDrift(artifact, opts.latestImportSha) ? { importDriftFromLatestSync: true as const } : {}),
  };
}
