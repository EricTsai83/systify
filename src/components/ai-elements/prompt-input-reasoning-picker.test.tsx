// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
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

  test("keeps the control visible when the selected override is none", () => {
    render(<PromptInputReasoningPicker value="none" onChange={vi.fn()} provider="openai" modelName="gpt-5.5" />);

    expect(screen.getByTestId("prompt-input-reasoning-picker-trigger")).toHaveTextContent("Instant");
  });
});
