/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { convexTest } from "convex-test";
import { APICallError } from "ai";

import schema from "./schema";
import rateLimiterTestHelper from "@convex-dev/rate-limiter/test";
import {
  LlmRateLimitError,
  TEST_INTERNALS,
  embedViaGateway,
  generateViaGateway,
  type LlmCallContext,
} from "./lib/llmGateway";

const modules = import.meta.glob("./**/*.ts");

function createTestHarness() {
  const t = convexTest(schema, modules);
  rateLimiterTestHelper.register(t);
  return t;
}

// `vi.mock` hoists to the top of the file BEFORE all imports, so
// the factory spies have to live inside a `vi.hoisted` block —
// otherwise they're undefined when the mocked module is first
// resolved.
const { openaiFactory, openaiEmbeddingFactory, anthropicFactory } = vi.hoisted(() => {
  const openaiEmbeddingFactory = vi.fn(() => ({ id: "mock-openai-embedding" }) as unknown as never);
  const openaiFactoryFn = vi.fn(() => ({ id: "mock-openai" }) as unknown as never);
  // The OpenAI provider entry is callable AND exposes `.embedding(...)`.
  // Match that shape so `openai(modelName)` and `openai.embedding(modelName)`
  // both route through the hoisted spies.
  const openaiFactory = Object.assign(openaiFactoryFn, { embedding: openaiEmbeddingFactory });
  const anthropicFactory = vi.fn(() => ({ id: "mock-anthropic" }) as unknown as never);
  return { openaiFactory, openaiEmbeddingFactory, anthropicFactory };
});

vi.mock("@ai-sdk/openai", () => ({
  openai: openaiFactory,
}));

vi.mock("@ai-sdk/anthropic", () => ({
  anthropic: anthropicFactory,
}));

// `generateText` / `streamText` / `embedMany` are mocked at the
// module level so each test can swap the resolved/rejected value
// without re-wiring. Tests use `vi.mocked(...)` to control behavior.
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(),
    streamText: vi.fn(),
    embedMany: vi.fn(),
  };
});

import { embedMany, generateText } from "ai";

beforeEach(() => {
  openaiFactory.mockClear();
  openaiEmbeddingFactory.mockClear();
  anthropicFactory.mockClear();
  vi.mocked(generateText).mockReset();
  vi.mocked(embedMany).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// =====================================================================
// Test #4 — usage normalization
// =====================================================================

describe("TEST_INTERNALS.normalizeUsage", () => {
  test("OpenAI: pulls noCacheTokens / cacheReadTokens from inputTokenDetails", () => {
    const sdkUsage = {
      inputTokens: 1_200,
      outputTokens: 400,
      inputTokenDetails: {
        noCacheTokens: 900,
        cacheReadTokens: 300,
        cacheWriteTokens: undefined,
      },
      outputTokenDetails: {
        reasoningTokens: 50,
      },
    };
    const normalized = TEST_INTERNALS.normalizeUsage("openai", sdkUsage, undefined);
    expect(normalized).toEqual({
      inputTokens: 900,
      outputTokens: 400,
      cachedInputTokens: 300,
      cacheWriteTokens: undefined,
      reasoningTokens: 50,
    });
  });

  test("Anthropic: pulls cacheWriteTokens into the dedicated field", () => {
    const sdkUsage = {
      inputTokens: 800,
      outputTokens: 200,
      inputTokenDetails: {
        noCacheTokens: 500,
        cacheReadTokens: 100,
        cacheWriteTokens: 200,
      },
      outputTokenDetails: {
        reasoningTokens: undefined,
      },
    };
    const normalized = TEST_INTERNALS.normalizeUsage("anthropic", sdkUsage, undefined);
    expect(normalized).toEqual({
      inputTokens: 500,
      outputTokens: 200,
      cachedInputTokens: 100,
      cacheWriteTokens: 200,
      reasoningTokens: undefined,
    });
  });

  test("falls back to top-level inputTokens when inputTokenDetails is absent", () => {
    const sdkUsage = {
      inputTokens: 1_000,
      outputTokens: 250,
    };
    const normalized = TEST_INTERNALS.normalizeUsage("openai", sdkUsage, undefined);
    expect(normalized.inputTokens).toBe(1_000);
    expect(normalized.cachedInputTokens).toBeUndefined();
    expect(normalized.outputTokens).toBe(250);
  });

  test("undefined usage produces empty normalized shape", () => {
    expect(TEST_INTERNALS.normalizeUsage("openai", undefined, undefined)).toEqual({});
  });
});

// =====================================================================
// Test #1 — provider dispatch / providerOptions wiring
// =====================================================================

describe("TEST_INTERNALS.buildProviderOptions", () => {
  test("OpenAI reasoning model: reasoningEffort lands under providerOptions.openai", () => {
    const opts = TEST_INTERNALS.buildProviderOptions("openai", "gpt-5.5", {
      system: "s",
      prompt: "p",
      reasoningEffort: "high",
    });
    expect(opts).toEqual({ openai: { reasoningEffort: "high" } });
  });

  test("Anthropic reasoning model: reasoningEffort maps to a thinking-budget token count", () => {
    // Claude Opus 4.7 (`supportsReasoning: true`) — effort maps
    // to the budget table in `buildProviderOptions`:
    // minimal=1024, low=5000, medium=16000, high=32000.
    const opts = TEST_INTERNALS.buildProviderOptions("anthropic", "claude-opus-4-7", {
      system: "s",
      prompt: "p",
      reasoningEffort: "high",
    });
    expect(opts).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 32_000 } },
    });
  });

  test("Anthropic non-reasoning model (Haiku 4.5): reasoningEffort is dropped", () => {
    // Haiku 4.5 (`supportsReasoning: false`) — never gets a
    // thinking budget regardless of what the caller passes. Catches
    // a class of bugs where a stale effort from a prior message
    // leaks into a model that would reject the option.
    const opts = TEST_INTERNALS.buildProviderOptions("anthropic", "claude-haiku-4-5", {
      system: "s",
      prompt: "p",
      reasoningEffort: "high",
    });
    expect(opts).toBeUndefined();
  });

  test("Anthropic reasoning model: minimal effort hits the API floor (1024)", () => {
    const opts = TEST_INTERNALS.buildProviderOptions("anthropic", "claude-opus-4-7", {
      system: "s",
      prompt: "p",
      reasoningEffort: "minimal",
    });
    expect(opts).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 1_024 } },
    });
  });

  test("explicit providerOptions are merged through", () => {
    const opts = TEST_INTERNALS.buildProviderOptions("openai", "gpt-5.5", {
      system: "s",
      prompt: "p",
      reasoningEffort: "medium",
      providerOptions: { openai: { logprobs: 1 } },
    });
    expect(opts).toEqual({
      openai: { logprobs: 1, reasoningEffort: "medium" },
    });
  });

  test("no reasoningEffort + no providerOptions yields undefined", () => {
    expect(TEST_INTERNALS.buildProviderOptions("openai", "gpt-5.5", { system: "s", prompt: "p" })).toBeUndefined();
  });
});

// =====================================================================
// Gateway integration tests (slot release, RPM denial, dispatch)
// =====================================================================

function buildOkGenerateResult(text = "ok") {
  return {
    text,
    steps: [],
    totalUsage: {
      inputTokens: 100,
      outputTokens: 50,
      inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 },
      outputTokenDetails: { reasoningTokens: 0 },
    },
    providerMetadata: undefined,
    response: { id: "resp_test_123", timestamp: new Date(0), modelId: "mock" },
  } as unknown as Awaited<ReturnType<typeof generateText>>;
}

function buildCallCtx(overrides?: Partial<LlmCallContext>): LlmCallContext {
  return {
    provider: "openai",
    modelName: "gpt-5.5",
    ownerTokenIdentifier: "user|test",
    capability: "sandbox",
    feature: "system_design",
    ...overrides,
  };
}

describe("generateViaGateway — provider dispatch (#1)", () => {
  test("provider=openai routes through @ai-sdk/openai factory", async () => {
    vi.mocked(generateText).mockResolvedValueOnce(buildOkGenerateResult());
    const t = createTestHarness();
    await t.action(async (ctx) => {
      await generateViaGateway(ctx, buildCallCtx({ provider: "openai", modelName: "gpt-5.5" }), {
        system: "s",
        prompt: "p",
      });
    });
    expect(openaiFactory).toHaveBeenCalledWith("gpt-5.5");
    expect(anthropicFactory).not.toHaveBeenCalled();
  });

  test("provider=anthropic routes through @ai-sdk/anthropic factory", async () => {
    vi.mocked(generateText).mockResolvedValueOnce(buildOkGenerateResult());
    const t = createTestHarness();
    await t.action(async (ctx) => {
      await generateViaGateway(ctx, buildCallCtx({ provider: "anthropic", modelName: "claude-opus-4-7" }), {
        system: "s",
        prompt: "p",
      });
    });
    expect(anthropicFactory).toHaveBeenCalledWith("claude-opus-4-7");
    expect(openaiFactory).not.toHaveBeenCalled();
  });

  test("unsupported (provider, model) throws before any acquire happens", async () => {
    const t = createTestHarness();
    await expect(
      t.action(async (ctx) => {
        await generateViaGateway(ctx, buildCallCtx({ provider: "openai", modelName: "no-such-model" }), {
          system: "s",
          prompt: "p",
        });
      }),
    ).rejects.toThrow(/unsupported model pick/);
    // Factory never invoked because catalog check fails first.
    expect(openaiFactory).not.toHaveBeenCalled();
    expect(vi.mocked(generateText)).not.toHaveBeenCalled();
  });
});

// Test #5 — concurrency slot release on error. The slot release is
// the most common semaphore bug; we test it by:
//   1. Setting `LLM_CONCURRENT_CALLS_PER_USER=1` so we have a
//      single observable slot.
//   2. Calling generateViaGateway with an SDK that throws.
//   3. Then making a second call. If the first call's slot was NOT
//      released, the second call would block on concurrency
//      acquire (denied → LlmRateLimitError); if it WAS released,
//      the second call proceeds normally.
describe("generateViaGateway — slot release on error (#5)", () => {
  beforeEach(() => {
    process.env.LLM_CONCURRENT_CALLS_PER_USER = "1";
    process.env.LLM_REQUESTS_PER_USER_PER_MINUTE = "100";
  });
  afterEach(() => {
    delete process.env.LLM_CONCURRENT_CALLS_PER_USER;
    delete process.env.LLM_REQUESTS_PER_USER_PER_MINUTE;
  });

  test("releases the concurrency slot even when the SDK throws", async () => {
    const sdkError = new APICallError({
      message: "boom",
      url: "https://example.com",
      requestBodyValues: {},
      statusCode: 400, // 4xx so withLlmRetry fails fast (no retry waits)
    });
    vi.mocked(generateText).mockRejectedValueOnce(sdkError);

    const t = createTestHarness();

    // First call must throw (SDK errored).
    await expect(
      t.action(async (ctx) => {
        await generateViaGateway(ctx, buildCallCtx(), { system: "s", prompt: "p" });
      }),
    ).rejects.toBe(sdkError);

    // Second call must SUCCEED — proving the first call's slot was
    // returned. If the slot leaked, this call would throw
    // LlmRateLimitError("concurrency_exceeded") because capacity = 1.
    vi.mocked(generateText).mockResolvedValueOnce(buildOkGenerateResult());
    await t.action(async (ctx) => {
      await generateViaGateway(ctx, buildCallCtx(), { system: "s", prompt: "p" });
    });
  });
});

// Test #6 — RPM bucket denial. The plan reference test: set
// LLM_REQUESTS_PER_USER_PER_MINUTE=2, fire 3 calls in tight loop,
// assert third throws LlmRateLimitError("requests_per_minute_exceeded").
describe("generateViaGateway — RPM denial (#6)", () => {
  beforeEach(() => {
    process.env.LLM_REQUESTS_PER_USER_PER_MINUTE = "2";
    process.env.LLM_REQUESTS_PER_USER_PER_MINUTE_BURST = "2";
    process.env.LLM_CONCURRENT_CALLS_PER_USER = "100";
  });
  afterEach(() => {
    delete process.env.LLM_REQUESTS_PER_USER_PER_MINUTE;
    delete process.env.LLM_REQUESTS_PER_USER_PER_MINUTE_BURST;
    delete process.env.LLM_CONCURRENT_CALLS_PER_USER;
  });

  test("third call throws LlmRateLimitError('requests_per_minute_exceeded')", async () => {
    vi.mocked(generateText).mockResolvedValue(buildOkGenerateResult());
    const t = createTestHarness();
    const ctxArg = buildCallCtx({ ownerTokenIdentifier: "user|rpm-test" });
    const callOnce = () =>
      t.action(async (ctx) => {
        await generateViaGateway(ctx, ctxArg, { system: "s", prompt: "p" });
      });

    await callOnce();
    await callOnce();
    // The third call should be denied at the RPM bucket.
    await expect(callOnce()).rejects.toBeInstanceOf(LlmRateLimitError);
    try {
      await callOnce();
    } catch (error) {
      expect(error).toBeInstanceOf(LlmRateLimitError);
      const e = error as LlmRateLimitError;
      expect(e.code).toBe("requests_per_minute_exceeded");
      expect(e.retryAfterMs).toBeGreaterThan(0);
    }
  });
});

// =====================================================================
// embedViaGateway — provider dispatch + cost calculation
// =====================================================================

function buildOkEmbedResult(values: string[], embedding: number[] = [0.1, 0.2, 0.3], tokens = 42) {
  return {
    embeddings: values.map(() => embedding),
    values,
    usage: { tokens },
    providerMetadata: undefined,
    response: { id: "embed_resp_1", timestamp: new Date(0), modelId: "mock" },
  } as unknown as Awaited<ReturnType<typeof embedMany>>;
}

function buildEmbedCallCtx(overrides?: Partial<LlmCallContext>): LlmCallContext {
  return {
    provider: "openai",
    modelName: "text-embedding-3-small",
    ownerTokenIdentifier: "user|embed-test",
    capability: "embedding",
    feature: "system_design",
    ...overrides,
  };
}

describe("embedViaGateway — happy path", () => {
  test("routes to openai.embedding(modelName) and returns vectors + cost", async () => {
    const values = ["chunk-a", "chunk-b"];
    vi.mocked(embedMany).mockResolvedValueOnce(buildOkEmbedResult(values, [0.5, -0.5], 1_000_000));

    const t = createTestHarness();
    const result = await t.action(async (ctx) => embedViaGateway(ctx, buildEmbedCallCtx(), { values }));

    expect(openaiEmbeddingFactory).toHaveBeenCalledWith("text-embedding-3-small");
    expect(anthropicFactory).not.toHaveBeenCalled();
    expect(result.embeddings).toHaveLength(2);
    expect(result.embeddings[0]).toEqual([0.5, -0.5]);
    expect(result.usage.inputTokens).toBe(1_000_000);
    // 1M input @ $0.02 = $0.02
    expect(result.costUsd).toBeCloseTo(0.02);
  });

  test("rejects when capability is not 'embedding' (guards generate-only models)", async () => {
    const t = createTestHarness();
    await expect(
      t.action(async (ctx) =>
        embedViaGateway(
          ctx,
          buildEmbedCallCtx({
            provider: "openai",
            modelName: "text-embedding-3-small",
            capability: "discuss",
          }),
          { values: ["x"] },
        ),
      ),
    ).rejects.toThrow(/capability must be "embedding"/);
    // SDK never reached because capability assertion fails first.
    expect(vi.mocked(embedMany)).not.toHaveBeenCalled();
    expect(openaiEmbeddingFactory).not.toHaveBeenCalled();
  });

  test("rejects an anthropic embedding pick with a clear error", async () => {
    const t = createTestHarness();
    // Anthropic has no catalogued embedding entry — the catalog guard
    // fires first, before we get a chance to surface the
    // "no embedding API" message. Either error is acceptable; the
    // important thing is the SDK is never invoked.
    await expect(
      t.action(async (ctx) =>
        embedViaGateway(ctx, buildEmbedCallCtx({ provider: "anthropic", modelName: "text-embedding-3-small" }), {
          values: ["x"],
        }),
      ),
    ).rejects.toThrow();
    expect(vi.mocked(embedMany)).not.toHaveBeenCalled();
  });
});
