// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { ServiceModeSwitcher } from "./service-mode-switcher";
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

describe("ServiceModeSwitcher", () => {
  test("renders all three service modes", () => {
    render(
      <ServiceModeSwitcher workspaceId={"workspace_1" as WorkspaceId} serviceMode="discuss" availability={null} />,
    );

    expect(screen.getByRole("button", { name: "Discuss" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Library" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Lab" })).toBeInTheDocument();
  });

  test("marks active mode with aria-pressed=true", () => {
    render(
      <ServiceModeSwitcher workspaceId={"workspace_1" as WorkspaceId} serviceMode="discuss" availability={null} />,
    );

    const discussBtn = screen.getByRole("button", { name: "Discuss" });
    const libraryBtn = screen.getByRole("button", { name: "Library" });

    expect(discussBtn).toHaveAttribute("aria-pressed", "true");
    expect(libraryBtn).toHaveAttribute("aria-pressed", "false");
  });

  test("navigates to new mode on click when available", async () => {
    render(
      <ServiceModeSwitcher
        workspaceId={"workspace_1" as WorkspaceId}
        serviceMode="discuss"
        availability={{
          availableServiceModes: ["discuss", "library", "lab"],
          disabledReasons: {},
        }}
      />,
    );

    const libraryBtn = screen.getByRole("button", { name: "Library" });
    fireEvent.click(libraryBtn);

    await waitFor(() => {
      expect(useNavigateMock).toHaveBeenCalled();
    });
  });

  test("does not navigate when clicking disabled mode", async () => {
    render(
      <ServiceModeSwitcher
        workspaceId={"workspace_1" as WorkspaceId}
        serviceMode="discuss"
        availability={{
          availableServiceModes: ["discuss"],
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
      <ServiceModeSwitcher
        workspaceId={"workspace_1" as WorkspaceId}
        serviceMode="discuss"
        availability={{
          availableServiceModes: ["discuss"],
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
    render(<ServiceModeSwitcher workspaceId={null} serviceMode="discuss" availability={null} />);

    const libraryBtn = screen.getByRole("button", { name: "Library" });
    fireEvent.click(libraryBtn);

    expect(useNavigateMock).not.toHaveBeenCalled();
  });

  test("does not navigate when clicking the current mode", () => {
    render(
      <ServiceModeSwitcher
        workspaceId={"workspace_1" as WorkspaceId}
        serviceMode="discuss"
        availability={{
          availableServiceModes: ["discuss", "library"],
          disabledReasons: {},
        }}
      />,
    );

    const discussBtn = screen.getByRole("button", { name: "Discuss" });
    fireEvent.click(discussBtn);

    expect(useNavigateMock).not.toHaveBeenCalled();
  });

  test("applies whileTap scale animation only when available and not reduced motion", () => {
    render(
      <ServiceModeSwitcher
        workspaceId={"workspace_1" as WorkspaceId}
        serviceMode="discuss"
        availability={{
          availableServiceModes: ["discuss", "library"],
          disabledReasons: {},
        }}
      />,
    );

    const libraryBtn = screen.getByRole("button", { name: "Library" });
    expect(libraryBtn).toBeInTheDocument();
    expect(libraryBtn).toHaveAttribute("aria-disabled", "false");
  });

  test("active mode shows label and pill", () => {
    render(
      <ServiceModeSwitcher workspaceId={"workspace_1" as WorkspaceId} serviceMode="discuss" availability={null} />,
    );

    const discussBtn = screen.getByRole("button", { name: "Discuss" });
    expect(discussBtn).toHaveTextContent("Discuss");
  });

  test("inactive modes hide label text content", () => {
    render(
      <ServiceModeSwitcher workspaceId={"workspace_1" as WorkspaceId} serviceMode="discuss" availability={null} />,
    );

    const libraryBtn = screen.getByRole("button", { name: "Library" });
    expect(libraryBtn).not.toHaveTextContent("Library");
  });
});
