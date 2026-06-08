// @vitest-environment jsdom

import type React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { LibraryAskPanel } from "./library-ask-panel";
import type { ArtifactId, RepositoryId } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  useMutation: vi.fn(),
  useQuery: vi.fn(),
  archiveThread: vi.fn(),
  setThreadPinned: vi.fn(),
  requestDraft: vi.fn(),
  applyDraft: vi.fn(),
  discardDraft: vi.fn(),
  regenerateDraft: vi.fn(),
  ensureOpen: vi.fn(),
  closeTab: vi.fn(),
  sendMessage: vi.fn(),
}));

vi.mock("convex/react", () => ({
  useMutation: mocks.useMutation,
  useQuery: mocks.useQuery,
}));

vi.mock("@/components/ai-elements/conversation", () => ({
  Conversation: ({ children }: { children: React.ReactNode }) => <div data-testid="conversation">{children}</div>,
  ConversationContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ConversationScrollButton: () => null,
}));

vi.mock("@/components/ai-elements/use-chat-scroll", () => ({
  useChatScroll: () => ({}),
}));

vi.mock("@/components/ai-elements/prompt-input", async () => {
  const ReactModule = await import("react");
  const PromptInputTextarea = ReactModule.forwardRef<
    HTMLTextAreaElement,
    React.TextareaHTMLAttributes<HTMLTextAreaElement>
  >((props, ref) => <textarea ref={ref} {...props} />);
  PromptInputTextarea.displayName = "PromptInputTextarea";

  return {
    PromptInput: ({
      children,
      onSubmit,
    }: {
      children: React.ReactNode;
      onSubmit?: (message: unknown, event: React.FormEvent<HTMLFormElement>) => void;
    }) => (
      <form
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit?.({}, event);
        }}
      >
        {children}
      </form>
    ),
    PromptInputTextarea,
    PromptInputFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    PromptInputTools: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  };
});

vi.mock("@/components/ai-elements/prompt-input-model-picker", () => ({
  PromptInputModelPicker: () => <button type="button">GPT-5.5</button>,
}));

vi.mock("@/components/ai-elements/prompt-input-reasoning-picker", () => ({
  PromptInputReasoningPicker: () => <button type="button">Reasoning</button>,
}));

vi.mock("@/components/chat-empty-state", () => ({
  EmptyStateHero: ({
    title,
    description,
  }: {
    title: string;
    description: React.ReactNode;
    visual?: React.ReactNode;
  }) => (
    <div>
      <h2>{title}</h2>
      <p>{description}</p>
    </div>
  ),
  PromptSuggestionList: ({ prompts }: { prompts: readonly string[]; onPick: (prompt: string) => void }) => (
    <div>
      {prompts.map((prompt) => (
        <button key={prompt} type="button">
          {prompt}
        </button>
      ))}
    </div>
  ),
}));

vi.mock("@/components/chat-message", () => ({
  MessageBubble: () => <div>message</div>,
}));

vi.mock("@/components/confirm-dialog", () => ({
  ConfirmDialog: ({ open, title }: { open: boolean; title: string }) => (open ? <div>{title}</div> : null),
}));

vi.mock("@/components/library-ask-thread-tabs", () => ({
  LibraryAskThreadTabs: () => <div data-testid="thread-tabs" />,
}));

vi.mock("@/components/folder-picker", () => ({
  FolderPicker: ({
    value,
    onChange,
    disabled,
  }: {
    value: Id<"artifactFolders"> | null;
    onChange: (folderId: Id<"artifactFolders"> | null) => void;
    disabled?: boolean;
  }) => (
    <select
      aria-label="Folder"
      disabled={disabled}
      value={value ?? ""}
      onChange={(event) => onChange((event.target.value || null) as Id<"artifactFolders"> | null)}
    >
      <option value="">Unfiled</option>
    </select>
  ),
}));

vi.mock("@/components/markdown", () => ({
  Markdown: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/button", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    asChild: _asChild,
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement> & {
    children?: React.ReactNode;
    variant?: string;
    size?: string;
    asChild?: boolean;
  }) => <button {...props}>{children}</button>,
}));

vi.mock("@/components/ui/button-state-text", () => ({
  ButtonStateText: ({ current }: { current: string }) => <>{current}</>,
}));

vi.mock("@/components/ui/input", () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
}));

vi.mock("@/components/ui/progress", () => ({
  Progress: ({ value }: { value?: number }) => <div aria-valuenow={value} role="progressbar" />,
}));

vi.mock("@/components/ui/textarea", () => ({
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} />,
}));

vi.mock("@/hooks/use-library-ask-tabs", () => ({
  useLibraryAskTabs: () => ({
    openThreads: [],
    ensureOpen: mocks.ensureOpen,
    closeTab: mocks.closeTab,
  }),
}));

vi.mock("@/hooks/use-composer-model-pick", () => ({
  useComposerModelPick: () => ({
    selectedProvider: "openai",
    selectedModelName: "gpt-5.5",
    setSelectedModel: vi.fn(),
    selectedReasoningEffort: null,
    setSelectedReasoningEffort: vi.fn(),
  }),
}));

vi.mock("@/hooks/use-chat-lifecycle", () => ({
  useChatLifecycle: () => ({
    isSending: false,
    handleSendMessage: mocks.sendMessage,
  }),
}));

vi.mock("@/hooks/use-conversation-thread", () => ({
  useConversationThread: () => ({
    messages: [],
    activeMessageStream: null,
    canLoadOlderMessages: false,
    handleLoadOlderMessages: vi.fn(),
    latestAssistantInFlight: false,
  }),
}));

vi.mock("@/hooks/use-default-model-pick", () => ({
  useDefaultModelPick: () => ({ provider: "openai", modelName: "gpt-5.5" }),
}));

vi.mock("@/hooks/use-model-access-disabled-reason", () => ({
  useModelAccessDisabledReason: () => null,
}));

vi.mock("sonner", () => ({
  toast: {
    error: vi.fn(),
    success: vi.fn(),
  },
}));

const repositoryId = "repo_1" as RepositoryId;
const activeArtifactId = "artifact_1" as ArtifactId;

type DraftEntry = {
  draft: Doc<"artifactDrafts">;
  job: Doc<"jobs"> | null;
};

let queryState: {
  activeArtifact: Doc<"artifacts"> | null;
  recentDrafts: DraftEntry[];
  threadDrafts: DraftEntry[];
  threads: Doc<"threads">[];
  threadSummary: Pick<Doc<"threads">, "title" | "lockedProvider" | "defaultModelName"> | null;
};

function functionName(reference: unknown): string {
  try {
    return getFunctionName(reference as Parameters<typeof getFunctionName>[0]);
  } catch {
    return "";
  }
}

function makeArtifact(overrides: Partial<Doc<"artifacts">> = {}): Doc<"artifacts"> {
  return {
    _id: activeArtifactId as Id<"artifacts">,
    _creationTime: 1,
    ownerTokenIdentifier: "user|library-ask-panel",
    repositoryId,
    kind: "readme_summary",
    title: "Architecture overview",
    summary: "Current summary",
    contentMarkdown: "# Current\n\nExisting content.",
    version: 1,
    chunkingStatus: "completed",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  } as Doc<"artifacts">;
}

function makeJob(overrides: Partial<Doc<"jobs">> = {}): Doc<"jobs"> {
  return {
    _id: "job_1" as Id<"jobs">,
    _creationTime: 1,
    ownerTokenIdentifier: "user|library-ask-panel",
    repositoryId,
    kind: "artifact_draft",
    status: "running",
    stage: "Reading codebase…",
    progress: 0.42,
    costCategory: "system_design",
    triggerSource: "user",
    ...overrides,
  } as Doc<"jobs">;
}

function makeDraft(overrides: Partial<Doc<"artifactDrafts">> = {}): Doc<"artifactDrafts"> {
  return {
    _id: "draft_1" as Id<"artifactDrafts">,
    _creationTime: 1,
    ownerTokenIdentifier: "user|library-ask-panel",
    repositoryId,
    jobId: "job_1" as Id<"jobs">,
    operation: "create",
    status: "ready",
    prompt: "Draft a runbook.",
    title: "Operations runbook",
    summary: "How to run the system.",
    contentMarkdown: "# Operations\n\nUse Live source.",
    generatedByProvider: "openai",
    generatedByModel: "gpt-5.5",
    promptVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    generatedAt: 1,
    ...overrides,
  } as Doc<"artifactDrafts">;
}

function renderPanel(overrides: Partial<React.ComponentProps<typeof LibraryAskPanel>> = {}) {
  return render(
    <LibraryAskPanel
      repositoryId={repositoryId}
      threadId={null}
      activeArtifactId={null}
      hasArtifacts={true}
      onSelectArtifact={vi.fn()}
      onSelectThread={vi.fn()}
      liveSourceStatus={{ kind: "ready" }}
      {...overrides}
    />,
  );
}

beforeEach(() => {
  queryState = {
    activeArtifact: makeArtifact(),
    recentDrafts: [],
    threadDrafts: [],
    threads: [],
    threadSummary: null,
  };

  mocks.archiveThread.mockReset().mockResolvedValue(null);
  mocks.setThreadPinned.mockReset().mockResolvedValue(null);
  mocks.requestDraft.mockReset().mockResolvedValue({ draftId: "draft_1", jobId: "job_1" });
  mocks.applyDraft.mockReset().mockResolvedValue({ artifactId: "artifact_new" });
  mocks.discardDraft.mockReset().mockResolvedValue(null);
  mocks.regenerateDraft.mockReset().mockResolvedValue({ draftId: "draft_2", jobId: "job_2" });
  mocks.ensureOpen.mockReset();
  mocks.closeTab.mockReset().mockReturnValue(null);
  mocks.sendMessage.mockReset();

  mocks.useMutation.mockReset();
  mocks.useMutation.mockImplementation((reference: unknown) => {
    const name = functionName(reference);
    if (name.endsWith("archiveThread")) return mocks.archiveThread;
    if (name.endsWith("setThreadPinned")) return mocks.setThreadPinned;
    if (name.endsWith("requestDraft")) return mocks.requestDraft;
    if (name.endsWith("applyDraft")) return mocks.applyDraft;
    if (name.endsWith("discardDraft")) return mocks.discardDraft;
    if (name.endsWith("regenerateDraft")) return mocks.regenerateDraft;
    return vi.fn();
  });

  mocks.useQuery.mockReset();
  mocks.useQuery.mockImplementation((reference: unknown, args: unknown) => {
    if (args === "skip") return undefined;
    const name = functionName(reference);
    if (name.endsWith("listThreads")) return queryState.threads;
    if (name.endsWith("getThreadSummary")) return queryState.threadSummary;
    if (name.endsWith("listByThread")) return queryState.threadDrafts;
    if (name.endsWith("listRecentByRepository")) return queryState.recentDrafts;
    if (name.endsWith("getById")) return queryState.activeArtifact;
    return undefined;
  });
});

afterEach(() => {
  cleanup();
});

describe("LibraryAskPanel artifact drafts", () => {
  test("shows the document action confirmation before requesting a draft", () => {
    renderPanel();

    fireEvent.click(screen.getByRole("button", { name: /Create artifact/i }));

    expect(screen.getByTestId("artifact-draft-confirm-card")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Create artifact" })).toBeInTheDocument();
    expect(screen.getByText(/Live source is active/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Draft with live source/i })).toBeDisabled();
    expect(mocks.requestDraft).not.toHaveBeenCalled();
  });

  test("renders an active draft job card with progress", () => {
    queryState.recentDrafts = [
      {
        draft: makeDraft({ status: "running", title: "Updated operations", operation: "update" }),
        job: makeJob({ stage: "Reading codebase…", progress: 0.42 }),
      },
    ];

    renderPanel();

    expect(screen.getByTestId("artifact-draft-card")).toBeInTheDocument();
    expect(screen.getByText("Artifact update draft")).toBeInTheDocument();
    expect(screen.getByText("Reading codebase…")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  test("ready draft Apply and Discard buttons call draft mutations", async () => {
    const onSelectArtifact = vi.fn();
    queryState.recentDrafts = [
      {
        draft: makeDraft({ status: "ready", operation: "create" }),
        job: makeJob({ status: "completed", stage: "Ready to review", progress: 1 }),
      },
    ];

    renderPanel({ onSelectArtifact });

    fireEvent.click(screen.getByRole("button", { name: /^Apply$/i }));

    await waitFor(() => {
      expect(mocks.applyDraft).toHaveBeenCalledWith({ draftId: "draft_1" });
      expect(onSelectArtifact).toHaveBeenCalledWith("artifact_new");
    });

    fireEvent.click(screen.getByRole("button", { name: /^Discard$/i }));

    await waitFor(() => {
      expect(mocks.discardDraft).toHaveBeenCalledWith({ draftId: "draft_1" });
    });
  });

  test("disables update action until an artifact is open", () => {
    renderPanel({ activeArtifactId: null });

    expect(screen.getByRole("button", { name: /Update open artifact/i })).toBeDisabled();
  });
});
