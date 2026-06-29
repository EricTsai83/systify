// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { PendingLibraryAskShell } from "./library";

describe("PendingLibraryAskShell", () => {
  test("keeps the loading composer unmasked while only the Ask button is disabled", () => {
    render(<PendingLibraryAskShell />);

    const input = screen.getByLabelText("Library Ask input loading");
    expect(input).not.toBeDisabled();
    expect(input).toHaveAttribute("readonly");
    expect(screen.queryByText("Draft")).not.toBeInTheDocument();
    expect(screen.queryByText("GPT-5.4 Mini")).not.toBeInTheDocument();
    expect(screen.queryByText("Low")).not.toBeInTheDocument();
    const askButton = screen.getByRole("button", { name: "Asking..." });
    expect(askButton).toBeDisabled();
  });
});
