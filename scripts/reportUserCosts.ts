#!/usr/bin/env bun
/**
 * Per-user LLM cost rollup CLI.
 *
 * Usage:
 *   bun run report:user-costs --user=<ownerTokenIdentifier> [--since=YYYY-MM-DD] [--until=YYYY-MM-DD]
 *
 * Example:
 *   bun run report:user-costs --user=workos|user_xyz --since=2026-04-01
 *
 * The script invokes the internal Convex query
 * `lib.userCost.getUserCostBreakdown` via `bunx convex run`, then
 * pretty-prints the rollup to stdout. It does NOT talk to the Convex
 * client SDK directly — that would require the admin key on the
 * operator's machine, while `bunx convex run` reuses the same
 * deployment auth the dev / prod CLI already has configured.
 *
 * Output sections:
 *   1. Window header (range, ms span).
 *   2. Totals line (USD + token mix).
 *   3. By provider (USD per provider).
 *   4. By model (USD per provider:model pair).
 *   5. By feature (System Design vs. chat).
 *   6. By day (sparse — only days with spend).
 *
 * Numbers are USD with 4-decimal precision so $0.0034 cache reads do
 * not round to zero in the rollup. Token counts are integer.
 */

import { spawn } from "node:child_process";

interface CostBucket {
  usd: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  count: number;
}

interface Breakdown {
  total: CostBucket;
  byProvider: Record<string, CostBucket>;
  byModel: Record<string, CostBucket>;
  byFeature: { chat: CostBucket; systemDesign: CostBucket };
  byDay: Array<{ yyyymmdd: string; bucket: CostBucket }>;
}

function parseArg(name: string, fallback?: string): string | undefined {
  const flag = `--${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(flag)) {
      return arg.slice(flag.length);
    }
  }
  return fallback;
}

function dateToMs(yyyymmdd: string): number {
  // Parse as UTC midnight so day boundaries line up with the
  // server-side `utcDayKey` rollup.
  const [yyyy, mm, dd] = yyyymmdd.split("-").map(Number);
  if (!Number.isFinite(yyyy) || !Number.isFinite(mm) || !Number.isFinite(dd)) {
    throw new Error(`Invalid date "${yyyymmdd}" — expected YYYY-MM-DD.`);
  }
  return Date.UTC(yyyy, mm - 1, dd);
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

function printBucket(label: string, bucket: CostBucket): void {
  console.log(
    `  ${label.padEnd(28)} ${formatUsd(bucket.usd).padStart(12)}  ` +
      `in=${formatTokens(bucket.inputTokens).padStart(7)} ` +
      `out=${formatTokens(bucket.outputTokens).padStart(7)} ` +
      `cache=${formatTokens(bucket.cachedInputTokens).padStart(7)} ` +
      `n=${bucket.count}`,
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
  const owner = parseArg("user");
  if (!owner) {
    console.error(
      "Usage: bun run report:user-costs --user=<ownerTokenIdentifier> [--since=YYYY-MM-DD] [--until=YYYY-MM-DD]",
    );
    process.exit(2);
  }
  const since = parseArg("since");
  const until = parseArg("until");
  const sinceMs = since ? dateToMs(since) : Date.now() - 30 * 24 * 60 * 60_000;
  const untilMs = until ? dateToMs(until) : Date.now();

  const result = (await runConvexQuery("lib/userCost", "getUserCostBreakdown", {
    ownerTokenIdentifier: owner,
    sinceMs,
    untilMs,
  })) as Breakdown;

  const fmtRange = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

  console.log("");
  console.log(`Cost rollup for ${owner}`);
  console.log(`  window: ${fmtRange(sinceMs)} → ${fmtRange(untilMs)} (UTC)`);
  console.log("");

  console.log("Total");
  printBucket("(all)", result.total);
  console.log("");

  console.log("By provider");
  for (const [provider, bucket] of Object.entries(result.byProvider)) {
    if (bucket.count === 0) continue;
    printBucket(provider, bucket);
  }
  console.log("");

  console.log("By model");
  const modelEntries = Object.entries(result.byModel).sort(([, a], [, b]) => b.usd - a.usd);
  for (const [model, bucket] of modelEntries) {
    printBucket(model, bucket);
  }
  if (modelEntries.length === 0) {
    console.log("  (no System Design runs in window)");
  }
  console.log("");

  console.log("By feature");
  printBucket("chat", result.byFeature.chat);
  printBucket("systemDesign", result.byFeature.systemDesign);
  console.log("");

  console.log("By day");
  for (const { yyyymmdd, bucket } of result.byDay) {
    printBucket(yyyymmdd, bucket);
  }
  if (result.byDay.length === 0) {
    console.log("  (no spend in window)");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
