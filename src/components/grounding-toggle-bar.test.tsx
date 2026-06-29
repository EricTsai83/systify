// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { GroundingToggleBar, createDiscussGroundingAxes } from "./grounding-toggle-bar";

afterEach(() => {
  cleanup();
});

describe("GroundingToggleBar", () => {
  test("recoverable Sandbox state selects desired grounding and shows prepare-on-send copy", () => {
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

  test("selecting Library clears active Sandbox grounding", () => {
    const setGroundLibrary = vi.fn();
    const setGroundSandbox = vi.fn();

    render(
      <GroundingToggleBar
        axes={createDiscussGroundingAxes({
          groundLibrary: false,
          groundSandbox: true,
          setGroundLibrary,
          setGroundSandbox,
          grounding: {
            library: { enabled: true },
            sandbox: { enabled: true },
          },
        })}
      />,
    );

    fireEvent.click(screen.getByTestId("grounding-toggle-library"));

    expect(setGroundSandbox).toHaveBeenCalledWith(false);
    expect(setGroundLibrary).toHaveBeenCalledWith(true);
  });

  test("None clears whichever grounding option is active", () => {
    const setGroundLibrary = vi.fn();

    render(
      <GroundingToggleBar
        axes={createDiscussGroundingAxes({
          groundLibrary: true,
          groundSandbox: false,
          setGroundLibrary,
          setGroundSandbox: vi.fn(),
          grounding: {
            library: { enabled: true },
            sandbox: { enabled: true },
          },
        })}
      />,
    );

    fireEvent.click(screen.getByTestId("grounding-toggle-none"));

    expect(setGroundLibrary).toHaveBeenCalledWith(false);
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

  test("library no-artifact verdict exposes the reason through the disabled toggle tooltip", async () => {
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
      />,
    );

    const libraryToggle = screen.getByTestId("grounding-toggle-library");
    expect(screen.queryByTestId("grounding-generate-cta")).not.toBeInTheDocument();
    expect(libraryToggle).toHaveAttribute("title", "Generate a guide first.");

    fireEvent.pointerEnter(libraryToggle);
    fireEvent.mouseMove(libraryToggle);
    fireEvent.focus(libraryToggle);

    expect(await screen.findByRole("tooltip")).toHaveTextContent("Generate a guide first.");
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
