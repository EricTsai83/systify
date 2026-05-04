// @vitest-environment jsdom

import type React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc } from "../../convex/_generated/dataModel";
import { ToolCallTrace } from "./tool-call-trace";
import type { MessageId } from "@/lib/types";

/**
 * Plan 06 — render coverage for `<ToolCallTrace>`.
 *
 * Two scenarios under test, both rendering through one component:
 *
 *   1. **Streaming** — `useQuery` returns a folded live snapshot from
 *      `chat.streaming.getMessageToolCallEvents`. The latest entry's
 *      `state` drives the running ticker, completed entries appear in
 *      the collapsible summary.
 *   2. **Finalized** — `useQuery` is `"skip"`-ed (because `isStreaming`
 *      is false), and `persistedToolCalls` from `messages.toolCalls`
 *      drives the same renderer.
 *
 * The mock for `useQuery` is set per-test rather than module-level so a
 * single test can drive different return values (running / completed /
 * empty) without touching others.
 */

const useQueryMock = vi.hoisted(() => vi.fn());

vi.mock("convex/react", () => ({
  useQuery: useQueryMock,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

// Collapsible mock that mimics the radix `Root` + `Trigger asChild` +
// `Content` contract just well enough for these tests:
//   - `Root` provides the `open` / `onOpenChange` props via React context
//     so the trigger and content can read them without prop drilling.
//   - `Trigger asChild` clones its child and merges an `onClick` handler
//     that flips the open state. Real radix does the same; our mock
//     exists so we don't drag the radix primitive (with its real focus
//     management) into a unit test.
//   - `Content` always renders so tests can inspect the entries even
//     while collapsed (the persisted-trace tests rely on this).
import { cloneElement, createContext, isValidElement, useContext } from "react";
import type { MouseEvent } from "react";

type CollapsibleCtx = { open: boolean; onOpenChange: (open: boolean) => void };
const collapsibleContext = createContext<CollapsibleCtx>({
  open: false,
  onOpenChange: () => {},
});

vi.mock("@/components/ui/collapsible", () => ({
  Collapsible: ({
    children,
    open = false,
    onOpenChange = () => {},
  }: {
    children: React.ReactNode;
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
  }) => (
    <collapsibleContext.Provider value={{ open, onOpenChange }}>
      <div data-testid="collapsible-root" data-open={open}>
        {children}
      </div>
    </collapsibleContext.Provider>
  ),
  CollapsibleTrigger: ({
    children,
    asChild,
  }: {
    children: React.ReactNode;
    asChild?: boolean;
  }) => {
    const { open, onOpenChange } = useContext(collapsibleContext);
    if (asChild && isValidElement<{ onClick?: (event: MouseEvent) => void }>(children)) {
      const childOnClick = children.props.onClick;
      return cloneElement(children, {
        onClick: (event: MouseEvent) => {
          childOnClick?.(event);
          onOpenChange(!open);
        },
      });
    }
    return <>{children}</>;
  },
  CollapsibleContent: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="collapsible-content">{children}</div>
  ),
}));

const messageId = "message_trace_1" as MessageId;

beforeEach(() => {
  useQueryMock.mockReset();
});

afterEach(() => {
  cleanup();
});

describe("ToolCallTrace — finalized (persistedToolCalls)", () => {
  test("renders nothing when toolCalls is undefined and not streaming", () => {
    const { container } = render(
      <ToolCallTrace messageId={messageId} persistedToolCalls={undefined} isStreaming={false} />,
    );
    expect(container).toBeEmptyDOMElement();
    // The streaming subscription must not fire when isStreaming=false —
    // protects history bubbles from spawning N subscriptions.
    expect(useQueryMock).toHaveBeenCalledWith(expect.anything(), "skip");
  });

  test("renders the collapsed Tool calls summary with the persisted entries", () => {
    const persisted: NonNullable<Doc<"messages">["toolCalls"]> = [
      {
        toolCallId: "c1",
        toolName: "read_file",
        inputSummary: '{"path":"convex/chat/send.ts"}',
        outputSummary: '{"ok":true}',
        startedAt: 1000,
        endedAt: 1500,
      },
      {
        toolCallId: "c2",
        toolName: "list_dir",
        inputSummary: '{"path":"convex/chat"}',
        outputSummary: '{"ok":true,"entries":[]}',
        startedAt: 1600,
        endedAt: 1700,
      },
    ];

    render(
      <ToolCallTrace messageId={messageId} persistedToolCalls={persisted} isStreaming={false} />,
    );

    expect(screen.getByTestId("tool-call-trace-toggle")).toHaveTextContent("Tool calls (2)");

    // The collapsible is collapsed by default — but the mocked
    // `CollapsibleContent` always renders so we can still inspect entries.
    expect(screen.getByTestId("tool-call-entry-c1")).toHaveAttribute("data-state", "completed");
    expect(screen.getByTestId("tool-call-entry-c2")).toHaveAttribute("data-state", "completed");
    // Path is extracted from the JSON-stringified input summary so the
    // user reads `convex/chat/send.ts` instead of the raw blob.
    expect(screen.getByTestId("tool-call-entry-c1")).toHaveTextContent("convex/chat/send.ts");
  });

  test("renders an errored entry with the destructive accent", () => {
    const persisted: NonNullable<Doc<"messages">["toolCalls"]> = [
      {
        toolCallId: "c-err",
        toolName: "read_file",
        inputSummary: '{"path":"missing.ts"}',
        outputSummary: "Error: file not found",
        startedAt: 0,
        endedAt: 250,
        errorCode: "tool_error",
      },
    ];

    render(
      <ToolCallTrace messageId={messageId} persistedToolCalls={persisted} isStreaming={false} />,
    );

    expect(screen.getByTestId("tool-call-entry-c-err")).toHaveAttribute("data-state", "errored");
    expect(screen.getByText(/Error code: tool_error/)).toBeInTheDocument();
  });

  test("clicking the toggle flips aria-expanded so the collapsible opens", () => {
    const persisted: NonNullable<Doc<"messages">["toolCalls"]> = [
      {
        toolCallId: "c-open",
        toolName: "read_file",
        inputSummary: '{"path":"a.ts"}',
        outputSummary: "{}",
        startedAt: 0,
        endedAt: 1,
      },
    ];
    render(
      <ToolCallTrace messageId={messageId} persistedToolCalls={persisted} isStreaming={false} />,
    );
    const toggle = screen.getByTestId("tool-call-trace-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
  });
});

describe("ToolCallTrace — streaming (live subscription)", () => {
  test("renders the running ticker for the in-flight tool", () => {
    useQueryMock.mockReturnValue([
      {
        toolCallId: "c-live",
        toolName: "read_file",
        inputSummary: '{"path":"convex/chat/send.ts"}',
        outputSummary: "",
        startedAt: 1000,
        endedAt: 1000,
        state: "running",
      },
    ]);

    render(
      <ToolCallTrace messageId={messageId} persistedToolCalls={undefined} isStreaming={true} />,
    );

    const ticker = screen.getByTestId("tool-call-ticker");
    expect(ticker).toHaveTextContent("Reading convex/chat/send.ts");
    // The collapsible header still summarizes (1) so the user sees how
    // many calls have happened so far.
    expect(screen.getByTestId("tool-call-trace-toggle")).toHaveTextContent("Tool calls (1)");
  });

  test("hides the ticker once every entry has settled", () => {
    useQueryMock.mockReturnValue([
      {
        toolCallId: "c-done",
        toolName: "list_dir",
        inputSummary: '{"path":"convex/"}',
        outputSummary: '{"ok":true,"entries":[]}',
        startedAt: 1000,
        endedAt: 1500,
        state: "completed",
      },
    ]);

    render(
      <ToolCallTrace messageId={messageId} persistedToolCalls={undefined} isStreaming={true} />,
    );

    expect(screen.queryByTestId("tool-call-ticker")).not.toBeInTheDocument();
    expect(screen.getByTestId("tool-call-entry-c-done")).toHaveAttribute("data-state", "completed");
  });

  test("renders nothing while the subscription is still loading", () => {
    // `useQuery` returns `undefined` until the first snapshot lands. The
    // component must not flash a stale persisted trace in that window.
    useQueryMock.mockReturnValue(undefined);

    const persisted: NonNullable<Doc<"messages">["toolCalls"]> = [
      {
        toolCallId: "c-stale",
        toolName: "read_file",
        inputSummary: '{"path":"old.ts"}',
        outputSummary: "{}",
        startedAt: 0,
        endedAt: 1,
      },
    ];
    const { container } = render(
      <ToolCallTrace messageId={messageId} persistedToolCalls={persisted} isStreaming={true} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  test("renders run_shell with the command extracted from the JSON args", () => {
    // Production shape: `generation.ts` JSON-stringifies the tool args
    // before redaction, so `inputSummary` for run_shell is
    // `{"command":"…"}`. The ticker must extract the inner command so
    // the user reads `Running grep -r foo convex/` instead of the raw
    // JSON blob.
    useQueryMock.mockReturnValue([
      {
        toolCallId: "c-shell-json",
        toolName: "run_shell",
        inputSummary: '{"command":"grep -r foo convex/"}',
        outputSummary: "",
        startedAt: 1000,
        endedAt: 1000,
        state: "running",
      },
    ]);

    render(
      <ToolCallTrace messageId={messageId} persistedToolCalls={undefined} isStreaming={true} />,
    );

    const ticker = screen.getByTestId("tool-call-ticker");
    expect(ticker).toHaveTextContent("Running grep -r foo convex/");
    // Negative assertion: the JSON braces must not leak into the ticker.
    expect(ticker.textContent).not.toContain("{");
  });

  test("truncates an overlong run_shell command in the ticker", () => {
    // Long commands should be capped so the ticker doesn't overflow the
    // single-line bar; the truncation marker (`…`) signals there's more.
    const longCommand = "find . ".concat("-name '*.ts' ".repeat(20));
    useQueryMock.mockReturnValue([
      {
        toolCallId: "c-shell-long",
        toolName: "run_shell",
        inputSummary: JSON.stringify({ command: longCommand }),
        outputSummary: "",
        startedAt: 1000,
        endedAt: 1000,
        state: "running",
      },
    ]);

    render(
      <ToolCallTrace messageId={messageId} persistedToolCalls={undefined} isStreaming={true} />,
    );

    const ticker = screen.getByTestId("tool-call-ticker");
    // The visible label is capped well below the full command length.
    expect(ticker.textContent ?? "").toMatch(/Running find \. -name.*…/);
    expect((ticker.textContent ?? "").length).toBeLessThan(longCommand.length);
  });

  test("falls back to the raw summary when run_shell input is not JSON", () => {
    // Defensive path: a future tool, a truncated JSON, or a raw-string
    // fixture should still produce a readable ticker rather than a
    // crashing parse.
    useQueryMock.mockReturnValue([
      {
        toolCallId: "c-shell-raw",
        toolName: "run_shell",
        inputSummary: "grep -r foo convex/",
        outputSummary: "",
        startedAt: 1000,
        endedAt: 1000,
        state: "running",
      },
    ]);

    render(
      <ToolCallTrace messageId={messageId} persistedToolCalls={undefined} isStreaming={true} />,
    );

    expect(screen.getByTestId("tool-call-ticker")).toHaveTextContent(/Running grep -r foo convex/);
  });
});
