import { ConvexError } from "convex/values";
import { describe, expect, test } from "vitest";
import type { Doc } from "../_generated/dataModel";
import { normalizeModelPreferences } from "./userPreferences";
import {
  SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE,
  buildSystemDesignJobSummary,
  normalizeSystemDesignSelections,
  planSystemDesignGenerationRequest,
  resolveSystemDesignCachePreviewModel,
  resolveSystemDesignRequestModelChoice,
} from "./systemDesignPlanning";

const emptyModelPreferences = normalizeModelPreferences(null);

function expectConvexErrorCode(fn: () => unknown, code: string): void {
  let caught: unknown;
  try {
    fn();
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(ConvexError);
  expect((caught as { data?: { code?: string } }).data?.code).toBe(code);
}

describe("normalizeSystemDesignSelections", () => {
  test("deduplicates selections and filters non-System Design artifact kinds", () => {
    const rawSelections: Array<Doc<"artifacts">["kind"]> = [
      "readme_summary",
      "entrypoints",
      "readme_summary",
      "security_overview",
    ];

    expect(normalizeSystemDesignSelections(rawSelections)).toEqual(["readme_summary", "security_overview"]);
  });
});

describe("planSystemDesignGenerationRequest", () => {
  test("returns normalized selections and the default request model", () => {
    const plan = planSystemDesignGenerationRequest({
      selections: ["readme_summary", "readme_summary", "architecture_overview"],
      modelPreferences: emptyModelPreferences,
      picker: {},
    });

    expect(plan).toEqual({
      selections: ["readme_summary", "architecture_overview"],
      modelChoice: SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE,
    });
  });

  test("rejects an empty normalized selection set", () => {
    expect(() =>
      planSystemDesignGenerationRequest({
        selections: ["entrypoints"],
        modelPreferences: emptyModelPreferences,
        picker: {},
      }),
    ).toThrow(/select at least one document/i);
  });
});

describe("resolveSystemDesignRequestModelChoice", () => {
  test("falls back to the first enabled sandbox model when the default is disabled", () => {
    const modelPreferences = normalizeModelPreferences({
      scopedModelPreferences: {
        sandbox: {
          disabledModels: [SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE],
        },
      },
    });

    expect(
      resolveSystemDesignRequestModelChoice({
        modelPreferences,
        picker: {},
      }),
    ).toEqual({
      provider: "anthropic",
      modelName: "claude-opus-4-8",
    });
  });

  test("rejects half-set model picker pairs", () => {
    expectConvexErrorCode(
      () =>
        resolveSystemDesignRequestModelChoice({
          modelPreferences: emptyModelPreferences,
          picker: { provider: "openai" },
        }),
      "invalid_model_pick",
    );
  });

  test("rejects explicit picks disabled in the sandbox preference scope", () => {
    const modelPreferences = normalizeModelPreferences({
      scopedModelPreferences: {
        sandbox: {
          disabledModels: [SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE],
        },
      },
    });

    expectConvexErrorCode(
      () =>
        resolveSystemDesignRequestModelChoice({
          modelPreferences,
          picker: SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE,
        }),
      "invalid_model_pick",
    );
  });

  test("rejects when every sandbox-capable model is disabled", () => {
    const modelPreferences = normalizeModelPreferences({
      scopedModelPreferences: {
        sandbox: {
          disabledModels: [SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE, { provider: "anthropic", modelName: "claude-opus-4-8" }],
        },
      },
    });

    expectConvexErrorCode(
      () =>
        resolveSystemDesignRequestModelChoice({
          modelPreferences,
          picker: {},
        }),
      "invalid_model_pick",
    );
  });

  test("rejects reasoning effort unsupported by the selected sandbox model", () => {
    expectConvexErrorCode(
      () =>
        resolveSystemDesignRequestModelChoice({
          modelPreferences: emptyModelPreferences,
          picker: { ...SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE, reasoningEffort: "none" },
        }),
      "unsupported_reasoning_effort",
    );
  });
});

describe("resolveSystemDesignCachePreviewModel", () => {
  test("keeps a valid sandbox preview pick", () => {
    expect(resolveSystemDesignCachePreviewModel({ provider: "anthropic", modelName: "claude-opus-4-8" })).toEqual({
      provider: "anthropic",
      modelName: "claude-opus-4-8",
    });
  });

  test("falls back to the default for partial or non-sandbox preview picks", () => {
    expect(resolveSystemDesignCachePreviewModel({ provider: "anthropic" })).toEqual(SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE);
    expect(resolveSystemDesignCachePreviewModel({ provider: "openai", modelName: "gpt-5.4-mini" })).toEqual(
      SYSTEM_DESIGN_DEFAULT_MODEL_CHOICE,
    );
  });
});

describe("buildSystemDesignJobSummary", () => {
  test("summarizes zero, one, two, and many selections", () => {
    expect(buildSystemDesignJobSummary([], "queued")).toBe("Queued System Design documents");
    expect(buildSystemDesignJobSummary(["readme_summary"], "queued")).toBe("Queued README Summary");
    expect(buildSystemDesignJobSummary(["readme_summary", "security_overview"], "running")).toBe(
      "Generating README Summary + Security Overview",
    );
    expect(buildSystemDesignJobSummary(["readme_summary", "security_overview", "operations_overview"], "running")).toBe(
      "Generating 3 System Design documents",
    );
  });
});
