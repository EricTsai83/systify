// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { GroundingToggleBar } from "./grounding-toggle-bar";

afterEach(() => {
  cleanup();
});

describe("GroundingToggleBar", () => {
  test("recoverable Sandbox state toggles desired grounding and shows prepare-on-send copy", () => {
    const setGroundSandbox = vi.fn();

    render(
      <GroundingToggleBar
        groundLibrary={false}
        groundSandbox={false}
        setGroundLibrary={vi.fn()}
        setGroundSandbox={setGroundSandbox}
        grounding={{
          library: { enabled: true },
          sandbox: {
            enabled: false,
            code: "sandbox_missing",
            message: "Live source will be prepared when a task needs it.",
            isActivatable: true,
          },
        }}
      />,
    );

    const sandboxToggle = screen.getByTestId("grounding-toggle-sandbox");
    expect(sandboxToggle).toHaveTextContent("prepares on send");

    fireEvent.click(sandboxToggle);

    expect(setGroundSandbox).toHaveBeenCalledWith(true);
  });
});
