// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { GroundingToggleBar, createDiscussGroundingAxes } from "./grounding-toggle-bar";

afterEach(() => {
  cleanup();
});

describe("GroundingToggleBar", () => {
  test("recoverable Sandbox state toggles desired grounding and shows prepare-on-send copy", () => {
    const setGroundSandbox = vi.fn();

    render(
      <GroundingToggleBar
        axes={createDiscussGroundingAxes({
          groundLibrary: false,
          groundSandbox: false,
          setGroundLibrary: vi.fn(),
          setGroundSandbox,
          grounding: {
            library: { enabled: true },
            sandbox: {
              enabled: false,
              code: "sandbox_missing",
              message: "Live source will be prepared when a task needs it.",
              isActivatable: true,
            },
          },
        })}
      />,
    );

    const sandboxToggle = screen.getByTestId("grounding-toggle-sandbox");
    expect(sandboxToggle).toHaveTextContent("prepares on send");

    fireEvent.click(sandboxToggle);

    expect(setGroundSandbox).toHaveBeenCalledWith(true);
  });

  test("discuss axis helper returns loading verdicts while availability loads", () => {
    const axes = createDiscussGroundingAxes({
      groundLibrary: false,
      groundSandbox: false,
      setGroundLibrary: vi.fn(),
      setGroundSandbox: vi.fn(),
      grounding: null,
    });

    expect(axes).toHaveLength(2);
    expect(axes[0]?.verdict).toMatchObject({ enabled: false, code: "loading" });
    expect(axes[1]?.verdict).toMatchObject({ enabled: false, code: "loading" });
  });

  test("library no-artifact verdict renders generate CTA", () => {
    render(
      <GroundingToggleBar
        axes={createDiscussGroundingAxes({
          groundLibrary: false,
          groundSandbox: false,
          setGroundLibrary: vi.fn(),
          setGroundSandbox: vi.fn(),
          grounding: {
            library: {
              enabled: false,
              code: "library_no_artifact",
              message: "Generate a guide first.",
            },
            sandbox: { enabled: true },
          },
        })}
        onOpenGenerateSystemDesign={vi.fn()}
      />,
    );

    expect(screen.getByTestId("grounding-generate-cta")).toBeInTheDocument();
  });

  test("disabled non-activatable axis does not call change handler", () => {
    const setGroundSandbox = vi.fn();

    render(
      <GroundingToggleBar
        axes={createDiscussGroundingAxes({
          groundLibrary: false,
          groundSandbox: false,
          setGroundLibrary: vi.fn(),
          setGroundSandbox,
          grounding: {
            library: { enabled: true },
            sandbox: {
              enabled: false,
              code: "sandbox_missing",
              message: "Sandbox unavailable.",
            },
          },
        })}
      />,
    );

    fireEvent.click(screen.getByTestId("grounding-toggle-sandbox"));

    expect(setGroundSandbox).not.toHaveBeenCalled();
  });
});
