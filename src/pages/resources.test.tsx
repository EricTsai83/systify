// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useMutation, useQuery } from "convex/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ResourcesSettingsSection } from "./resources";

vi.mock("convex/react", () => ({
  useMutation: vi.fn(),
  useQuery: vi.fn(),
}));

afterEach(() => {
  cleanup();
  vi.mocked(useMutation).mockReset();
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

  test("requests sandbox activation from an expired sandbox row", async () => {
    const requestSandboxActivation = makeMutationMock();
    requestSandboxActivation.mockResolvedValue({ jobId: "job_1" });
    vi.mocked(useMutation).mockReturnValue(requestSandboxActivation);
    vi.mocked(useQuery).mockReturnValue([makeInventoryRow({ reasonCode: "sandbox_expired" })]);

    render(
      <MemoryRouter>
        <ResourcesSettingsSection />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Wake sandbox" }));

    await waitFor(() => {
      expect(requestSandboxActivation).toHaveBeenCalledWith({ repositoryId: "repo_1" });
    });
    expect(requestSandboxActivation).toHaveBeenCalledTimes(1);
  });

  test("shows a user-facing error when sandbox activation fails", async () => {
    const requestSandboxActivation = makeMutationMock();
    requestSandboxActivation.mockRejectedValue(new Error("Daytona is temporarily unavailable."));
    vi.mocked(useMutation).mockReturnValue(requestSandboxActivation);
    vi.mocked(useQuery).mockReturnValue([makeInventoryRow({ reasonCode: "sandbox_unavailable" })]);

    render(
      <MemoryRouter>
        <ResourcesSettingsSection />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Retry sandbox" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Daytona is temporarily unavailable.");
    expect(requestSandboxActivation).toHaveBeenCalledWith({ repositoryId: "repo_1" });
  });
});

function makeMutationMock() {
  const mutation = vi.fn() as ReturnType<typeof vi.fn> & {
    withOptimisticUpdate: (...args: unknown[]) => typeof mutation;
  };
  mutation.withOptimisticUpdate = vi.fn().mockReturnValue(mutation);
  return mutation as typeof mutation & ReturnType<typeof useMutation>;
}

function makeInventoryRow({
  reasonCode,
}: {
  reasonCode: "missing_sandbox" | "sandbox_unavailable" | "sandbox_expired";
}) {
  return {
    repositoryId: "repo_1",
    fullName: "acme/widget",
    importStatus: "completed",
    lastImportedAt: Date.now() - 60_000,
    hasRemoteUpdates: false,
    sandboxModeStatus: {
      reasonCode,
      message: null,
    },
    sandbox: {
      status: reasonCode === "sandbox_unavailable" ? "failed" : "stopped",
      ttlExpiresAt: Date.now() - 1_000,
      autoStopIntervalMinutes: 15,
      autoArchiveIntervalMinutes: 1440,
    },
  };
}
