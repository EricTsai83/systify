// @vitest-environment jsdom

import type React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { useQuery } from "convex/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PromptInputModelPicker } from "./prompt-input-model-picker";
import type { ModelCatalogEntry } from "@/lib/types";

vi.mock("convex/react", () => ({
  useQuery: vi.fn(),
}));

vi.mock("@/components/ai-elements/prompt-input", () => ({
  PromptInputSelect: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PromptInputSelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PromptInputSelectItem: ({ children, value }: { children: React.ReactNode; value: string }) => (
    <div data-value={value}>{children}</div>
  ),
  PromptInputSelectTrigger: ({ children, ...props }: React.HTMLAttributes<HTMLButtonElement>) => (
    <button type="button" {...props}>
      {children}
    </button>
  ),
  PromptInputSelectValue: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

vi.mock("@/components/ui/select", () => ({
  SelectGroup: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  SelectLabel: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <span>{children}</span>,
}));

const catalogEntries = [
  {
    provider: "openai",
    modelName: "gpt-5-mini",
    displayName: "GPT-5 mini",
    capability: "discuss",
  },
  {
    provider: "anthropic",
    modelName: "claude-sonnet-4-5",
    displayName: "Claude Sonnet 4.5",
    capability: "discuss",
  },
] satisfies Pick<ModelCatalogEntry, "provider" | "modelName" | "displayName" | "capability">[];

afterEach(() => {
  cleanup();
  vi.mocked(useQuery).mockReset();
});

describe("PromptInputModelPicker", () => {
  test("marks the locked provider label with a tooltip instead of a separate pill", () => {
    vi.mocked(useQuery).mockReturnValue(catalogEntries);

    render(
      <PromptInputModelPicker
        value={{ provider: "anthropic", modelName: "claude-sonnet-4-5" }}
        onChange={vi.fn()}
        threadLockedProvider="anthropic"
      />,
    );

    expect(screen.queryByTestId("prompt-input-model-picker-lock-pill")).not.toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByTestId("prompt-input-model-picker-lock-icon")).toHaveAttribute(
      "aria-label",
      "Locked to Anthropic",
    );
    expect(screen.getByText("Locked to Anthropic")).toBeInTheDocument();
    expect(screen.queryByText("OpenAI")).not.toBeInTheDocument();
  });
});
