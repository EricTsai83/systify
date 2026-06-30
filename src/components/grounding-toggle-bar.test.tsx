// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { GroundingToggleBar, createDiscussGroundingAxes } from "./grounding-toggle-bar";

beforeAll(() => {
  if (!HTMLElement.prototype.hasPointerCapture) {
    HTMLElement.prototype.hasPointerCapture = () => false;
  }
  if (!HTMLElement.prototype.releasePointerCapture) {
    HTMLElement.prototype.releasePointerCapture = () => {};
  }
});

afterEach(() => {
  cleanup();
});

describe("GroundingToggleBar", () => {
  function openGroundingSelector() {
    fireEvent.pointerDown(screen.getByTestId("grounding-toggle-trigger"), { button: 0, pointerType: "mouse" });
  }

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

    openGroundingSelector();
    const sandboxToggle = screen.getByTestId("grounding-toggle-sandbox");
    expect(sandboxToggle).toHaveTextContent("Prepares");

    fireEvent.click(sandboxToggle);

    expect(setGroundSandbox).toHaveBeenCalledWith(true);
  });

  test("selecting Library enables Library grounding without redundantly clearing Sandbox", () => {
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

    openGroundingSelector();
    fireEvent.click(screen.getByTestId("grounding-toggle-library"));

    expect(setGroundLibrary).toHaveBeenCalledWith(true);
    // Mutual exclusion is enforced by the session reducer (setGroundLibrary
    // clears sandbox), so the bar does not redundantly clear the other axis.
    expect(setGroundSandbox).not.toHaveBeenCalled();
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

    openGroundingSelector();
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

    openGroundingSelector();
    const libraryToggle = screen.getByTestId("grounding-toggle-library");
    expect(screen.queryByTestId("grounding-generate-cta")).not.toBeInTheDocument();
    expect(libraryToggle).toHaveAttribute("title", "Generate a guide first.");
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

    openGroundingSelector();
    fireEvent.click(screen.getByTestId("grounding-toggle-sandbox"));

    expect(setGroundSandbox).not.toHaveBeenCalled();
  });
});
