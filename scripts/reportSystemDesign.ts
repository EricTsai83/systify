#!/usr/bin/env bun
/**
 * System Design generator telemetry CLI.
 *
 * Usage:
 *   bun run report:system-design [--days=N] [--kind=...] [--provider=openai|anthropic] [--model=...]
 *
 * Example:
 *   bun run report:system-design --days=14
 *   bun run report:system-design --kind=architecture_diagram --provider=openai --model=gpt-5
 *
 * Invokes the internal Convex query
 * `eval/systemDesign/report:aggregateRunStats` via `bunx convex run`,
 * then pretty-prints the rollup to stdout. The wrapper mirrors
 * `reportUserCosts.ts` — same `bunx convex run` shape so both CLIs
 * share their auth model (the operator's existing dev / prod CLI
 * deployment auth).
 *
 * Output sections:
 *   1. Window header (range, days).
 *   2. Headline totals (runs, success rate, cache hit rate, cost,
 *      mean step count).
 *   3. By status (succeeded / failed / cached_hit / quality_rejected).
 *   4. By kind (per-kind success rate + cost + tokens).
 *   5. By provider:model.
 *   6. By failure reason (only rows that failed / quality-rejected).
 *
 * Numbers are USD with 4-decimal precision so $0.0034 reads do not
 * round to zero. Token counts compact via "k" / "M" suffixes.
 */

import { spawn } from "node:child_process";

interface KindRunBucket {
  totalRuns: number;
  succeededRuns: number;
  failedRuns: number;
  cachedHitRuns: number;
  qualityRejectedRuns: number;
  meanSteps: number;
  totalSteps: number;
  totalCostUsd: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedInputTokens: number;
  totalCacheWriteTokens: number;
  totalReasoningTokens: number;
  totalDurationMs: number;
}

interface KindRunStats {
  windowStart: number;
  windowEnd: number;
  windowDays: number;
  total: KindRunBucket;
  byStatus: Record<string, KindRunBucket>;
  byKind: Record<string, KindRunBucket>;
  byProviderModel: Record<string, KindRunBucket>;
  byFailureReason: Record<string, KindRunBucket>;
}

function parseArg(name: string): string | undefined {
  const flag = `--${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(flag)) {
      return arg.slice(flag.length);
    }
  }
  return undefined;
}

function formatUsd(usd: number): string {
  return `$${usd.toFixed(4)}`;
}

function formatTokens(n: number): string {
  if (n === 0) return "—";
  if (n < 1_000) return String(n);
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function formatPercent(numerator: number, denominator: number): string {
  if (denominator <= 0) return "—";
  return `${((numerator / denominator) * 100).toFixed(1)}%`;
}

function formatDuration(ms: number): string {
  if (ms < 1_000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function printBucketLine(label: string, bucket: KindRunBucket): void {
  const successRate = formatPercent(bucket.succeededRuns, bucket.totalRuns);
  const cacheRate = formatPercent(bucket.cachedHitRuns, bucket.totalRuns);
  console.log(
    `  ${label.padEnd(32)} ` +
      `runs=${String(bucket.totalRuns).padStart(4)} ` +
      `ok=${successRate.padStart(6)} ` +
      `cache=${cacheRate.padStart(6)} ` +
      `steps=${bucket.meanSteps.toFixed(1).padStart(5)} ` +
      `${formatUsd(bucket.totalCostUsd).padStart(11)} ` +
      `in=${formatTokens(bucket.totalInputTokens).padStart(7)} ` +
      `out=${formatTokens(bucket.totalOutputTokens).padStart(7)}`,
  );
}

async function runConvexQuery(module: string, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const json = JSON.stringify(args);
  return new Promise((resolve, reject) => {
    const child = spawn("bunx", ["convex", "run", `${module}:${fn}`, json], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`bunx convex run exited with ${code}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch (error) {
        reject(new Error(`Failed to parse Convex output as JSON: ${(error as Error).message}\n${stdout}`));
      }
    });
  });
}

async function main(): Promise<void> {
  const days = parseArg("days");
  const kind = parseArg("kind");
  const provider = parseArg("provider");
  const model = parseArg("model");

  const queryArgs: Record<string, unknown> = {};
  if (days) {
    const parsed = Number(days);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed <= 0) {
      console.error(`Invalid --days="${days}" — expected a positive integer.`);
      process.exit(2);
    }
    queryArgs.windowDays = parsed;
  }
  if (kind) queryArgs.kind = kind;
  if (provider) queryArgs.provider = provider;
  if (model) queryArgs.modelName = model;

  const result = (await runConvexQuery("eval/systemDesign/report", "aggregateRunStats", queryArgs)) as KindRunStats;

  const fmtDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

  console.log("");
  console.log(`System Design rollup`);
  console.log(`  window: ${fmtDate(result.windowStart)} → ${fmtDate(result.windowEnd)} (${result.windowDays}d)`);
  if (kind || provider || model) {
    const filters: string[] = [];
    if (kind) filters.push(`kind=${kind}`);
    if (provider) filters.push(`provider=${provider}`);
    if (model) filters.push(`model=${model}`);
    console.log(`  filters: ${filters.join("  ")}`);
  }
  console.log("");

  const t = result.total;
  console.log("Headline");
  console.log(`  total runs               ${t.totalRuns}`);
  console.log(`  succeeded                ${t.succeededRuns}  (${formatPercent(t.succeededRuns, t.totalRuns)})`);
  console.log(`  cache hit                ${t.cachedHitRuns}  (${formatPercent(t.cachedHitRuns, t.totalRuns)})`);
  console.log(`  failed                   ${t.failedRuns}`);
  console.log(`  quality rejected         ${t.qualityRejectedRuns}`);
  console.log(`  total cost               ${formatUsd(t.totalCostUsd)}`);
  console.log(`  mean steps / run         ${t.meanSteps.toFixed(2)}`);
  console.log(`  mean duration / run      ${formatDuration(t.totalRuns > 0 ? t.totalDurationMs / t.totalRuns : 0)}`);
  console.log("");

  console.log("By status");
  for (const [status, bucket] of Object.entries(result.byStatus)) {
    if (bucket.totalRuns === 0) continue;
    printBucketLine(status, bucket);
  }
  console.log("");

  console.log("By kind");
  const kindEntries = Object.entries(result.byKind).sort(([a], [b]) => a.localeCompare(b));
  for (const [name, bucket] of kindEntries) {
    printBucketLine(name, bucket);
  }
  if (kindEntries.length === 0) console.log("  (no runs in window)");
  console.log("");

  console.log("By provider:model");
  const modelEntries = Object.entries(result.byProviderModel).sort(([, a], [, b]) => b.totalCostUsd - a.totalCostUsd);
  for (const [name, bucket] of modelEntries) {
    printBucketLine(name, bucket);
  }
  if (modelEntries.length === 0) console.log("  (no runs in window)");
  console.log("");

  console.log("By failure reason");
  const failureEntries = Object.entries(result.byFailureReason).sort(([, a], [, b]) => b.totalRuns - a.totalRuns);
  for (const [name, bucket] of failureEntries) {
    printBucketLine(name, bucket);
  }
  if (failureEntries.length === 0) console.log("  (no failed or quality-rejected runs in window)");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
