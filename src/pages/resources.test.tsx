// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { useQuery } from "convex/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ResourcesSettingsSection } from "./resources";

vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.mocked(useQuery).mockReset();
});

describe("ResourcesSettingsSection", () => {
  test("renders the populated resource layout skeleton while inventory loads", () => {
    vi.mocked(useQuery).mockImplementation(() => undefined);

    const { container } = render(
      <MemoryRouter>
        <ResourcesSettingsSection />
      </MemoryRouter>,
    );

    const summarySkeleton = container.querySelector("[data-resource-summary-skeleton='true']");
    const listSkeleton = container.querySelector("[data-resource-skeleton-list='true']");

    expect(summarySkeleton).not.toBeNull();
    expect(listSkeleton).not.toBeNull();
    expect(summarySkeleton!.compareDocumentPosition(listSkeleton!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelectorAll("[data-resource-summary-skeleton-badge='true']")).toHaveLength(5);

    const rows = container.querySelectorAll("[data-resource-skeleton-row='true']");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.querySelectorAll("[data-resource-status-skeleton='true']")).toHaveLength(2);
    }
  });
});
