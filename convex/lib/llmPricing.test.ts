import { describe, expect, test } from "vitest";
import { costUsdToCents, estimateCostUsd, getPricing, TEST_INTERNALS } from "./llmPricing";

describe("estimateCostUsd", () => {
  test("calculates cost for a priced OpenAI model", () => {
    // 1M input @ $0.15 + 0.5M output @ $0.60 = $0.45
    expect(estimateCostUsd("openai", "gpt-4o-mini", { inputTokens: 1_000_000, outputTokens: 500_000 })).toBeCloseTo(
      0.45,
    );
  });

  test("returns undefined when (provider, model) pair is unknown", () => {
    expect(estimateCostUsd("openai", "unknown-model", { inputTokens: 1_000, outputTokens: 2_000 })).toBeUndefined();
  });

  test("returns undefined when both core token fields are missing", () => {
    expect(estimateCostUsd("openai", "gpt-4o-mini", {})).toBeUndefined();
    expect(estimateCostUsd("openai", "gpt-4o-mini", { cachedInputTokens: 100 })).toBeUndefined();
  });

  test("attributes partial cost when only one of input/output is present", () => {
    // 1M output @ $0.60 = $0.60 (no input → only output line charges)
    expect(estimateCostUsd("openai", "gpt-4o-mini", { outputTokens: 1_000_000 })).toBeCloseTo(0.6);
    // 1M input @ $0.15 = $0.15
    expect(estimateCostUsd("openai", "gpt-4o-mini", { inputTokens: 1_000_000 })).toBeCloseTo(0.15);
  });

  test("OpenAI gpt-5.5 sandbox tier prices correctly", () => {
    // 1M input @ $5 + 1M output @ $30 = $35
    expect(estimateCostUsd("openai", "gpt-5.5", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(35);
  });

  test("OpenAI gpt-5.4-mini discuss / library tier prices correctly", () => {
    // 1M input @ $0.25 + 1M output @ $2 = $2.25
    expect(estimateCostUsd("openai", "gpt-5.4-mini", { inputTokens: 1_000_000, outputTokens: 1_000_000 })).toBeCloseTo(
      2.25,
    );
  });

  test("Anthropic Opus 4.7 prices correctly", () => {
    // 1M input @ $5 + 1M output @ $25 = $30
    expect(
      estimateCostUsd("anthropic", "claude-opus-4-7", { inputTokens: 1_000_000, outputTokens: 1_000_000 }),
    ).toBeCloseTo(30);
  });

  test("cachedInputTokens are billed at the cache-read tier (Anthropic legacy Sonnet)", () => {
    // Sonnet: 0.5M cache read @ $0.30 + 0.5M input @ $3 + 1M output @ $15 = $16.65
    const cost = estimateCostUsd("anthropic", "claude-sonnet-4-6", {
      inputTokens: 500_000,
      cachedInputTokens: 500_000,
      outputTokens: 1_000_000,
    });
    expect(cost).toBeCloseTo(16.65);
  });

  test("cacheWriteTokens are billed at the premium write tier (Anthropic Opus 4.7)", () => {
    // 1M cache write @ $6.25 + 0M input + 0M output = $6.25
    expect(
      estimateCostUsd("anthropic", "claude-opus-4-7", {
        inputTokens: 0,
        outputTokens: 0,
        cacheWriteTokens: 1_000_000,
      }),
    ).toBeCloseTo(6.25);
  });

  test("reasoningTokens default to the output rate when no explicit reasoning tier", () => {
    // gpt-5.5 has no reasoningPerMillion → reasoning bills at output ($30/M)
    // 100k reasoning @ $30/M = $3
    expect(
      estimateCostUsd("openai", "gpt-5.5", { inputTokens: 0, outputTokens: 0, reasoningTokens: 100_000 }),
    ).toBeCloseTo(3);
  });

  test("a (provider, model) pair from one provider cannot resolve through the other", () => {
    // The gpt-5.5 entry lives under openai: — looking it up under anthropic: misses.
    expect(estimateCostUsd("anthropic", "gpt-5.5", { inputTokens: 1, outputTokens: 1 })).toBeUndefined();
  });

  test("OpenAI text-embedding-3-small prices input-only at $0.02/M", () => {
    // 1M input tokens @ $0.02 + 0 output @ $0 = $0.02 exactly.
    // Embedding rows carry `outputPerMillion: 0` so passing
    // `outputTokens: 0` from `embedViaGateway` lands a clean
    // input-only cost without a special path in `estimateCostUsd`.
    expect(
      estimateCostUsd("openai", "text-embedding-3-small", { inputTokens: 1_000_000, outputTokens: 0 }),
    ).toBeCloseTo(0.02);
  });

  test("OpenAI text-embedding-3-large prices input-only at $0.13/M", () => {
    expect(
      estimateCostUsd("openai", "text-embedding-3-large", { inputTokens: 1_000_000, outputTokens: 0 }),
    ).toBeCloseTo(0.13);
  });
});

describe("getPricing", () => {
  test("returns the pricing entry for a known pair", () => {
    const pricing = getPricing("openai", "gpt-5.5");
    expect(pricing).toBeDefined();
    expect(pricing?.inputPerMillion).toBe(5);
  });

  test("returns undefined for an unknown pair", () => {
    expect(getPricing("openai", "no-such-model")).toBeUndefined();
  });
});

describe("PRICING coverage shape", () => {
  test("all keys follow the provider:modelName convention", () => {
    for (const key of TEST_INTERNALS.pricingKeys()) {
      expect(key, `pricing key "${key}" should match <provider>:<modelName>`).toMatch(/^[a-z]+:[a-zA-Z0-9_.-]+$/);
    }
  });
});

describe("costUsdToCents", () => {
  test("ceiling-rounds positive costs so daily-cap settlement never under-charges", () => {
    // $0.001 → 1 cent (not 0). Without ceiling, ~100 sub-cent replies
    // could stack to a free dollar of sandbox spend per user.
    expect(costUsdToCents(0.001)).toBe(1);
    expect(costUsdToCents(0.04)).toBe(4);
    expect(costUsdToCents(0.045)).toBe(5);
    expect(costUsdToCents(0.05)).toBe(5);
    // Edge: exact-cent costs round to themselves, not 1 over.
    expect(costUsdToCents(1)).toBe(100);
  });

  test("returns undefined for undefined input so the settle helper can short-circuit", () => {
    expect(costUsdToCents(undefined)).toBeUndefined();
  });

  test("clamps negative / non-finite inputs to 0", () => {
    // Defensive: if a future provider returns a weird number, we don't
    // want to produce a negative `count` that the rate-limiter rejects.
    expect(costUsdToCents(-0.5)).toBe(0);
    expect(costUsdToCents(Number.NaN)).toBe(0);
    expect(costUsdToCents(Number.POSITIVE_INFINITY)).toBe(0);
  });

  test("zero cost converts to zero cents (not undefined) so the call site can distinguish heuristic from priced-zero", () => {
    expect(costUsdToCents(0)).toBe(0);
  });
});
