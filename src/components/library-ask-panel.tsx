import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import {
  BookOpenIcon,
  CaretDownIcon,
  FileHtmlIcon,
  FilePlusIcon,
  GitDiffIcon,
  PaperPlaneTiltIcon,
  SparkleIcon,
} from "@phosphor-icons/react";
import { useMutation, useQuery } from "convex/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import {
  Conversation,
  ConversationContent,
  ConversationItem,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { useChatScroll } from "@/components/ai-elements/use-chat-scroll";
import { CompactModelSettingsMenu } from "@/components/compact-model-settings-menu";
import {
  PromptInputComposerFrame,
  PromptInputFooter,
  PromptInputTextarea,
  PromptInputToolList,
} from "@/components/ai-elements/prompt-input";
import { PromptInputModelPicker } from "@/components/ai-elements/prompt-input-model-picker";
import { PromptInputReasoningPicker } from "@/components/ai-elements/prompt-input-reasoning-picker";
import { EmptyStateHero, PromptSuggestionList } from "@/components/chat-empty-state";
import { MessageBubble } from "@/components/chat-message";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  LibraryArtifactDraftCard,
  LibraryArtifactDraftConfirmCard,
  type LibraryArtifactDraftEntry,
  type LibraryArtifactDraftIntent,
} from "@/components/library-artifact-draft-card";
import { LibraryAskThreadTabs } from "@/components/library-ask-thread-tabs";
import { type PromptInputModelPickerValue } from "@/components/ai-elements/prompt-input-model-picker";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useLibraryAskTabs } from "@/hooks/use-library-ask-tabs";
import { useComposerModelPick, type ComposerModelPickValue } from "@/hooks/use-composer-model-pick";
import { useChatLifecycle } from "@/hooks/use-chat-lifecycle";
import { useConversationThread } from "@/hooks/use-conversation-thread";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { useDefaultModelPick } from "@/hooks/use-default-model-pick";
import { useModelAccessDisabledReason } from "@/hooks/use-model-access-disabled-reason";
import { buildChatSendRequest } from "@/lib/chat-composer-session";
import { toUserErrorMessage } from "@/lib/errors";
import { REPOSITORY_GUIDE_COPY } from "@/lib/product-copy";
import type {
  ActiveMessageStream,
  ArtifactId,
  LlmProvider,
  ReasoningEffort,
  RepositoryId,
  ThreadId,
} from "@/lib/types";
import { toast } from "sonner";

const LOCKED_PLACEHOLDER = `${REPOSITORY_GUIDE_COPY.generateAction} to unlock Library Ask.`;
const LOCKED_HINT = "Library Ask needs at least one design doc in this repository before you can send a question.";
const DEFAULT_UPDATE_DRAFT_PROMPT = "Refresh this artifact using the codebase as the source of truth.";

type LibraryAskTimelineEntry =
  | { kind: "message"; _id: Doc<"messages">["_id"]; createdAt: number; message: Doc<"messages"> }
  | { kind: "draft"; _id: Doc<"artifactDrafts">["_id"]; createdAt: number; entry: LibraryArtifactDraftEntry };

type LibraryAskThreadState = {
  threadId: ThreadId | null;
  confirmedThreadId: ThreadId | null;
  activeThreadProbe: Doc<"threads"> | null | undefined;
  tabs: ReadonlyArray<{ id: ThreadId; title: string }>;
};

type LibraryAskDraftState = {
  draftEntries: LibraryArtifactDraftEntry[];
  draftIntent: LibraryArtifactDraftIntent | null;
  activeArtifactTitle: string | undefined;
  draftModelPick: PromptInputModelPickerValue | null;
  draftReasoningEffort: ReasoningEffort | null;
  isRequestingDraft: boolean;
  disabledReason: string | undefined;
};

type LibraryAskComposerState = {
  input: string;
  setInput: (next: string) => void;
  placeholder: string;
  hintId: string | undefined;
  disabledReason: string | undefined;
  isSending: boolean;
  latestAssistantInFlight: boolean;
  isWaitingForThreadConfirmation: boolean;
  error: string | null;
  toolsReady: boolean;
};

type PromptInputSubmitMessage = {
  text: string;
};

export function LibraryAskPanel({
  repositoryId,
  threadId,
  activeArtifactId,
  hasArtifacts,
  onSelectArtifact,
  onSelectThread,
  onGenerate,
  askDisabledReason,
  generateDisabledReason,
  artifactDraftDisabledReason,
  liveSourceStatus,
  premiumModelsDisabledReason,
  highReasoningDisabledReason,
}: {
  repositoryId: RepositoryId;
  threadId: ThreadId | null;
  activeArtifactId: ArtifactId | null;
  /**
   * Whether the repository has at least one indexed artifact. Library Ask
   * runs RAG over those artifacts, so when this is `false` the composer
   * is locked and the empty state surfaces a "Generate design docs" CTA.
   * `undefined` means the artifact list is still loading; keep the panel in
   * a pending state until the backend-backed gate has a real verdict.
   */
  hasArtifacts: boolean | undefined;
  onSelectArtifact: (artifactId: ArtifactId) => void;
  /**
   * Set or clear the active Ask thread (`?ask=`). Used for tab clicks, the
   * `+` create flow, history-dialog picks, and advancing the active tab
   * when the current one is closed or deleted.
   */
  onSelectThread: (threadId: ThreadId | null) => void;
  /**
   * Open the Design Docs generation dialog. Surfaced in the no-artifacts
   * empty state and inline lock hint so the user can act on the gate
   * without leaving the Ask panel.
   */
  onGenerate?: () => void;
  askDisabledReason?: string;
  generateDisabledReason?: string;
  artifactDraftDisabledReason?: string;
  liveSourceStatus?: { kind: "idle" | "preparing" | "ready" | "expiring_soon" };
  premiumModelsDisabledReason?: string;
  highReasoningDisabledReason?: string;
}) {
  const archiveThread = useMutation(api.chat.threads.archiveThread);
  const setThreadPinned = useMutation(api.chat.threads.setThreadPinned);
  const requestDraft = useMutation(api.libraryArtifactDrafts.requestDraft);

  const threads = useQuery(api.chat.threads.listThreads, { repositoryId, mode: "library" });
  // Dual-purpose: confirms the active thread exists (so the message queries
  // below can be gated and never throw the route into its error boundary)
  // and supplies the tab title when the thread has aged out of `listThreads`.
  const activeThreadProbe = useQuery(api.chat.threads.getThreadSummary, threadId ? { threadId } : "skip");
  // Only subscribe once the probe has confirmed the thread exists. A stale
  // `?ask=` bookmark then degrades to the empty state instead of holding
  // message subscriptions for a missing thread.
  const confirmedThreadId = threadId && activeThreadProbe ? threadId : null;
  const { messages, activeMessageStream, canLoadOlderMessages, handleLoadOlderMessages, latestAssistantInFlight } =
    useConversationThread({ threadId: confirmedThreadId });
  const threadDrafts = useQuery(
    api.libraryArtifactDrafts.listByThread,
    confirmedThreadId ? { threadId: confirmedThreadId } : "skip",
  );
  const recentDrafts = useQuery(api.libraryArtifactDrafts.listRecentByRepository, threadId ? "skip" : { repositoryId });
  const [repositoryDraftSessionStartedAt, setRepositoryDraftSessionStartedAt] = useState(() => Date.now());
  const [visibleRepositoryDraftIds, setVisibleRepositoryDraftIds] = useState<Doc<"artifactDrafts">["_id"][]>([]);
  const draftEntries = useMemo<LibraryArtifactDraftEntry[]>(() => {
    if (threadId) {
      return confirmedThreadId ? [...(threadDrafts ?? [])].sort(compareDraftEntriesByCreatedAt) : [];
    }
    if (!recentDrafts) {
      return [];
    }
    return recentDrafts.filter((entry) => {
      if (entry.draft.threadId !== undefined) {
        return false;
      }
      return (
        entry.draft.createdAt >= repositoryDraftSessionStartedAt || visibleRepositoryDraftIds.includes(entry.draft._id)
      );
    });
  }, [
    confirmedThreadId,
    recentDrafts,
    repositoryDraftSessionStartedAt,
    threadDrafts,
    threadId,
    visibleRepositoryDraftIds,
  ]);
  const timelineEntries = useMemo<LibraryAskTimelineEntry[]>(() => {
    if (!threadId) {
      return [];
    }
    return [
      ...(messages ?? []).map((message) => ({
        kind: "message" as const,
        _id: message._id,
        createdAt: message._creationTime,
        message,
      })),
      ...draftEntries.map((entry) => ({
        kind: "draft" as const,
        _id: entry.draft._id,
        createdAt: entry.draft.createdAt,
        entry,
      })),
    ].sort(compareTimelineEntries);
  }, [draftEntries, messages, threadId]);
  const scrollEntries: readonly { readonly _id: string }[] | undefined = threadId ? timelineEntries : messages;

  // Owns stick-to-bottom, anchor preservation on prepend, sentinel
  // observer for load-older, threadId-keyed reset, and prefers-
  // reduced-motion gating for the Ask conversation.
  const conversationScroll = useChatScroll({
    threadId: confirmedThreadId,
    messages: scrollEntries,
    streamingSignal: activeMessageStream?.content ?? null,
    canLoadOlder: canLoadOlderMessages,
    onLoadOlder: handleLoadOlderMessages,
  });

  const { openThreads, ensureOpen, closeTab } = useLibraryAskTabs(repositoryId);

  const [input, setInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pendingArchiveThreadId, setPendingArchiveThreadId] = useState<ThreadId | null>(null);
  const [isArchivingThread, setIsArchivingThread] = useState(false);
  const [draftIntent, setDraftIntent] = useState<LibraryArtifactDraftIntent | null>(null);
  const [draftUserPick, setDraftUserPick] = useState<PromptInputModelPickerValue | null>(null);
  const [draftReasoningEffort, setDraftReasoningEffort] = useState<ReasoningEffort | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const activeArtifact = useQuery(api.artifacts.getById, activeArtifactId ? { artifactId: activeArtifactId } : "skip");

  const handlePickSuggestion = useCallback((suggestion: string) => {
    setInput(suggestion);
    requestAnimationFrame(() => {
      const node = textareaRef.current;
      if (node) {
        node.focus();
        node.setSelectionRange(suggestion.length, suggestion.length);
      }
    });
  }, []);

  const threadsById = useMemo(() => {
    const map = new Map<ThreadId, Doc<"threads">>();
    for (const thread of threads ?? []) {
      map.set(thread._id as ThreadId, thread);
    }
    return map;
  }, [threads]);

  // Tabs render the open set with the freshest title available — the live
  // `listThreads` title when the thread is in that (capped) window, else the
  // title cached in localStorage when the tab was opened.
  const tabs = useMemo(
    () =>
      openThreads.map((tab) => {
        const live = threadsById.get(tab.id);
        return live ? { id: tab.id, title: live.title } : tab;
      }),
    [openThreads, threadsById],
  );

  // Whatever becomes the active thread (`?ask=`) must show as a tab. Title
  // comes from `listThreads` when present, else the existence probe — which
  // covers a thread bookmarked after it aged out of `listThreads`.
  const activeTitle = (threadId ? threadsById.get(threadId)?.title : undefined) ?? activeThreadProbe?.title ?? null;
  useEffect(() => {
    if (threadId && activeTitle) {
      ensureOpen({ id: threadId, title: activeTitle });
    }
  }, [threadId, activeTitle, ensureOpen]);

  // The Ask panel no longer remounts when the active thread changes — the
  // thread is a `?ask=` query param on the same route. Clear the in-progress
  // draft + any stale error explicitly so they don't bleed between threads.
  useEffect(() => {
    setInput("");
    setError(null);
    setDraftIntent(null);
    setRepositoryDraftSessionStartedAt(Date.now());
    setVisibleRepositoryDraftIds([]);
  }, [threadId]);

  const lockedProvider = activeThreadProbe?.lockedProvider ?? null;
  const defaultModelName = activeThreadProbe?.defaultModelName ?? null;
  const { selectedProvider, selectedModelName, setSelectedModel, selectedReasoningEffort, setSelectedReasoningEffort } =
    useComposerModelPick({
      threadId,
      capability: "library",
      preferenceScope: "library",
      threadLockedProvider: lockedProvider,
      threadDefaultModelName: defaultModelName,
    });
  const libraryCatalogEntries = useQuery(api.llmCatalog.listPickableModels, { preferenceScope: "library" });

  const lifecycleThreadId = threadId && activeThreadProbe === undefined ? threadId : confirmedThreadId;
  const newThreadArtifactContext = useMemo(
    () => (activeArtifactId ? [activeArtifactId] : undefined),
    [activeArtifactId],
  );
  const clearInput = useCallback(() => setInput(""), []);
  const handleAfterCreateThread = useCallback(
    (id: ThreadId) => {
      ensureOpen({ id, title: "Library Ask" });
      onSelectThread(id);
    },
    [ensureOpen, onSelectThread],
  );
  const { isSending, handleSendMessage: handleLifecycleSendMessage } = useChatLifecycle({
    selectedThreadId: lifecycleThreadId,
    buildSendRequest: (content) =>
      buildChatSendRequest({
        selectedThreadId: lifecycleThreadId,
        repositoryId,
        mode: "library",
        content,
        provider: selectedProvider,
        modelName: selectedModelName,
        reasoningEffort: selectedReasoningEffort,
        newThreadArtifactContext,
      }),
    clearChatInput: clearInput,
    setActionError: setError,
    onAfterCreateThread: handleAfterCreateThread,
  });

  // "+" no longer eagerly creates a thread — it transitions the panel to a
  // draft state (clears `?ask=`, focuses the composer). The thread is created
  // by `handleSubmit` only when the user sends their first message, so a
  // click that ends without typing leaves nothing in the database.
  const handleCreateThread = useCallback(() => {
    setError(null);
    setInput("");
    setDraftIntent(null);
    setRepositoryDraftSessionStartedAt(Date.now());
    setVisibleRepositoryDraftIds([]);
    onSelectThread(null);
    textareaRef.current?.focus();
  }, [onSelectThread]);

  const handleCloseTab = useCallback(
    (id: ThreadId) => {
      const nextActive = closeTab(id);
      // Closing the active tab advances `?ask=` to the neighbour (or clears
      // it). Closing a background tab leaves the active thread alone.
      if (id === threadId) {
        onSelectThread(nextActive);
      }
    },
    [closeTab, onSelectThread, threadId],
  );

  const handleSelectFromHistory = useCallback(
    (thread: Doc<"threads">) => {
      // Add the tab immediately so it appears before `?ask=` round-trips.
      ensureOpen({ id: thread._id as ThreadId, title: thread.title });
      onSelectThread(thread._id as ThreadId);
    },
    [ensureOpen, onSelectThread],
  );

  const handleTogglePin = useCallback(
    (id: ThreadId, pinned: boolean) => {
      void setThreadPinned({ threadId: id, pinned }).catch((caught) => {
        toast.error(toUserErrorMessage(caught, pinned ? "Failed to pin thread." : "Failed to unpin thread."));
      });
    },
    [setThreadPinned],
  );

  const handleConfirmArchive = useCallback(async () => {
    if (!pendingArchiveThreadId) return;
    const target = pendingArchiveThreadId;
    setIsArchivingThread(true);
    try {
      await archiveThread({ threadId: target });
      setPendingArchiveThreadId(null);
      // Drop it from the open-tab set; if it was the active thread, advance
      // `?ask=` to the neighbour the close suggests.
      const nextActive = closeTab(target);
      if (target === threadId) {
        onSelectThread(nextActive);
      }
    } catch (caught) {
      toast.error(toUserErrorMessage(caught, "Failed to archive thread."));
    } finally {
      setIsArchivingThread(false);
    }
  }, [archiveThread, closeTab, onSelectThread, pendingArchiveThreadId, threadId]);

  const artifactStatusDisabledReason = hasArtifacts === undefined ? "Checking Library documents…" : undefined;
  const isLocked = hasArtifacts === false;
  const composerToolsReady =
    artifactStatusDisabledReason === undefined && (isLocked || Array.isArray(libraryCatalogEntries));
  const composerToolsDisabledReason = composerToolsReady ? undefined : "Loading composer controls…";
  const selectedModelPick =
    selectedProvider && selectedModelName ? { provider: selectedProvider, modelName: selectedModelName } : null;
  const askModelAccessDisabledReason = useModelAccessDisabledReason({
    modelPick: selectedModelPick,
    reasoningEffort: selectedReasoningEffort,
    preferenceScope: "library",
    premiumModelsDisabledReason,
    highReasoningDisabledReason,
  });
  const markdownDraftDefaultPick = useDefaultModelPick({ capability: "sandbox", preferenceScope: "sandbox" });
  const htmlDraftDefaultPick = useDefaultModelPick({ capability: "library", preferenceScope: "library" });
  const draftOutputFormat = draftIntent?.outputFormat ?? "markdown";
  const draftPreferenceScope = draftOutputFormat === "html" ? "library" : "sandbox";
  const draftModelPick =
    draftUserPick ?? (draftOutputFormat === "html" ? htmlDraftDefaultPick : markdownDraftDefaultPick) ?? null;
  const draftModelAccessDisabledReason = useModelAccessDisabledReason({
    modelPick: draftModelPick,
    reasoningEffort: draftReasoningEffort,
    preferenceScope: draftPreferenceScope,
    premiumModelsDisabledReason,
    highReasoningDisabledReason,
  });
  const threadConfirmationDisabledReason =
    threadId && confirmedThreadId === null ? "Waiting for thread confirmation…" : undefined;
  const documentActionDisabledReason =
    artifactStatusDisabledReason ??
    threadConfirmationDisabledReason ??
    artifactDraftDisabledReason ??
    draftModelAccessDisabledReason ??
    undefined;
  const draftMenuDisabledReason = artifactDraftDisabledReason;
  const composerDisabledReason =
    askDisabledReason ??
    artifactStatusDisabledReason ??
    threadConfirmationDisabledReason ??
    composerToolsDisabledReason ??
    (isLocked ? LOCKED_HINT : askModelAccessDisabledReason);
  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>, contentOverride?: string) => {
      if (composerDisabledReason != null || latestAssistantInFlight) {
        event.preventDefault();
        return;
      }
      await handleLifecycleSendMessage(event, contentOverride);
    },
    [composerDisabledReason, handleLifecycleSendMessage, latestAssistantInFlight],
  );
  const composerHintId = isLocked && threadId ? "library-ask-locked-hint" : undefined;
  const composerPlaceholder =
    artifactStatusDisabledReason !== undefined
      ? "Question about this library..."
      : isLocked
        ? LOCKED_PLACEHOLDER
        : activeArtifactId
          ? "Question about the open artifact..."
          : "Question about this library...";
  const repositoryCodeLabel = getRepositoryCodeDraftLabel(liveSourceStatus);
  const openCreateDraft = useCallback(() => {
    setError(null);
    setDraftUserPick(null);
    setDraftReasoningEffort(null);
    setDraftIntent({
      operation: "create",
      outputFormat: "markdown",
      title: "",
      folderId: null,
      prompt: input.trim(),
    });
  }, [input]);
  const openUpdateDraft = useCallback(() => {
    if (!activeArtifactId) return;
    setError(null);
    setDraftUserPick(null);
    setDraftReasoningEffort(null);
    setDraftIntent({
      operation: "update",
      outputFormat: "markdown",
      title: activeArtifact?.title ?? "",
      folderId: null,
      prompt: input.trim(),
    });
  }, [activeArtifact?.title, activeArtifactId, input]);
  const openHtmlReportDraft = useCallback(() => {
    setError(null);
    setDraftUserPick(null);
    setDraftReasoningEffort(null);
    setDraftIntent({
      operation: "create",
      outputFormat: "html",
      title: "",
      folderId: null,
      prompt: input.trim(),
    });
  }, [input]);

  const [isRequestingDraft, runRequestDraft] = useAsyncCallback(async () => {
    if (!draftIntent) return;
    if (documentActionDisabledReason) {
      setError(documentActionDisabledReason);
      return;
    }
    if (!draftModelPick) {
      setError("Loading models — try again in a moment.");
      return;
    }
    if (threadId && !confirmedThreadId) {
      setError(threadConfirmationDisabledReason ?? "Waiting for thread confirmation…");
      return;
    }
    if (draftIntent.operation === "create" && draftIntent.title.trim().length === 0) {
      setError("Add a title for the new artifact.");
      return;
    }
    const prompt = draftIntent.prompt.trim();
    if (draftIntent.operation === "create" && prompt.length === 0) {
      setError("Describe what to draft.");
      return;
    }
    const requestPrompt =
      draftIntent.operation === "update" && prompt.length === 0 ? DEFAULT_UPDATE_DRAFT_PROMPT : prompt;
    try {
      const result = await requestDraft({
        repositoryId,
        threadId: confirmedThreadId ? confirmedThreadId : undefined,
        operation: draftIntent.operation,
        outputFormat: draftIntent.outputFormat,
        prompt: requestPrompt,
        title: draftIntent.operation === "create" ? draftIntent.title : undefined,
        folderId: draftIntent.operation === "create" ? (draftIntent.folderId ?? undefined) : undefined,
        targetArtifactId: draftIntent.operation === "update" ? (activeArtifactId ?? undefined) : undefined,
        provider: draftModelPick.provider,
        modelName: draftModelPick.modelName,
        ...(draftReasoningEffort !== null ? { reasoningEffort: draftReasoningEffort } : {}),
      });
      if (!confirmedThreadId) {
        setVisibleRepositoryDraftIds((current) =>
          current.includes(result.draftId) ? current : [...current, result.draftId],
        );
      }
      setError(null);
      setDraftIntent(null);
    } catch (caught) {
      setError(toUserErrorMessage(caught, "Failed to start artifact draft."));
    }
  });

  const handleRepositoryDraftRegenerated = useCallback((draftId: Doc<"artifactDrafts">["_id"]) => {
    setVisibleRepositoryDraftIds((current) => (current.includes(draftId) ? current : [...current, draftId]));
  }, []);

  const draftCards =
    draftEntries.length > 0 ? (
      <div className="space-y-5" data-testid="artifact-draft-list">
        {draftEntries.map((entry) => (
          <LibraryArtifactDraftCard
            key={entry.draft._id}
            entry={entry}
            onApplied={onSelectArtifact}
            onRegenerated={handleRepositoryDraftRegenerated}
          />
        ))}
      </div>
    ) : null;

  const threadState: LibraryAskThreadState = {
    threadId,
    confirmedThreadId,
    activeThreadProbe,
    tabs,
  };
  const draftState: LibraryAskDraftState = {
    draftEntries,
    draftIntent,
    activeArtifactTitle: activeArtifact?.title,
    draftModelPick,
    draftReasoningEffort,
    isRequestingDraft,
    disabledReason: documentActionDisabledReason,
  };
  const composerState: LibraryAskComposerState = {
    input,
    setInput,
    placeholder: composerPlaceholder,
    hintId: composerHintId,
    disabledReason: composerDisabledReason ?? undefined,
    isSending,
    latestAssistantInFlight,
    isWaitingForThreadConfirmation: threadConfirmationDisabledReason !== undefined,
    error,
    toolsReady: composerToolsReady,
  };

  return (
    // Plain container, not a landmark: this panel renders inside the app
    // sidebar's <aside>, so its own section is just content within it.
    <div className="flex h-full w-full flex-col bg-background">
      <LibraryAskThreadChrome
        tabs={threadState.tabs}
        activeThreadId={threadState.threadId}
        onSelectTab={onSelectThread}
        onCloseTab={handleCloseTab}
        onNewThread={handleCreateThread}
        isCreating={false}
        threads={threads}
        onSelectFromHistory={handleSelectFromHistory}
        onTogglePin={handleTogglePin}
        onArchiveThread={setPendingArchiveThreadId}
      />

      <LibraryAskBody
        threadId={threadState.threadId}
        confirmedThreadId={threadState.confirmedThreadId}
        isArtifactStatusLoading={artifactStatusDisabledReason !== undefined}
        isLocked={isLocked}
        draftCards={draftCards}
        conversationScroll={conversationScroll}
        timelineEntries={timelineEntries}
        activeMessageStream={activeMessageStream ?? null}
        canLoadOlderMessages={canLoadOlderMessages}
        onSelectArtifact={onSelectArtifact}
        onGenerate={onGenerate}
        generateDisabledReason={generateDisabledReason}
        activeArtifactId={activeArtifactId}
        onPickSuggestion={handlePickSuggestion}
        composerHintId={composerHintId}
        onDraftRegenerated={handleRepositoryDraftRegenerated}
      />

      <LibraryAskComposer
        state={composerState}
        repositoryId={repositoryId}
        draftState={draftState}
        repositoryCodeLabel={repositoryCodeLabel}
        onDraftModelPickChange={setDraftUserPick}
        onDraftReasoningEffortChange={setDraftReasoningEffort}
        onDraftIntentChange={setDraftIntent}
        onCancelDraft={() => setDraftIntent(null)}
        onSubmitDraft={() => void runRequestDraft()}
        premiumModelsDisabledReason={premiumModelsDisabledReason}
        highReasoningDisabledReason={highReasoningDisabledReason}
        textareaRef={textareaRef}
        onSubmit={handleSubmit}
        tools={{
          isLocked,
          activeArtifactId,
          documentActionDisabledReason,
          draftMenuDisabledReason,
          openCreateDraft,
          openUpdateDraft,
          openHtmlReportDraft,
          selectedModelPick,
          setSelectedModel,
          lockedProvider,
          premiumModelsDisabledReason,
          libraryCatalogEntries,
          selectedReasoningEffort,
          setSelectedReasoningEffort,
          selectedProvider,
          selectedModelName,
          highReasoningDisabledReason,
        }}
      />

      <ConfirmDialog
        open={pendingArchiveThreadId !== null}
        onOpenChange={(open) => !open && setPendingArchiveThreadId(null)}
        title="Archive thread"
        description="This removes the thread from active history. You can restore or permanently delete it from Archive."
        actionLabel="Archive thread"
        loadingLabel="Archiving…"
        isPending={isArchivingThread}
        onConfirm={() => void handleConfirmArchive()}
      />
    </div>
  );
}

function LibraryAskThreadChrome({
  tabs,
  activeThreadId,
  onSelectTab,
  onCloseTab,
  onNewThread,
  isCreating,
  threads,
  onSelectFromHistory,
  onTogglePin,
  onArchiveThread,
}: {
  tabs: ReadonlyArray<{ id: ThreadId; title: string }>;
  activeThreadId: ThreadId | null;
  onSelectTab: (threadId: ThreadId | null) => void;
  onCloseTab: (threadId: ThreadId) => void;
  onNewThread: () => void;
  isCreating: boolean;
  threads: Doc<"threads">[] | undefined;
  onSelectFromHistory: (thread: Doc<"threads">) => void;
  onTogglePin: (threadId: ThreadId, pinned: boolean) => void;
  onArchiveThread: (threadId: ThreadId) => void;
}) {
  return (
    <LibraryAskThreadTabs
      tabs={tabs}
      activeThreadId={activeThreadId}
      onSelectTab={onSelectTab}
      onCloseTab={onCloseTab}
      onNewThread={onNewThread}
      isCreating={isCreating}
      threads={threads}
      onSelectFromHistory={onSelectFromHistory}
      onTogglePin={onTogglePin}
      onArchiveThread={onArchiveThread}
    />
  );
}

function LibraryAskBody({
  threadId,
  confirmedThreadId,
  isArtifactStatusLoading,
  isLocked,
  draftCards,
  conversationScroll,
  timelineEntries,
  activeMessageStream,
  canLoadOlderMessages,
  onSelectArtifact,
  onGenerate,
  generateDisabledReason,
  activeArtifactId,
  onPickSuggestion,
  composerHintId,
  onDraftRegenerated,
}: {
  threadId: ThreadId | null;
  confirmedThreadId: ThreadId | null;
  isArtifactStatusLoading: boolean;
  isLocked: boolean;
  draftCards: ReactNode;
  conversationScroll: ReturnType<typeof useChatScroll>;
  timelineEntries: LibraryAskTimelineEntry[];
  activeMessageStream: ActiveMessageStream | null;
  canLoadOlderMessages: boolean;
  onSelectArtifact: (artifactId: ArtifactId) => void;
  onGenerate?: () => void;
  generateDisabledReason?: string;
  activeArtifactId: ArtifactId | null;
  onPickSuggestion: (suggestion: string) => void;
  composerHintId: string | undefined;
  onDraftRegenerated: (draftId: Doc<"artifactDrafts">["_id"]) => void;
}) {
  if (threadId) {
    return (
      <LibraryAskTimeline
        confirmedThreadId={confirmedThreadId}
        isLocked={isLocked}
        conversationScroll={conversationScroll}
        timelineEntries={timelineEntries}
        activeMessageStream={activeMessageStream}
        canLoadOlderMessages={canLoadOlderMessages}
        onSelectArtifact={onSelectArtifact}
        onGenerate={onGenerate}
        generateDisabledReason={generateDisabledReason}
        composerHintId={composerHintId}
        onDraftRegenerated={onDraftRegenerated}
      />
    );
  }
  if (isArtifactStatusLoading) {
    return <div aria-hidden="true" data-testid="library-ask-artifacts-loading" className="min-h-0 flex-1" />;
  }
  if (isLocked) {
    return (
      <LibraryAskLockedEmptyState
        draftCards={draftCards}
        onGenerate={onGenerate}
        generateDisabledReason={generateDisabledReason}
      />
    );
  }
  return (
    <LibraryAskDefaultEmptyState
      draftCards={draftCards}
      activeArtifactId={activeArtifactId}
      onPickSuggestion={onPickSuggestion}
    />
  );
}

function LibraryAskTimeline({
  confirmedThreadId,
  isLocked,
  conversationScroll,
  timelineEntries,
  activeMessageStream,
  canLoadOlderMessages,
  onSelectArtifact,
  onGenerate,
  generateDisabledReason,
  composerHintId,
  onDraftRegenerated,
}: {
  confirmedThreadId: ThreadId | null;
  isLocked: boolean;
  conversationScroll: ReturnType<typeof useChatScroll>;
  timelineEntries: LibraryAskTimelineEntry[];
  activeMessageStream: ActiveMessageStream | null;
  canLoadOlderMessages: boolean;
  onSelectArtifact: (artifactId: ArtifactId) => void;
  onGenerate?: () => void;
  generateDisabledReason?: string;
  composerHintId: string | undefined;
  onDraftRegenerated: (draftId: Doc<"artifactDrafts">["_id"]) => void;
}) {
  return (
    <Conversation
      key={confirmedThreadId ?? "pending-library-ask-thread"}
      scroll={conversationScroll}
      className="min-h-0 flex-1"
    >
      <ConversationContent
        className={`gap-0 px-5 py-3 sm:px-6 ${isLocked ? "min-h-full" : ""} ${
          conversationScroll.didPrepend ? "" : "animate-soft-enter"
        }`}
        showLoadOlderSentinel={canLoadOlderMessages}
        aria-busy={activeMessageStream !== null}
      >
        {confirmedThreadId ? (
          <>
            {timelineEntries.map((entry, index) => (
              <ConversationItem
                key={entry._id}
                messageId={entry._id}
                scrollAnchor={entry.kind === "message" && entry.message.role === "user"}
                className={timelineSpacingClassName(timelineEntries[index - 1], entry)}
              >
                {entry.kind === "message" ? (
                  <MessageBubble
                    message={entry.message}
                    activeMessageStream={activeMessageStream}
                    onSelectArtifact={onSelectArtifact}
                  />
                ) : (
                  <LibraryArtifactDraftCard
                    entry={entry.entry}
                    onApplied={onSelectArtifact}
                    onRegenerated={onDraftRegenerated}
                  />
                )}
              </ConversationItem>
            ))}
          </>
        ) : null}
        {isLocked && confirmedThreadId ? (
          <ConversationItem messageId="library-ask-no-artifacts" className="mt-4">
            <NoArtifactsHint
              descriptionId={composerHintId}
              onGenerate={onGenerate}
              generateDisabledReason={generateDisabledReason}
            />
          </ConversationItem>
        ) : null}
        {isLocked && !confirmedThreadId ? (
          <NoArtifactsHint
            descriptionId={composerHintId}
            onGenerate={onGenerate}
            generateDisabledReason={generateDisabledReason}
          />
        ) : null}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

function LibraryAskLockedEmptyState({
  draftCards,
  onGenerate,
  generateDisabledReason,
}: {
  draftCards: ReactNode;
  onGenerate?: () => void;
  generateDisabledReason?: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 animate-soft-enter flex-col gap-5 px-4 py-6">
      {draftCards}
      <NoArtifactsHint onGenerate={onGenerate} generateDisabledReason={generateDisabledReason} />
    </div>
  );
}

function LibraryAskDefaultEmptyState({
  draftCards,
  activeArtifactId,
  onPickSuggestion,
}: {
  draftCards: ReactNode;
  activeArtifactId: ArtifactId | null;
  onPickSuggestion: (suggestion: string) => void;
}) {
  return (
    <div className="flex min-h-0 flex-1 animate-soft-enter flex-col gap-5 px-4 py-6">
      {draftCards}
      <div className="flex flex-1 items-center justify-center">
        <EmptyStateHero
          visual={
            <div className="flex size-11 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
              <BookOpenIcon size={20} weight="duotone" />
            </div>
          }
          title="Ask the Library"
          description={
            activeArtifactId
              ? "Answers cite this artifact and other indexed chunks."
              : "Answers cite retrieved artifact chunks. Artifact drafts use the codebase as the source of truth and wait for Apply."
          }
        />
      </div>
      <PromptSuggestionList
        prompts={activeArtifactId ? ARTIFACT_SUGGESTIONS : LIBRARY_SUGGESTIONS}
        onPick={onPickSuggestion}
        layout="stack"
      />
    </div>
  );
}

type LibraryAskComposerToolsState = {
  isLocked: boolean;
  activeArtifactId: ArtifactId | null;
  documentActionDisabledReason: string | undefined;
  draftMenuDisabledReason: string | undefined;
  openCreateDraft: () => void;
  openUpdateDraft: () => void;
  openHtmlReportDraft: () => void;
  selectedModelPick: PromptInputModelPickerValue | null;
  setSelectedModel: (value: ComposerModelPickValue) => void;
  lockedProvider: LlmProvider | null;
  premiumModelsDisabledReason?: string;
  libraryCatalogEntries: Parameters<typeof PromptInputModelPicker>[0]["catalogEntries"];
  selectedReasoningEffort: ReasoningEffort | null;
  setSelectedReasoningEffort: (value: ReasoningEffort | null) => void;
  selectedProvider: LlmProvider | null;
  selectedModelName: string | null;
  highReasoningDisabledReason?: string;
};

function LibraryAskComposer({
  state,
  repositoryId,
  draftState,
  repositoryCodeLabel,
  onDraftModelPickChange,
  onDraftReasoningEffortChange,
  onDraftIntentChange,
  onCancelDraft,
  onSubmitDraft,
  premiumModelsDisabledReason,
  highReasoningDisabledReason,
  textareaRef,
  onSubmit,
  tools,
}: {
  state: LibraryAskComposerState;
  repositoryId: RepositoryId;
  draftState: LibraryAskDraftState;
  repositoryCodeLabel: string;
  onDraftModelPickChange: (value: PromptInputModelPickerValue | null) => void;
  onDraftReasoningEffortChange: (value: ReasoningEffort | null) => void;
  onDraftIntentChange: (intent: LibraryArtifactDraftIntent) => void;
  onCancelDraft: () => void;
  onSubmitDraft: () => void;
  premiumModelsDisabledReason?: string;
  highReasoningDisabledReason?: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  onSubmit: (event: FormEvent<HTMLFormElement>, contentOverride?: string) => void | Promise<void>;
  tools: LibraryAskComposerToolsState;
}) {
  if (draftState.draftIntent) {
    return (
      <div className="border-t border-border bg-background px-4 py-3">
        {state.error ? <p className="mb-2 text-xs text-destructive">{state.error}</p> : null}
        <LibraryArtifactDraftConfirmCard
          repositoryId={repositoryId}
          intent={draftState.draftIntent}
          activeArtifactTitle={draftState.activeArtifactTitle}
          disabledReason={draftState.disabledReason}
          repositoryCodeLabel={
            draftState.draftIntent.outputFormat === "html"
              ? "Uses Library knowledge by default, not live source."
              : repositoryCodeLabel
          }
          modelPick={draftState.draftModelPick}
          onModelPickChange={onDraftModelPickChange}
          reasoningEffort={draftState.draftReasoningEffort}
          onReasoningEffortChange={onDraftReasoningEffortChange}
          premiumModelsDisabledReason={premiumModelsDisabledReason}
          highReasoningDisabledReason={highReasoningDisabledReason}
          onChange={onDraftIntentChange}
          onCancel={onCancelDraft}
          onSubmit={onSubmitDraft}
          isSubmitting={draftState.isRequestingDraft}
        />
      </div>
    );
  }

  return (
    <div className="border-t border-border px-4 py-3">
      <PromptInputComposerFrame
        error={state.error}
        promptInputClassName="[&_[data-slot=input-group]]:min-h-[9rem]"
        onSubmit={(message: PromptInputSubmitMessage, event) => {
          void onSubmit(event, message.text);
        }}
      >
        <PromptInputTextarea
          ref={textareaRef}
          name="message"
          value={state.input}
          onChange={(event) => state.setInput(event.target.value)}
          placeholder={state.placeholder}
          className="min-h-24 text-sm"
          readOnly={state.isSending || state.latestAssistantInFlight || state.isWaitingForThreadConfirmation}
          aria-describedby={state.hintId}
        />
        <PromptInputFooter className="h-11 min-h-11 flex-nowrap items-center overflow-hidden">
          {state.toolsReady ? (
            <LibraryAskComposerTools tools={tools} />
          ) : (
            <div
              aria-hidden="true"
              data-testid="library-ask-composer-tools-placeholder"
              className="h-8 min-h-8 min-w-0 flex-1"
            />
          )}
          <LibraryAskSendButton state={state} />
        </PromptInputFooter>
      </PromptInputComposerFrame>
    </div>
  );
}

function LibraryAskComposerTools({ tools }: { tools: LibraryAskComposerToolsState }) {
  return (
    <PromptInputToolList
      data-testid="library-ask-composer-tools"
      className="composer-model-settings-query h-8 min-h-8 min-w-0 flex-1 animate-soft-enter overflow-hidden"
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={[
              "inline-flex h-8 w-auto min-w-0 max-w-32 shrink-0 items-center justify-start gap-1.5 rounded-none border-none bg-transparent px-2 py-0 text-xs font-medium text-muted-foreground shadow-none transition-colors",
              "hover:bg-accent hover:text-foreground",
              "focus-visible:bg-transparent focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              "aria-expanded:bg-accent aria-expanded:text-foreground",
              "disabled:pointer-events-none disabled:opacity-50",
              "[&_svg]:shrink-0",
            ].join(" ")}
            disabled={tools.draftMenuDisabledReason !== undefined}
            title={tools.draftMenuDisabledReason}
          >
            <SparkleIcon size={13} weight="bold" />
            <span className="truncate leading-none">Draft</span>
            <CaretDownIcon size={11} weight="bold" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-56">
          <DropdownMenuItem onSelect={tools.openCreateDraft}>
            <FilePlusIcon size={14} weight="bold" />
            <div className="min-w-0">
              <div className="text-xs font-medium">New artifact</div>
              <div className="text-[11px] text-muted-foreground">Choose title, folder, and instructions.</div>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={tools.activeArtifactId === null}
            onSelect={tools.openUpdateDraft}
            title={tools.activeArtifactId === null ? "Open an artifact to draft an update." : undefined}
          >
            <GitDiffIcon size={14} weight="bold" />
            <div className="min-w-0">
              <div className="text-xs font-medium">Update open artifact</div>
              <div className="text-[11px] text-muted-foreground">Refresh the current artifact in place.</div>
            </div>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={tools.openHtmlReportDraft}>
            <FileHtmlIcon size={14} weight="bold" />
            <div className="min-w-0">
              <div className="text-xs font-medium">HTML report</div>
              <div className="text-[11px] text-muted-foreground">Create a Library-grounded report.</div>
            </div>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {!tools.isLocked ? <LibraryAskModelSettings tools={tools} /> : null}
    </PromptInputToolList>
  );
}

function LibraryAskModelSettings({ tools }: { tools: LibraryAskComposerToolsState }) {
  const getDisabledReason = (entry: NonNullable<LibraryAskComposerToolsState["libraryCatalogEntries"]>[number]) =>
    tools.premiumModelsDisabledReason && entry.capability === "sandbox" ? tools.premiumModelsDisabledReason : null;

  return (
    <>
      <div className="composer-model-settings-compact">
        <CompactModelSettingsMenu
          modelPicker={{
            value: tools.selectedModelPick,
            onChange: tools.setSelectedModel,
            threadLockedProvider: tools.lockedProvider,
            getDisabledReason,
            catalogEntries: tools.libraryCatalogEntries,
          }}
          reasoningPicker={{
            value: tools.selectedReasoningEffort,
            onChange: tools.setSelectedReasoningEffort,
            provider: tools.selectedProvider ?? undefined,
            modelName: tools.selectedModelName ?? undefined,
            disabledReasoningEfforts: tools.highReasoningDisabledReason ? ["high", "xhigh"] : [],
            disabledReasoningEffortMessage: tools.highReasoningDisabledReason,
            catalogEntries: tools.libraryCatalogEntries,
          }}
        />
      </div>
      <div className="composer-model-settings-desktop">
        <PromptInputModelPicker
          value={tools.selectedModelPick}
          onChange={tools.setSelectedModel}
          threadLockedProvider={tools.lockedProvider}
          preferenceScope="library"
          getDisabledReason={getDisabledReason}
          triggerClassName="h-8 max-w-[48vw] py-0"
          catalogEntries={tools.libraryCatalogEntries}
        />
        <PromptInputReasoningPicker
          value={tools.selectedReasoningEffort}
          onChange={tools.setSelectedReasoningEffort}
          provider={tools.selectedProvider ?? undefined}
          modelName={tools.selectedModelName ?? undefined}
          preferenceScope="library"
          disabledReasoningEfforts={tools.highReasoningDisabledReason ? ["high", "xhigh"] : []}
          disabledReasoningEffortMessage={tools.highReasoningDisabledReason}
          triggerClassName="h-8 py-0"
          catalogEntries={tools.libraryCatalogEntries}
        />
      </div>
    </>
  );
}

function LibraryAskSendButton({ state }: { state: LibraryAskComposerState }) {
  return (
    <Button
      type="submit"
      size="icon"
      disabled={!state.input.trim() || state.isSending || state.latestAssistantInFlight || state.disabledReason != null}
      aria-label={state.isSending ? "Asking..." : "Ask"}
      title={state.disabledReason ?? (state.isSending ? "Asking..." : "Ask")}
      className="h-8 w-8 shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
    >
      <PaperPlaneTiltIcon size={14} weight="fill" />
    </Button>
  );
}

const ARTIFACT_SUGGESTIONS = [
  "Summarize the key points of this artifact.",
  "What decisions does this document capture?",
  "Which related artifacts should I read next?",
];

const LIBRARY_SUGGESTIONS = [
  "What does this repository do?",
  "Walk me through the architecture.",
  "How is data modeled across the system?",
];

function compareDraftEntriesByCreatedAt(left: LibraryArtifactDraftEntry, right: LibraryArtifactDraftEntry) {
  return left.draft.createdAt - right.draft.createdAt || left.draft._creationTime - right.draft._creationTime;
}

function compareTimelineEntries(left: LibraryAskTimelineEntry, right: LibraryAskTimelineEntry) {
  if (left.createdAt !== right.createdAt) {
    return left.createdAt - right.createdAt;
  }
  if (left.kind !== right.kind) {
    return left.kind === "message" ? -1 : 1;
  }
  return String(left._id).localeCompare(String(right._id));
}

function timelineSpacingClassName(
  previousEntry: LibraryAskTimelineEntry | undefined,
  entry: LibraryAskTimelineEntry,
): string | undefined {
  if (!previousEntry) return undefined;
  return timelineEntrySender(previousEntry) === timelineEntrySender(entry) ? "mt-5" : "mt-12";
}

function timelineEntrySender(entry: LibraryAskTimelineEntry): "user" | "assistant" {
  if (entry.kind === "draft") return "assistant";
  return entry.message.role === "user" ? "user" : "assistant";
}

/**
 * Empty-state shown when the repository has no artifacts yet. The Ask panel
 * is the single home for the Generate design docs CTA — the Library
 * main canvas only narrates the missing-document state and points users
 * here. Centering the hero + button together keeps the action immediately
 * below the description text, instead of stranded at the bottom of the
 * tall sidebar column.
 */
function NoArtifactsHint({
  className,
  descriptionId,
  onGenerate,
  generateDisabledReason,
}: {
  className?: string;
  descriptionId?: string;
  onGenerate?: () => void;
  generateDisabledReason?: string;
}) {
  return (
    <div
      className={`flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-4 py-6 ${className ?? ""}`.trim()}
    >
      <EmptyStateHero
        title={REPOSITORY_GUIDE_COPY.noArtifactsTitle}
        description={<span id={descriptionId}>{REPOSITORY_GUIDE_COPY.noArtifactsDescription}</span>}
      />
      {onGenerate ? (
        <Button
          type="button"
          variant="default"
          size="default"
          className="gap-2 px-4"
          disabled={generateDisabledReason !== undefined}
          title={generateDisabledReason}
          onClick={onGenerate}
        >
          <SparkleIcon size={14} weight="bold" />
          {REPOSITORY_GUIDE_COPY.generateAction}
        </Button>
      ) : null}
    </div>
  );
}

function getRepositoryCodeDraftLabel(status: { kind: "idle" | "preparing" | "ready" | "expiring_soon" } | undefined) {
  if (status === undefined) {
    return "Repository code status is loading. The draft will verify access before it starts.";
  }
  if (status.kind === "ready" || status.kind === "expiring_soon") {
    return "Repository code is ready. The draft will treat the codebase as the source of truth.";
  }
  if (status.kind === "preparing") {
    return "Repository code access is starting. The draft will continue once it is ready.";
  }
  return "The draft will prepare repository code access first, then use the codebase as the source of truth.";
}
