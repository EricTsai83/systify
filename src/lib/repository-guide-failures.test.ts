import { describe, expect, test } from "vitest";
import {
  describeRepositoryGuideFailure,
  getRepositoryGuideKindTitle,
  type RepositoryGuideFailureJob,
} from "./repository-guide-failures";

describe("describeRepositoryGuideFailure", () => {
  test("describes a single per-kind live-source failure", () => {
    const descriptor = describeRepositoryGuideFailure({
      kindFailures: [
        {
          kind: "readme_summary",
          reason: "live_source_unavailable",
        },
      ],
      selections: ["readme_summary"],
    });

    expect(descriptor).toEqual({
      title: "Couldn't generate README Summary",
      reasonText:
        "Live access to the repository wasn't available when this ran. The next attempt will prepare it first.",
      buttonLabel: "Generate README Summary",
      selections: ["readme_summary"],
    });
  });

  test("retries only failed kinds and deduplicates repeated failures", () => {
    const descriptor = describeRepositoryGuideFailure({
      selections: ["readme_summary", "data_model_overview", "security_overview"],
      kindFailures: [
        { kind: "readme_summary", reason: "model_empty_output" },
        { kind: "readme_summary", reason: "model_empty_output" },
        { kind: "security_overview", reason: "model_empty_output" },
      ],
    });

    expect(descriptor).toMatchObject({
      title: "Couldn't generate 2 guide sections",
      buttonLabel: "Generate 2 guide sections",
      selections: ["readme_summary", "security_overview"],
    });
    expect(descriptor?.reasonText).toMatch(/model didn't produce/i);
  });

  test("uses mixed-reason copy when failed kinds have different reasons", () => {
    const descriptor = describeRepositoryGuideFailure({
      kindFailures: [
        { kind: "readme_summary", reason: "transport_rate_limit" },
        { kind: "data_model_overview", reason: "infra" },
      ],
    });

    expect(descriptor?.reasonText).toBe(
      "Some guide sections couldn't be generated. The next attempt will retry the failed ones.",
    );
  });

  test("falls back to generic copy when per-kind failures have no reason", () => {
    const descriptor = describeRepositoryGuideFailure({
      kindFailures: [{ kind: "deployment_overview" }],
    });

    expect(descriptor?.reasonText).toBe(
      "Something stopped the run before it finished. The next attempt will start a fresh one.",
    );
  });

  test("describes top-level job failures from persisted selections", () => {
    const descriptor = describeRepositoryGuideFailure({
      selections: ["readme_summary", "data_model_overview"],
      errorMessage: "Live access to the repository wasn't available.",
    });

    expect(descriptor).toEqual({
      title: "Couldn't generate 2 guide sections",
      reasonText: "Live access to the repository wasn't available.",
      buttonLabel: "Generate 2 guide sections",
      selections: ["readme_summary", "data_model_overview"],
    });
  });

  test("returns null when a legacy failed job has no retry target", () => {
    const job: RepositoryGuideFailureJob = {
      errorMessage: "Generation failed before it could finish.",
    };

    expect(describeRepositoryGuideFailure(job)).toBeNull();
  });
});

describe("getRepositoryGuideKindTitle", () => {
  test("returns catalog titles for known kinds and raw labels for unknown kinds", () => {
    expect(getRepositoryGuideKindTitle("security_overview")).toBe("Security Overview");
    expect(getRepositoryGuideKindTitle("legacy_kind")).toBe("legacy_kind");
  });
});
