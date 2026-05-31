#!/usr/bin/env bun
/**
 * System Design eval runner CLI.
 *
 * Usage:
 *   bun run eval:system-design \
 *     --repos=slug1:k57abc...,slug2:k58def... \
 *     [--corpus=slug1,slug2] \
 *     [--kinds=architecture_overview,security_overview] \
 *     [--budgets=10,20,30] \
 *     [--provider=openai] \
 *     [--model=gpt-5] \
 *     [--output=eval-results/<custom>.jsonl] \
 *     [--no-judge]
 *
 * Required: `--repos` — operator must pre-import each corpus repo
 * into their Convex deployment and supply the slug → repositoryId
 * map. Slugs not in the map are reported in the skipped section.
 *
 * Optional: `--no-judge` skips the judge phase. Useful for cheap
 * smoke runs that only verify the prompt + sandbox pipeline.
 *
 * Output: a JSONL file under `eval-results/` (gitignored). One line
 * per `EvalRunRecord`. Default filename uses the UTC timestamp so
 * back-to-back runs don't clobber.
 *
 * Implementation note: spawns `bunx convex run` to invoke the
 * `runEval` internal action — same auth model as the existing
 * report CLIs. The runner returns its records in stdout JSON; this
 * script ensures the output directory exists, then writes JSONL.
 */

import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serializeEvalRecordsJsonl, type EvalRunRecord } from "../convex/eval/systemDesign/aggregate";
import { SYSTEM_DESIGN_KINDS, type SystemDesignKind } from "../convex/lib/systemDesign";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(HERE, "..");
const RUBRIC_DIR = path.join(PROJECT_ROOT, "convex", "eval", "systemDesign", "rubrics");
const DEFAULT_OUTPUT_DIR = path.join(PROJECT_ROOT, "eval-results");

interface RunEvalResult {
  records: EvalRunRecord[];
  skipped: Array<{
    slug: string;
    reason: string;
    detail?: string;
    sandboxReason?: string;
  }>;
}

function parseArg(name: string): string | undefined {
  const flag = `--${name}=`;
  for (const arg of process.argv.slice(2)) {
    if (arg.startsWith(flag)) return arg.slice(flag.length);
  }
  return undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.slice(2).includes(`--${name}`);
}

function parseReposArg(value: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const sep = trimmed.indexOf(":");
    if (sep < 0) {
      throw new Error(`Invalid --repos entry "${trimmed}" — expected slug:repositoryId`);
    }
    const slug = trimmed.slice(0, sep).trim();
    const id = trimmed.slice(sep + 1).trim();
    if (!slug || !id) {
      throw new Error(`Invalid --repos entry "${trimmed}" — slug or id is empty`);
    }
    out[slug] = id;
  }
  return out;
}

function utcTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

async function loadRubrics(): Promise<Record<string, string>> {
  const rubrics: Record<string, string> = {};
  for (const kind of SYSTEM_DESIGN_KINDS) {
    const rubricPath = path.join(RUBRIC_DIR, `${kind}.md`);
    try {
      rubrics[kind] = await readFile(rubricPath, "utf8");
    } catch (error) {
      throw new Error(`Failed to read rubric for ${kind} at ${rubricPath}: ${(error as Error).message}`);
    }
  }
  return rubrics;
}

async function runConvexAction(module: string, fn: string, args: Record<string, unknown>): Promise<unknown> {
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
  const reposRaw = parseArg("repos");
  if (!reposRaw) {
    console.error(
      "Usage: bun run eval:system-design --repos=slug:repoId,slug:repoId [--corpus=...] [--kinds=...] [--budgets=...] [--provider=openai] [--model=gpt-5] [--output=...] [--no-judge]",
    );
    process.exit(2);
  }
  const repositoryIds = parseReposArg(reposRaw);
  if (Object.keys(repositoryIds).length === 0) {
    console.error("--repos must include at least one slug:repositoryId pair.");
    process.exit(2);
  }

  const corpusSlugs = parseArg("corpus")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const kinds = parseArg("kinds")
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean) as SystemDesignKind[] | undefined;
  const budgets = parseArg("budgets")
    ?.split(",")
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  const provider = parseArg("provider");
  const model = parseArg("model");
  const skipJudge = hasFlag("no-judge");
  const outputRaw = parseArg("output");

  const rubrics = skipJudge ? undefined : await loadRubrics();

  const queryArgs: Record<string, unknown> = { repositoryIds };
  if (corpusSlugs && corpusSlugs.length > 0) queryArgs.corpusSlugs = corpusSlugs;
  if (kinds && kinds.length > 0) queryArgs.kinds = kinds;
  if (budgets && budgets.length > 0) queryArgs.budgets = budgets;
  if (provider) queryArgs.provider = provider;
  if (model) queryArgs.modelName = model;
  if (rubrics) queryArgs.rubrics = rubrics;

  console.log("Running eval — this may take several minutes per corpus entry…");
  const raw = await runConvexAction("eval/systemDesign/runner", "runEval", queryArgs);
  const result = raw as RunEvalResult;

  const outputPath = outputRaw ? path.resolve(outputRaw) : path.join(DEFAULT_OUTPUT_DIR, `${utcTimestamp()}.jsonl`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serializeEvalRecordsJsonl(result.records), "utf8");

  console.log("");
  console.log(`Records written: ${result.records.length}`);
  console.log(`Output:          ${outputPath}`);
  if (result.skipped.length > 0) {
    console.log("");
    console.log(`Skipped (${result.skipped.length}):`);
    for (const entry of result.skipped) {
      const detail = entry.detail ? ` — ${entry.detail}` : "";
      const sub = entry.sandboxReason ? ` (${entry.sandboxReason})` : "";
      console.log(`  ${entry.slug.padEnd(24)} ${entry.reason}${sub}${detail}`);
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
