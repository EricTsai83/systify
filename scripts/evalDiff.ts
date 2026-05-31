#!/usr/bin/env bun
/**
 * System Design eval JSONL diff CLI.
 *
 * Usage:
 *   bun run eval:diff <before.jsonl> <after.jsonl>
 *
 * Reads two eval JSONL files and prints per-`(kind × providerModel)`
 * deltas — judge score, success rate, cost per success. Sorted by
 * `|judgeScoreDelta|` descending so the largest movers (improvements
 * AND regressions) lead.
 *
 * Use to decide whether a prompt edit, a step-budget tune, or a model
 * swap should land. The `README.md` next door spells out the
 * regression-handling playbook (≥0.3 judge-score regression on any
 * kind → revert OR investigate failure signals).
 */

import { readFile } from "node:fs/promises";
import { diffSummaries, parseEvalRecordsJsonl, type EvalSummaryDelta } from "../convex/eval/systemDesign/aggregate";

function formatUsd(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function formatSignedUsd(usd: number): string {
  const sign = usd >= 0 ? "+" : "";
  return `${sign}${formatUsd(usd)}`;
}

function formatSignedNumber(n: number, digits = 2): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(digits)}`;
}

function formatSignedPercent(rate: number): string {
  const sign = rate >= 0 ? "+" : "";
  return `${sign}${(rate * 100).toFixed(1)}%`;
}

function flagDelta(delta: number, threshold: number): string {
  if (delta >= threshold) return "▲";
  if (delta <= -threshold) return "▼";
  return " ";
}

function printDelta(delta: EvalSummaryDelta): void {
  const judgeFlag = flagDelta(delta.judgeScoreDelta, 0.3);
  const succFlag = flagDelta(delta.successRateDelta, 0.1);
  const cps = delta.costPerSuccessDelta;
  const cpsFlag = cps <= -0.001 ? "▲" : cps >= 0.001 ? "▼" : " ";
  console.log(
    `  ${judgeFlag}${succFlag}${cpsFlag} ` +
      `${delta.kind.padEnd(24)} ${delta.providerModel.padEnd(28)} ` +
      `judge=${delta.beforeJudgeScore.toFixed(2)}→${delta.afterJudgeScore.toFixed(2)} ` +
      `(${formatSignedNumber(delta.judgeScoreDelta)}) ` +
      `ok=${(delta.beforeSuccessRate * 100).toFixed(0)}%→${(delta.afterSuccessRate * 100).toFixed(0)}% ` +
      `(${formatSignedPercent(delta.successRateDelta)}) ` +
      `cps=${formatUsd(delta.beforeCostPerSuccess)}→${formatUsd(delta.afterCostPerSuccess)} ` +
      `(${formatSignedUsd(cps)}) ` +
      `n=${delta.beforeSampleCount}/${delta.afterSampleCount}`,
  );
}

async function main(): Promise<void> {
  const [beforePath, afterPath] = process.argv.slice(2);
  if (!beforePath || !afterPath) {
    console.error("Usage: bun run eval:diff <before.jsonl> <after.jsonl>");
    process.exit(2);
  }
  const [beforeText, afterText] = await Promise.all([readFile(beforePath, "utf8"), readFile(afterPath, "utf8")]);
  const beforeRecords = parseEvalRecordsJsonl(beforeText);
  const afterRecords = parseEvalRecordsJsonl(afterText);
  const diff = diffSummaries(beforeRecords, afterRecords);

  console.log("");
  console.log(`Eval diff`);
  console.log(`  before:  ${beforePath}  (${beforeRecords.length} records)`);
  console.log(`  after:   ${afterPath}  (${afterRecords.length} records)`);
  console.log("");

  const b = diff.beforeSummary.total;
  const a = diff.afterSummary.total;
  console.log("Headline");
  console.log(
    `  success rate             ${(b.totalTrials > 0 ? (b.succeededTrials / b.totalTrials) * 100 : 0).toFixed(1)}% → ` +
      `${(a.totalTrials > 0 ? (a.succeededTrials / a.totalTrials) * 100 : 0).toFixed(1)}%`,
  );
  console.log(
    `  mean judge score         ${b.judgeScoredTrials > 0 ? b.meanJudgeScore.toFixed(2) : "—"} → ` +
      `${a.judgeScoredTrials > 0 ? a.meanJudgeScore.toFixed(2) : "—"}`,
  );
  console.log(`  total cost               ${formatUsd(b.totalCostUsd)} → ${formatUsd(a.totalCostUsd)}`);
  console.log(`  mean cost / trial        ${formatUsd(b.meanCostUsd)} → ${formatUsd(a.meanCostUsd)}`);
  console.log("");

  console.log("Per (kind × provider:model) — sorted by |judge delta|");
  console.log(`  ▲▼ flags: judge ≥±0.30, success ≥±10%, cost-per-success ≥±$0.001`);
  console.log("");
  if (diff.deltas.length === 0) {
    console.log("  (no rows)");
  } else {
    for (const delta of diff.deltas) printDelta(delta);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
