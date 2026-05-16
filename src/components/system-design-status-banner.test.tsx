// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { useQuery } from "convex/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Doc } from "../../convex/_generated/dataModel";
import type { RepositoryId } from "@/lib/types";
import { SystemDesignStatusBanner } from "./system-design-status-banner";

vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
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

describe("SystemDesignStatusBanner", () => {
  test("renders nothing while the query is loading", () => {
    setJob(undefined);
    const { container } = render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    expect(container.firstChild).toBeNull();
  });

  test("renders nothing when there is no recent job", () => {
    setJob(null);
    const { container } = render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    expect(container.firstChild).toBeNull();
  });

  test("renders the queued state with indeterminate progress", () => {
    setJob(makeJob({ status: "queued", stage: "queued", progress: 0 }));
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
    render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    expect(screen.getByText("Generated 1 of 3: README Summary")).toBeInTheDocument();
    expect(screen.getByText("33%")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  test("renders the indeterminate progress state for a running job with progress 0", () => {
    setJob(
      makeJob({
        status: "running",
        stage: "starting",
        progress: 0,
      }),
    );
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
    const { container } = render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    expect(container.firstChild).toBeNull();
  });

  test("renders the failure summary + details when the job completed with kindFailures", () => {
    setJob(
      makeJob({
        status: "completed",
        stage: "completed",
        progress: 1,
        outputSummary: "Generated 2 of 3; 1 failed.",
        kindFailures: [
          {
            kind: "readme_summary",
            errorId: "err_abc",
            message: "LLM returned an empty document.",
          },
        ],
      }),
    );
    render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    expect(screen.getByText("Generated 2 of 3; 1 failed.")).toBeInTheDocument();
    expect(screen.getByText(/1 failed kind/)).toBeInTheDocument();
    expect(screen.getByText("readme_summary")).toBeInTheDocument();
    expect(screen.getByText("LLM returned an empty document.")).toBeInTheDocument();
  });

  test("renders the top-level errorMessage when the job failed", () => {
    setJob(
      makeJob({
        status: "failed",
        stage: "failed",
        progress: 0.4,
        errorMessage: "Sandbox is not provisioned.",
      }),
    );
    render(<SystemDesignStatusBanner repositoryId={repositoryId} />);
    expect(screen.getByText("Sandbox is not provisioned.")).toBeInTheDocument();
  });
});
