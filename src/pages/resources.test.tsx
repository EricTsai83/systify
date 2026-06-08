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
  window.sessionStorage.clear();
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

  test("requests sandbox cleanup from a ready sandbox row after confirmation", async () => {
    const requestSandboxCleanup = makeMutationMock();
    requestSandboxCleanup.mockResolvedValue({ jobId: "job_1" });
    vi.mocked(useMutation).mockReturnValue(requestSandboxCleanup);
    vi.mocked(useQuery).mockReturnValue([makeInventoryRow({ reasonCode: "available", sandboxStatus: "ready" })]);

    render(
      <MemoryRouter>
        <ResourcesSettingsSection />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("button", { name: "Wake sandbox" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activate" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Stop live source" }));
    expect(screen.getByText("Stop live source?")).toBeInTheDocument();
    expect(
      screen.getByText(
        "This closes the current live source environment. The next live-source task will prepare a fresh one.",
      ),
    ).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole("button", { name: "Stop live source" }).at(-1)!);

    await waitFor(() => {
      expect(requestSandboxCleanup).toHaveBeenCalledWith({ repositoryId: "repo_1" });
    });
    expect(requestSandboxCleanup).toHaveBeenCalledTimes(1);
  });

  test("shows cancel setup for a provisioning sandbox row", () => {
    vi.mocked(useMutation).mockReturnValue(makeMutationMock());
    vi.mocked(useQuery).mockReturnValue([
      makeInventoryRow({ reasonCode: "sandbox_provisioning", sandboxStatus: "provisioning" }),
    ]);

    render(
      <MemoryRouter>
        <ResourcesSettingsSection />
      </MemoryRouter>,
    );

    expect(screen.getByRole("button", { name: "Cancel setup" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Activate" })).not.toBeInTheDocument();
  });

  test("shows no sandbox action when there is no sandbox row", () => {
    vi.mocked(useMutation).mockReturnValue(makeMutationMock());
    vi.mocked(useQuery).mockReturnValue([makeInventoryRow({ reasonCode: "missing_sandbox", sandboxStatus: null })]);

    render(
      <MemoryRouter>
        <ResourcesSettingsSection />
      </MemoryRouter>,
    );

    expect(screen.queryByRole("button", { name: "Stop live source" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Cancel setup" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Open repository" })).toBeInTheDocument();
  });

  test("shows a user-facing error when sandbox cleanup fails", async () => {
    const requestSandboxCleanup = makeMutationMock();
    requestSandboxCleanup.mockRejectedValue(new Error("Daytona is temporarily unavailable."));
    vi.mocked(useMutation).mockReturnValue(requestSandboxCleanup);
    vi.mocked(useQuery).mockReturnValue([
      makeInventoryRow({ reasonCode: "sandbox_unavailable", sandboxStatus: "failed" }),
    ]);

    render(
      <MemoryRouter>
        <ResourcesSettingsSection />
      </MemoryRouter>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Stop live source" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Stop live source" }).at(-1)!);

    expect(await screen.findByRole("alert")).toHaveTextContent("Daytona is temporarily unavailable.");
    expect(requestSandboxCleanup).toHaveBeenCalledWith({ repositoryId: "repo_1" });
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
  sandboxStatus,
}: {
  reasonCode: "available" | "missing_sandbox" | "sandbox_unavailable" | "sandbox_expired" | "sandbox_provisioning";
  sandboxStatus: "ready" | "stopped" | "provisioning" | "failed" | null;
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
    sandbox:
      sandboxStatus === null
        ? null
        : {
            status: sandboxStatus,
            ttlExpiresAt: sandboxStatus === "ready" ? Date.now() + 60_000 : Date.now() - 1_000,
            autoStopIntervalMinutes: 15,
            autoArchiveIntervalMinutes: 1440,
          },
  };
}
