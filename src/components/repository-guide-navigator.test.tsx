// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { RepositoryGuideNavigator } from "./repository-guide-navigator";
import { REPOSITORY_GUIDE_SECTIONS } from "@/lib/repository-guide-catalog";
import type { ArtifactListItem, RepositoryId } from "@/lib/types";

const { useQueryMock } = vi.hoisted(() => ({ useQueryMock: vi.fn() }));

vi.mock("convex/react", () => ({
  useQuery: useQueryMock,
}));

beforeEach(() => {
  useQueryMock.mockReset();
});

afterEach(() => {
  cleanup();
});

const repositoryId = "repo_1" as RepositoryId;

function artifact(id: string, kind: string, title = kind, updatedAt = 1_700_000_000_000): ArtifactListItem {
  return {
    _id: id,
    _creationTime: updatedAt - 1_000,
    kind,
    title,
    description: `${title} description`,
    updatedAt,
  } as unknown as ArtifactListItem;
}

describe("RepositoryGuideNavigator", () => {
  test("empty state does not preview ungenerated templates or render a generate CTA", () => {
    useQueryMock.mockReturnValue(null); // no active job

    render(<RepositoryGuideNavigator repositoryId={repositoryId} artifacts={[]} onSelectArtifact={vi.fn()} />);

    expect(screen.getByRole("heading", { name: /No library documents yet/i })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: /Optional templates/i })).not.toBeInTheDocument();
    for (const section of REPOSITORY_GUIDE_SECTIONS) {
      expect(screen.queryByText(section.title)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole("button", { name: /Generate design docs/i })).not.toBeInTheDocument();
  });

  test("existing design doc is a launcher that opens its artifact", () => {
    useQueryMock.mockReturnValue(null);

    const onSelectArtifact = vi.fn();
    render(
      <RepositoryGuideNavigator
        repositoryId={repositoryId}
        artifacts={[artifact("art_readme", "readme_summary", "README Summary")]}
        onSelectArtifact={onSelectArtifact}
      />,
    );

    expect(screen.getByRole("heading", { name: /^Library overview$/i })).toBeInTheDocument();
    const designDocsSection = screen.getByRole("region", { name: "Design Docs" });
    const openButton = within(designDocsSection).getByRole("button", { name: /Open README Summary/i });
    fireEvent.click(openButton);
    expect(onSelectArtifact).toHaveBeenCalledWith("art_readme");
  });

  test("includes custom and repository documents, not just generated design docs", () => {
    useQueryMock.mockReturnValue(null);

    const onSelectArtifact = vi.fn();
    render(
      <RepositoryGuideNavigator
        repositoryId={repositoryId}
        artifacts={[
          artifact("art_arch", "architecture_overview", "Architecture Overview", 1_700_000_000_000),
          artifact("art_custom", "custom_document", "Release Plan", 1_700_000_010_000),
          artifact("art_legacy", "entrypoints", "Entrypoints", 1_700_000_020_000),
        ]}
        onSelectArtifact={onSelectArtifact}
      />,
    );

    expect(screen.getByRole("heading", { name: /^Design Docs$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Custom documents$/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /^Repository docs$/i })).toBeInTheDocument();

    const customDocsSection = screen.getByRole("region", { name: "Custom documents" });
    const repositoryDocsSection = screen.getByRole("region", { name: "Repository docs" });
    fireEvent.click(within(customDocsSection).getByRole("button", { name: /Open Release Plan/i }));
    fireEvent.click(within(repositoryDocsSection).getByRole("button", { name: /Open Entrypoints/i }));
    expect(onSelectArtifact).toHaveBeenNthCalledWith(1, "art_custom");
    expect(onSelectArtifact).toHaveBeenNthCalledWith(2, "art_legacy");
  });

  test("recent section sorts by updated time", () => {
    useQueryMock.mockReturnValue(null);

    render(
      <RepositoryGuideNavigator
        repositoryId={repositoryId}
        artifacts={[
          artifact("art_old", "readme_summary", "Older doc", 1_700_000_000_000),
          artifact("art_new", "custom_document", "Newer doc", 1_700_000_010_000),
        ]}
        onSelectArtifact={vi.fn()}
      />,
    );

    const recentSection = screen.getByRole("region", { name: "Recent" });
    const buttons = within(recentSection).getAllByRole("button");
    expect(buttons[0]).toHaveAccessibleName("Open Newer doc");
    expect(buttons[1]).toHaveAccessibleName("Open Older doc");
  });

  test("shows generation progress without showing template cards or generate CTA", () => {
    useQueryMock.mockReturnValue({
      status: "running",
      selections: ["architecture_overview"],
    });

    render(<RepositoryGuideNavigator repositoryId={repositoryId} artifacts={[]} onSelectArtifact={vi.fn()} />);

    expect(screen.getByRole("heading", { name: /^Library overview$/i })).toBeInTheDocument();
    expect(screen.getByText(/Generating 1 design doc/i)).toBeInTheDocument();
    expect(screen.queryByText("Architecture Overview")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Generate design docs/i })).not.toBeInTheDocument();
  });
});
