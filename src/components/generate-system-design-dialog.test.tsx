// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GenerateSystemDesignDialog } from "./generate-system-design-dialog";
import type { RepositoryId } from "@/lib/types";

const { useMutationMock, useQueryMock } = vi.hoisted(() => ({
  useMutationMock: vi.fn(),
  useQueryMock: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: useMutationMock,
  useQuery: useQueryMock,
}));

beforeEach(() => {
  useMutationMock.mockReset();
  useQueryMock.mockReset();
});

afterEach(() => {
  cleanup();
});

const repositoryId = "repo_1" as RepositoryId;

describe("GenerateSystemDesignDialog", () => {
  test("renders dialog with all checkboxes in default state", () => {
    useQueryMock.mockReturnValue(null);
    useMutationMock.mockReturnValue(vi.fn());

    render(<GenerateSystemDesignDialog open={true} onOpenChange={vi.fn()} repositoryId={repositoryId} />);

    // Check default selected items are checked (heuristic kinds)
    const manifestCheckbox = screen.getByRole("checkbox", { name: /Repository Manifest/i });
    const architectureCheckbox = screen.getByRole("checkbox", { name: /Architecture Overview/i });
    expect(manifestCheckbox).toBeChecked();
    expect(architectureCheckbox).toBeChecked();

    // Check that LLM-backed items are unchecked by default
    const readmeCheckbox = screen.getByRole("checkbox", { name: /README Summary/i });
    const dataModelCheckbox = screen.getByRole("checkbox", { name: /Data Model Overview/i });
    expect(readmeCheckbox).not.toBeChecked();
    expect(dataModelCheckbox).not.toBeChecked();
  });

  test("toggles selection when clicking checkboxes", () => {
    useQueryMock.mockReturnValue(null);
    useMutationMock.mockReturnValue(vi.fn());

    render(<GenerateSystemDesignDialog open={true} onOpenChange={vi.fn()} repositoryId={repositoryId} />);

    const dataModelCheckbox = screen.getByRole("checkbox", { name: /Data Model Overview/i });
    expect(dataModelCheckbox).not.toBeChecked();

    fireEvent.click(dataModelCheckbox);
    expect(dataModelCheckbox).toBeChecked();

    fireEvent.click(dataModelCheckbox);
    expect(dataModelCheckbox).not.toBeChecked();
  });

  test("updates counts when selections change", async () => {
    useQueryMock.mockReturnValue(null);
    useMutationMock.mockReturnValue(vi.fn());

    render(<GenerateSystemDesignDialog open={true} onOpenChange={vi.fn()} repositoryId={repositoryId} />);

    // Default: 2 free items are selected (manifest, architecture_overview)
    expect(screen.getByText(/Selected:/i)).toHaveTextContent("Selected: 2 total (2 free, 0 LLM).");

    // Toggle a free item off, toggle two LLM items on
    const manifestCheckbox = screen.getByRole("checkbox", { name: /Repository Manifest/i });
    const readmeCheckbox = screen.getByRole("checkbox", { name: /README Summary/i });
    const dataModelCheckbox = screen.getByRole("checkbox", { name: /Data Model Overview/i });

    fireEvent.click(manifestCheckbox);
    fireEvent.click(readmeCheckbox);
    fireEvent.click(dataModelCheckbox);

    // Now: 1 free + 2 llm
    await waitFor(() => {
      expect(screen.getByText(/Selected:/i)).toHaveTextContent("Selected: 3 total (1 free, 2 LLM).");
    });
  });

  test("shows alert and disables inputs when a job is in progress", () => {
    const mockJob = { _id: "job_1", status: "running" };
    useQueryMock.mockReturnValue(mockJob);
    useMutationMock.mockReturnValue(vi.fn());

    render(<GenerateSystemDesignDialog open={true} onOpenChange={vi.fn()} repositoryId={repositoryId} />);

    // Check that the alert is displayed
    expect(screen.getByText(/A generation is already in progress/i)).toBeInTheDocument();

    // Check that checkboxes are disabled
    const checkboxes = screen.getAllByRole("checkbox");
    for (const checkbox of checkboxes) {
      expect(checkbox).toBeDisabled();
    }

    // Check that Generate button is disabled
    const generateBtn = screen.getByRole("button", { name: /Generate selected/i });
    expect(generateBtn).toBeDisabled();
  });

  test("submits successfully and closes dialog on success", async () => {
    useQueryMock.mockReturnValue(null);
    const requestGeneration = vi.fn().mockResolvedValue({ jobId: "job_1" });
    useMutationMock.mockReturnValue(requestGeneration);

    const onOpenChange = vi.fn();
    render(<GenerateSystemDesignDialog open={true} onOpenChange={onOpenChange} repositoryId={repositoryId} />);

    const generateBtn = screen.getByRole("button", { name: /Generate selected/i });
    fireEvent.click(generateBtn);

    await waitFor(() => {
      expect(requestGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          repositoryId,
          selections: expect.arrayContaining(["manifest", "architecture_overview"]),
        }),
      );
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  test("shows error message on submission failure", async () => {
    useQueryMock.mockReturnValue(null);
    const requestGeneration = vi.fn().mockRejectedValue(new Error("Network error"));
    useMutationMock.mockReturnValue(requestGeneration);

    const onOpenChange = vi.fn();
    render(<GenerateSystemDesignDialog open={true} onOpenChange={onOpenChange} repositoryId={repositoryId} />);

    const generateBtn = screen.getByRole("button", { name: /Generate selected/i });
    fireEvent.click(generateBtn);

    await waitFor(() => {
      expect(screen.getByText(/Network error/i)).toBeInTheDocument();
    });

    // Dialog should remain open on error
    expect(onOpenChange).not.toHaveBeenCalled();
  });

  test("clears error state when dialog closes and reopens", async () => {
    useQueryMock.mockReturnValue(null);
    const requestGeneration = vi.fn().mockRejectedValue(new Error("Network error"));
    useMutationMock.mockReturnValue(requestGeneration);

    const onOpenChange = vi.fn();
    const { rerender } = render(
      <GenerateSystemDesignDialog open={true} onOpenChange={onOpenChange} repositoryId={repositoryId} />,
    );

    const generateBtn = screen.getByRole("button", { name: /Generate selected/i });
    fireEvent.click(generateBtn);

    await waitFor(() => {
      expect(screen.getByText(/Network error/i)).toBeInTheDocument();
    });

    // Close and reopen the dialog
    rerender(<GenerateSystemDesignDialog open={false} onOpenChange={onOpenChange} repositoryId={repositoryId} />);
    rerender(<GenerateSystemDesignDialog open={true} onOpenChange={onOpenChange} repositoryId={repositoryId} />);

    // Error should be cleared
    expect(screen.queryByText(/Network error/i)).not.toBeInTheDocument();
  });

  test("disables submit button when no items are selected", async () => {
    useQueryMock.mockReturnValue(null);
    useMutationMock.mockReturnValue(vi.fn());

    render(<GenerateSystemDesignDialog open={true} onOpenChange={vi.fn()} repositoryId={repositoryId} />);

    // Uncheck all default items (only heuristic kinds are default-checked)
    const manifestCheckbox = screen.getByRole("checkbox", { name: /Repository Manifest/i });
    const architectureCheckbox = screen.getByRole("checkbox", { name: /Architecture Overview/i });

    fireEvent.click(manifestCheckbox);
    fireEvent.click(architectureCheckbox);

    // Generate button should be disabled
    const generateBtn = screen.getByRole("button", { name: /Generate selected/i });
    expect(generateBtn).toBeDisabled();
  });
});
