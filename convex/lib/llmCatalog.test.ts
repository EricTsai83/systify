import { describe, expect, test } from "vitest";

import { getCatalogEntry, isValidPick, listPickableModels, MODEL_CATALOG } from "./llmCatalog";
import { TEST_INTERNALS as PRICING_INTERNALS } from "./llmPricing";

describe("MODEL_CATALOG", () => {
  test("has at least one OpenAI and one Anthropic entry", () => {
    const providers = new Set(MODEL_CATALOG.map((e) => e.provider));
    expect(providers.has("openai")).toBe(true);
    expect(providers.has("anthropic")).toBe(true);
  });

  test("modelName + provider are unique across entries", () => {
    const seen = new Set<string>();
    for (const entry of MODEL_CATALOG) {
      const key = `${entry.provider}:${entry.modelName}`;
      expect(seen.has(key), `duplicate catalog entry ${key}`).toBe(false);
      seen.add(key);
    }
  });

  test("every catalog entry has a matching pricing row (no silent zero-cost models)", () => {
    // Coverage invariant: a catalog entry without a pricing row
    // would return `undefined` from `estimateCostUsd`, which the
    // daily-cap settlement treats as "no cost recorded" — silently
    // letting users overspend through that model. Pin the pairing
    // at build time so the drift surfaces here, not in production
    // billing.
    const pricedKeys = new Set(PRICING_INTERNALS.pricingKeys());
    for (const entry of MODEL_CATALOG) {
      const key = `${entry.provider}:${entry.modelName}`;
      expect(pricedKeys.has(key), `catalog entry ${key} has no pricing row in llmPricing.ts`).toBe(true);
    }
  });

  test("embedding-capability entries never claim tool support and are not user-pickable", () => {
    // Embedding models cannot run tools (they only return vectors)
    // and are routed via the backend `embedViaGateway` — surfacing
    // them in the composer picker would just confuse the user.
    // Pin both invariants so a future catalog edit can't accidentally
    // expose an embedding row in the model picker.
    const embeddingEntries = MODEL_CATALOG.filter((entry) => entry.capability === "embedding");
    expect(embeddingEntries.length).toBeGreaterThan(0);
    for (const entry of embeddingEntries) {
      expect(
        entry.supportsTools,
        `embedding entry ${entry.provider}:${entry.modelName} must not claim tool support`,
      ).toBe(false);
      expect(entry.userPickable, `embedding entry ${entry.provider}:${entry.modelName} must not be user-pickable`).toBe(
        false,
      );
    }
  });
});

describe("getCatalogEntry", () => {
  test("returns the entry for a known pair", () => {
    const entry = getCatalogEntry("openai", "gpt-5");
    expect(entry?.displayName).toBe("GPT-5");
    expect(entry?.capability).toBe("sandbox");
  });

  test("returns undefined for a (provider, model) pair not in the catalog", () => {
    expect(getCatalogEntry("openai", "no-such-model")).toBeUndefined();
    expect(getCatalogEntry("anthropic", "gpt-5")).toBeUndefined();
  });
});

describe("isValidPick", () => {
  test("true for catalogued pairs", () => {
    expect(isValidPick("openai", "gpt-5")).toBe(true);
    expect(isValidPick("anthropic", "claude-opus-4-8")).toBe(true);
  });

  test("false for fabricated pairs", () => {
    expect(isValidPick("openai", "gpt-99")).toBe(false);
    expect(isValidPick("anthropic", "gpt-5")).toBe(false);
  });
});

describe("listPickableModels", () => {
  test("includes only userPickable entries", () => {
    const all = listPickableModels();
    expect(all.every((e) => e.userPickable)).toBe(true);
  });

  test("provider filter narrows the result", () => {
    const openaiOnly = listPickableModels({ provider: "openai" });
    expect(openaiOnly.length).toBeGreaterThan(0);
    expect(openaiOnly.every((e) => e.provider === "openai")).toBe(true);
  });

  test("capability filter narrows the result", () => {
    const sandboxTier = listPickableModels({ capability: "sandbox" });
    expect(sandboxTier.length).toBeGreaterThan(0);
    expect(sandboxTier.every((e) => e.capability === "sandbox")).toBe(true);
  });

  test("provider + capability compose", () => {
    const anthropicSandbox = listPickableModels({ provider: "anthropic", capability: "sandbox" });
    expect(anthropicSandbox.every((e) => e.provider === "anthropic" && e.capability === "sandbox")).toBe(true);
  });
});
