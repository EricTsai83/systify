// @vitest-environment jsdom

import type React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { Doc } from "../../convex/_generated/dataModel";
import { ChatPanel } from "./chat-panel";
import type { ArtifactId, MessageId, ThreadId } from "@/lib/types";

vi.mock("convex/react", () => ({
  useMutation: vi.fn(() => vi.fn()),
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
