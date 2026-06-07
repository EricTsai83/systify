// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { PromptInputReasoningPicker } from "./prompt-input-reasoning-picker";
import type { ModelCatalogEntry } from "@/lib/types";

const { useQueryMock } = vi.hoisted(() => ({
  useQueryMock: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useQuery: useQueryMock,
}));

const reasoningModel: ModelCatalogEntry = {
  provider: "openai",
  modelName: "gpt-5.5",
  displayName: "GPT-5.5",
  capability: "sandbox",
  reasoningEffort: "medium",
  supportedReasoningEfforts: ["low", "medium", "high"],
  supportsReasoning: true,
  supportsTools: true,
  contextWindow: 1_050_000,
  userPickable: true,
};

beforeEach(() => {
  useQueryMock.mockReset();
  useQueryMock.mockReturnValue([reasoningModel]);
});

afterEach(() => {
  cleanup();
});

describe("PromptInputReasoningPicker", () => {
  test("shows the catalog reasoning default before the user picks an override", () => {
    render(<PromptInputReasoningPicker value={null} onChange={vi.fn()} provider="openai" modelName="gpt-5.5" />);

    expect(screen.getByTestId("prompt-input-reasoning-picker-trigger")).toHaveTextContent("Medium");
  });

  test("keeps the control visible when the selected override is supported", () => {
    render(<PromptInputReasoningPicker value="low" onChange={vi.fn()} provider="openai" modelName="gpt-5.5" />);

    expect(screen.getByTestId("prompt-input-reasoning-picker-trigger")).toHaveTextContent("Low");
  });

  test("uses distinct trigger icons for low and medium efforts", () => {
    const { unmount } = render(
      <PromptInputReasoningPicker value="low" onChange={vi.fn()} provider="openai" modelName="gpt-5.5" />,
    );
    const lowIcon = screen.getByTestId("prompt-input-reasoning-picker-trigger").querySelector("svg")?.innerHTML;

    unmount();

    render(<PromptInputReasoningPicker value="medium" onChange={vi.fn()} provider="openai" modelName="gpt-5.5" />);
    const mediumIcon = screen.getByTestId("prompt-input-reasoning-picker-trigger").querySelector("svg")?.innerHTML;

    expect(lowIcon).toBeTruthy();
    expect(mediumIcon).toBeTruthy();
    expect(lowIcon).not.toEqual(mediumIcon);
  });

  test("falls back and notifies when a stale override is not supported by the selected model", async () => {
    const onChange = vi.fn();
    render(<PromptInputReasoningPicker value="none" onChange={onChange} provider="openai" modelName="gpt-5.5" />);

    expect(screen.getByTestId("prompt-input-reasoning-picker-trigger")).toHaveTextContent("Medium");
    expect(screen.queryByText("Instant")).not.toBeInTheDocument();
    await waitFor(() => expect(onChange).toHaveBeenCalledWith("medium"));
  });
});
