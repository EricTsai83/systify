// @vitest-environment jsdom

import type React from "react";
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useQuery } from "convex/react";
import { getFunctionName } from "convex/server";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Doc } from "../../convex/_generated/dataModel";
import { ChatContainer, ChatPanel } from "./chat-panel";
import type { ArtifactId, MessageId, ThreadId } from "@/lib/types";

// `<ToolCallTrace>` calls `useQuery` for the live event subscription. For
// the chat-panel suite we only care that the trace component does not
// crash on import — the ticker rendering is covered in `tool-call-trace.test.tsx`.
// Returning `[]` for any `useQuery` call keeps the trace rendering but
// surfaces no entries, which is the correct behavior for the existing
// fixtures that don't supply `toolCalls`.
vi.mock("convex/react", () => ({
  useMutation: vi.fn(() => vi.fn()),
  useQuery: vi.fn(() => []),
}));

vi.mock("@/components/import-repo-dialog", () => ({
  ImportRepoDialog: () => <div>import repo</div>,
}));

vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuSeparator: () => <div />,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/app-notice", () => ({
  // Mock surfaces title / message and forwards `onAction` and `onDismiss` so
  // tests can exercise the Plan 14 mode-suggestion hint (Switch + Dismiss)
  // and the existing sandbox-warning "Sync now" CTA without depending on the
  // shadcn Alert primitive's internal layout.
  AppNotice: ({
    title,
    message,
    actionLabel,
    onAction,
    actionDisabled,
    onDismiss,
    dismissLabel,
  }: {
    title: string;
    message: string;
    actionLabel?: string;
    onAction?: () => void;
    actionDisabled?: boolean;
    onDismiss?: () => void;
    dismissLabel?: string;
  }) => (
    <div data-testid="app-notice">
      <div>{title}</div>
      <div>{message}</div>
      {actionLabel && onAction ? (
        <button type="button" disabled={actionDisabled} onClick={onAction}>
          {actionLabel}
        </button>
      ) : null}
      {onDismiss ? (
        <button
          type="button"
          aria-label={dismissLabel ?? "Dismiss"}
          data-testid="app-notice-dismiss"
          onClick={onDismiss}
        >
          ×
        </button>
      ) : null}
    </div>
  ),
}));

// Plan 14 — Radix Popover renders into a portal that complicates "did the
// trigger render the right entries?" assertions. Stubbing both Popover and
// the trigger to plain divs lets the popover's content live alongside the
// trigger in the DOM, which is enough for the unit-level coverage in this
// file (Radix's open/close behavior is exercised in its own test suite).
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode; asChild?: boolean }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement> & { children?: React.ReactNode }) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("@/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  CardHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  CardTitle: ({ children }: { children: React.ReactNode }) => <h3>{children}</h3>,
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));

// Tooltip is rendered as the disabled-mode hint container; the test only
// cares that the trigger child renders, so we replace it with passthroughs.
vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

const threadId = "thread_1" as ThreadId;
const assistantMessageId = "message_1" as MessageId;

const queryName = (query: unknown) => {
  try {
    return getFunctionName(query as Parameters<typeof getFunctionName>[0]);
  } catch {
    return null;
  }
};

afterEach(() => {
  cleanup();
  vi.mocked(useQuery).mockReset();
  vi.mocked(useQuery).mockReturnValue([]);
});

describe("ChatPanel streaming rendering", () => {
  test("ChatContainer owns message and active-stream subscriptions for the selected thread", () => {
    vi.mocked(useQuery).mockImplementation((...callArgs) => {
      const [query, args] = callArgs;
      if (args === "skip") {
        return undefined;
      }
      switch (queryName(query)) {
        case "chat/threads:listMessages":
          return [
            {
              _id: assistantMessageId,
              role: "assistant",
              status: "streaming",
              content: "",
              errorMessage: undefined,
            } as unknown as Doc<"messages">,
          ];
        case "chat/streaming:getActiveMessageStream":
          return {
            assistantMessageId,
            content: "streamed from container",
            startedAt: Date.now(),
            lastAppendedAt: Date.now(),
          };
        default:
          return [];
      }
    });

    render(
      <ChatContainer
        selectedThreadId={threadId}
        isShellLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="discuss"
        setChatMode={vi.fn()}
        availableModes={["discuss"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    expect(vi.mocked(useQuery)).toHaveBeenCalledWith(expect.anything(), { threadId });
    expect(screen.getByText("streamed from container")).toBeInTheDocument();
  });

  test("renders active stream content for the in-flight assistant message", () => {
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "streaming",
            content: "",
            errorMessage: undefined,
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={{
          assistantMessageId,
          content: "streamed reply",
          startedAt: Date.now(),
          lastAppendedAt: Date.now(),
        }}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="discuss"
        setChatMode={vi.fn()}
        availableModes={["discuss"]}
        disabledModeReasons={{
          library: "Attach a repository to use Library mode.",
          lab: "Attach a repository with a ready sandbox to use Lab mode.",
        }}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    expect(screen.getByText("streamed reply")).toBeInTheDocument();
  });

  test("hands off from active stream content to durable message content without duplication", () => {
    const { rerender } = render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "streaming",
            content: "",
            errorMessage: undefined,
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={{
          assistantMessageId,
          content: "final streamed reply",
          startedAt: Date.now(),
          lastAppendedAt: Date.now(),
        }}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="library"
        setChatMode={vi.fn()}
        availableModes={["discuss", "library"]}
        disabledModeReasons={{ lab: "Provision a sandbox to use Lab mode." }}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    expect(screen.getByText("final streamed reply")).toBeInTheDocument();

    rerender(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "completed",
            content: "final streamed reply",
            errorMessage: undefined,
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="library"
        setChatMode={vi.fn()}
        availableModes={["discuss", "library"]}
        disabledModeReasons={{ lab: "Provision a sandbox to use Lab mode." }}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    expect(screen.getAllByText("final streamed reply")).toHaveLength(1);
  });

  test("renders mode selector trigger for desktop controls", () => {
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="discuss"
        setChatMode={vi.fn()}
        availableModes={["discuss", "library", "lab"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );
    expect(screen.getByRole("combobox", { name: /^answer mode selector$/i })).toBeInTheDocument();
  });
});

/**
 * Plan 02: assistant messages must surface (a) which mode produced them via
 * a small chip, and (b) a clickable inline citation for every `[A#]` that
 * resolves against `messages.citationMap`. Together these let the user
 * trace any factual claim back to a specific artifact.
 */
describe("ChatPanel mode badge and inline citations", () => {
  test("renders a mode chip for each assistant message using the mode's display label", () => {
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "completed",
            mode: "library",
            content: "Answer body.",
            errorMessage: undefined,
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="library"
        setChatMode={vi.fn()}
        availableModes={["discuss", "library"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    // The badge label must come from the mode catalog ("Library"),
    // not the raw DB literal ("library"). Anchoring the assertion on the
    // user-facing label catches any future drift between the badge and
    // the mode-selector pill.
    const badge = screen.getByTestId("message-mode-badge");
    expect(badge).toHaveTextContent("Library");
  });

  test("does not render a mode chip on user messages", () => {
    // The sender already knows which mode they were in when they hit
    // Send, so a chip on the user bubble would be visual noise.
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: "message_user_1" as MessageId,
            role: "user",
            status: "completed",
            mode: "library",
            content: "What about X?",
            errorMessage: undefined,
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="library"
        setChatMode={vi.fn()}
        availableModes={["discuss", "library"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("message-mode-badge")).not.toBeInTheDocument();
  });

  test("rewrites resolvable [A#] tokens into clickable citation buttons", () => {
    const onSelectArtifact = vi.fn();
    const artifactAlpha = "artifact_alpha" as ArtifactId;
    const artifactBeta = "artifact_beta" as ArtifactId;

    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "completed",
            mode: "library",
            content: "The boundary is documented [A1] and the risk is tracked [A2].",
            citationMap: [
              { index: 1, artifactId: artifactAlpha },
              { index: 2, artifactId: artifactBeta },
            ],
            errorMessage: undefined,
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="library"
        setChatMode={vi.fn()}
        availableModes={["library"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
        onSelectArtifact={onSelectArtifact}
      />,
    );

    // Both tokens become buttons. Clicking each forwards the
    // *artifact id*, not the textual `[A#]`, so the shell can route
    // straight to the panel without any further lookup.
    const buttonA1 = screen.getByTestId("citation-link-1");
    const buttonA2 = screen.getByTestId("citation-link-2");
    expect(buttonA1).toHaveTextContent("[A1]");
    expect(buttonA2).toHaveTextContent("[A2]");

    fireEvent.click(buttonA1);
    expect(onSelectArtifact).toHaveBeenCalledWith(artifactAlpha);
    fireEvent.click(buttonA2);
    expect(onSelectArtifact).toHaveBeenCalledWith(artifactBeta);
  });

  test("leaves [A#] tokens as plain text when the citation map has no matching entry", () => {
    // Defensive against models that hallucinate an `[A99]` when only
    // `[A1]` is in scope. The token must still render (so the user can
    // tell the model tried to cite something) but must not become a
    // clickable button — clicking would jump nowhere.
    const onSelectArtifact = vi.fn();
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "completed",
            mode: "library",
            content: "See [A99] for details.",
            citationMap: [{ index: 1, artifactId: "artifact_alpha" as ArtifactId }],
            errorMessage: undefined,
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="library"
        setChatMode={vi.fn()}
        availableModes={["library"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
        onSelectArtifact={onSelectArtifact}
      />,
    );

    expect(screen.queryByTestId("citation-link-99")).not.toBeInTheDocument();
    // The textual token still appears verbatim somewhere in the bubble.
    // We use a regex to tolerate whitespace splits introduced by the
    // segment renderer (each text run becomes its own Fragment).
    expect(screen.getByText(/\[A99\]/)).toBeInTheDocument();
  });
});

/**
 * Plan 11 — sandbox-mode citation lint highlights. The renderer reads
 * `messages.unverifiedClaims` and wraps the flagged offset ranges in a
 * `<mark>` so the user can scan unverified prose with extra skepticism.
 * Coverage targets:
 *
 *   - Flagged ranges render as `<mark data-testid="unverified-claim">`
 *     wrapping exactly the flagged substring.
 *   - The highlight composes with the docs-mode `[A#]` citation rewrite:
 *     a flagged sentence that contains a resolvable `[A#]` token still
 *     produces a working button *inside* the `<mark>` wrapper.
 *   - Streaming / pending replies skip the highlight (the lint hasn't
 *     run yet on the live content; applying stale ranges would
 *     mismark arbitrary character positions in the live delta).
 *   - `undefined` / empty `unverifiedClaims` produce no `<mark>` (so
 *     pre-Plan-11 messages and clean replies render unchanged).
 *   - Out-of-order ranges are handled defensively without crashing —
 *     the renderer sorts a copy before walking, so a hypothetical
 *     future schema relaxation cannot brick the bubble.
 */
describe("ChatPanel unverified-claim highlights (Plan 11)", () => {
  test("wraps each unverified range in a <mark> covering exactly the flagged sentence", () => {
    // The lint emits offsets that round-trip with `content.slice(start, end)`.
    // The renderer slices with the same offsets, so the marked text must
    // match the lint's sentence exactly — no leading whitespace, no
    // missing terminator.
    const content =
      "The handler validates the payload [convex/api/foo.ts:12-30]. " +
      "Then it dispatches to a worker queue without retry semantics.";
    // Match the offsets produced by the citation lint for this fixture.
    const start = content.indexOf("Then it dispatches");
    const end = start + "Then it dispatches to a worker queue without retry semantics.".length;

    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "completed",
            mode: "lab",
            content,
            unverifiedClaims: [{ start, end }],
            errorMessage: undefined,
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="lab"
        setChatMode={vi.fn()}
        availableModes={["lab"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    const mark = screen.getByTestId("unverified-claim");
    expect(mark.tagName.toLowerCase()).toBe("mark");
    // textContent normalizes any nested fragments back to a single
    // string so we can pin the wrapped text without depending on the
    // run-splitting structure.
    expect(mark.textContent).toBe("Then it dispatches to a worker queue without retry semantics.");
  });

  test("preserves citation buttons inside an unverified range (highlight + click compose)", () => {
    // A flagged sentence that happens to contain a resolvable `[A#]`
    // token is the most realistic composition case: the lint flags
    // sandbox sentences that lack `[path:line]` — `[A#]` does not
    // count as a satisfaction of that contract — but the docs-mode
    // citation map can still be present (sandbox prompts also see
    // artifacts). The button must remain clickable and forward the
    // artifact id, even though it lives inside the `<mark>`.
    const onSelectArtifact = vi.fn();
    const artifactId = "artifact_alpha" as ArtifactId;
    const content = "This sentence cites [A1] but not at file:line.";
    const start = 0;
    const end = content.length;

    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "completed",
            mode: "lab",
            content,
            citationMap: [{ index: 1, artifactId }],
            unverifiedClaims: [{ start, end }],
            errorMessage: undefined,
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="lab"
        setChatMode={vi.fn()}
        availableModes={["lab"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
        onSelectArtifact={onSelectArtifact}
      />,
    );

    const mark = screen.getByTestId("unverified-claim");
    const button = screen.getByTestId("citation-link-1");
    // Button lives inside the <mark> wrapper rather than as a sibling.
    expect(mark).toContainElement(button);
    // Click still resolves the artifact; the highlight wrapper does
    // not eat the event.
    fireEvent.click(button);
    expect(onSelectArtifact).toHaveBeenCalledWith(artifactId);
  });

  test("does not render unverified-claim highlights while the message is still streaming", () => {
    // The lint runs at finalize / fail / cancel time; mid-stream the
    // ranges in `messages.unverifiedClaims` (if any are present from
    // a previous reply on the same row, which can't happen in
    // production but the renderer must still degrade safely) would
    // index against the live `activeMessageStream.content` and
    // mis-mark arbitrary character positions. Gating on terminal
    // status is the same gate the cost-ticker uses.
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "streaming",
            mode: "lab",
            content: "",
            unverifiedClaims: [{ start: 0, end: 10 }],
            errorMessage: undefined,
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={{
          assistantMessageId,
          content: "live partial content",
          startedAt: Date.now(),
          lastAppendedAt: Date.now(),
        }}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="lab"
        setChatMode={vi.fn()}
        availableModes={["lab"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("unverified-claim")).not.toBeInTheDocument();
    // The streamed content still renders without the (gated) highlight.
    expect(screen.getByText("live partial content")).toBeInTheDocument();
  });

  test("renders no <mark> when unverifiedClaims is undefined or empty", () => {
    // Pre-Plan-11 messages and clean (fully-cited) replies have
    // `unverifiedClaims === undefined`. Both must render without
    // any highlight so the bubble looks identical to the pre-lint
    // shape.
    for (const claims of [undefined, []] as const) {
      const { unmount } = render(
        <ChatPanel
          selectedThreadId={threadId}
          messages={[
            {
              _id: assistantMessageId,
              role: "assistant",
              status: "completed",
              mode: "lab",
              content: "All claims cite the source [convex/api/foo.ts:1-10].",
              unverifiedClaims: claims,
              errorMessage: undefined,
            } as unknown as Doc<"messages">,
          ]}
          activeMessageStream={null}
          isChatLoading={false}
          chatInput=""
          setChatInput={vi.fn()}
          chatMode="lab"
          setChatMode={vi.fn()}
          availableModes={["lab"]}
          disabledModeReasons={{}}
          isSending={false}
          onSendMessage={vi.fn()}
          sandboxModeStatus={{ reasonCode: "available", message: null }}
          isSyncing={false}
          onSync={vi.fn()}
        />,
      );

      expect(screen.queryByTestId("unverified-claim")).not.toBeInTheDocument();
      unmount();
    }
  });

  test("handles out-of-order ranges defensively without dropping the bubble", () => {
    // The lint emits sorted ranges, but the renderer must not assume
    // sorted input — a hypothetical future schema relaxation that
    // hands us reversed ranges should still produce *some* sensible
    // rendering (sorted internally) rather than crash on a negative
    // slice.
    const content = "First sentence here. Second sentence next.";
    const firstStart = content.indexOf("First sentence here.");
    const firstEnd = firstStart + "First sentence here.".length;
    const secondStart = content.indexOf("Second sentence next.");
    const secondEnd = secondStart + "Second sentence next.".length;

    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "completed",
            mode: "lab",
            content,
            unverifiedClaims: [
              { start: secondStart, end: secondEnd },
              { start: firstStart, end: firstEnd },
            ],
            errorMessage: undefined,
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="lab"
        setChatMode={vi.fn()}
        availableModes={["lab"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    const marks = screen.getAllByTestId("unverified-claim");
    expect(marks).toHaveLength(2);
    // Internal sorting means the DOM order matches the textual order
    // even though the input order was reversed.
    expect(marks[0].textContent).toBe("First sentence here.");
    expect(marks[1].textContent).toBe("Second sentence next.");
  });
});

/**
 * Plan 07 — Stop button toggles in for Send while the latest assistant
 * message is still streaming / pending. Coverage targets:
 *
 *   - Stop button renders only when (a) `onCancelInFlightReply` is wired AND
 *     (b) the latest assistant message is non-terminal.
 *   - Click on Stop fires the callback exactly once.
 *   - "Stopping…" label appears between click and bubble flip.
 *   - `cancelled` status surfaces the "Cancelled" label in the message status
 *     chip rather than fall through to the raw enum.
 *   - Send is restored once the assistant message reaches a terminal state.
 */
describe("ChatPanel cancel-in-flight reply (Plan 07)", () => {
  test("renders Send when no assistant reply is in flight", () => {
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: "message_user_1" as MessageId,
            role: "user",
            status: "completed",
            mode: "discuss",
            content: "Hi",
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput="more"
        setChatInput={vi.fn()}
        chatMode="discuss"
        setChatMode={vi.fn()}
        availableModes={["discuss"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        onCancelInFlightReply={vi.fn()}
        isCancellingReply={false}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    expect(screen.getByTestId("chat-panel-send-button")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-panel-stop-button")).not.toBeInTheDocument();
  });

  test("renders Stop in place of Send while the latest assistant message is streaming", () => {
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "streaming",
            mode: "discuss",
            content: "partial reply",
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={{
          assistantMessageId,
          content: "partial reply",
          startedAt: Date.now(),
          lastAppendedAt: Date.now(),
        }}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="discuss"
        setChatMode={vi.fn()}
        availableModes={["discuss"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        onCancelInFlightReply={vi.fn()}
        isCancellingReply={false}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    const stop = screen.getByTestId("chat-panel-stop-button");
    expect(stop).toBeInTheDocument();
    expect(stop).toHaveTextContent("Stop");
    expect(screen.queryByTestId("chat-panel-send-button")).not.toBeInTheDocument();
  });

  test("renders Stop while the assistant message is pending (between sendMessage and markRunning)", () => {
    // The brief pending window before the action flips status to
    // streaming is still cancellation-eligible — the action's first
    // poll will pick it up. Showing Send during that window would let
    // the user double-fire send.
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "pending",
            mode: "discuss",
            content: "",
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="discuss"
        setChatMode={vi.fn()}
        availableModes={["discuss"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        onCancelInFlightReply={vi.fn()}
        isCancellingReply={false}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    expect(screen.getByTestId("chat-panel-stop-button")).toBeInTheDocument();
  });

  test("falls back to Send when onCancelInFlightReply is not wired even with a streaming reply", () => {
    // Defensive: a caller that opts out of cancellation (e.g. an embedded
    // demo without a Convex backend) must still get the standard Send
    // button — never a Stop button that nobody listens to.
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "streaming",
            mode: "discuss",
            content: "",
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput="next"
        setChatInput={vi.fn()}
        chatMode="discuss"
        setChatMode={vi.fn()}
        availableModes={["discuss"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    expect(screen.getByTestId("chat-panel-send-button")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-panel-stop-button")).not.toBeInTheDocument();
  });

  test("clicking Stop invokes onCancelInFlightReply exactly once", () => {
    const onCancel = vi.fn();
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "streaming",
            mode: "discuss",
            content: "",
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="discuss"
        setChatMode={vi.fn()}
        availableModes={["discuss"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        onCancelInFlightReply={onCancel}
        isCancellingReply={false}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("chat-panel-stop-button"));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test("renders 'Stopping…' and disables the Stop button while the cancel mutation is in flight", () => {
    const onCancel = vi.fn();
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "streaming",
            mode: "discuss",
            content: "",
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="discuss"
        setChatMode={vi.fn()}
        availableModes={["discuss"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        onCancelInFlightReply={onCancel}
        isCancellingReply={true}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    const stop = screen.getByTestId("chat-panel-stop-button");
    expect(stop).toHaveTextContent("Stopping…");
    expect(stop).toBeDisabled();

    // Defensive: even if the user manages to click the disabled button via
    // assistive tech (some screen readers can dispatch click on aria-disabled),
    // we don't want to fire the cancel a second time.
    fireEvent.click(stop);
    expect(onCancel).not.toHaveBeenCalled();
  });

  test("flips back to Send once the assistant message reaches a terminal state", () => {
    // Smoke test of the post-cancellation state: bubble is `cancelled`,
    // but for the form footer the panel should be ready for the next
    // prompt (Send button visible again).
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "cancelled",
            mode: "discuss",
            content: "partial reply",
            errorMessage: "Cancelled by user.",
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="discuss"
        setChatMode={vi.fn()}
        availableModes={["discuss"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        onCancelInFlightReply={vi.fn()}
        isCancellingReply={false}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    expect(screen.getByTestId("chat-panel-send-button")).toBeInTheDocument();
    expect(screen.queryByTestId("chat-panel-stop-button")).not.toBeInTheDocument();
  });

  test("cancelled assistant message renders 'Cancelled' status label", () => {
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "cancelled",
            mode: "discuss",
            content: "partial reply",
            errorMessage: "Cancelled by user.",
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="discuss"
        setChatMode={vi.fn()}
        availableModes={["discuss"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        onCancelInFlightReply={vi.fn()}
        isCancellingReply={false}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    // Status label distinguishes user-initiated stop from upstream
    // failure ("Failed"). Anchor the assertion on the visible label
    // rather than role/aria so a future restyling doesn't silently
    // regress copy.
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
    expect(screen.getByText("Cancelled by user.")).toBeInTheDocument();
  });
});

/**
 * Plan 10 — per-message cost ticker. The ticker:
 *
 *   1. Renders only on terminal-state assistant messages (completed /
 *      failed / cancelled) — streaming partial usage would tick
 *      visibly and distract from the reply text.
 *   2. Combines cost / tokens / tool-call count, gracefully handling
 *      missing pieces (e.g. heuristic replies have no cost; discuss
 *      replies have no tools).
 *   3. Renders sub-cent costs as `<$0.01` so "cheap" stays visually
 *      distinct from "free".
 */
describe("ChatPanel per-message cost ticker (Plan 10)", () => {
  test("renders cost + tokens for a fully-priced sandbox reply", () => {
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "completed",
            mode: "lab",
            content: "Done.",
            estimatedInputTokens: 800,
            estimatedOutputTokens: 400,
            estimatedCostUsd: 0.034,
            errorMessage: undefined,
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="lab"
        setChatMode={vi.fn()}
        availableModes={["discuss", "library", "lab"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    const ticker = screen.getByTestId("message-cost-ticker");
    // 800 + 400 = 1200 = 1.2k tokens; cost rounds to ~$0.03.
    expect(ticker).toHaveTextContent("~$0.03");
    expect(ticker).toHaveTextContent("1.2k tokens");
  });

  test("renders tool-call count when present (sandbox replies with tools)", () => {
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "completed",
            mode: "lab",
            content: "Done.",
            estimatedInputTokens: 1200,
            estimatedOutputTokens: 800,
            estimatedCostUsd: 0.05,
            toolCalls: [
              {
                toolCallId: "t1",
                toolName: "read_file",
                inputSummary: "{}",
                outputSummary: "{}",
                startedAt: 1,
                endedAt: 2,
              },
              {
                toolCallId: "t2",
                toolName: "list_dir",
                inputSummary: "{}",
                outputSummary: "{}",
                startedAt: 3,
                endedAt: 4,
              },
            ],
            errorMessage: undefined,
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="lab"
        setChatMode={vi.fn()}
        availableModes={["discuss", "library", "lab"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    const ticker = screen.getByTestId("message-cost-ticker");
    expect(ticker).toHaveTextContent("2 tools");
  });

  test("renders <$0.01 for sub-cent costs so 'cheap' stays distinct from 'free'", () => {
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "completed",
            mode: "lab",
            content: "Done.",
            estimatedInputTokens: 50,
            estimatedOutputTokens: 30,
            estimatedCostUsd: 0.0008,
            errorMessage: undefined,
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="lab"
        setChatMode={vi.fn()}
        availableModes={["discuss", "library", "lab"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    expect(screen.getByTestId("message-cost-ticker")).toHaveTextContent("<$0.01");
  });

  test("does not render the ticker for streaming or pending messages", () => {
    // Partial-usage tickers would update visibly during streaming and
    // distract from the reply content. The ticker only fires on
    // terminal states.
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "streaming",
            mode: "lab",
            content: "partial",
            estimatedInputTokens: 200,
            estimatedOutputTokens: 100,
            estimatedCostUsd: 0.015,
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="lab"
        setChatMode={vi.fn()}
        availableModes={["discuss", "library", "lab"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("message-cost-ticker")).not.toBeInTheDocument();
  });

  test("does not render the ticker for heuristic replies (no cost, no tokens, no tools)", () => {
    // Heuristic replies (no OPENAI_API_KEY) produce no cost data.
    // Showing an empty ticker line would be visual noise; skipping it
    // entirely is the cleaner UX.
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "completed",
            mode: "discuss",
            content: "Heuristic answer.",
            errorMessage: undefined,
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="discuss"
        setChatMode={vi.fn()}
        availableModes={["discuss"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("message-cost-ticker")).not.toBeInTheDocument();
  });

  test("renders tokens-only when pricing is unavailable for the model (cost ticker degrades gracefully)", () => {
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "completed",
            mode: "discuss",
            content: "answer",
            estimatedInputTokens: 600,
            estimatedOutputTokens: 200,
            // estimatedCostUsd intentionally undefined — model not in pricing table.
            errorMessage: undefined,
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="discuss"
        setChatMode={vi.fn()}
        availableModes={["discuss"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    const ticker = screen.getByTestId("message-cost-ticker");
    // 600 + 200 = 800 tokens — under the 1k threshold so renders raw.
    expect(ticker).toHaveTextContent("800 tokens");
    expect(ticker).not.toHaveTextContent("$");
  });
});

/**
 * Plan 14 — example-prompt cards rendered above the composer when the
 * thread is empty. Coverage targets:
 *
 *   - Empty thread shows a card grid for the *current* mode's prompts.
 *   - Switching modes swaps the cards (the panel's `mode` prop is
 *     authoritative — there's no internal mode state to drift).
 *   - Clicking a card forwards the prompt text to `setChatInput`
 *     verbatim and does *not* call `onSendMessage`. Auto-submit was
 *     a deliberate non-goal: the cards are scaffolds, not finished
 *     questions.
 *   - Cards disappear once the thread has at least one message — the
 *     empty-state container is the only render site.
 */
describe("ChatPanel mode examples (Plan 14)", () => {
  test("renders the active mode's example cards in the empty state", () => {
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="discuss"
        setChatMode={vi.fn()}
        availableModes={["discuss", "library", "lab"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    const grid = screen.getByTestId("mode-examples");
    // The `data-mode` attribute pins the grid to the active mode so the
    // test fails loudly if the catalog wiring drifts (e.g. someone hard-
    // codes "lab" prompts in the discuss branch).
    expect(grid).toHaveAttribute("data-mode", "discuss");
    // discuss-mode catalog has 3 entries; we anchor on data-testid prefix
    // so adding a 4th in the future doesn't silently flip this assertion.
    expect(screen.getByTestId("mode-example-discuss-0")).toBeInTheDocument();
    expect(screen.getByTestId("mode-example-discuss-1")).toBeInTheDocument();
    expect(screen.getByTestId("mode-example-discuss-2")).toBeInTheDocument();
  });

  test("swaps cards when the active mode changes", () => {
    const { rerender } = render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="library"
        setChatMode={vi.fn()}
        availableModes={["discuss", "library", "lab"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    expect(screen.getByTestId("mode-examples")).toHaveAttribute("data-mode", "library");
    expect(screen.getByTestId("mode-example-library-0")).toBeInTheDocument();

    rerender(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="lab"
        setChatMode={vi.fn()}
        availableModes={["discuss", "library", "lab"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    expect(screen.getByTestId("mode-examples")).toHaveAttribute("data-mode", "lab");
    expect(screen.getByTestId("mode-example-lab-0")).toBeInTheDocument();
    // The previous mode's cards must be gone — no duplicate test ids
    // hanging around from the prior render tree.
    expect(screen.queryByTestId("mode-example-library-0")).not.toBeInTheDocument();
  });

  test("clicking an example card seeds the composer without auto-submitting", () => {
    const setChatInput = vi.fn();
    const onSendMessage = vi.fn();
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={setChatInput}
        chatMode="discuss"
        setChatMode={vi.fn()}
        availableModes={["discuss", "library", "lab"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={onSendMessage}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    const firstCard = screen.getByTestId("mode-example-discuss-0");
    const cardText = firstCard.textContent ?? "";
    fireEvent.click(firstCard);

    expect(setChatInput).toHaveBeenCalledTimes(1);
    expect(setChatInput).toHaveBeenCalledWith(cardText);
    // Critical: clicking a card never sends. The prompt is a scaffold
    // the user is expected to refine before hitting Send.
    expect(onSendMessage).not.toHaveBeenCalled();
  });

  test("hides example cards once the thread has messages (only renders in empty state)", () => {
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[
          {
            _id: assistantMessageId,
            role: "assistant",
            status: "completed",
            mode: "discuss",
            content: "An answer.",
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="discuss"
        setChatMode={vi.fn()}
        availableModes={["discuss"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    expect(screen.queryByTestId("mode-examples")).not.toBeInTheDocument();
  });
});

/**
 * Plan 14 — `(i)` info popover next to the mode selector. The trigger
 * is user-initiated (no auto-pop) and exposes one short caption + one
 * example prompt per mode. Tests verify:
 *
 *   - The trigger renders next to the selector regardless of breakpoint
 *     (we render two instances — one per layout — for clean co-location;
 *     `getAllBy*` is the right query so a future single-instance design
 *     doesn't silently regress this contract).
 *   - All three modes appear in the popover content with their captions
 *     and the first example prompt from `MODE_CATALOG`.
 */
describe("ChatPanel mode info popover (Plan 14)", () => {
  test("renders the (i) info trigger and the mode descriptor list", () => {
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="discuss"
        setChatMode={vi.fn()}
        availableModes={["discuss", "library", "lab"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    // Two triggers (compact + desktop) is the intended shape — only one
    // is visible per breakpoint via responsive utilities, but both
    // render in jsdom. Asserting on the count guards against a regression
    // where one breakpoint loses its trigger.
    const triggers = screen.getAllByTestId("mode-info-trigger");
    expect(triggers).toHaveLength(2);

    // Each popover instance carries one entry per mode. We assert on the
    // entry test ids rather than the visible labels so a future copy
    // change to "Sandbox (beta)" does not flap this test.
    const discussEntries = screen.getAllByTestId("mode-info-entry-discuss");
    const docsEntries = screen.getAllByTestId("mode-info-entry-library");
    const sandboxEntries = screen.getAllByTestId("mode-info-entry-lab");
    expect(discussEntries).toHaveLength(2);
    expect(docsEntries).toHaveLength(2);
    expect(sandboxEntries).toHaveLength(2);

    // The popover surfaces the *first* example prompt per mode so users
    // who don't read the empty-state cards still see one good question
    // shape per mode. Anchor on a unique substring from each catalog
    // example to catch any drift in the wiring.
    expect(discussEntries[0]).toHaveTextContent(/optimistic vs pessimistic locking/i);
    expect(docsEntries[0]).toHaveTextContent(/architecture decisions/i);
    expect(sandboxEntries[0]).toHaveTextContent(/in-flight reply lease/i);
  });
});

/**
 * Plan 14 — passive mode-suggestion hint above the toolbar. Coverage
 * targets:
 *
 *   - File-path heuristic surfaces a Switch-to-Sandbox CTA when the
 *     user is in discuss/docs and types a recognized source path.
 *   - Open-ended-prefix heuristic surfaces a Switch-to-General-Chat CTA
 *     when the user is in docs/sandbox and starts with one of the two
 *     phrasings.
 *   - Clicking [Switch to {mode}] forwards the suggested mode to
 *     `setChatMode` exactly once.
 *   - Clicking the dismiss × hides the hint immediately and keeps it
 *     hidden for that heuristic key for the rest of the session, even
 *     if the same input shape recurs (the dismiss memory is keyed on
 *     the heuristic, not the literal input).
 *   - The hint disappears when the suggested mode is gated out of
 *     `availableModes` so the [Switch] button never bounces off a
 *     disabled selector item.
 */
describe("ChatPanel mode-suggestion hint (Plan 14)", () => {
  test("shows a Switch-to-Sandbox hint when a docs-mode user mentions a source path", () => {
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput="Explain convex/chat/send.ts line 80"
        setChatInput={vi.fn()}
        chatMode="library"
        setChatMode={vi.fn()}
        availableModes={["discuss", "library", "lab"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    expect(
      screen.getByText("This question references a specific file. Lab mode would give a more accurate answer."),
    ).toBeInTheDocument();
    // The CTA names the destination explicitly so the user knows what
    // the click will change before they click.
    expect(screen.getByRole("button", { name: "Switch to Lab" })).toBeInTheDocument();
  });

  test("shows a Switch-to-General-Chat hint for an open-ended sandbox-mode question", () => {
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput="How should I structure auth in this codebase?"
        setChatInput={vi.fn()}
        chatMode="lab"
        setChatMode={vi.fn()}
        availableModes={["discuss", "library", "lab"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    expect(screen.getByText("This sounds open-ended; Discuss might be better.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Switch to Discuss" })).toBeInTheDocument();
  });

  test("clicking the Switch CTA invokes setChatMode with the suggested mode", () => {
    const setChatMode = vi.fn();
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput="Look at src/components/chat-panel.tsx"
        setChatInput={vi.fn()}
        chatMode="discuss"
        setChatMode={setChatMode}
        availableModes={["discuss", "library", "lab"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Switch to Lab" }));
    expect(setChatMode).toHaveBeenCalledTimes(1);
    expect(setChatMode).toHaveBeenCalledWith("lab");
  });

  test("dismiss button hides the hint and keeps it hidden for the same heuristic key", () => {
    // The dismiss memory is keyed on the *heuristic* ("specific-file:lab"),
    // not the literal input. So dismissing once for `convex/chat/send.ts`
    // must also silence a later message about `convex/chat/context.ts` that
    // would otherwise re-fire the same rule. This is the "session-local
    // preference" model called out in the plan.

    function Harness() {
      // Local state mirrors the real shell wiring: `chatInput` is hoisted
      // to the parent, so the dismiss set inside ChatPanel must persist
      // across input changes within the same panel mount.
      const [chatInput, setChatInput] = useState("Look at src/components/chat-panel.tsx");
      return (
        <ChatPanel
          selectedThreadId={threadId}
          messages={[]}
          activeMessageStream={null}
          isChatLoading={false}
          chatInput={chatInput}
          setChatInput={setChatInput}
          chatMode="discuss"
          setChatMode={vi.fn()}
          availableModes={["discuss", "library", "lab"]}
          disabledModeReasons={{}}
          isSending={false}
          onSendMessage={vi.fn()}
          sandboxModeStatus={{ reasonCode: "available", message: null }}
          isSyncing={false}
          onSync={vi.fn()}
        />
      );
    }

    render(<Harness />);

    // Hint visible for the first file-path mention.
    expect(screen.getByText(/Lab mode would give a more accurate answer\./)).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Dismiss suggestion"));

    // Hint disappears immediately on dismiss.
    expect(screen.queryByText(/Lab mode would give a more accurate answer\./)).not.toBeInTheDocument();

    // Drive the same panel mount to a *different* file-path input. The
    // heuristic would otherwise re-fire because `convex/chat/context.ts`
    // matches the same regex; the dismiss is keyed on the heuristic
    // ("specific-file:lab") rather than the literal input, so the
    // hint must stay hidden.
    fireEvent.change(screen.getByPlaceholderText(/Ask about architecture/i), {
      target: { value: "Now check convex/chat/context.ts instead" },
    });
    expect(screen.queryByText(/Lab mode would give a more accurate answer\./)).not.toBeInTheDocument();
  });

  test("does not render a hint when the suggested mode is not in availableModes", () => {
    // If sandbox is gated by rollout / quotas / repo state, the hint
    // would advertise a mode the [Switch] button cannot actually
    // select. Suppression is the only correct behavior.
    render(
      <ChatPanel
        selectedThreadId={threadId}
        messages={[]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput="Look at convex/chat/send.ts"
        setChatInput={vi.fn()}
        chatMode="discuss"
        setChatMode={vi.fn()}
        availableModes={["discuss", "library"]}
        disabledModeReasons={{ lab: "Provision a sandbox to use Lab mode." }}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    expect(
      screen.queryByText("This question references a specific file. Lab mode would give a more accurate answer."),
    ).not.toBeInTheDocument();
  });
});
