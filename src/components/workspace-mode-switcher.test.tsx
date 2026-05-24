// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { WorkspaceModeSwitcher } from "./workspace-mode-switcher";
import { libraryPath } from "@/route-paths";
import type { WorkspaceId } from "@/lib/types";

const { useNavigateMock } = vi.hoisted(() => ({
  useNavigateMock: vi.fn(),
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => useNavigateMock,
}));

beforeEach(() => {
  useNavigateMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("WorkspaceModeSwitcher", () => {
  test("renders all three service modes", () => {
    render(<WorkspaceModeSwitcher workspaceId={"workspace_1" as WorkspaceId} mode="discuss" availability={null} />);

    expect(screen.getByRole("button", { name: "Discuss" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Library" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lab" })).toBeInTheDocument();
  });

  test("marks active mode with aria-pressed=true", () => {
    render(<WorkspaceModeSwitcher workspaceId={"workspace_1" as WorkspaceId} mode="discuss" availability={null} />);

    const discussBtn = screen.getByRole("button", { name: "Discuss" });
    const libraryBtn = screen.getByRole("button", { name: "Library" });

    expect(discussBtn).toHaveAttribute("aria-pressed", "true");
    expect(libraryBtn).toHaveAttribute("aria-pressed", "false");
  });

  test("navigates to new mode on click when available", async () => {
    render(
      <WorkspaceModeSwitcher
        workspaceId={"workspace_1" as WorkspaceId}
        mode="discuss"
        availability={{
          availableModes: ["discuss", "library", "lab"],
          disabledReasons: {},
        }}
      />,
    );

    const libraryBtn = screen.getByRole("button", { name: "Library" });
    fireEvent.click(libraryBtn);

    await waitFor(() => {
      expect(useNavigateMock).toHaveBeenCalledWith(libraryPath("workspace_1" as WorkspaceId));
    });
  });

  test("does not navigate when clicking disabled mode", async () => {
    render(
      <WorkspaceModeSwitcher
        workspaceId={"workspace_1" as WorkspaceId}
        mode="discuss"
        availability={{
          availableModes: ["discuss"],
          disabledReasons: {
            library: { message: "Attach a repo to unlock" },
            lab: { message: "Attach a repo to unlock" },
          },
        }}
      />,
    );

    const libraryBtn = screen.getByRole("button", { name: "Library" });
    fireEvent.click(libraryBtn);

    expect(useNavigateMock).not.toHaveBeenCalled();
  });

  test("marks unavailable modes with aria-disabled and reduced opacity", () => {
    render(
      <WorkspaceModeSwitcher
        workspaceId={"workspace_1" as WorkspaceId}
        mode="discuss"
        availability={{
          availableModes: ["discuss"],
          disabledReasons: {
            library: { message: "Attach a repo to unlock" },
          },
        }}
      />,
    );

    const libraryBtn = screen.getByRole("button", { name: "Library" });
    expect(libraryBtn).toHaveAttribute("aria-disabled", "true");
    expect(libraryBtn).toHaveClass("opacity-50");
  });

  test("does not navigate when workspaceId is null", () => {
    render(<WorkspaceModeSwitcher workspaceId={null} mode="discuss" availability={null} />);

    const libraryBtn = screen.getByRole("button", { name: "Library" });
    fireEvent.click(libraryBtn);

    expect(useNavigateMock).not.toHaveBeenCalled();
  });

  test("does not navigate when clicking the current mode", () => {
    render(
      <WorkspaceModeSwitcher
        workspaceId={"workspace_1" as WorkspaceId}
        mode="discuss"
        availability={{
          availableModes: ["discuss", "library"],
          disabledReasons: {},
        }}
      />,
    );

    const discussBtn = screen.getByRole("button", { name: "Discuss" });
    fireEvent.click(discussBtn);

    expect(useNavigateMock).not.toHaveBeenCalled();
  });

  test("available mode renders as interactive (aria-disabled=false)", () => {
    render(
      <WorkspaceModeSwitcher
        workspaceId={"workspace_1" as WorkspaceId}
        mode="discuss"
        availability={{
          availableModes: ["discuss", "library"],
          disabledReasons: {},
        }}
      />,
    );

    const libraryBtn = screen.getByRole("button", { name: "Library" });
    expect(libraryBtn).toBeInTheDocument();
    expect(libraryBtn).toHaveAttribute("aria-disabled", "false");
  });

  test("active mode shows label and pill", () => {
    render(<WorkspaceModeSwitcher workspaceId={"workspace_1" as WorkspaceId} mode="discuss" availability={null} />);

    const discussBtn = screen.getByRole("button", { name: "Discuss" });
    expect(discussBtn).toHaveTextContent("Discuss");
    const pillElement = discussBtn.querySelector("span.absolute.inset-0.rounded-sm.bg-background");
    expect(pillElement).toBeInTheDocument();
  });

  test("inactive label sits outside the visible button area (clipped by overflow)", () => {
    render(<WorkspaceModeSwitcher workspaceId={"workspace_1" as WorkspaceId} mode="discuss" availability={null} />);

    const libraryBtn = screen.getByRole("button", { name: "Library" });
    expect(libraryBtn).toHaveClass("overflow-hidden");

    // The label is always rendered (for the "always inside, gradually revealed"
    // animation), but absolutely positioned at left-[30px] — exactly the
    // inactive button's width — so overflow-hidden clips it entirely.
    const labelSpan = libraryBtn.querySelector("span[aria-hidden='true']");
    expect(labelSpan).toHaveTextContent("Library");
    expect(labelSpan).toHaveClass("left-[30px]");
  });
});
