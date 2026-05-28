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
  test("checks every document by default", () => {
    useQueryMock.mockReturnValue(null);
    useMutationMock.mockReturnValue(vi.fn());

    render(<GenerateSystemDesignDialog open={true} onOpenChange={vi.fn()} repositoryId={repositoryId} />);

    // The publication opts the user in to the full set — all eight documents
    // start checked.
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(8);
    for (const checkbox of checkboxes) {
      expect(checkbox).toBeChecked();
    }
  });

  test("toggles selection when clicking checkboxes", () => {
    useQueryMock.mockReturnValue(null);
    useMutationMock.mockReturnValue(vi.fn());

    render(<GenerateSystemDesignDialog open={true} onOpenChange={vi.fn()} repositoryId={repositoryId} />);

    const dataModelCheckbox = screen.getByRole("checkbox", { name: /Data Model Overview/i });
    expect(dataModelCheckbox).toBeChecked();

    fireEvent.click(dataModelCheckbox);
    expect(dataModelCheckbox).not.toBeChecked();

    fireEvent.click(dataModelCheckbox);
    expect(dataModelCheckbox).toBeChecked();
  });

  test("updates the selected count when selections change", async () => {
    useQueryMock.mockReturnValue(null);
    useMutationMock.mockReturnValue(vi.fn());

    render(<GenerateSystemDesignDialog open={true} onOpenChange={vi.fn()} repositoryId={repositoryId} />);

    // Default: all 8 documents selected.
    expect(screen.getByText(/Selected:/i)).toHaveTextContent("Selected: 8 of 8 documents.");

    // Toggle two documents off.
    fireEvent.click(screen.getByRole("checkbox", { name: /README Summary/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Security Overview/i }));

    await waitFor(() => {
      expect(screen.getByText(/Selected:/i)).toHaveTextContent("Selected: 6 of 8 documents.");
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

  test("submits the full default selection and closes dialog on success", async () => {
    useQueryMock.mockReturnValue(null);
    const requestGeneration = vi.fn().mockResolvedValue({ jobId: "job_1" });
    useMutationMock.mockReturnValue(requestGeneration);

    const onOpenChange = vi.fn();
    render(<GenerateSystemDesignDialog open={true} onOpenChange={onOpenChange} repositoryId={repositoryId} />);

    const generateBtn = screen.getByRole("button", { name: /Generate selected/i });
    fireEvent.click(generateBtn);

    await waitFor(() => {
      expect(requestGeneration).toHaveBeenCalledWith({
        repositoryId,
        selections: [
          "readme_summary",
          "architecture_overview",
          "architecture_diagram",
          "data_model_overview",
          "api_surface_overview",
          "deployment_overview",
          "security_overview",
          "operations_overview",
        ],
      });
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

  test("disables submit button when no items are selected", () => {
    useQueryMock.mockReturnValue(null);
    useMutationMock.mockReturnValue(vi.fn());

    render(<GenerateSystemDesignDialog open={true} onOpenChange={vi.fn()} repositoryId={repositoryId} />);

    // Uncheck every document.
    for (const checkbox of screen.getAllByRole("checkbox")) {
      fireEvent.click(checkbox);
    }

    // Generate button should be disabled
    const generateBtn = screen.getByRole("button", { name: /Generate selected/i });
    expect(generateBtn).toBeDisabled();
  });
});
