/**
 * Single chokepoint for every LLM call in the system.
 *
 * Imports `@ai-sdk/openai` and `@ai-sdk/anthropic` — these
 * imports MUST NOT appear anywhere else in `convex/`. The
 * `llmGateway.test.ts` provider-isolation test asserts this so a
 * future change that smuggles a provider SDK back into a call site
 * fails CI rather than silently breaks the abstraction.
 *
 * The gateway owns:
 *   1. Catalog validation (`isValidPick`).
 *   2. Per-user RPM acquire (`acquireLlmRequestSlot`).
 *   3. Per-user concurrency acquire (`acquireLlmConcurrencySlot`).
 *   4. Provider-dispatched SDK call wrapped in `withLlmRetry`.
 *   5. Usage normalization from each provider's `providerMetadata`.
 *   6. Cost computation via `estimateCostUsd`.
 *   7. Concurrency slot release (MUST run in `finally`).
 *   8. `llm_tokens_used` metric emission.
 *   9. Uniform `LlmGenerateResult` / `LlmStreamResult` return.
 *
 * The functions are TS async helpers, not registered Convex
 * actions — callers (which are themselves Convex actions) pass in
 * their `ActionCtx`. This keeps provider dispatch inline without
 * a runMutation hop for every LLM call.
 *
 * **Streaming settlement order is the failure-mode-critical bit.**
 * `streamViaGateway` returns an `LlmStreamResult` whose `final*`
 * promises settle exactly once — on natural completion, on stream
 * error, or on caller-invoked `abort()`. The concurrency slot
 * release is wired into a `try/finally` around the entire stream
 * lifecycle so a crashed consumer cannot leak a slot. The release
 * IS the most common semaphore bug — covered by an explicit unit
 * test in `llmGateway.test.ts`.
 */

import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import {
  type EmbeddingModel,
  type GenerateTextResult,
  type StepResult,
  type StopCondition,
  type StreamTextResult,
  type TextStreamPart,
  type ToolSet,
  embedMany,
  generateText,
  streamText,
} from "ai";

/**
 * Provider-options JSON shape forwarded into `generateText` /
 * `streamText`. Mirrors the AI SDK's `SharedV3ProviderOptions`
 * (`Record<string, JSONObject>`) without importing
 * `@ai-sdk/provider`, so non-gateway call sites that want to pass
 * provider-specific opts (`{ openai: { reasoningEffort: "high" } }`)
 * don't have to pull in an SDK package.
 *
 * Values are recursively-JSON, which the AI SDK enforces strictly:
 * a plain `unknown` would let callers smuggle non-serializable
 * values (functions, undefined, etc.) into the provider config and
 * surface as opaque downstream errors. The explicit JSON union
 * surfaces the same mistake at the call site.
 */
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };
export type ProviderOptions = Record<string, JsonObject>;

import { internal } from "../_generated/api";
import type { ActionCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

import type { ModelCapability, ReasoningEffort } from "./llmCatalog";
import { isValidPick } from "./llmCatalog";
import type { LlmProvider, NormalizedUsage } from "./llmProvider";
import { estimateCostUsd } from "./llmPricing";
import { emitMetric, logWarn } from "./observability";
import { withLlmRetry } from "./withLlmRetry";

/**
 * Per-call context. Travels with the call through retry, metric
 * emission, and observability. `feature` drives which dashboard
 * grouping the metric lands under; `jobId / threadId / messageId`
 * are optional forensic anchors.
 */
export interface LlmCallContext {
  provider: LlmProvider;
  modelName: string;
  ownerTokenIdentifier: string;
  capability: ModelCapability;
  feature: "chat" | "system_design" | "eval_judge" | "indexing";
  jobId?: Id<"jobs">;
  threadId?: Id<"threads">;
  messageId?: Id<"messages">;
}

/**
 * Per-step hook passed through to `streamText` / `generateText`. The chat
 * path uses this to inject a "you have X of N tool steps left" reminder
 * into the system prompt of every step after the first; other call sites
 * leave it unset.
 *
 * Defined as a narrow callback type (rather than re-exporting the AI
 * SDK's `PrepareStepCallback`) so non-gateway call sites don't have to
 * import the SDK to pass this through.
 */
export type PrepareStepCallback = (args: { stepNumber: number }) => { system?: string } | undefined;

/**
 * Arguments forwarded to the SDK call. `reasoningEffort` is a
 * gateway-level knob that the dispatch wires into provider-specific
 * `providerOptions` so callers don't have to know per-provider
 * key names.
 */
export interface LlmGenerateArgs {
  system: string;
  prompt: string;
  tools?: ToolSet;
  stopWhen?: StopCondition<ToolSet>;
  providerOptions?: ProviderOptions;
  reasoningEffort?: ReasoningEffort;
  /**
   * Optional per-step prompt rewrite. Mirrors the AI SDK's
   * `prepareStep` shape — `undefined` return keeps the outer `system`
   * prompt verbatim. The chat path uses this to insert a tool-budget
   * reminder; system design and eval paths leave it unset.
   */
  prepareStep?: PrepareStepCallback;
}

/**
 * Unified result returned by `generateViaGateway`. Steps and
 * usage are post-normalized — the caller does not need to read
 * `providerMetadata`.
 */
export interface LlmGenerateResult {
  text: string;
  steps: StepResult<ToolSet>[];
  usage: NormalizedUsage;
  costUsd: number | undefined;
  rawResponseId?: string;
}

/**
 * Unified streaming result. The promises settle after the stream
 * completes (success / error / abort). The slot release runs in a
 * `finally` block on the same code path that resolves these
 * promises, so a caller that awaits `finalUsage` is implicitly
 * also waiting for the slot release.
 */
export interface LlmStreamResult {
  /** Delta stream — mirrors `StreamTextResult.fullStream`. */
  fullStream: AsyncIterable<TextStreamPart<ToolSet>>;
  /** Settles with the concatenated assistant text. */
  finalText: Promise<string>;
  /** Settles with normalized usage. */
  finalUsage: Promise<NormalizedUsage>;
  /** Settles with cost USD (undefined when pricing missed). */
  finalCostUsd: Promise<number | undefined>;
  /** Settles with the step trace. */
  finalSteps: Promise<StepResult<ToolSet>[]>;
  /** Caller-invokable cancellation. Idempotent. */
  abort: () => void;
}

/**
 * Discriminated rate-limit error. Thrown by the gateway before any
 * provider call when either fairness bucket denies acquire. The
 * frontend branches on `code` for per-cause copy; the System
 * Design failure recorder maps both codes to
 * `failureReason: "transport_rate_limit"` for analytics.
 *
 * Does NOT extend `ConvexError` because gateway callers handle this
 * inline (the chat path surfaces it to the user; the System Design
 * path records it as a transport failure). A `ConvexError` would
 * have to be thrown from a mutation context, but the gateway is
 * called from actions — using a plain `Error` subclass keeps the
 * type honest.
 */
export class LlmRateLimitError extends Error {
  constructor(
    public readonly code: "requests_per_minute_exceeded" | "concurrency_exceeded",
    public readonly retryAfterMs: number,
  ) {
    super(`LLM rate limit: ${code} (retry after ${retryAfterMs}ms)`);
    this.name = "LlmRateLimitError";
  }
}

/**
 * Provider-agnostic embedding-usage shape. The AI SDK's
 * `EmbeddingModelUsage` exposes a single `tokens: number` field —
 * embeddings have no notion of input/output split, cache tiers, or
 * reasoning. We map that into `inputTokens` so the same
 * `estimateCostUsd` math (and any future cost dashboard) treats
 * embedding spend as input-only by construction.
 */
export interface NormalizedEmbeddingUsage {
  inputTokens: number;
}

/**
 * Arguments forwarded to the embedding SDK call. Mirrors the AI
 * SDK's `embedMany` shape — we always batch through `embedMany`
 * (even for a single value) so the call site doesn't have to branch
 * between `embed` and `embedMany`, and so per-batch usage settles
 * once per gateway invocation.
 */
export interface LlmEmbedArgs {
  values: string[];
}

/**
 * Unified embedding result. `embeddings` preserves the input order —
 * `embeddings[i]` is the vector for `args.values[i]`. `usage` is
 * the total tokens consumed across the batch; `costUsd` is computed
 * via `estimateCostUsd` against the catalogued model's input rate.
 */
export interface LlmEmbedResult {
  embeddings: number[][];
  usage: NormalizedEmbeddingUsage;
  costUsd: number | undefined;
}

/**
 * Batch embedding via the gateway. Mirrors `generateViaGateway`'s
 * 9-step internal flow (catalog validation → RPM acquire →
 * concurrency acquire → withLlmRetry-wrapped SDK call → usage
 * normalization → cost compute → metric emit → slot release in
 * finally → return).
 *
 * The `callCtx.capability` MUST be `"embedding"` — embedding
 * models are gated behind the dedicated capability so a generate
 * call site cannot accidentally route here, and so the catalog's
 * embedding-tier entries refuse a stray generation request.
 *
 * Throws `LlmRateLimitError` on gateway-level fairness denial.
 * Throws the original AI SDK / provider error after retry
 * exhaustion (`withLlmRetry` re-throws on terminal failure).
 */
export async function embedViaGateway(
  ctx: ActionCtx,
  callCtx: LlmCallContext,
  args: LlmEmbedArgs,
): Promise<LlmEmbedResult> {
  assertCatalogPick(callCtx);
  assertEmbeddingCapability(callCtx);
  await acquireRpmOrThrow(ctx, callCtx);
  await acquireConcurrencyOrThrow(ctx, callCtx);
  try {
    const result = await withLlmRetry(
      () =>
        embedMany({
          model: getSdkEmbeddingModel(callCtx.provider, callCtx.modelName),
          values: args.values,
          // Wrapper owns retries — see `withLlmRetry` contract.
          maxRetries: 0,
        }),
      {
        operation: `${callCtx.feature}.embed`,
        provider: callCtx.provider,
        modelName: callCtx.modelName,
        resourceId: callCtx.jobId ?? callCtx.messageId ?? callCtx.threadId,
      },
    );
    const usage: NormalizedEmbeddingUsage = { inputTokens: result.usage.tokens };
    // Reuse the generation cost calculator: embedding rows have
    // `outputPerMillion: 0` so passing `{ inputTokens, outputTokens: 0 }`
    // produces the correct input-only cost in one line.
    const costUsd = estimateCostUsd(callCtx.provider, callCtx.modelName, {
      inputTokens: usage.inputTokens,
      outputTokens: 0,
    });
    emitMetric("llm_embedding_tokens_used", {
      value: usage.inputTokens,
      tags: {
        provider: callCtx.provider,
        model: callCtx.modelName,
        feature: callCtx.feature,
      },
      details: {
        ownerTokenIdentifier: callCtx.ownerTokenIdentifier,
        inputTokens: usage.inputTokens,
        batchSize: args.values.length,
      },
    });
    // Vercel AI SDK's `embedMany` returns `embeddings: Embedding[]`,
    // where each Embedding is a readonly number[]. Spread into a
    // mutable shape so callers can persist without further coercion.
    return {
      embeddings: result.embeddings.map((embedding) => [...embedding]),
      usage,
      costUsd,
    };
  } finally {
    // MUST run on every exit path — including `withLlmRetry`
    // exhaustion — otherwise the slot leaks for up to HOUR.
    await releaseConcurrencyBestEffort(ctx, callCtx);
  }
}

/**
 * Single-shot generation. Returns once the model finishes (last
 * step's text + tool calls assembled).
 *
 * Throws `LlmRateLimitError` on gateway-level fairness denial.
 * Throws the original AI SDK / provider error after retry
 * exhaustion (`withLlmRetry` re-throws on terminal failure).
 */
export async function generateViaGateway(
  ctx: ActionCtx,
  callCtx: LlmCallContext,
  args: LlmGenerateArgs,
): Promise<LlmGenerateResult> {
  assertCatalogPick(callCtx);
  await acquireRpmOrThrow(ctx, callCtx);
  await acquireConcurrencyOrThrow(ctx, callCtx);
  try {
    const result = await withLlmRetry(
      () =>
        generateText({
          model: getSdkModel(callCtx.provider, callCtx.modelName),
          system: args.system,
          prompt: args.prompt,
          ...(args.tools ? { tools: args.tools } : {}),
          ...(args.stopWhen ? { stopWhen: args.stopWhen } : {}),
          providerOptions: buildProviderOptions(callCtx.provider, args),
          // Wrapper owns retries — see `withLlmRetry` contract.
          maxRetries: 0,
        }),
      {
        operation: `${callCtx.feature}.generate`,
        provider: callCtx.provider,
        modelName: callCtx.modelName,
        resourceId: callCtx.jobId ?? callCtx.messageId ?? callCtx.threadId,
      },
    );
    const usage = normalizeGenerateUsage(callCtx.provider, result);
    const costUsd = estimateCostUsd(callCtx.provider, callCtx.modelName, usage);
    emitMetric("llm_tokens_used", {
      value: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
      tags: {
        provider: callCtx.provider,
        model: callCtx.modelName,
        feature: callCtx.feature,
      },
      details: {
        ownerTokenIdentifier: callCtx.ownerTokenIdentifier,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        reasoningTokens: usage.reasoningTokens,
      },
    });
    return {
      text: result.text,
      steps: result.steps,
      usage,
      costUsd,
      rawResponseId: result.response.id,
    };
  } finally {
    // MUST run on every exit path — including `withLlmRetry`
    // exhaustion — otherwise the slot leaks for up to HOUR.
    await releaseConcurrencyBestEffort(ctx, callCtx);
  }
}

/**
 * Streaming generation. Returns synchronously with an
 * `LlmStreamResult`; the caller consumes `fullStream` and awaits
 * the `final*` promises after stream completion.
 *
 * The concurrency slot is held until the stream settles (natural
 * completion, error, or `abort()`). On error or abort, partial
 * usage / cost is reported when the SDK provides it; otherwise
 * the `final*` promises reject with the underlying error.
 *
 * Acquire steps happen synchronously inside this call before the
 * SDK is invoked. Errors from acquire surface as a rejected
 * Promise from the function call itself.
 */
export async function streamViaGateway(
  ctx: ActionCtx,
  callCtx: LlmCallContext,
  args: LlmGenerateArgs,
): Promise<LlmStreamResult> {
  assertCatalogPick(callCtx);
  await acquireRpmOrThrow(ctx, callCtx);
  await acquireConcurrencyOrThrow(ctx, callCtx);

  const abortController = new AbortController();
  // streamText is synchronous — returns the StreamTextResult
  // immediately; the stream itself is consumed via the
  // AsyncIterable on `.fullStream`. We need NOT use `withLlmRetry`
  // here because retry on a streaming call would require buffering
  // and replaying the prompt; the chat / system-design call sites
  // surface stream errors directly to the user / job recorder.
  let sdkResult: StreamTextResult<ToolSet, never>;
  try {
    sdkResult = streamText({
      model: getSdkModel(callCtx.provider, callCtx.modelName),
      system: args.system,
      prompt: args.prompt,
      ...(args.tools ? { tools: args.tools } : {}),
      ...(args.stopWhen ? { stopWhen: args.stopWhen } : {}),
      ...(args.prepareStep ? { prepareStep: args.prepareStep } : {}),
      providerOptions: buildProviderOptions(callCtx.provider, args),
      abortSignal: abortController.signal,
      maxRetries: 0,
    });
  } catch (error) {
    // Synchronous `streamText` failure (e.g. catalog validation
    // inside the SDK). Release the slot before re-throwing.
    await releaseConcurrencyBestEffort(ctx, callCtx);
    throw error;
  }

  // Settlement runs exactly once. Wires every exit path
  // (natural completion, error inside the stream, caller abort)
  // through the same release + metric + promise-resolve sequence.
  let settled = false;
  const settle = async (): Promise<{
    text: string;
    usage: NormalizedUsage;
    costUsd: number | undefined;
    steps: StepResult<ToolSet>[];
  }> => {
    if (settled) {
      // Should never happen — guarded so a double-await (caller
      // awaits all four `final*` promises sequentially) doesn't
      // double-release.
      throw new Error("LlmStreamResult settled twice");
    }
    settled = true;
    try {
      const [text, sdkUsage, providerMetadata, steps] = await Promise.all([
        sdkResult.text,
        sdkResult.totalUsage,
        sdkResult.providerMetadata,
        sdkResult.steps,
      ]);
      const usage = normalizeUsage(callCtx.provider, sdkUsage, providerMetadata);
      const costUsd = estimateCostUsd(callCtx.provider, callCtx.modelName, usage);
      emitMetric("llm_tokens_used", {
        value: (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0),
        tags: {
          provider: callCtx.provider,
          model: callCtx.modelName,
          feature: callCtx.feature,
        },
        details: {
          ownerTokenIdentifier: callCtx.ownerTokenIdentifier,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cachedInputTokens: usage.cachedInputTokens,
          cacheWriteTokens: usage.cacheWriteTokens,
          reasoningTokens: usage.reasoningTokens,
        },
      });
      return { text, usage, costUsd, steps };
    } finally {
      // MUST run regardless of whether the promise chain
      // resolved or rejected. Most common semaphore bug.
      await releaseConcurrencyBestEffort(ctx, callCtx);
    }
  };

  // We compute settlement once and share the result across the
  // four `final*` promises. Using `.then` to project each field
  // keeps the contract: any of the four resolves after the slot
  // releases.
  const settlementPromise = settle();

  return {
    fullStream: sdkResult.fullStream,
    finalText: settlementPromise.then((s) => s.text),
    finalUsage: settlementPromise.then((s) => s.usage),
    finalCostUsd: settlementPromise.then((s) => s.costUsd),
    finalSteps: settlementPromise.then((s) => s.steps),
    abort: () => abortController.abort(),
  };
}

function assertCatalogPick(callCtx: LlmCallContext): void {
  if (!isValidPick(callCtx.provider, callCtx.modelName)) {
    throw new Error(
      `LlmGateway: unsupported model pick ${callCtx.provider}:${callCtx.modelName} (not in MODEL_CATALOG)`,
    );
  }
}

/**
 * Guard `embedViaGateway` so a generate-tier model can never be
 * dispatched through the embedding path (and vice-versa: a generate
 * call site cannot mistakenly route an embedding model through
 * `generateViaGateway` — that would fail at the SDK boundary, but
 * this guard surfaces the bug at the gateway with a clear error).
 */
function assertEmbeddingCapability(callCtx: LlmCallContext): void {
  if (callCtx.capability !== "embedding") {
    throw new Error(
      `LlmGateway.embedViaGateway: capability must be "embedding" (got "${callCtx.capability}") for ${callCtx.provider}:${callCtx.modelName}`,
    );
  }
}

async function acquireRpmOrThrow(ctx: ActionCtx, callCtx: LlmCallContext): Promise<void> {
  const status = await ctx.runMutation(internal.lib.rateLimit.acquireLlmRequestSlot, {
    ownerTokenIdentifier: callCtx.ownerTokenIdentifier,
  });
  if (!status.ok) {
    emitMetric("llm_request_rate_denied", {
      value: status.retryAfterMs,
      tags: { provider: callCtx.provider, feature: callCtx.feature },
      details: { ownerTokenIdentifier: callCtx.ownerTokenIdentifier },
    });
    throw new LlmRateLimitError("requests_per_minute_exceeded", status.retryAfterMs);
  }
  emitMetric("llm_request_rate_acquired", {
    tags: { provider: callCtx.provider, feature: callCtx.feature },
    details: { ownerTokenIdentifier: callCtx.ownerTokenIdentifier },
  });
}

async function acquireConcurrencyOrThrow(ctx: ActionCtx, callCtx: LlmCallContext): Promise<void> {
  const status = await ctx.runMutation(internal.lib.rateLimit.acquireLlmConcurrency, {
    ownerTokenIdentifier: callCtx.ownerTokenIdentifier,
  });
  if (!status.ok) {
    emitMetric("llm_concurrency_denied", {
      value: status.retryAfterMs,
      tags: { provider: callCtx.provider, feature: callCtx.feature },
      details: { ownerTokenIdentifier: callCtx.ownerTokenIdentifier },
    });
    throw new LlmRateLimitError("concurrency_exceeded", status.retryAfterMs);
  }
  emitMetric("llm_concurrency_acquired", {
    tags: { provider: callCtx.provider, feature: callCtx.feature },
    details: { ownerTokenIdentifier: callCtx.ownerTokenIdentifier },
  });
}

/**
 * Release the slot regardless of upstream success / failure.
 * Swallows release errors with a warn log — releasing into a
 * disconnected backend is worth a warning, never a re-throw
 * that masks the original error.
 */
async function releaseConcurrencyBestEffort(ctx: ActionCtx, callCtx: LlmCallContext): Promise<void> {
  try {
    await ctx.runMutation(internal.lib.rateLimit.releaseLlmConcurrency, {
      ownerTokenIdentifier: callCtx.ownerTokenIdentifier,
    });
    emitMetric("llm_concurrency_released", {
      tags: { provider: callCtx.provider, feature: callCtx.feature },
      details: { ownerTokenIdentifier: callCtx.ownerTokenIdentifier },
    });
  } catch (error) {
    logWarn("llm", "concurrency_release_failed", {
      provider: callCtx.provider,
      modelName: callCtx.modelName,
      feature: callCtx.feature,
      ownerTokenIdentifier: callCtx.ownerTokenIdentifier,
      // Best-effort: the slot will refresh at the next bucket
      // window boundary even if the release patch failed.
      hint: "Slot will be reclaimed when the bucket window resets.",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Per-provider model handle. Adding a third provider = add a case
 * here + the catalog entry; no call site changes.
 */
function getSdkModel(provider: LlmProvider, modelName: string) {
  switch (provider) {
    case "openai":
      return openai(modelName);
    case "anthropic":
      return anthropic(modelName);
  }
}

/**
 * Per-provider embedding-model handle. Anthropic does NOT publish
 * an embedding API today — the catalog refuses to register an
 * embedding entry under `anthropic`, so this branch is unreachable
 * via valid catalog picks. The explicit throw documents the
 * boundary so a future "anthropic adds embeddings" change surfaces
 * here, not as a cryptic SDK error.
 */
function getSdkEmbeddingModel(provider: LlmProvider, modelName: string): EmbeddingModel {
  switch (provider) {
    case "openai":
      return openai.embedding(modelName);
    case "anthropic":
      throw new Error(
        `LlmGateway: provider "anthropic" does not support embeddings (model ${modelName}); ` +
          "no Anthropic embedding API is currently published.",
      );
  }
}

/**
 * Translate gateway-level args into provider-specific
 * `providerOptions`. Today only `reasoningEffort` differs across
 * providers (OpenAI uses the field; Anthropic ignores it — PR-A3
 * adds the thinking-budget knob for Anthropic).
 */
function buildProviderOptions(provider: LlmProvider, args: LlmGenerateArgs): ProviderOptions | undefined {
  const merged: ProviderOptions = { ...(args.providerOptions ?? {}) };
  if (args.reasoningEffort !== undefined) {
    switch (provider) {
      case "openai": {
        const existing = (merged.openai as Record<string, unknown>) ?? {};
        merged.openai = { ...existing, reasoningEffort: args.reasoningEffort };
        break;
      }
      case "anthropic":
        // Anthropic exposes thinking budget separately; PR-A3
        // wires it. For PR-A1 we accept the arg silently so
        // OpenAI-shaped callers don't have to branch.
        break;
    }
  }
  return Object.keys(merged).length === 0 ? undefined : merged;
}

/**
 * Normalize usage for `generateText` results. Reads the
 * provider-specific `providerMetadata` fields and produces a
 * uniform `NormalizedUsage`.
 */
function normalizeGenerateUsage(provider: LlmProvider, result: GenerateTextResult<ToolSet, never>): NormalizedUsage {
  return normalizeUsage(provider, result.totalUsage, result.providerMetadata);
}

/**
 * AI SDK v6 surfaces cache + reasoning splits structurally on
 * `LanguageModelUsage.inputTokenDetails` /
 * `outputTokenDetails`. We map those directly into
 * `NormalizedUsage` so pricing sees non-overlapping segments:
 *
 *   - `inputTokens`        ← `noCacheTokens` (uncached prompt)
 *   - `cachedInputTokens`  ← `cacheReadTokens`
 *   - `cacheWriteTokens`   ← `cacheWriteTokens` (Anthropic)
 *   - `outputTokens`       ← top-level `outputTokens`
 *   - `reasoningTokens`    ← `outputTokenDetails.reasoningTokens`
 *
 * The `providerMetadata` argument is currently unused — kept on the
 * signature so the function can absorb provider-specific fields
 * (e.g. a future Gemini cache-tier counter) without a call-site
 * change.
 *
 * Fallback contract: when `inputTokenDetails` is missing (older
 * provider or partial usage from an errored stream), we fall back
 * to the top-level `inputTokens` as the uncached count. This
 * matches the existing chat-path behaviour pre-gateway —
 * over-bills the cache portion at the input rate rather than
 * dropping the call to "cost unknown".
 */
function normalizeUsage(
  _provider: LlmProvider,
  sdkUsage:
    | {
        inputTokens?: number | undefined;
        outputTokens?: number | undefined;
        inputTokenDetails?: {
          noCacheTokens?: number | undefined;
          cacheReadTokens?: number | undefined;
          cacheWriteTokens?: number | undefined;
        };
        outputTokenDetails?: {
          reasoningTokens?: number | undefined;
        };
      }
    | undefined,
  _providerMetadata: Record<string, unknown> | undefined,
): NormalizedUsage {
  if (!sdkUsage) return {};
  const inputDetails = sdkUsage.inputTokenDetails;
  const outputDetails = sdkUsage.outputTokenDetails;
  const inputTokens = inputDetails?.noCacheTokens ?? sdkUsage.inputTokens;
  const cachedInputTokens = inputDetails?.cacheReadTokens;
  const cacheWriteTokens = inputDetails?.cacheWriteTokens;
  const reasoningTokens = outputDetails?.reasoningTokens;
  return {
    inputTokens,
    outputTokens: sdkUsage.outputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    reasoningTokens,
  };
}

/**
 * Test-only export. Exposes the otherwise-private normalization
 * function so the usage-normalization unit test can pin behaviour
 * without invoking the full SDK round-trip.
 */
export const TEST_INTERNALS = {
  normalizeUsage,
  buildProviderOptions,
} as const;
