// @vitest-environment jsdom

import type React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { LibraryEditor } from "./library-editor";
import type { ArtifactFreshness, ArtifactId } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  useAction: vi.fn(),
  useQuery: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useAction: mocks.useAction,
  useQuery: mocks.useQuery,
}));

vi.mock("@/components/markdown", () => ({
  Markdown: ({ children }: { children: React.ReactNode }) => <div data-testid="markdown">{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    children?: React.ReactNode;
    variant?: string;
    size?: string;
  }) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/scroll-area", () => ({
  ScrollArea: ({ children, className }: { children: React.ReactNode; className?: string }) => (
    <div className={className}>{children}</div>
  ),
}));

vi.mock("@/components/ui/skeleton", () => ({
  Skeleton: ({ className }: { className?: string }) => <div data-testid="skeleton" className={className} />,
}));

const artifactId = "artifact_html" as ArtifactId;

function functionName(reference: unknown): string {
  try {
    return getFunctionName(reference as Parameters<typeof getFunctionName>[0]);
  } catch {
    return "";
  }
}

function makeHtmlArtifact(): Doc<"artifacts"> & { freshness: ArtifactFreshness } {
  return {
    _id: artifactId as Id<"artifacts">,
    _creationTime: 1,
    ownerTokenIdentifier: "user|library-editor",
    repositoryId: "repo_1" as Id<"repositories">,
    kind: "custom_document",
    title: "Executive report",
    summary: "A self-contained HTML report.",
    contentMarkdown: "# Executive report\n\nSource-backed companion.",
    renderFormat: "html",
    version: 1,
    currentVersionId: "version_1" as Id<"artifactVersions">,
    chunkingStatus: "indexed",
    updatedAt: 1,
    freshness: "unverified",
  } as Doc<"artifacts"> & { freshness: ArtifactFreshness };
}

beforeEach(() => {
  mocks.useAction.mockReset().mockReturnValue(vi.fn());
  mocks.useQuery.mockReset().mockImplementation((reference: unknown, args: unknown) => {
    if (args === "skip") return undefined;
    const name = functionName(reference);
    if (name.endsWith("artifacts:getById")) return makeHtmlArtifact();
    if (name.endsWith("artifactVersions:listByArtifact")) {
      return [{ version: 1, renderFormat: "html", createdAt: 1 }];
    }
    if (name.endsWith("artifactHtml:getPreviewUrl")) {
      return { url: "https://storage.example/report.html", version: 1, createdAt: 1 };
    }
    if (name.endsWith("artifactFolders:getById")) return null;
    return undefined;
  });
});

afterEach(() => {
  cleanup();
});

describe("LibraryEditor HTML artifacts", () => {
  test("renders persisted HTML artifacts in a sandboxed iframe", () => {
    render(<LibraryEditor artifactId={artifactId} />);

    const iframe = screen.getByTitle("HTML report preview");
    expect(iframe).toHaveAttribute("sandbox", "");
    expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(iframe).toHaveAttribute("src", "https://storage.example/report.html");
    expect(screen.queryByTestId("markdown")).not.toBeInTheDocument();
  });
});
