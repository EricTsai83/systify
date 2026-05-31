/**
 * LLM-as-judge for System Design eval.
 *
 * Pins the model: `(provider: "openai", modelName: "gpt-5-nano")`.
 * The judge model is part of the eval contract — bumping it
 * invalidates every prior score, so we keep it in code (not env)
 * and require a deliberate edit.
 *
 * Module is a plain async helper (not an `internalAction`) so the
 * Node runner (`runner.ts`) can call it inline. The gateway carries
 * the call through the same retry / rate-limit / cost pipeline as
 * production chat — eval traffic shows up in dashboards tagged
 * `feature: "eval_judge"` and `model: "gpt-5-nano"`.
 *
 * The judge does NOT enforce a JSON schema at the SDK layer (the AI
 * SDK's `output: object({...})` would round-trip to a tool call,
 * which `gpt-5-nano` cannot do). Instead we ask for raw JSON in the
 * prompt and tolerate parse failures by returning a `parseError` —
 * the caller still records the failed trial rather than throwing.
 */

import type { ActionCtx } from "../../_generated/server";
import { generateViaGateway } from "../../lib/llmGateway";
import type { SystemDesignKind } from "../../lib/systemDesign";
import type { JudgeAxisScores } from "./aggregate";

export type { JudgeAxisScores };

export interface JudgeResult {
  axes: JudgeAxisScores;
  comments: string;
  overallScore: number;
  /** Set when the judge model's JSON did not parse. Axes are zero in that case. */
  parseError?: string;
  rawOutput?: string;
}

const JUDGE_PROVIDER = "openai" as const;
const JUDGE_MODEL = "gpt-5-nano";
const EVAL_HARNESS_OWNER = "eval:harness";

const ZERO_AXES: JudgeAxisScores = {
  faithfulness: 0,
  completeness: 0,
  specificity: 0,
  citationQuality: 0,
};

export async function judgeArtifact(
  ctx: ActionCtx,
  args: {
    kind: SystemDesignKind;
    contentMarkdown: string;
    rubricMarkdown: string;
    ownerTokenIdentifier?: string;
  },
): Promise<JudgeResult> {
  const system = [
    "You are an LLM judge scoring System Design documents.",
    "Read the rubric carefully — it defines the scoring axes and failure / excellence signals.",
    "Then read the candidate document.",
    "Return ONLY a JSON object matching the rubric's Output Format. No prose before or after.",
    "Each axis is an integer 1-5. Be calibrated: a 5 is exceptional and rare; a 3 is competent.",
  ].join(" ");

  const prompt = [
    `Kind: ${args.kind}`,
    "",
    "=== Rubric ===",
    args.rubricMarkdown,
    "",
    "=== Candidate Document ===",
    args.contentMarkdown,
    "",
    "=== Your JSON ===",
  ].join("\n");

  const result = await generateViaGateway(
    ctx,
    {
      provider: JUDGE_PROVIDER,
      modelName: JUDGE_MODEL,
      ownerTokenIdentifier: args.ownerTokenIdentifier ?? EVAL_HARNESS_OWNER,
      capability: "discuss",
      feature: "eval_judge",
    },
    { system, prompt },
  );

  return parseJudgeOutput(result.text);
}

/**
 * Parse the judge's raw text. Strategy:
 *   1. Try a direct `JSON.parse`.
 *   2. If that fails, search for the first balanced `{...}` block
 *      and parse THAT. Some smaller models wrap the JSON in
 *      "Sure, here is your JSON:" prose despite the instruction.
 *   3. Coerce axes into `1..5` integers; clamp out-of-range. Missing
 *      axis → 0 (caller can spot the gap via `parseError`).
 *
 * Exposed for unit-testing without invoking the gateway.
 */
export function parseJudgeOutput(rawText: string): JudgeResult {
  const tryDirect = safeJsonParse(rawText);
  const parsed = tryDirect ?? safeJsonParse(extractFirstJsonObject(rawText) ?? "");
  if (!parsed || typeof parsed !== "object") {
    return {
      axes: ZERO_AXES,
      comments: "",
      overallScore: 0,
      parseError: "Judge output was not valid JSON.",
      rawOutput: rawText.slice(0, 1024),
    };
  }
  const axesRaw = (parsed as { axes?: unknown }).axes;
  if (!axesRaw || typeof axesRaw !== "object") {
    return {
      axes: ZERO_AXES,
      comments:
        typeof (parsed as { comments?: unknown }).comments === "string"
          ? (parsed as { comments: string }).comments
          : "",
      overallScore: 0,
      parseError: "Judge output JSON missing `axes` object.",
      rawOutput: rawText.slice(0, 1024),
    };
  }

  const axes: JudgeAxisScores = {
    faithfulness: clampAxis((axesRaw as Record<string, unknown>).faithfulness),
    completeness: clampAxis((axesRaw as Record<string, unknown>).completeness),
    specificity: clampAxis((axesRaw as Record<string, unknown>).specificity),
    citationQuality: clampAxis((axesRaw as Record<string, unknown>).citationQuality),
  };

  const overallScore =
    Math.round(((axes.faithfulness + axes.completeness + axes.specificity + axes.citationQuality) / 4) * 100) / 100;

  return {
    axes,
    comments:
      typeof (parsed as { comments?: unknown }).comments === "string" ? (parsed as { comments: string }).comments : "",
    overallScore,
  };
}

function safeJsonParse(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Scan for the first top-level `{...}` balanced block. Bracket
 * counting is sufficient — JSON strings can't contain unescaped
 * braces, and our judge prompt asks for raw JSON without code
 * fences, so we don't need a full tokenizer.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function clampAxis(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n < 1) return 1;
  if (n > 5) return 5;
  return Math.round(n);
}

export const TEST_INTERNALS = {
  parseJudgeOutput,
  extractFirstJsonObject,
  clampAxis,
} as const;
