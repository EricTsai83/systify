// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc } from "../../convex/_generated/dataModel";
import { ArtifactPanel } from "./artifact-panel";
import type { ThreadId } from "@/lib/types";

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

const threadId = "thread_1" as ThreadId;

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

let artifactsResult: Doc<"artifacts">[] | undefined;

beforeEach(() => {
  artifactsResult = [];
  useMutationMock.mockReset();
  useQueryMock.mockReset();
  useMutationMock.mockReturnValue(vi.fn());
  useQueryMock.mockImplementation((_query: unknown, args: unknown) => (args === "skip" ? undefined : artifactsResult));
});

afterEach(() => {
  cleanup();
});

describe("ArtifactPanel action defaults", () => {
  test("skips artifacts subscription when panel is hidden", () => {
    render(
      <ArtifactPanel
        threadId={threadId}
        repositoryArtifacts={[artifact]}
        hasAttachedRepository
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isVisible={false}
      />,
    );

    expect(useQueryMock).toHaveBeenCalledWith(expect.anything(), "skip");
    expect(screen.queryByText("System overview")).not.toBeInTheDocument();
  });

  test("re-subscribes and renders latest artifacts when panel is reopened", () => {
    const { rerender } = render(
      <ArtifactPanel
        threadId={threadId}
        hasAttachedRepository
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isVisible={false}
      />,
    );

    expect(useQueryMock).toHaveBeenLastCalledWith(expect.anything(), "skip");
    expect(screen.queryByText("System overview")).not.toBeInTheDocument();

    artifactsResult = [artifact];
    rerender(
      <ArtifactPanel
        threadId={threadId}
        hasAttachedRepository
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isVisible
      />,
    );

    expect(useQueryMock).toHaveBeenLastCalledWith(expect.anything(), { threadId });
    expect(screen.getByText("System overview")).toBeInTheDocument();
  });

  test("defaults open when no artifacts, then auto-collapses once artifacts exist", () => {
    const { rerender } = render(
      <ArtifactPanel
        threadId={threadId}
        hasAttachedRepository
        sandboxModeStatus={{ reasonCode: "available", message: null }}
      />,
    );

    expect(screen.getByRole("button", { name: /generate architecture diagram/i })).toBeInTheDocument();

    artifactsResult = [artifact];
    rerender(
      <ArtifactPanel
        threadId={threadId}
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
        hasAttachedRepository
        sandboxModeStatus={{ reasonCode: "available", message: null }}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /\+ generate/i }));
    expect(screen.queryByRole("button", { name: /generate architecture diagram/i })).not.toBeInTheDocument();

    artifactsResult = [artifact];
    rerender(
      <ArtifactPanel
        threadId={threadId}
        hasAttachedRepository
        sandboxModeStatus={{ reasonCode: "available", message: null }}
      />,
    );
    expect(screen.queryByRole("button", { name: /generate architecture diagram/i })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /\+ generate/i }));
    expect(screen.getByRole("button", { name: /generate architecture diagram/i })).toBeInTheDocument();

    artifactsResult = [];
    rerender(
      <ArtifactPanel
        threadId={threadId}
        hasAttachedRepository
        sandboxModeStatus={{ reasonCode: "available", message: null }}
      />,
    );
    expect(screen.getByRole("button", { name: /generate architecture diagram/i })).toBeInTheDocument();
  });
});
