// @vitest-environment jsdom

import type React from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { getFunctionName } from "convex/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import { LibraryAskPanel } from "./library-ask-panel";
import type { ArtifactId, RepositoryId, ThreadId } from "@/lib/types";

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
  conversationMessages: [] as Doc<"messages">[],
}));

const catalogEntries = [
  {
    provider: "openai",
    modelName: "gpt-5.5",
    displayName: "GPT-5.5",
    capability: "library",
    supportsReasoning: true,
    supportsTools: false,
    contextWindow: 200_000,
    userPickable: true,
    favorite: false,
    default: false,
    defaultSource: null,
  },
];

vi.mock("convex/react", () => ({
  useMutation: mocks.useMutation,
  useQuery: mocks.useQuery,
}));

vi.mock("@/components/ai-elements/conversation", () => ({
  Conversation: ({ children }: { children: React.ReactNode }) => <div data-testid="conversation">{children}</div>,
  ConversationContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  ConversationItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
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
  const PromptInput = ({
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
  );

  return {
    PromptInput,
    PromptInputComposerFrame: ({
      children,
      error,
      hint,
      onSubmit,
    }: {
      children: React.ReactNode;
      error?: React.ReactNode;
      hint?: React.ReactNode;
      onSubmit?: (message: unknown, event: React.FormEvent<HTMLFormElement>) => void;
    }) => (
      <div>
        {error ? <p>{error}</p> : null}
        <PromptInput onSubmit={onSubmit}>{children}</PromptInput>
        {hint ? <p>{hint}</p> : null}
      </div>
    ),
    PromptInputTextarea,
    PromptInputFooter: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    PromptInputTools: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
    PromptInputToolList: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
      <div {...props}>{children}</div>
    ),
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
  MessageBubble: ({ message }: { message: Doc<"messages"> }) => (
    <div data-testid="message-bubble">{message.content}</div>
  ),
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
    messages: mocks.conversationMessages,
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
const threadId = "thread_1" as ThreadId;
const activeArtifactId = "artifact_1" as ArtifactId;

type DraftEntry = {
  draft: Doc<"artifactDrafts">;
  job: Doc<"jobs"> | null;
};

let queryState: {
  activeArtifact: Doc<"artifacts"> | null;
  recentDrafts: DraftEntry[] | undefined;
  threadDrafts: DraftEntry[];
  threads: Doc<"threads">[];
  threadSummary: Pick<Doc<"threads">, "title" | "lockedProvider" | "defaultModelName"> | null;
  draftHtmlPreview: { url: string; htmlHash?: string; htmlByteLength?: number } | null | undefined;
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
    description: "Current description",
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
    description: "How to run the system.",
    contentMarkdown: "# Operations\n\nUse repository code.",
    generatedByProvider: "openai",
    generatedByModel: "gpt-5.5",
    promptVersion: 1,
    createdAt: 1,
    updatedAt: 1,
    generatedAt: 1,
    ...overrides,
  } as Doc<"artifactDrafts">;
}

function makeMessage(overrides: Partial<Doc<"messages">> = {}): Doc<"messages"> {
  return {
    _id: "message_1" as Id<"messages">,
    _creationTime: 1,
    ownerTokenIdentifier: "user|library-ask-panel",
    repositoryId,
    threadId: threadId as Id<"threads">,
    role: "user",
    status: "completed",
    mode: "library",
    content: "message",
    ...overrides,
  } as Doc<"messages">;
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

function openDraftMenu() {
  const trigger = screen.getByRole("button", { name: "Draft" });
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
}

function selectDraftMenuItem(name: RegExp) {
  openDraftMenu();
  fireEvent.click(screen.getByRole("menuitem", { name }));
}

beforeEach(() => {
  queryState = {
    activeArtifact: makeArtifact(),
    recentDrafts: [],
    threadDrafts: [],
    threads: [],
    threadSummary: null,
    draftHtmlPreview: { url: "https://storage.example/report.html", htmlHash: "abc123", htmlByteLength: 2048 },
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
  mocks.conversationMessages = [];

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
    if (name.endsWith("listPickableModels")) return catalogEntries;
    if (name.endsWith("getDraftPreviewUrl")) return queryState.draftHtmlPreview;
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

    selectDraftMenuItem(/New artifact/i);

    const card = screen.getByTestId("artifact-draft-confirm-card");
    expect(card).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Create artifact" })).toBeInTheDocument();
    expect(
      screen.getByText("Repository code is ready. The draft will treat the codebase as the source of truth."),
    ).toBeInTheDocument();
    expect(screen.getByText("Add a title for the new artifact.")).toBeInTheDocument();
    expect(within(card).getByRole("button", { name: /Draft artifact/i })).toBeDisabled();
    expect(mocks.requestDraft).not.toHaveBeenCalled();
  });

  test("allows updating the open artifact without custom instructions", async () => {
    renderPanel({ activeArtifactId });

    selectDraftMenuItem(/Update open artifact/i);

    expect(screen.getByTestId("artifact-draft-confirm-card")).toBeInTheDocument();
    expect(screen.getByText("Instructions (optional)")).toBeInTheDocument();
    expect(screen.getByText(/codebase source of truth/i)).toBeInTheDocument();

    fireEvent.click(
      within(screen.getByTestId("artifact-draft-confirm-card")).getByRole("button", { name: /Draft update/i }),
    );

    await waitFor(() => {
      expect(mocks.requestDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          repositoryId,
          operation: "update",
          targetArtifactId: activeArtifactId,
          prompt: "Refresh this artifact using the codebase as the source of truth.",
          provider: "openai",
          modelName: "gpt-5.5",
        }),
      );
    });
  });

  test("requests an explicit HTML report draft", async () => {
    renderPanel();

    selectDraftMenuItem(/HTML report/i);

    const card = screen.getByTestId("artifact-draft-confirm-card");
    expect(within(card).getByRole("heading", { name: "Draft HTML report" })).toBeInTheDocument();
    expect(within(card).getByText("Uses Library knowledge by default, not live source.")).toBeInTheDocument();

    fireEvent.change(within(card).getByLabelText("Title"), { target: { value: "Executive report" } });
    fireEvent.change(within(card).getByLabelText("Instructions"), {
      target: { value: "Create a polished architecture report." },
    });
    fireEvent.click(within(card).getByRole("button", { name: /Draft HTML report/i }));

    await waitFor(() => {
      expect(mocks.requestDraft).toHaveBeenCalledWith(
        expect.objectContaining({
          repositoryId,
          operation: "create",
          outputFormat: "html",
          title: "Executive report",
          prompt: "Create a polished architecture report.",
          provider: "openai",
          modelName: "gpt-5.5",
        }),
      );
    });
  });

  test("renders ready HTML draft cards with an iframe preview", () => {
    queryState.threadSummary = { title: "Library Ask", lockedProvider: undefined, defaultModelName: undefined };
    queryState.threadDrafts = [
      {
        draft: makeDraft({
          status: "ready",
          operation: "create",
          outputFormat: "html",
          title: "Executive report",
          contentMarkdown: "# Executive report\n\nSource-backed companion.",
          htmlHash: "abcdef123456",
          htmlByteLength: 2048,
          sourceArtifacts: [{ artifactId: "artifact_source" as Id<"artifacts">, version: 2, title: "Source" }],
          sourceChunkIds: ["chunk_source" as Id<"artifactChunks">],
        }),
        job: makeJob({ status: "completed", stage: "Ready to review", progress: 1 }),
      },
    ];

    renderPanel({ threadId });

    const iframe = screen.getByTitle("Executive report HTML preview");
    expect(iframe).toHaveAttribute("sandbox", "");
    expect(iframe).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(iframe).toHaveAttribute("src", "https://storage.example/report.html");
    expect(screen.queryByText("# Executive report")).not.toBeInTheDocument();
  });

  test("renders an active draft job card with progress", () => {
    queryState.threadSummary = { title: "Library Ask", lockedProvider: undefined, defaultModelName: undefined };
    queryState.threadDrafts = [
      {
        draft: makeDraft({ status: "running", title: "Updated operations", operation: "update" }),
        job: makeJob({ stage: "Reading codebase…", progress: 0.42 }),
      },
    ];

    renderPanel({ threadId });

    expect(screen.getByTestId("artifact-draft-card")).toBeInTheDocument();
    expect(screen.getByText("Artifact update draft")).toBeInTheDocument();
    expect(screen.getByText("Reading codebase…")).toBeInTheDocument();
    expect(screen.getByText("42%")).toBeInTheDocument();
  });

  test("renders thread draft cards in the message timeline by creation time", () => {
    queryState.threadSummary = { title: "Library Ask", lockedProvider: undefined, defaultModelName: undefined };
    mocks.conversationMessages = [
      makeMessage({ _id: "message_1" as Id<"messages">, _creationTime: 10, content: "Before draft" }),
      makeMessage({ _id: "message_2" as Id<"messages">, _creationTime: 40, content: "After drafts" }),
    ];
    queryState.threadDrafts = [
      {
        draft: makeDraft({
          _id: "draft_new" as Id<"artifactDrafts">,
          _creationTime: 30,
          jobId: "job_new" as Id<"jobs">,
          status: "ready",
          operation: "update",
          title: "New regenerated draft",
          createdAt: 30,
          updatedAt: 30,
        }),
        job: makeJob({ _id: "job_new" as Id<"jobs">, status: "completed" }),
      },
      {
        draft: makeDraft({
          _id: "draft_old" as Id<"artifactDrafts">,
          _creationTime: 20,
          jobId: "job_old" as Id<"jobs">,
          status: "discarded",
          operation: "update",
          title: "Old discarded draft",
          createdAt: 20,
          updatedAt: 50,
        }),
        job: makeJob({ _id: "job_old" as Id<"jobs">, status: "completed" }),
      },
    ];

    renderPanel({ threadId });

    const timelineText = screen.getByTestId("conversation").textContent ?? "";
    expect(timelineText.indexOf("Before draft")).toBeLessThan(timelineText.indexOf("Old discarded draft"));
    expect(timelineText.indexOf("Old discarded draft")).toBeLessThan(timelineText.indexOf("New regenerated draft"));
    expect(timelineText.indexOf("New regenerated draft")).toBeLessThan(timelineText.indexOf("After drafts"));
  });

  test("does not show stale repository failed drafts on a new thread surface", () => {
    queryState.recentDrafts = [
      {
        draft: makeDraft({
          _id: "draft_thread_scoped" as Id<"artifactDrafts">,
          jobId: "job_thread_scoped" as Id<"jobs">,
          threadId: threadId as Id<"threads">,
          status: "failed",
          operation: "update",
          title: "Thread architecture overview",
          errorMessage: "Artifact draft failed. Regenerate to try again.",
          createdAt: Date.now() + 1_000,
          updatedAt: Date.now() + 1_000,
        }),
        job: makeJob({
          _id: "job_thread_scoped" as Id<"jobs">,
          status: "failed",
          errorMessage: "Artifact draft failed.",
        }),
      },
      {
        draft: makeDraft({
          status: "failed",
          operation: "update",
          title: "Architecture overview",
          errorMessage: "Artifact draft failed. Regenerate to try again.",
          createdAt: 1,
          updatedAt: 1,
        }),
        job: makeJob({ status: "failed", errorMessage: "Artifact draft failed." }),
      },
    ];

    renderPanel();

    expect(screen.queryByTestId("artifact-draft-card")).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Ask the Library" })).toBeInTheDocument();
  });

  test("ready draft Apply button calls apply mutation and selects the artifact", async () => {
    const onSelectArtifact = vi.fn();
    queryState.threadSummary = { title: "Library Ask", lockedProvider: undefined, defaultModelName: undefined };
    queryState.threadDrafts = [
      {
        draft: makeDraft({ status: "ready", operation: "create" }),
        job: makeJob({ status: "completed", stage: "Ready to review", progress: 1 }),
      },
    ];

    renderPanel({ threadId, onSelectArtifact });

    fireEvent.click(screen.getByRole("button", { name: /^Apply$/i }));

    await waitFor(() => {
      expect(mocks.applyDraft).toHaveBeenCalledWith({ draftId: "draft_1" });
      expect(onSelectArtifact).toHaveBeenCalledWith("artifact_new");
    });
  });

  test("ready draft Discard button calls discard mutation", async () => {
    queryState.threadSummary = { title: "Library Ask", lockedProvider: undefined, defaultModelName: undefined };
    queryState.threadDrafts = [
      {
        draft: makeDraft({ status: "ready", operation: "create" }),
        job: makeJob({ status: "completed", stage: "Ready to review", progress: 1 }),
      },
    ];

    renderPanel({ threadId });

    fireEvent.click(screen.getByRole("button", { name: /^Discard$/i }));

    await waitFor(() => {
      expect(mocks.discardDraft).toHaveBeenCalledWith({ draftId: "draft_1" });
    });
  });

  test("disables update action until an artifact is open", () => {
    renderPanel({ activeArtifactId: null });

    openDraftMenu();

    expect(screen.getByRole("menuitem", { name: /Update open artifact/i })).toHaveAttribute("data-disabled");
  });

  test("keeps Draft selector enabled while the active thread is confirming", () => {
    queryState.threadSummary = null;

    renderPanel({ threadId });

    expect(screen.getByRole("button", { name: "Draft" })).toBeEnabled();
    expect(screen.queryByTestId("library-ask-composer-tools-placeholder")).not.toBeInTheDocument();
  });

  test("reserves composer tool space while the library model catalog is loading", () => {
    mocks.useQuery.mockImplementation((reference: unknown, args: unknown) => {
      if (args === "skip") return undefined;
      const name = functionName(reference);
      if (name.endsWith("listThreads")) return queryState.threads;
      if (name.endsWith("getThreadSummary")) return queryState.threadSummary;
      if (name.endsWith("listByThread")) return queryState.threadDrafts;
      if (name.endsWith("listRecentByRepository")) return queryState.recentDrafts;
      if (name.endsWith("listPickableModels")) return undefined;
      if (name.endsWith("getById")) return queryState.activeArtifact;
      return undefined;
    });

    renderPanel();

    expect(screen.queryByRole("button", { name: "Draft" })).not.toBeInTheDocument();
    expect(screen.queryByText("GPT-5.5")).not.toBeInTheDocument();
    expect(screen.getByTestId("library-ask-composer-tools-placeholder")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
  });

  test("keeps composer tools visible while recent repository drafts are loading", () => {
    queryState.recentDrafts = undefined;

    renderPanel();

    expect(screen.getByRole("button", { name: "Draft" })).toBeInTheDocument();
    expect(screen.getByText("GPT-5.5")).toBeInTheDocument();
    expect(screen.getByTestId("library-ask-composer-tools")).toHaveClass("animate-soft-enter");
    expect(screen.queryByTestId("library-ask-composer-tools-placeholder")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask" })).toBeInTheDocument();
  });

  test("waits for artifact metadata before choosing the Library Ask empty state", () => {
    renderPanel({ hasArtifacts: undefined, onGenerate: vi.fn() });

    expect(screen.getByTestId("library-ask-artifacts-loading")).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Ask the Library" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "No design docs to ask about yet" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate design docs" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Draft" })).not.toBeInTheDocument();
    expect(screen.getByTestId("library-ask-composer-tools-placeholder")).toBeInTheDocument();
    expect(screen.getByRole("textbox")).toBeEnabled();
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
  });

  test("keeps the composer editable when Library Ask sending is unavailable", () => {
    renderPanel({ hasArtifacts: false, onGenerate: vi.fn() });

    const textbox = screen.getByRole("textbox");
    fireEvent.change(textbox, { target: { value: "What should I read first?" } });

    expect(textbox).toBeEnabled();
    expect(textbox).toHaveValue("What should I read first?");
    expect(screen.getByRole("button", { name: "Generate design docs" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Ask" })).toBeDisabled();
  });
});
