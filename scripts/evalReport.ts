#!/usr/bin/env bun
/**
 * System Design eval JSONL report CLI.
 *
 * Usage:
 *   bun run eval:report <path-to-eval-records.jsonl>
 *
 * Reads a JSONL file written by `bun run eval:system-design`, folds
 * the rows via `aggregateRecords`, and pretty-prints headline / by-kind
 * / by-corpus / by-(provider:model) / by-(kind@budget) tables to stdout.
 *
 * Mirrors `scripts/reportSystemDesign.ts` in shape; differs in source
 * (local JSONL file vs Convex query) because eval records intentionally
 * live outside the production telemetry table — see `aggregate.ts`.
 */

import { readFile } from "node:fs/promises";
import {
  aggregateRecords,
  parseEvalRecordsJsonl,
  type EvalBucket,
  type EvalSummary,
} from "../convex/eval/systemDesign/aggregate";

function formatUsd(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function formatTokens(n: number): string {
  if (n === 0) return "—";
  if (n < 1_000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) return "—";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function printBucketLine(label: string, bucket: EvalBucket): void {
  const ok = formatPercent(bucket.succeededTrials, bucket.totalTrials);
  const judge = bucket.judgeScoredTrials > 0 ? bucket.meanJudgeScore.toFixed(2) : "—";
  console.log(
    `  ${label.padEnd(36)} ` +
      `n=${String(bucket.totalTrials).padStart(4)} ` +
      `ok=${ok.padStart(6)} ` +
      `judge=${String(judge).padStart(4)} ` +
      `${formatUsd(bucket.totalCostUsd).padStart(11)} ` +
      `dur=${formatDuration(bucket.meanDurationMs).padStart(8)} ` +
      `in=${formatTokens(bucket.totalInputTokens).padStart(7)} ` +
      `out=${formatTokens(bucket.totalOutputTokens).padStart(7)}`,
  );
}

function printSection(title: string, entries: Array<[string, EvalBucket]>): void {
  console.log(title);
  if (entries.length === 0) {
    console.log("  (no rows)");
  } else {
    for (const [label, bucket] of entries) printBucketLine(label, bucket);
  }
  console.log("");
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error("Usage: bun run eval:report <path-to-eval-records.jsonl>");
    process.exit(2);
  }
  const text = await readFile(inputPath, "utf8");
  const records = parseEvalRecordsJsonl(text);
  const summary: EvalSummary = aggregateRecords(records);

  console.log("");
  console.log(`Eval report`);
  console.log(`  source:  ${inputPath}`);
  console.log(`  records: ${summary.totalRecords}`);
  console.log("");

  const t = summary.total;
  console.log("Headline");
  console.log(`  trials                   ${t.totalTrials}`);
  console.log(`  succeeded                ${t.succeededTrials}  (${formatPercent(t.succeededTrials, t.totalTrials)})`);
  console.log(`  failed                   ${t.failedTrials}`);
  console.log(`  quality rejected         ${t.qualityRejectedTrials}`);
  console.log(
    `  mean judge score         ${t.judgeScoredTrials > 0 ? t.meanJudgeScore.toFixed(2) : "—"}  (${t.judgeScoredTrials} scored)`,
  );
  console.log(`  total cost               ${formatUsd(t.totalCostUsd)}`);
  console.log(`  mean cost / trial        ${formatUsd(t.meanCostUsd)}`);
  console.log(`  mean duration / trial    ${formatDuration(t.meanDurationMs)}`);
  console.log("");

  printSection(
    "By kind",
    Object.entries(summary.byKind).sort(([a], [b]) => a.localeCompare(b)),
  );
  printSection(
    "By corpus",
    Object.entries(summary.byCorpus).sort(([a], [b]) => a.localeCompare(b)),
  );
  printSection(
    "By provider:model",
    Object.entries(summary.byProviderModel).sort(([, a], [, b]) => b.totalCostUsd - a.totalCostUsd),
  );
  printSection(
    "By kind@budget",
    Object.entries(summary.byKindBudget).sort(([a], [b]) => a.localeCompare(b)),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
