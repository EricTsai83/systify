import { describe, expect, test } from "vitest";
import { SYSTEM_DESIGN_FAILURE_REASONS, isSystemDesignFailureReason } from "./systemDesignFailures";

describe("System Design failure taxonomy", () => {
  test("keeps the persisted reason literals in one ordered list", () => {
    expect(SYSTEM_DESIGN_FAILURE_REASONS).toEqual([
      "live_source_unavailable",
      "model_empty_output",
      "transport_rate_limit",
      "transport_other",
      "output_quality",
      "infra",
    ]);
  });

  test("guards persisted failure reason strings", () => {
    expect(isSystemDesignFailureReason("transport_rate_limit")).toBe(true);
    expect(isSystemDesignFailureReason("legacy_reason")).toBe(false);
  });
});
