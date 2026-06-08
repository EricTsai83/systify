// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Markdown } from "@/components/markdown";

const mermaidMock = vi.hoisted(() => ({
  initialize: vi.fn(),
  render: vi.fn(),
}));

vi.mock("mermaid", () => ({
  default: mermaidMock,
}));

beforeEach(() => {
  mermaidMock.initialize.mockReset();
  mermaidMock.render.mockReset();
  mermaidMock.render.mockResolvedValue({
    svg: '<svg viewBox="0 0 100 40"><text>Rendered diagram</text></svg>',
  });
});

afterEach(() => {
  cleanup();
});

describe("Markdown Mermaid rendering", () => {
  test("renders mermaid fences with the Systify diagram frame", async () => {
    render(
      <Markdown>
        {'```mermaid title="Request pipeline" caption="Arrows follow request order."\nflowchart TD\nA --> B\n```'}
      </Markdown>,
    );

    expect(await screen.findByRole("img", { name: "Request pipeline diagram" })).toBeInTheDocument();
    expect(screen.getByText("Request pipeline")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "Arrows follow request order." })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View diagram fullscreen" })).toBeInTheDocument();
    expect(mermaidMock.initialize).toHaveBeenCalledWith(
      expect.objectContaining({
        securityLevel: "strict",
        startOnLoad: false,
      }),
    );
    expect(mermaidMock.render).toHaveBeenCalledWith(
      expect.stringMatching(/^systify-mermaid-/),
      "flowchart TD\nA --> B",
    );
  });

  test("keeps artifact mermaid repair available from the custom renderer", async () => {
    mermaidMock.render.mockRejectedValue(new Error("Parse error on line 2"));
    const repair = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);

    render(<Markdown onRepairMermaid={repair}>{"```mermaid\nflowchart TD\nA -->\n```"}</Markdown>);

    expect(await screen.findByText("Mermaid diagram could not render.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Repair diagram" }));

    await waitFor(() => {
      expect(repair).toHaveBeenCalledWith({
        chart: "flowchart TD\nA -->",
        error: "Parse error on line 2",
      });
    });
  });

  test("zooms fullscreen wheel gestures from the viewport center", async () => {
    render(<Markdown>{'```mermaid title="Request pipeline"\nflowchart TD\nA --> B\n```'}</Markdown>);

    expect(await screen.findByRole("img", { name: "Request pipeline diagram" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View diagram fullscreen" }));

    const dialog = screen.getByRole("dialog", { name: "Request pipeline diagram" });
    const viewport = dialog.querySelector('[data-mermaid-viewport="fullscreen"]');
    const content = dialog.querySelector("[data-mermaid-viewport-content]");

    expect(viewport).toBeInstanceOf(HTMLElement);
    expect(content).toBeInstanceOf(HTMLElement);

    Object.defineProperty(viewport, "getBoundingClientRect", {
      configurable: true,
      value: () => ({
        bottom: 200,
        height: 200,
        left: 0,
        right: 400,
        top: 0,
        width: 400,
        x: 0,
        y: 0,
        toJSON: () => {},
      }),
    });

    fireEvent.wheel(viewport as HTMLElement, {
      clientX: 380,
      clientY: 180,
      deltaY: -100,
    });

    expect(content).toHaveStyle({
      transform: "translate(0px, 0px) scale(1.25)",
    });
  });
});
