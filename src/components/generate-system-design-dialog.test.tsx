// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getFunctionName } from "convex/server";
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

/**
 * Convex's codegen exposes `getFunctionName(query)` as the canonical way
 * to identify a query reference at runtime. We use it to route a single
 * `useQuery` mock to per-query stubs (active job vs. cached status vs.
 * the picker's catalog).
 */
function queryName(query: unknown): string {
  try {
    return getFunctionName(query as Parameters<typeof getFunctionName>[0]);
  } catch {
    return "";
  }
}

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
    // start checked. We filter by the catalog id prefix so the
    // "Regenerate even if cached" toggle (a separate checkbox in the same
    // dialog) doesn't get folded into the assertion.
    const selectionCheckboxes = screen
      .getAllByRole("checkbox")
      .filter((checkbox) => checkbox.id.startsWith("gen-") && checkbox.id !== "gen-force-regenerate");
    expect(selectionCheckboxes).toHaveLength(8);
    for (const checkbox of selectionCheckboxes) {
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

    // Default: all 8 guide sections selected.
    expect(screen.getByText(/Selected:/i)).toHaveTextContent("Selected: 8 of 8 guide sections.");

    // Toggle two documents off.
    fireEvent.click(screen.getByRole("checkbox", { name: /README Summary/i }));
    fireEvent.click(screen.getByRole("checkbox", { name: /Security Overview/i }));

    await waitFor(() => {
      expect(screen.getByText(/Selected:/i)).toHaveTextContent("Selected: 6 of 8 guide sections.");
    });
  });

  test("shows alert and disables inputs when a job is in progress", () => {
    const mockJob = { _id: "job_1", status: "running" };
    useQueryMock.mockReturnValue(mockJob);
    useMutationMock.mockReturnValue(vi.fn());

    render(<GenerateSystemDesignDialog open={true} onOpenChange={vi.fn()} repositoryId={repositoryId} />);

    // Check that the alert is displayed
    expect(screen.getByText(/A Repository Guide run is already in progress/i)).toBeInTheDocument();

    // Check that checkboxes are disabled
    const checkboxes = screen.getAllByRole("checkbox");
    for (const checkbox of checkboxes) {
      expect(checkbox).toBeDisabled();
    }

    // Check that Generate button is disabled
    const generateBtn = screen.getByRole("button", { name: /Generate selected/i });
    expect(generateBtn).toBeDisabled();
  });

  test("submits the full default selection with the default model pick and closes dialog on success", async () => {
    // The dialog's default model now resolves through
    // `useDefaultModelPick(api.llmCatalog.getDefaultModelPick)` rather
    // than a hardcoded literal. Stub that query so the submit button
    // can fire with a non-null pair without needing to mount the full
    // picker.
    useQueryMock.mockImplementation((query: unknown) => {
      const name = queryName(query);
      if (name.endsWith("getDefaultModelPick")) {
        return { provider: "openai", modelName: "gpt-5.5" };
      }
      return null;
    });
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
        provider: "openai",
        modelName: "gpt-5.5",
        // `forceRegenerate` defaults to `undefined` (not `false`) so the
        // backend treats the field as omitted rather than explicit-off.
        forceRegenerate: undefined,
      });
      expect(onOpenChange).toHaveBeenCalledWith(false);
    });
  });

  test("submits with forceRegenerate=true when the user toggles the checkbox", async () => {
    useQueryMock.mockImplementation((query: unknown) => {
      const name = queryName(query);
      if (name.endsWith("getDefaultModelPick")) {
        return { provider: "openai", modelName: "gpt-5.5" };
      }
      return null;
    });
    const requestGeneration = vi.fn().mockResolvedValue({ jobId: "job_1" });
    useMutationMock.mockReturnValue(requestGeneration);

    render(<GenerateSystemDesignDialog open={true} onOpenChange={vi.fn()} repositoryId={repositoryId} />);

    fireEvent.click(screen.getByRole("checkbox", { name: /Regenerate even if cached/i }));
    fireEvent.click(screen.getByRole("button", { name: /Generate selected/i }));

    await waitFor(() => {
      expect(requestGeneration).toHaveBeenCalledWith(
        expect.objectContaining({
          forceRegenerate: true,
        }),
      );
    });
  });

  test("renders the cache hint when getCachedSelectionStatus reports cached kinds", () => {
    // Three queries fire here — `getActiveSystemDesignJob` (no job),
    // `getCachedSelectionStatus`, and the picker's `listPickableModels`.
    // Route via `getFunctionName` so the cache hint test is robust to
    // additional queries landing in the dialog later.
    useQueryMock.mockImplementation((query: unknown) => {
      const name = queryName(query);
      if (name.endsWith("getCachedSelectionStatus")) {
        return {
          total: 8,
          cachedKinds: ["readme_summary", "architecture_overview", "data_model_overview"],
          pendingKinds: [
            "architecture_diagram",
            "api_surface_overview",
            "deployment_overview",
            "security_overview",
            "operations_overview",
          ],
        };
      }
      if (name.endsWith("listPickableModels")) {
        return [
          {
            provider: "openai",
            modelName: "gpt-5.5",
            displayName: "GPT-5.5",
            capability: "sandbox",
            supportsReasoning: true,
            supportsTools: true,
            contextWindow: 200_000,
            userPickable: true,
          },
        ];
      }
      if (name.endsWith("getDefaultModelPick")) {
        return { provider: "openai", modelName: "gpt-5.5" };
      }
      return null;
    });
    useMutationMock.mockReturnValue(vi.fn());

    render(<GenerateSystemDesignDialog open={true} onOpenChange={vi.fn()} repositoryId={repositoryId} />);

    expect(
      screen.getByText(/3 of 8 selected guide sections already exist for this commit and model/i),
    ).toBeInTheDocument();
  });

  test("shows error message on submission failure", async () => {
    useQueryMock.mockImplementation((query: unknown) => {
      const name = queryName(query);
      if (name.endsWith("getDefaultModelPick")) {
        return { provider: "openai", modelName: "gpt-5.5" };
      }
      return null;
    });
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
    useQueryMock.mockImplementation((query: unknown) => {
      const name = queryName(query);
      if (name.endsWith("getDefaultModelPick")) {
        return { provider: "openai", modelName: "gpt-5.5" };
      }
      return null;
    });
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
