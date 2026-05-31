/**
 * Pure aggregation over `EvalRunRecord` rows produced by `runner.ts`.
 *
 * Lives separate from `report.ts` (production telemetry rollup) on
 * purpose: eval records sit on disk as JSONL files written by the
 * operator-driven CLI; production telemetry sits in the
 * `systemDesignKindRuns` Convex table written by the live generator.
 * Both rollups share *shape* concepts (per-kind buckets, success rate)
 * but the storage and freshness contracts are different. Merging them
 * would couple operator iteration cadence to production schema.
 *
 * Module is pure TypeScript — no Convex imports — so the bun CLI
 * scripts (`scripts/evalReport.ts`, `scripts/evalDiff.ts`) import
 * directly via relative path without paying a Convex deployment hop.
 */

import type { LlmProvider } from "../../lib/llmProvider";
import type { SystemDesignKind } from "../../lib/systemDesign";

export type EvalRunStatus = "succeeded" | "failed" | "quality_rejected";

/**
 * Judge axis shape — lives here (not `judge.ts`) so the type travels
 * with `EvalRunRecord` and the CLI scripts can read records without
 * transitively importing `judge.ts`. Importing `judge.ts` would pull
 * in `llmGateway.ts` → `_generated/api.d.ts`, which the bun-runtime
 * tsconfig doesn't have the lib for.
 */
export interface JudgeAxisScores {
  faithfulness: number;
  completeness: number;
  specificity: number;
  citationQuality: number;
}

/**
 * One row per `(corpus × kind × stepBudget × provider × model)` trial.
 * Written by `runner.ts`; serialized to JSONL by the eval CLI; read
 * back by the report / diff CLIs.
 *
 * Optional fields propagate `undefined` honestly — a `failed` trial
 * has no `judgeAxes`; a `cached_hit` would have no LLM usage (the
 * eval harness skips cache, so `cached_hit` is never written here).
 */
export interface EvalRunRecord {
  corpusSlug: string;
  kind: SystemDesignKind;
  stepBudget: number;
  provider: LlmProvider;
  modelName: string;
  promptVersion: number;
  status: EvalRunStatus;
  failureReason?: string;
  missingSections?: string[];
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalCostUsd?: number;
  durationMs: number;
  judgeAxes?: JudgeAxisScores;
  judgeOverallScore?: number;
  judgeComments?: string;
  judgeParseError?: string;
  outputCharLength?: number;
  startedAt: number;
}

export interface EvalBucket {
  totalTrials: number;
  succeededTrials: number;
  failedTrials: number;
  qualityRejectedTrials: number;
  /** Sum across recorded scores; `meanJudgeScore` derives by /count. */
  totalJudgeScore: number;
  judgeScoredTrials: number;
  meanJudgeScore: number;
  totalCostUsd: number;
  meanCostUsd: number;
  totalDurationMs: number;
  meanDurationMs: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  meanInputTokens: number;
  meanOutputTokens: number;
}

export interface EvalSummary {
  totalRecords: number;
  total: EvalBucket;
  byKind: Record<string, EvalBucket>;
  byCorpus: Record<string, EvalBucket>;
  byProviderModel: Record<string, EvalBucket>;
  /** `${kind}@${stepBudget}` so a single key captures the budget sweep. */
  byKindBudget: Record<string, EvalBucket>;
}

export interface EvalSummaryDelta {
  kind: string;
  providerModel: string;
  beforeSampleCount: number;
  afterSampleCount: number;
  beforeJudgeScore: number;
  afterJudgeScore: number;
  judgeScoreDelta: number;
  beforeSuccessRate: number;
  afterSuccessRate: number;
  successRateDelta: number;
  beforeCostPerSuccess: number;
  afterCostPerSuccess: number;
  costPerSuccessDelta: number;
}

export interface EvalSummaryDiff {
  beforeSummary: EvalSummary;
  afterSummary: EvalSummary;
  deltas: EvalSummaryDelta[];
}

function makeBucket(): EvalBucket {
  return {
    totalTrials: 0,
    succeededTrials: 0,
    failedTrials: 0,
    qualityRejectedTrials: 0,
    totalJudgeScore: 0,
    judgeScoredTrials: 0,
    meanJudgeScore: 0,
    totalCostUsd: 0,
    meanCostUsd: 0,
    totalDurationMs: 0,
    meanDurationMs: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
    meanInputTokens: 0,
    meanOutputTokens: 0,
  };
}

function addRecord(bucket: EvalBucket, record: EvalRunRecord): void {
  bucket.totalTrials += 1;
  switch (record.status) {
    case "succeeded":
      bucket.succeededTrials += 1;
      break;
    case "failed":
      bucket.failedTrials += 1;
      break;
    case "quality_rejected":
      bucket.qualityRejectedTrials += 1;
      break;
  }
  if (typeof record.judgeOverallScore === "number" && Number.isFinite(record.judgeOverallScore)) {
    bucket.totalJudgeScore += record.judgeOverallScore;
    bucket.judgeScoredTrials += 1;
  }
  if (typeof record.totalCostUsd === "number" && Number.isFinite(record.totalCostUsd) && record.totalCostUsd > 0) {
    bucket.totalCostUsd += record.totalCostUsd;
  }
  bucket.totalDurationMs += record.durationMs;
  if (typeof record.inputTokens === "number") bucket.totalInputTokens += record.inputTokens;
  if (typeof record.outputTokens === "number") bucket.totalOutputTokens += record.outputTokens;
}

function finalizeBucket(bucket: EvalBucket): void {
  bucket.meanJudgeScore = bucket.judgeScoredTrials > 0 ? bucket.totalJudgeScore / bucket.judgeScoredTrials : 0;
  const n = bucket.totalTrials;
  bucket.meanCostUsd = n > 0 ? bucket.totalCostUsd / n : 0;
  bucket.meanDurationMs = n > 0 ? bucket.totalDurationMs / n : 0;
  bucket.meanInputTokens = n > 0 ? bucket.totalInputTokens / n : 0;
  bucket.meanOutputTokens = n > 0 ? bucket.totalOutputTokens / n : 0;
}

export function aggregateRecords(records: readonly EvalRunRecord[]): EvalSummary {
  const total = makeBucket();
  const byKind: Record<string, EvalBucket> = {};
  const byCorpus: Record<string, EvalBucket> = {};
  const byProviderModel: Record<string, EvalBucket> = {};
  const byKindBudget: Record<string, EvalBucket> = {};

  for (const record of records) {
    addRecord(total, record);
    addRecord((byKind[record.kind] ??= makeBucket()), record);
    addRecord((byCorpus[record.corpusSlug] ??= makeBucket()), record);
    const pmKey = `${record.provider}:${record.modelName}`;
    addRecord((byProviderModel[pmKey] ??= makeBucket()), record);
    const kbKey = `${record.kind}@${record.stepBudget}`;
    addRecord((byKindBudget[kbKey] ??= makeBucket()), record);
  }

  finalizeBucket(total);
  for (const bucket of Object.values(byKind)) finalizeBucket(bucket);
  for (const bucket of Object.values(byCorpus)) finalizeBucket(bucket);
  for (const bucket of Object.values(byProviderModel)) finalizeBucket(bucket);
  for (const bucket of Object.values(byKindBudget)) finalizeBucket(bucket);

  return {
    totalRecords: records.length,
    total,
    byKind,
    byCorpus,
    byProviderModel,
    byKindBudget,
  };
}

/**
 * Group records by `(kind, providerModel)` so the diff can compute
 * per-cell deltas without a second pass over the full record list.
 */
function groupByKindAndModel(records: readonly EvalRunRecord[]): Map<string, EvalRunRecord[]> {
  const out = new Map<string, EvalRunRecord[]>();
  for (const r of records) {
    const key = `${r.kind}::${r.provider}:${r.modelName}`;
    const bucket = out.get(key);
    if (bucket) bucket.push(r);
    else out.set(key, [r]);
  }
  return out;
}

function safeMean(total: number, count: number): number {
  return count > 0 ? total / count : 0;
}

function successRate(bucket: { totalTrials: number; succeededTrials: number }): number {
  return bucket.totalTrials > 0 ? bucket.succeededTrials / bucket.totalTrials : 0;
}

function costPerSuccess(bucket: { totalCostUsd: number; succeededTrials: number }): number {
  // Use 0 for "no successes" so the delta stays finite — operator can
  // see successRate independently to discriminate "cheaper" from
  // "stopped succeeding".
  return bucket.succeededTrials > 0 ? bucket.totalCostUsd / bucket.succeededTrials : 0;
}

export function diffSummaries(
  beforeRecords: readonly EvalRunRecord[],
  afterRecords: readonly EvalRunRecord[],
): EvalSummaryDiff {
  const beforeSummary = aggregateRecords(beforeRecords);
  const afterSummary = aggregateRecords(afterRecords);

  const beforeGroups = groupByKindAndModel(beforeRecords);
  const afterGroups = groupByKindAndModel(afterRecords);
  const allKeys = new Set<string>([...beforeGroups.keys(), ...afterGroups.keys()]);

  const deltas: EvalSummaryDelta[] = [];
  for (const key of allKeys) {
    const [kind, providerModel] = key.split("::");
    const beforeList = beforeGroups.get(key) ?? [];
    const afterList = afterGroups.get(key) ?? [];

    const beforeBucket = makeBucket();
    for (const r of beforeList) addRecord(beforeBucket, r);
    finalizeBucket(beforeBucket);
    const afterBucket = makeBucket();
    for (const r of afterList) addRecord(afterBucket, r);
    finalizeBucket(afterBucket);

    const beforeJudge = safeMean(beforeBucket.totalJudgeScore, beforeBucket.judgeScoredTrials);
    const afterJudge = safeMean(afterBucket.totalJudgeScore, afterBucket.judgeScoredTrials);
    const beforeSucc = successRate(beforeBucket);
    const afterSucc = successRate(afterBucket);
    const beforeCps = costPerSuccess(beforeBucket);
    const afterCps = costPerSuccess(afterBucket);

    deltas.push({
      kind,
      providerModel,
      beforeSampleCount: beforeBucket.totalTrials,
      afterSampleCount: afterBucket.totalTrials,
      beforeJudgeScore: beforeJudge,
      afterJudgeScore: afterJudge,
      judgeScoreDelta: afterJudge - beforeJudge,
      beforeSuccessRate: beforeSucc,
      afterSuccessRate: afterSucc,
      successRateDelta: afterSucc - beforeSucc,
      beforeCostPerSuccess: beforeCps,
      afterCostPerSuccess: afterCps,
      costPerSuccessDelta: afterCps - beforeCps,
    });
  }

  deltas.sort((a, b) => Math.abs(b.judgeScoreDelta) - Math.abs(a.judgeScoreDelta));
  return { beforeSummary, afterSummary, deltas };
}

export function parseEvalRecordsJsonl(jsonl: string): EvalRunRecord[] {
  const out: EvalRunRecord[] = [];
  for (const line of jsonl.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    out.push(JSON.parse(trimmed) as EvalRunRecord);
  }
  return out;
}

export function serializeEvalRecordsJsonl(records: readonly EvalRunRecord[]): string {
  if (records.length === 0) return "";
  return records.map((r) => JSON.stringify(r)).join("\n") + "\n";
}

export const TEST_INTERNALS = {
  makeBucket,
  addRecord,
  finalizeBucket,
  groupByKindAndModel,
  successRate,
  costPerSuccess,
} as const;
