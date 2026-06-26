// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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

/** Minimal artifact stub — the navigator only reads `_id` and `kind`. */
function artifact(id: string, kind: string): ArtifactListItem {
  return { _id: id, kind, title: kind } as unknown as ArtifactListItem;
}

describe("RepositoryGuideNavigator", () => {
  test("empty state previews every section and leads with the generate CTA", () => {
    useQueryMock.mockReturnValue(null); // no active job

    const onGenerate = vi.fn();
    render(
      <RepositoryGuideNavigator
        repositoryId={repositoryId}
        artifacts={[]}
        onSelectArtifact={vi.fn()}
        onGenerate={onGenerate}
      />,
    );

    expect(screen.getByRole("heading", { name: /Start with design docs/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /Optional templates/i })).toBeInTheDocument();
    for (const section of REPOSITORY_GUIDE_SECTIONS) {
      expect(screen.getByText(section.title)).toBeInTheDocument();
    }
    // No artifact exists yet → every card is an inert preview, so the only
    // button on the surface is the primary CTA.
    const cta = screen.getByRole("button", { name: /Generate design docs/i });
    expect(cta).toBeEnabled();
    fireEvent.click(cta);
    expect(onGenerate).toHaveBeenCalledTimes(1);
  });

  test("a ready section is a launcher that opens its artifact", () => {
    useQueryMock.mockReturnValue(null);

    const onSelectArtifact = vi.fn();
    render(
      <RepositoryGuideNavigator
        repositoryId={repositoryId}
        artifacts={[artifact("art_readme", "readme_summary")]}
        onSelectArtifact={onSelectArtifact}
        onGenerate={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: /^Design Docs$/i })).toBeInTheDocument();
    const openButton = screen.getByRole("button", { name: /Open README Summary/i });
    fireEvent.click(openButton);
    expect(onSelectArtifact).toHaveBeenCalledWith("art_readme");
  });

  test("keeps the CTA available for adding sections while a job runs", () => {
    useQueryMock.mockReturnValue({
      status: "running",
      selections: ["architecture_overview"],
    });

    const onGenerate = vi.fn();
    render(
      <RepositoryGuideNavigator
        repositoryId={repositoryId}
        artifacts={[]}
        onSelectArtifact={vi.fn()}
        onGenerate={onGenerate}
      />,
    );

    expect(screen.getByRole("heading", { name: /Generating Design Docs/i })).toBeInTheDocument();
    const cta = screen.getByRole("button", { name: /Generate design docs/i });
    expect(cta).toBeEnabled();
    fireEvent.click(cta);
    expect(onGenerate).toHaveBeenCalledTimes(1);
    // The kind the job is producing shows the live "generating" affordance.
    expect(screen.getAllByText(/Generating…/i).length).toBeGreaterThan(0);
  });

  test("honours a disabled reason on the CTA", () => {
    useQueryMock.mockReturnValue(null);

    render(
      <RepositoryGuideNavigator
        repositoryId={repositoryId}
        artifacts={[]}
        onSelectArtifact={vi.fn()}
        onGenerate={vi.fn()}
        generateDisabledReason="Generation is disabled in demo mode."
      />,
    );

    expect(screen.getByRole("button", { name: /Generate design docs/i })).toBeDisabled();
    expect(screen.getByText("Generation is disabled in demo mode.")).toBeInTheDocument();
  });
});
