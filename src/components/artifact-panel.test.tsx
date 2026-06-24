// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc } from "../../convex/_generated/dataModel";
import { ArtifactPanel } from "./artifact-panel";
import type { RepositoryId } from "@/lib/types";

const { useMutationMock, useQueryMock } = vi.hoisted(() => ({
  useMutationMock: vi.fn(),
  useQueryMock: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: useMutationMock,
  useQuery: useQueryMock,
}));

vi.mock("@/components/folder-navigator", () => ({
  FolderNavigator: () => <div data-testid="folder-navigator-stub" />,
}));

const repositoryId = "repo_1" as RepositoryId;

const artifact = {
  _id: "artifact_1",
  _creationTime: Date.now(),
  kind: "architecture_diagram",
  title: "System overview",
  description: "Generated diagram",
  contentMarkdown: "graph TD;A-->B;",
  version: 1,
} as unknown as Doc<"artifacts">;

function makeMutationMock() {
  // `useArtifactViewState` wraps its mutation with
  // `.withOptimisticUpdate(...)`. Real Convex mutations carry that
  // method on the returned callable; the bare `vi.fn()` does not, so
  // attach a stub that returns the same callable to keep the chain
  // type-compatible without pulling in Convex's runtime.
  const mutation = vi.fn() as ReturnType<typeof vi.fn> & {
    withOptimisticUpdate: (...args: unknown[]) => typeof mutation;
  };
  mutation.withOptimisticUpdate = vi.fn().mockReturnValue(mutation);
  return mutation;
}

beforeEach(() => {
  useMutationMock.mockReset();
  useQueryMock.mockReset();
  useMutationMock.mockImplementation(() => makeMutationMock());
  useQueryMock.mockReturnValue({ views: {}, bootstrap: Date.now() });
});

afterEach(() => {
  cleanup();
});

describe("ArtifactPanel", () => {
  test("hides folder navigator when panel is not visible", () => {
    render(<ArtifactPanel repositoryId={repositoryId} artifacts={[artifact]} isVisible={false} />);

    expect(screen.queryByTestId("folder-navigator-stub")).not.toBeInTheDocument();
  });

  test("renders folder navigator when panel is visible with a repo", () => {
    render(<ArtifactPanel repositoryId={repositoryId} artifacts={[artifact]} isVisible />);

    expect(screen.getByTestId("folder-navigator-stub")).toBeInTheDocument();
  });

  test("renders the empty-state copy when no repository is attached", () => {
    render(<ArtifactPanel repositoryId={null} artifacts={[]} isVisible />);

    expect(screen.queryByTestId("folder-navigator-stub")).not.toBeInTheDocument();
    expect(screen.getByText(/attach a repository/i)).toBeInTheDocument();
  });
});
