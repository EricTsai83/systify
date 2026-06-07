import { describe, expect, test } from "vitest";

import {
  ARTIFACT_CHUNK_EMBEDDING_DIMENSIONS,
  getCatalogEntry,
  isSupportedReasoningEffort,
  isUserPickableModel,
  isValidPick,
  listPickableModels,
  MODEL_CATALOG,
  ROLE_MODELS,
} from "./llmCatalog";
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

  test("every ROLE_MODELS entry resolves to a valid catalog row (swap-safety guard)", () => {
    // The role → catalog binding is the contract that makes
    // "swap a model = one-line edit" work. A role whose modelName
    // drifts out of the catalog would crash the gateway on first
    // invocation; pinning the invariant here catches the drift at
    // build time.
    for (const [role, pick] of Object.entries(ROLE_MODELS)) {
      expect(isValidPick(pick.provider, pick.modelName), `ROLE_MODELS.${role} missing catalog entry`).toBe(true);
    }
  });

  test("every user-pickable reasoning model carries a reasoningEffort default", () => {
    // Picker UX assumption: a reasoning-capable model resolved
    // through the catalog default should land on a non-undefined
    // effort so the gateway can apply provider options without
    // re-deriving from a per-model lookup. Anthropic entries are
    // explicitly OK without a default (catalog stays OpenAI-shaped
    // — the gateway maps `undefined` → catalog default upstream).
    for (const entry of MODEL_CATALOG) {
      if (entry.userPickable && entry.supportsReasoning && entry.provider === "openai") {
        expect(
          entry.reasoningEffort,
          `${entry.provider}:${entry.modelName} should declare a default reasoningEffort`,
        ).toBeDefined();
      }
    }
  });

  test("every reasoning-capable model declares non-empty supported reasoning efforts", () => {
    for (const entry of MODEL_CATALOG) {
      if (entry.supportsReasoning) {
        expect(
          entry.supportedReasoningEfforts?.length,
          `${entry.provider}:${entry.modelName} should declare supportedReasoningEfforts`,
        ).toBeGreaterThan(0);
        if (entry.reasoningEffort !== undefined) {
          expect(entry.supportedReasoningEfforts).toContain(entry.reasoningEffort);
        }
      } else {
        expect(entry.supportedReasoningEfforts ?? []).toHaveLength(0);
      }
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
        entry.embeddingDimensions,
        `embedding entry ${entry.provider}:${entry.modelName} must declare vector dimensions`,
      ).toBe(ARTIFACT_CHUNK_EMBEDDING_DIMENSIONS);
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
    const entry = getCatalogEntry("openai", "gpt-5.5");
    expect(entry?.displayName).toBe("GPT-5.5");
    expect(entry?.capability).toBe("sandbox");
  });

  test("returns undefined for a (provider, model) pair not in the catalog", () => {
    expect(getCatalogEntry("openai", "no-such-model")).toBeUndefined();
    expect(getCatalogEntry("anthropic", "gpt-5.5")).toBeUndefined();
  });
});

describe("isValidPick", () => {
  test("true for catalogued pairs", () => {
    expect(isValidPick("openai", "gpt-5.5")).toBe(true);
    expect(isValidPick("anthropic", "claude-opus-4-8")).toBe(true);
    expect(isValidPick("anthropic", "claude-opus-4-7")).toBe(true);
  });

  test("false for fabricated pairs", () => {
    expect(isValidPick("openai", "gpt-99")).toBe(false);
    expect(isValidPick("anthropic", "gpt-5.5")).toBe(false);
  });
});

describe("isUserPickableModel", () => {
  test("accepts visible generation models", () => {
    expect(isUserPickableModel("openai", "gpt-5.5")).toBe(true);
    expect(isUserPickableModel("openai", "gpt-5.5", "sandbox")).toBe(true);
  });

  test("rejects hidden and embedding-only entries", () => {
    expect(isUserPickableModel("openai", "gpt-5.4-nano")).toBe(false);
    expect(isUserPickableModel("openai", "text-embedding-3-small")).toBe(false);
  });

  test("enforces an optional capability filter", () => {
    expect(isUserPickableModel("openai", "gpt-5.4-mini", "discuss")).toBe(true);
    expect(isUserPickableModel("openai", "gpt-5.4-mini", "library")).toBe(true);
    expect(isUserPickableModel("openai", "gpt-5.4-mini", "sandbox")).toBe(false);
    expect(isUserPickableModel("openai", "gpt-5.5", "discuss")).toBe(false);
    expect(isUserPickableModel("openai", "gpt-5.5", "library")).toBe(false);
  });
});

describe("isSupportedReasoningEffort", () => {
  test("accepts undefined effort for any catalogued model", () => {
    expect(isSupportedReasoningEffort("openai", "gpt-5.5", undefined)).toBe(true);
  });

  test("enforces provider/model-specific supported efforts", () => {
    expect(isSupportedReasoningEffort("openai", "gpt-5.5", "medium")).toBe(true);
    expect(isSupportedReasoningEffort("openai", "gpt-5.5", "none")).toBe(false);
    expect(isSupportedReasoningEffort("anthropic", "claude-opus-4-8", "minimal")).toBe(true);
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

  test("library surfaces use discuss-tier pickable models", () => {
    const libraryTier = listPickableModels({ capability: "library" });
    expect(libraryTier.length).toBeGreaterThan(0);
    expect(libraryTier.every((e) => e.capability === "discuss")).toBe(true);
  });

  test("provider + capability compose", () => {
    const anthropicSandbox = listPickableModels({ provider: "anthropic", capability: "sandbox" });
    expect(anthropicSandbox.every((e) => e.provider === "anthropic" && e.capability === "sandbox")).toBe(true);
  });
});
