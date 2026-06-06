// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useMutation, useQuery } from "convex/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Doc } from "../../convex/_generated/dataModel";
import type { RepositoryId } from "@/lib/types";
import { SystemDesignStatusBanner } from "./system-design-status-banner";

vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
  useMutation: vi.fn(),
}));

const repositoryId = "repo_1" as RepositoryId;
const jobId = "job_1" as Doc<"jobs">["_id"];

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

function makeJob(overrides: Partial<Doc<"jobs">> = {}): Doc<"jobs"> {
  return {
    _id: jobId,
    _creationTime: Date.now(),
    kind: "system_design",
    stage: "running",
    status: "running",
    progress: 0,
    repositoryId,
    ownerTokenIdentifier: "test",
    costCategory: "system_design",
    triggerSource: "user",
    ...overrides,
  } as unknown as Doc<"jobs">;
}

function setJob(job: Doc<"jobs"> | null | undefined) {
  vi.mocked(useQuery).mockReturnValue(job);
}

function setMutation(impl: (args: unknown) => Promise<unknown>) {
  vi.mocked(useMutation).mockReturnValue(impl as unknown as ReturnType<typeof useMutation>);
}

describe("SystemDesignStatusBanner", () => {
  test("renders nothing while the query is loading", () => {
    setJob(undefined);
    setMutation(async () => undefined);
    const { container } = render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    expect(container.firstChild).toBeNull();
  });

  test("renders nothing when there is no recent job", () => {
    setJob(null);
    setMutation(async () => undefined);
    const { container } = render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    expect(container.firstChild).toBeNull();
  });

  test("renders the queued state with indeterminate progress", () => {
    setJob(makeJob({ status: "queued", stage: "queued", progress: 0 }));
    setMutation(async () => undefined);
    render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    expect(screen.getByText("Queued…")).toBeInTheDocument();
    const progress = screen.getByRole("progressbar");
    expect(progress).toBeInTheDocument();
    expect(progress).not.toHaveAttribute("aria-valuenow");
  });

  test("renders progress UI while the job is running", () => {
    setJob(
      makeJob({
        status: "running",
        stage: "Generated 1 of 3: README Summary",
        progress: 0.33,
      }),
    );
    setMutation(async () => undefined);
    render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    expect(screen.getByText("Generated 1 of 3: README Summary")).toBeInTheDocument();
    expect(screen.getByText("33%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  test("collapses preparing stages to the user-friendly placeholder", () => {
    setJob(
      makeJob({
        status: "running",
        stage: "Preparing environment for your request…",
        progress: 0.1,
      }),
    );
    setMutation(async () => undefined);
    render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    expect(screen.getByText("Preparing environment for your request…")).toBeInTheDocument();
  });

  test("renders the indeterminate progress state for a running job with progress 0", () => {
    setJob(
      makeJob({
        status: "running",
        stage: "starting",
        progress: 0,
      }),
    );
    setMutation(async () => undefined);
    render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    const progress = screen.getByRole("progressbar");
    expect(progress).toBeInTheDocument();
    expect(progress).not.toHaveAttribute("aria-valuenow");
  });

  test("renders nothing for a completed job with no failures", () => {
    setJob(
      makeJob({
        status: "completed",
        stage: "completed",
        progress: 1,
        outputSummary: "Generated 3 of 3 documents.",
      }),
    );
    setMutation(async () => undefined);
    const { container } = render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    expect(container.firstChild).toBeNull();
  });

  test("maps live_source_unavailable to the live-source reason text + single-kind button", () => {
    setJob(
      makeJob({
        status: "completed",
        stage: "completed",
        progress: 1,
        outputSummary: "Generated 0 of 1; 1 failed.",
        selections: ["readme_summary"],
        kindFailures: [
          {
            kind: "readme_summary",
            errorId: "err_abc",
            message: "Daytona probe failed",
            reason: "live_source_unavailable",
          },
        ],
      }),
    );
    setMutation(async () => undefined);
    render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    expect(screen.getByText("Couldn't generate README Summary")).toBeInTheDocument();
    expect(screen.getByText(/Live access to the repository wasn't available when this ran/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generate README Summary/ })).toBeInTheDocument();
  });

  test("maps model_empty_output to the empty-output reason text", () => {
    setJob(
      makeJob({
        status: "completed",
        stage: "completed",
        progress: 1,
        selections: ["data_model_overview"],
        kindFailures: [
          {
            kind: "data_model_overview",
            errorId: "err_def",
            message: "LLM returned an empty document.",
            reason: "model_empty_output",
          },
        ],
      }),
    );
    setMutation(async () => undefined);
    render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    expect(screen.getByText("Couldn't generate Data Model Overview")).toBeInTheDocument();
    expect(screen.getByText(/The model didn't produce a complete guide section/)).toBeInTheDocument();
  });

  test("maps transport_rate_limit to the rate-limit reason text", () => {
    setJob(
      makeJob({
        status: "completed",
        stage: "completed",
        progress: 1,
        selections: ["api_surface_overview"],
        kindFailures: [
          {
            kind: "api_surface_overview",
            errorId: "err_rl",
            message: "Provider 429: retry-after 30s.",
            reason: "transport_rate_limit",
          },
        ],
      }),
    );
    setMutation(async () => undefined);
    render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    expect(screen.getByText(/provider rate-limited/i)).toBeInTheDocument();
  });

  test("maps output_quality to the quality-gate reason text", () => {
    setJob(
      makeJob({
        status: "completed",
        stage: "completed",
        progress: 1,
        selections: ["architecture_diagram"],
        kindFailures: [
          {
            kind: "architecture_diagram",
            errorId: "err_q",
            message: "Missing sections: components, mermaid_block.",
            reason: "output_quality",
          },
        ],
      }),
    );
    setMutation(async () => undefined);
    render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    expect(screen.getByText(/without the required content/i)).toBeInTheDocument();
  });

  test("maps transport_other to the generic transport reason text", () => {
    setJob(
      makeJob({
        status: "completed",
        stage: "completed",
        progress: 1,
        selections: ["security_overview"],
        kindFailures: [
          {
            kind: "security_overview",
            errorId: "err_t",
            message: "fetch failed: ENETDOWN.",
            reason: "transport_other",
          },
        ],
      }),
    );
    setMutation(async () => undefined);
    render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    expect(screen.getByText(/transport error stopped the run/i)).toBeInTheDocument();
  });

  test("maps infra to the engineering-notified reason text", () => {
    setJob(
      makeJob({
        status: "completed",
        stage: "completed",
        progress: 1,
        selections: ["operations_overview"],
        kindFailures: [
          {
            kind: "operations_overview",
            errorId: "err_i",
            message: "ConvexError: schema validation failed.",
            reason: "infra",
          },
        ],
      }),
    );
    setMutation(async () => undefined);
    render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    expect(screen.getByText(/internal error stopped the run/i)).toBeInTheDocument();
  });

  test("kindFailure without a reason falls back to the generic copy", () => {
    setJob(
      makeJob({
        status: "completed",
        stage: "completed",
        progress: 1,
        selections: ["deployment_overview"],
        kindFailures: [
          {
            kind: "deployment_overview",
            errorId: "err_legacy",
            message: "Row with no structured reason.",
          },
        ],
      }),
    );
    setMutation(async () => undefined);
    render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    expect(screen.getByText(/something stopped the run/i)).toBeInTheDocument();
  });

  test("aggregates mixed reasons under the mixed-reason text", () => {
    setJob(
      makeJob({
        status: "completed",
        stage: "completed",
        progress: 1,
        selections: ["readme_summary", "data_model_overview"],
        kindFailures: [
          {
            kind: "readme_summary",
            errorId: "err_a",
            message: "Daytona probe failed",
            reason: "live_source_unavailable",
          },
          {
            kind: "data_model_overview",
            errorId: "err_b",
            message: "LLM returned an empty document.",
            reason: "model_empty_output",
          },
        ],
      }),
    );
    setMutation(async () => undefined);
    render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    expect(screen.getByText("Couldn't generate 2 guide sections")).toBeInTheDocument();
    expect(screen.getByText(/Some guide sections couldn't be generated/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generate 2 guide sections/ })).toBeInTheDocument();
  });

  test("retry click invokes requestSystemDesignGeneration with the failed kinds", async () => {
    const mutationSpy = vi.fn().mockResolvedValue(undefined);
    setMutation(mutationSpy);
    setJob(
      makeJob({
        status: "completed",
        selections: ["readme_summary", "data_model_overview"],
        kindFailures: [
          {
            kind: "readme_summary",
            errorId: "err_a",
            message: "Daytona probe failed",
            reason: "live_source_unavailable",
          },
        ],
      }),
    );
    render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    fireEvent.click(screen.getByRole("button", { name: /Generate README Summary/ }));
    expect(mutationSpy).toHaveBeenCalledWith({
      repositoryId,
      selections: ["readme_summary"],
    });
  });

  test("renders top-level failure with action button derived from persisted selections", () => {
    setJob(
      makeJob({
        status: "failed",
        stage: "failed",
        progress: 0.4,
        errorMessage: "Live access to the repository wasn't available.",
        selections: ["readme_summary", "data_model_overview"],
      }),
    );
    setMutation(async () => undefined);
    render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    expect(screen.getByText("Couldn't generate 2 guide sections")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Generate 2 guide sections/ })).toBeInTheDocument();
  });

  test("falls back to errorMessage when no selections or kindFailures are persisted", () => {
    setJob(
      makeJob({
        status: "failed",
        stage: "failed",
        progress: 0.4,
        errorMessage: "Generation failed before it could finish.",
      }),
    );
    setMutation(async () => undefined);
    render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    expect(screen.getByText("Generation failed before it could finish.")).toBeInTheDocument();
  });
});
