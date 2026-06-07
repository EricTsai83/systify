import { APICallError } from "ai";
import { describe, expect, test } from "vitest";
import { LlmRateLimitError } from "./llmGateway";
import { SandboxPreparationError } from "./sandboxLiveness";
import { classifySystemDesignKindRunError } from "./systemDesignFailureClassification";

function apiCallError(statusCode: number | undefined): APICallError {
  return new APICallError({
    message: "provider failed",
    url: "https://provider.example.test",
    requestBodyValues: {},
    statusCode,
  });
}

describe("classifySystemDesignKindRunError", () => {
  test("classifies live-source preparation failures", () => {
    const error = new SandboxPreparationError({
      reason: "live_source_unavailable",
      userFacingMessage: "Live access to the repository wasn't available.",
    });

    expect(classifySystemDesignKindRunError(error)).toBe("live_source_unavailable");
  });

  test("classifies gateway, provider, and budget rate limits", () => {
    expect(classifySystemDesignKindRunError(new LlmRateLimitError("requests_per_minute_exceeded", 1_000))).toBe(
      "transport_rate_limit",
    );
    expect(classifySystemDesignKindRunError(apiCallError(429))).toBe("transport_rate_limit");
    expect(
      classifySystemDesignKindRunError({
        data: { code: "USER_USAGE_BUDGET_EXCEEDED" },
      }),
    ).toBe("transport_rate_limit");
  });

  test("classifies non-429 provider failures as transport errors", () => {
    expect(classifySystemDesignKindRunError(apiCallError(503))).toBe("transport_other");
    expect(classifySystemDesignKindRunError(apiCallError(undefined))).toBe("transport_other");
  });

  test("classifies legacy empty-document errors and generic infrastructure errors", () => {
    expect(classifySystemDesignKindRunError(new Error("empty document returned from provider"))).toBe(
      "model_empty_output",
    );
    expect(classifySystemDesignKindRunError(new Error("mutation failed"))).toBe("infra");
  });
});
