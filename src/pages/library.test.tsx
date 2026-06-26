// @vitest-environment jsdom

import { render, screen, within } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { LibraryLiveSourceBadge, PendingLibraryAskShell } from "./library";

describe("LibraryLiveSourceBadge", () => {
  test("shows code access active when sandbox activity is ready", () => {
    render(
      <LibraryLiveSourceBadge
        status={{
          kind: "ready",
          activeJob: null,
          sandbox: null,
        }}
      />,
    );

    expect(screen.getByLabelText("Repository code access is active")).toHaveTextContent("Code access active");
  });

  test("shows code access starting while setup is in flight", () => {
    render(
      <LibraryLiveSourceBadge
        status={{
          kind: "preparing",
          activeJob: null,
          sandbox: null,
        }}
      />,
    );

    expect(screen.getByLabelText("Repository code access is starting")).toHaveTextContent("Code access starting");
  });

  test("shows code access idle for idle status", () => {
    render(
      <LibraryLiveSourceBadge
        status={{
          kind: "idle",
          activeJob: null,
          sandbox: null,
        }}
      />,
    );

    expect(
      screen.getByLabelText("Repository code access starts when a task needs current repository files."),
    ).toHaveTextContent("Code access idle");
  });
});

describe("PendingLibraryAskShell", () => {
  test("keeps the loading composer unmasked while only the Ask button is disabled", () => {
    render(<PendingLibraryAskShell />);

    const input = screen.getByLabelText("Library Ask input loading");
    expect(input).not.toBeDisabled();
    expect(input).toHaveAttribute("readonly");
    expect(screen.queryByText("Draft")).not.toBeInTheDocument();
    expect(screen.queryByText("GPT-5.4 Mini")).not.toBeInTheDocument();
    expect(screen.queryByText("Low")).not.toBeInTheDocument();
    const askButton = screen.getByRole("button", { name: "Ask" });
    expect(askButton).toBeDisabled();
    expect(within(askButton).getByText("Asking...")).toBeInTheDocument();
  });
});
