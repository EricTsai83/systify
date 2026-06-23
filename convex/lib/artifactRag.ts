"use node";

import { internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import type { ActionCtx } from "../_generated/server";
import type { ArtifactChunkSearchHit } from "../artifactChunkStore";
import { embedWithAccounting } from "./embeddingAccounting";
import { logInfo, logWarn } from "./observability";
import { buildUsageSourceId } from "./usageAccounting";

const DEFAULT_RETRIEVAL_TOP_N = 8;
const DEFAULT_RETRIEVAL_CANDIDATE_K = 20;
const RRF_K = 60;

export interface RetrievedChunk {
  chunkId: Id<"artifactChunks">;
  artifactId: Id<"artifacts">;
  artifactVersion: number;
  artifactTitle: string;
  artifactKind: Doc<"artifacts">["kind"];
  headingPath: string[];
  content: string;
  lexicalScore: number;
  semanticScore: number;
  rrfScore: number;
}

type RetrieveArgs = {
  /**
   * Owner identity that drives per-user fairness in the gateway
   * (RPM + concurrency buckets) and the per-user / per-repository
   * daily-cap settlement after each embedding call.
   */
  ownerTokenIdentifier: string;
  repositoryId: Id<"repositories">;
  artifactScope?: Id<"artifacts">[];
  query: string;
  topN?: number;
  candidateK?: number;
  /**
   * Optional forensic anchors forwarded to the gateway's
   * `LlmCallContext`. RAG retrieval runs inside the chat reply
   * flow, so plumbing these lets the `llm_embedding_tokens_used`
   * metric tie back to the message / thread that triggered it.
   */
  threadId?: Id<"threads">;
  messageId?: Id<"messages">;
};

type RankedCandidate = ArtifactChunkSearchHit & {
  semanticScore: number;
  rrfScore: number;
};

type RetrievalHit = ArtifactChunkSearchHit & {
  semanticScore?: number;
};

export async function retrieveArtifactChunks(ctx: ActionCtx, args: RetrieveArgs): Promise<RetrievedChunk[]> {
  const topN = normalizeLimit(args.topN, DEFAULT_RETRIEVAL_TOP_N);
  const candidateK = normalizeLimit(args.candidateK, DEFAULT_RETRIEVAL_CANDIDATE_K);
  const scope = new Set(args.artifactScope ?? []);

  const [lexicalResult, semanticResult] = await Promise.allSettled([
    retrieveLexical(ctx, args, candidateK),
    retrieveSemantic(ctx, args, candidateK),
  ]);

  const lexical = lexicalResult.status === "fulfilled" ? lexicalResult.value : [];
  if (lexicalResult.status === "rejected") {
    logWarn("artifactRag", "lexical_retrieval_failed", {
      repositoryId: args.repositoryId,
      error: lexicalResult.reason instanceof Error ? lexicalResult.reason.message : String(lexicalResult.reason),
    });
  }

  const semantic = semanticResult.status === "fulfilled" ? semanticResult.value : [];
  if (semanticResult.status === "rejected") {
    logWarn("artifactRag", "semantic_retrieval_failed", {
      repositoryId: args.repositoryId,
      error: semanticResult.reason instanceof Error ? semanticResult.reason.message : String(semanticResult.reason),
    });
  }

  const candidates = new Map<Id<"artifactChunks">, RankedCandidate>();
  addRankedCandidates(candidates, selectScopedCandidates(lexical, scope, candidateK), "lexical");
  addRankedCandidates(candidates, selectScopedCandidates(semantic, scope, candidateK), "semantic");

  const ranked = [...candidates.values()]
    .sort((left, right) => {
      if (right.rrfScore !== left.rrfScore) {
        return right.rrfScore - left.rrfScore;
      }
      return right.lexicalScore + right.semanticScore - (left.lexicalScore + left.semanticScore);
    })
    .slice(0, topN);

  logInfo("artifactRag", "retrieved_artifact_chunks", {
    repositoryId: args.repositoryId,
    lexicalCandidates: lexical.length,
    semanticCandidates: semantic.length,
    returned: ranked.length,
    retrieval_mode: semantic.length > 0 ? "hybrid" : "lexical_only",
  });

  return ranked.map((candidate) => ({
    chunkId: candidate.chunkId,
    artifactId: candidate.artifactId,
    artifactVersion: candidate.artifactVersion,
    artifactTitle: candidate.artifactTitle,
    artifactKind: candidate.artifactKind,
    headingPath: candidate.headingPath,
    content: candidate.content,
    lexicalScore: candidate.lexicalScore,
    semanticScore: candidate.semanticScore,
    rrfScore: candidate.rrfScore,
  }));
}

async function retrieveLexical(
  ctx: ActionCtx,
  args: RetrieveArgs,
  candidateK: number,
): Promise<ArtifactChunkSearchHit[]> {
  const overfetchLimit = args.artifactScope && args.artifactScope.length > 0 ? candidateK * 4 : candidateK;
  const [contentHits, summaryHits] = await Promise.all([
    ctx.runQuery(internal.artifactChunkStore.searchContent, {
      repositoryId: args.repositoryId,
      query: args.query,
      limit: overfetchLimit,
    }),
    ctx.runQuery(internal.artifactChunkStore.searchSummary, {
      repositoryId: args.repositoryId,
      query: args.query,
      limit: overfetchLimit,
    }),
  ]);

  const merged = new Map<Id<"artifactChunks">, ArtifactChunkSearchHit>();
  for (const hit of [...contentHits, ...summaryHits]) {
    const existing = merged.get(hit.chunkId);
    if (!existing || hit.lexicalScore > existing.lexicalScore) {
      merged.set(hit.chunkId, hit);
    }
  }
  return [...merged.values()].sort((a, b) => b.lexicalScore - a.lexicalScore).slice(0, overfetchLimit);
}

async function retrieveSemantic(ctx: ActionCtx, args: RetrieveArgs, candidateK: number): Promise<RetrievalHit[]> {
  const sourceId = buildUsageSourceId.libraryRetrieval(
    args.messageId ?? args.threadId ?? "unattributed",
    stableHash(args.query),
  );
  const { embeddings } = await embedWithAccounting(ctx, {
    values: [args.query],
    sourceId,
    ownerTokenIdentifier: args.ownerTokenIdentifier,
    repositoryId: args.repositoryId,
    usageFeature: "libraryRetrieval",
    // RAG retrieval is invoked from the chat reply pipeline to ground
    // assistant answers in library artifacts. The `chat` literal keeps
    // the metric grouped with the same feature as the chat generation
    // that triggered it; no new gateway feature literal is warranted.
    gatewayFeature: "chat",
    ...(args.threadId !== undefined ? { threadId: args.threadId } : {}),
    ...(args.messageId !== undefined ? { messageId: args.messageId } : {}),
  });
  const [embedding] = embeddings;
  if (embedding === undefined) {
    // Defensive: `embedMany` returns one vector per input, so a missing
    // entry for a single-value batch implies an SDK contract change.
    throw new Error("artifactRag: embedding accounting returned zero embeddings for a one-value query");
  }

  const overfetchLimit = args.artifactScope && args.artifactScope.length > 0 ? candidateK * 4 : candidateK;
  const results = await ctx.vectorSearch("artifactChunks", "by_embedding", {
    vector: embedding,
    limit: overfetchLimit,
    filter: (q) => q.eq("repositoryId", args.repositoryId),
  });
  const rows: ArtifactChunkSearchHit[] = await ctx.runQuery(internal.artifactChunkStore.getChunksByIds, {
    chunkIds: results.map((result) => result._id),
  });
  const scoreById = new Map(results.map((result) => [result._id, result._score]));
  return rows.map((row) => ({
    ...row,
    lexicalScore: 0,
    semanticScore: scoreById.get(row.chunkId) ?? 0,
  }));
}

function addRankedCandidates(
  candidates: Map<Id<"artifactChunks">, RankedCandidate>,
  hits: RetrievalHit[],
  channel: "lexical" | "semantic",
) {
  for (const [rankIndex, hit] of hits.entries()) {
    const rank = rankIndex + 1;
    const existing =
      candidates.get(hit.chunkId) ??
      ({
        ...hit,
        semanticScore: 0,
        rrfScore: 0,
      } satisfies RankedCandidate);

    existing.rrfScore += 1 / (RRF_K + rank);
    if (channel === "lexical") {
      existing.lexicalScore = Math.max(existing.lexicalScore, hit.lexicalScore);
    } else {
      existing.semanticScore = Math.max(existing.semanticScore, hit.semanticScore ?? 0);
    }
    candidates.set(hit.chunkId, existing);
  }
}

function filterScope<T extends { artifactId: Id<"artifacts"> }>(hits: T[], scope: Set<Id<"artifacts">>): T[] {
  if (scope.size === 0) {
    return hits;
  }
  return hits.filter((hit) => scope.has(hit.artifactId));
}

function selectScopedCandidates<T extends { artifactId: Id<"artifacts"> }>(
  hits: T[],
  scope: Set<Id<"artifacts">>,
  candidateK: number,
): T[] {
  return filterScope(hits, scope).slice(0, candidateK);
}

function normalizeLimit(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.floor(value);
}

function stableHash(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}
