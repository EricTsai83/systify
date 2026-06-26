// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { LibraryTabs } from "./library-tabs";
import type { ArtifactId, ArtifactListItem } from "@/lib/types";

afterEach(() => {
  cleanup();
});

function artifact(id: string, title: string): ArtifactListItem {
  return { _id: id, title } as unknown as ArtifactListItem;
}

describe("LibraryTabs", () => {
  test("keeps a selected focusable tab when the overview is active with open artifacts", () => {
    const artifactId = "artifact_a" as ArtifactId;
    render(
      <LibraryTabs
        openArtifactIds={[artifactId]}
        activeArtifactId={null}
        artifactsById={new Map([[artifactId, artifact("artifact_a", "README Summary")]])}
        onActivate={vi.fn()}
        onClose={vi.fn()}
        onReorder={vi.fn()}
      />,
    );

    const tabs = screen.getAllByRole("tab");
    expect(tabs).toHaveLength(2);
    expect(screen.getByRole("tab", { selected: true })).toHaveTextContent("Overview");
    expect(screen.getByRole("tab", { name: "Overview" })).toHaveAttribute("tabindex", "0");
    expect(screen.getByRole("tab", { name: "README Summary" })).toHaveAttribute("tabindex", "-1");
  });
});
