// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Doc } from "../../convex/_generated/dataModel";
import type { RepositoryId } from "@/lib/types";
import { ImportStatusBanner } from "./import-status-banner";

const repoId = "repo_1" as RepositoryId;
const jobId = "job_1" as Doc<"jobs">["_id"];

afterEach(() => {
  cleanup();
});

function makeJob(overrides: Partial<Doc<"jobs">> = {}): Doc<"jobs"> {
  return {
    _id: jobId,
    _creationTime: Date.now(),
    kind: "import",
    stage: "queued",
    status: "queued",
    progress: 0,
    repositoryId: repoId,
    ownerTokenIdentifier: "test",
    costCategory: "indexing",
    triggerSource: "user",
    ...overrides,
  } as unknown as Doc<"jobs">;
}

type BannerProps = React.ComponentProps<typeof ImportStatusBanner>;

function renderBanner(overrides: Partial<BannerProps> = {}) {
  const props: BannerProps = {
    importStatus: "completed",
    latestImportJobId: jobId,
    jobs: [],
    isSyncing: false,
    onRetry: vi.fn(),
    ...overrides,
  };
  return { ...render(<ImportStatusBanner {...props} />), props };
}

describe("ImportStatusBanner visibility", () => {
  test("renders nothing when importStatus is completed", () => {
    const { container } = renderBanner({ importStatus: "completed" });
    expect(container.firstChild).toBeNull();
  });

  test("renders nothing when importStatus is idle", () => {
    const { container } = renderBanner({ importStatus: "idle" });
    expect(container.firstChild).toBeNull();
  });

  test("renders when importStatus is queued", () => {
    renderBanner({
      importStatus: "queued",
      jobs: [makeJob({ status: "queued", stage: "queued", progress: 0 })],
    });
    expect(screen.getByText("Preparing…")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  test("renders when importStatus is running", () => {
    renderBanner({
      importStatus: "running",
      jobs: [makeJob({ status: "running", stage: "fetching_repository", progress: 0.1 })],
    });
    expect(screen.getByText("Reading repository from GitHub…")).toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  test("renders error state when importStatus is failed", () => {
    renderBanner({
      importStatus: "failed",
      jobs: [makeJob({ status: "failed", stage: "failed", progress: 1, errorMessage: "Clone failed" })],
    });
    expect(screen.getByText(/Import failed/)).toBeInTheDocument();
    expect(screen.getByText(/Clone failed/)).toBeInTheDocument();
  });
});

describe("ImportStatusBanner stage labels", () => {
  test("shows 'Preparing…' for queued stage", () => {
    renderBanner({
      importStatus: "queued",
      jobs: [makeJob({ stage: "queued", progress: 0 })],
    });
    expect(screen.getByText("Preparing…")).toBeInTheDocument();
  });

  test("shows 'Reading repository from GitHub…' for fetching_repository stage", () => {
    renderBanner({
      importStatus: "running",
      jobs: [makeJob({ stage: "fetching_repository", progress: 0.1 })],
    });
    expect(screen.getByText("Reading repository from GitHub…")).toBeInTheDocument();
  });

  test("shows 'Indexing files…' for persisting_files stage", () => {
    renderBanner({
      importStatus: "running",
      jobs: [makeJob({ stage: "persisting_files", progress: 0.5 })],
    });
    expect(screen.getByText("Indexing files…")).toBeInTheDocument();
  });

  test("shows 'Indexing code chunks…' for persisting_chunks stage", () => {
    renderBanner({
      importStatus: "running",
      jobs: [makeJob({ stage: "persisting_chunks", progress: 0.75 })],
    });
    expect(screen.getByText("Indexing code chunks…")).toBeInTheDocument();
  });
});

describe("ImportStatusBanner progress", () => {
  test("shows indeterminate progress state when progress < 0.5", () => {
    renderBanner({
      importStatus: "running",
      jobs: [makeJob({ stage: "fetching_repository", progress: 0.1 })],
    });
    const progressBar = screen.getByRole("progressbar");
    expect(progressBar).toBeInTheDocument();
    // No aria-valuenow for indeterminate state
    expect(progressBar).not.toHaveAttribute("aria-valuenow");
  });

  test("shows real progress percentage when progress >= 0.5", () => {
    renderBanner({
      importStatus: "running",
      jobs: [makeJob({ stage: "persisting_files", progress: 0.5 })],
    });
    const progressBar = screen.getByRole("progressbar");
    expect(progressBar).toHaveAttribute("aria-valuenow", "50");
    expect(screen.getByText("50%")).toBeInTheDocument();
  });

  test("shows 75% for persisting_chunks stage", () => {
    renderBanner({
      importStatus: "running",
      jobs: [makeJob({ stage: "persisting_chunks", progress: 0.75 })],
    });
    expect(screen.getByText("75%")).toBeInTheDocument();
  });
});

describe("ImportStatusBanner retry", () => {
  test("shows retry button on failure", () => {
    renderBanner({
      importStatus: "failed",
      jobs: [makeJob({ status: "failed", errorMessage: "Network error" })],
    });
    expect(screen.getByRole("button", { name: /Retry/i })).toBeInTheDocument();
  });

  test("calls onRetry when retry button is clicked", () => {
    const onRetry = vi.fn();
    renderBanner({
      importStatus: "failed",
      jobs: [makeJob({ status: "failed", errorMessage: "Network error" })],
      onRetry,
    });
    fireEvent.click(screen.getByRole("button", { name: /Retry/i }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  test("disables retry button when isSyncing is true", () => {
    renderBanner({
      importStatus: "failed",
      jobs: [makeJob({ status: "failed" })],
      isSyncing: true,
    });
    expect(screen.getByRole("button", { name: /Retrying/i })).toBeDisabled();
  });

  test("shows error message inline with label", () => {
    renderBanner({
      importStatus: "failed",
      jobs: [makeJob({ status: "failed", errorMessage: "Repo not accessible" })],
    });
    expect(screen.getByText(/Import failed — Repo not accessible/)).toBeInTheDocument();
  });
});
