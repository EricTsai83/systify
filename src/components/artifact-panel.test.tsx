// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc } from "../../convex/_generated/dataModel";
import { ArtifactPanel } from "./artifact-panel";
import type { RepositoryId, ThreadId } from "@/lib/types";

const { useMutationMock, useQueryMock } = vi.hoisted(() => ({
  useMutationMock: vi.fn(),
  useQueryMock: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: useMutationMock,
  useQuery: useQueryMock,
}));

vi.mock("@/components/mermaid-renderer", () => ({
  MermaidRenderer: ({ source }: { source: string }) => <pre>{source}</pre>,
}));

vi.mock("@/components/folder-navigator", () => ({
  FolderNavigator: () => <div data-testid="folder-navigator-stub" />,
}));

vi.mock("@/components/folder-picker", () => ({
  FolderPicker: () => <div data-testid="folder-picker-stub" />,
}));

const threadId = "thread_1" as ThreadId;
const repositoryId = "repo_1" as RepositoryId;

const artifact = {
  _id: "artifact_1",
  _creationTime: Date.now(),
  kind: "architecture_diagram",
  title: "System overview",
  summary: "Generated diagram",
  contentMarkdown: "graph TD;A-->B;",
  source: "assistant",
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

describe("ArtifactPanel action defaults", () => {
  test("hides folder navigator when panel is not visible", () => {
    render(
      <ArtifactPanel
        threadId={threadId}
        repositoryId={repositoryId}
        artifacts={[artifact]}
        hasAttachedRepository
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isVisible={false}
      />,
    );

    expect(screen.queryByTestId("folder-navigator-stub")).not.toBeInTheDocument();
  });

  test("renders folder navigator when panel is visible with a repo", () => {
    render(
      <ArtifactPanel
        threadId={threadId}
        repositoryId={repositoryId}
        artifacts={[artifact]}
        hasAttachedRepository
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isVisible
      />,
    );

    expect(screen.getByTestId("folder-navigator-stub")).toBeInTheDocument();
  });

  test("defaults the Generate panel open when there are no artifacts", () => {
    render(
      <ArtifactPanel
        threadId={threadId}
        repositoryId={repositoryId}
        artifacts={[]}
        hasAttachedRepository
        sandboxModeStatus={{ reasonCode: "available", message: null }}
      />,
    );

    expect(screen.getByRole("button", { name: /generate architecture diagram/i })).toBeInTheDocument();
  });

  test("auto-collapses the Generate panel once artifacts exist", () => {
    render(
      <ArtifactPanel
        threadId={threadId}
        repositoryId={repositoryId}
        artifacts={[artifact]}
        hasAttachedRepository
        sandboxModeStatus={{ reasonCode: "available", message: null }}
      />,
    );

    expect(screen.queryByRole("button", { name: /generate architecture diagram/i })).not.toBeInTheDocument();
  });

  test("manual toggle locks preference across artifact-count changes", () => {
    const { rerender } = render(
      <ArtifactPanel
        threadId={threadId}
        repositoryId={repositoryId}
        artifacts={[]}
        hasAttachedRepository
        sandboxModeStatus={{ reasonCode: "available", message: null }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /\+ generate/i }));
    expect(screen.queryByRole("button", { name: /generate architecture diagram/i })).not.toBeInTheDocument();

    rerender(
      <ArtifactPanel
        threadId={threadId}
        repositoryId={repositoryId}
        artifacts={[artifact]}
        hasAttachedRepository
        sandboxModeStatus={{ reasonCode: "available", message: null }}
      />,
    );
    expect(screen.queryByRole("button", { name: /generate architecture diagram/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /\+ generate/i }));
    expect(screen.getByRole("button", { name: /generate architecture diagram/i })).toBeInTheDocument();

    rerender(
      <ArtifactPanel
        threadId={threadId}
        repositoryId={repositoryId}
        artifacts={[]}
        hasAttachedRepository
        sandboxModeStatus={{ reasonCode: "available", message: null }}
      />,
    );
    expect(screen.getByRole("button", { name: /generate architecture diagram/i })).toBeInTheDocument();
  });
});
