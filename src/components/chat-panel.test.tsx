// @vitest-environment jsdom

import type React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Doc } from "../../convex/_generated/dataModel";
import { ChatPanel } from "./chat-panel";
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
  AppNotice: ({ title, message }: { title: string; message: string }) => (
    <div>
      {title}
      {message}
    </div>
  ),
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

afterEach(() => {
  cleanup();
});

describe("ChatPanel streaming rendering", () => {
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
          docs: "Attach a repository to use Design Docs mode.",
          sandbox: "Attach a repository with a ready sandbox to use Sandbox mode.",
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
        chatMode="docs"
        setChatMode={vi.fn()}
        availableModes={["discuss", "docs"]}
        disabledModeReasons={{ sandbox: "Provision a sandbox to use Sandbox mode." }}
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
        chatMode="docs"
        setChatMode={vi.fn()}
        availableModes={["discuss", "docs"]}
        disabledModeReasons={{ sandbox: "Provision a sandbox to use Sandbox mode." }}
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
        availableModes={["discuss", "docs", "sandbox"]}
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
            mode: "docs",
            content: "Answer body.",
            errorMessage: undefined,
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="docs"
        setChatMode={vi.fn()}
        availableModes={["discuss", "docs"]}
        disabledModeReasons={{}}
        isSending={false}
        onSendMessage={vi.fn()}
        sandboxModeStatus={{ reasonCode: "available", message: null }}
        isSyncing={false}
        onSync={vi.fn()}
      />,
    );

    // The badge label must come from the mode catalog ("Design Docs"),
    // not the raw DB literal ("docs"). Anchoring the assertion on the
    // user-facing label catches any future drift between the badge and
    // the mode-selector pill.
    const badge = screen.getByTestId("message-mode-badge");
    expect(badge).toHaveTextContent("Design Docs");
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
            mode: "docs",
            content: "What about X?",
            errorMessage: undefined,
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="docs"
        setChatMode={vi.fn()}
        availableModes={["discuss", "docs"]}
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
            mode: "docs",
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
        chatMode="docs"
        setChatMode={vi.fn()}
        availableModes={["docs"]}
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
            mode: "docs",
            content: "See [A99] for details.",
            citationMap: [{ index: 1, artifactId: "artifact_alpha" as ArtifactId }],
            errorMessage: undefined,
          } as unknown as Doc<"messages">,
        ]}
        activeMessageStream={null}
        isChatLoading={false}
        chatInput=""
        setChatInput={vi.fn()}
        chatMode="docs"
        setChatMode={vi.fn()}
        availableModes={["docs"]}
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
            mode: "sandbox",
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
        chatMode="sandbox"
        setChatMode={vi.fn()}
        availableModes={["discuss", "docs", "sandbox"]}
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
            mode: "sandbox",
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
        chatMode="sandbox"
        setChatMode={vi.fn()}
        availableModes={["discuss", "docs", "sandbox"]}
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
            mode: "sandbox",
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
        chatMode="sandbox"
        setChatMode={vi.fn()}
        availableModes={["discuss", "docs", "sandbox"]}
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
            mode: "sandbox",
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
        chatMode="sandbox"
        setChatMode={vi.fn()}
        availableModes={["discuss", "docs", "sandbox"]}
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
