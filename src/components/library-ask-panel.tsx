import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { BookOpenIcon, FilePlusIcon, GitDiffIcon, PaperPlaneTiltIcon, SparkleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery } from "convex/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { useChatScroll } from "@/components/ai-elements/use-chat-scroll";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputTextarea,
  PromptInputTools,
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
import { useLibraryAskTabs } from "@/hooks/use-library-ask-tabs";
import { useComposerModelPick } from "@/hooks/use-composer-model-pick";
import { useChatLifecycle } from "@/hooks/use-chat-lifecycle";
import { useConversationThread } from "@/hooks/use-conversation-thread";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { useDefaultModelPick } from "@/hooks/use-default-model-pick";
import { useModelAccessDisabledReason } from "@/hooks/use-model-access-disabled-reason";
import { toUserErrorMessage } from "@/lib/errors";
import { REPOSITORY_GUIDE_COPY } from "@/lib/product-copy";
import type { ArtifactId, ReasoningEffort, RepositoryId, ThreadId } from "@/lib/types";
import { toast } from "sonner";

const LOCKED_PLACEHOLDER = `${REPOSITORY_GUIDE_COPY.generateAction} to unlock Library Ask.`;
const LOCKED_HINT = "Library Ask needs at least one guide section in this repository before you can send a question.";

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
   * is locked and the empty state surfaces a "Generate System Design"
   * CTA — the same gate the backend's `assertRepositoryModeEligible`
   * enforces with `library_no_artifact`.
   */
  hasArtifacts: boolean;
  onSelectArtifact: (artifactId: ArtifactId) => void;
  /**
   * Set or clear the active Ask thread (`?ask=`). Used for tab clicks, the
   * `+` create flow, history-dialog picks, and advancing the active tab
   * when the current one is closed or deleted.
   */
  onSelectThread: (threadId: ThreadId | null) => void;
  /**
   * Open the Generate System Design dialog. Surfaced in the no-artifacts
   * empty state and inline lock hint so the user can act on the gate
   * without leaving the Ask panel.
   */
  onGenerate?: () => void;
  askDisabledReason?: string;
  generateDisabledReason?: string;
  artifactDraftDisabledReason?: string;
  liveSourceStatus?: { kind: "idle" | "activating" | "ready" | "expiring_soon" };
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
  const recentDrafts = useQuery(
    api.libraryArtifactDrafts.listRecentByRepository,
    confirmedThreadId ? "skip" : { repositoryId },
  );
  const draftEntries: LibraryArtifactDraftEntry[] = threadDrafts ?? recentDrafts ?? [];

  // Owns stick-to-bottom, anchor preservation on prepend, sentinel
  // observer for load-older, threadId-keyed reset, and prefers-
  // reduced-motion gating for the Ask conversation.
  const conversationScroll = useChatScroll({
    threadId: confirmedThreadId,
    messages,
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
  const handleAfterLifecycleArchive = useCallback(() => {}, []);
  const { isSending, handleSendMessage: handleLifecycleSendMessage } = useChatLifecycle({
    selectedThreadId: lifecycleThreadId,
    repositoryId,
    threadToArchive: pendingArchiveThreadId,
    chatInput: input,
    chatMode: "library",
    selectedProvider,
    selectedModelName,
    selectedReasoningEffort,
    newThreadTitle: "Library Ask",
    newThreadArtifactContext,
    clearChatInput: clearInput,
    setActionError: setError,
    setThreadToArchive: setPendingArchiveThreadId,
    onAfterCreateThread: handleAfterCreateThread,
    onAfterArchiveThread: handleAfterLifecycleArchive,
  });

  // "+" no longer eagerly creates a thread — it transitions the panel to a
  // draft state (clears `?ask=`, focuses the composer). The thread is created
  // by `handleSubmit` only when the user sends their first message, so a
  // click that ends without typing leaves nothing in the database.
  const handleCreateThread = useCallback(() => {
    setError(null);
    setInput("");
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

  const isLocked = !hasArtifacts;
  const selectedModelPick =
    selectedProvider && selectedModelName ? { provider: selectedProvider, modelName: selectedModelName } : null;
  const askModelAccessDisabledReason = useModelAccessDisabledReason({
    modelPick: selectedModelPick,
    reasoningEffort: selectedReasoningEffort,
    preferenceScope: "library",
    premiumModelsDisabledReason,
    highReasoningDisabledReason,
  });
  const draftDefaultPick = useDefaultModelPick({ capability: "sandbox", preferenceScope: "sandbox" });
  const draftModelPick = draftUserPick ?? draftDefaultPick ?? null;
  const draftModelAccessDisabledReason = useModelAccessDisabledReason({
    modelPick: draftModelPick,
    reasoningEffort: draftReasoningEffort,
    preferenceScope: "sandbox",
    premiumModelsDisabledReason,
    highReasoningDisabledReason,
  });
  const documentActionDisabledReason = artifactDraftDisabledReason ?? draftModelAccessDisabledReason ?? undefined;
  const composerDisabledReason = askDisabledReason ?? (isLocked ? LOCKED_HINT : askModelAccessDisabledReason);
  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      if (composerDisabledReason != null || latestAssistantInFlight) {
        event.preventDefault();
        return;
      }
      await handleLifecycleSendMessage(event);
    },
    [composerDisabledReason, handleLifecycleSendMessage, latestAssistantInFlight],
  );
  const composerHintId = isLocked && threadId ? "library-ask-locked-hint" : undefined;
  const composerPlaceholder = isLocked
    ? LOCKED_PLACEHOLDER
    : activeArtifactId
      ? "Question about the open artifact..."
      : "Question about this library...";
  const liveSourceLabel = getLiveSourceDraftLabel(liveSourceStatus);
  const openCreateDraft = useCallback(() => {
    setError(null);
    setDraftIntent({
      operation: "create",
      title: "",
      folderId: null,
      prompt: input.trim(),
    });
  }, [input]);
  const openUpdateDraft = useCallback(() => {
    if (!activeArtifactId) return;
    setError(null);
    setDraftIntent({
      operation: "update",
      title: activeArtifact?.title ?? "",
      folderId: null,
      prompt: input.trim(),
    });
  }, [activeArtifact?.title, activeArtifactId, input]);

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
    if (draftIntent.operation === "create" && draftIntent.title.trim().length === 0) {
      setError("Add a title for the new artifact.");
      return;
    }
    if (draftIntent.prompt.trim().length === 0) {
      setError("Describe what to draft.");
      return;
    }
    try {
      await requestDraft({
        repositoryId,
        threadId: confirmedThreadId ?? undefined,
        operation: draftIntent.operation,
        prompt: draftIntent.prompt,
        title: draftIntent.operation === "create" ? draftIntent.title : undefined,
        folderId: draftIntent.operation === "create" ? (draftIntent.folderId ?? undefined) : undefined,
        targetArtifactId: draftIntent.operation === "update" ? (activeArtifactId ?? undefined) : undefined,
        provider: draftModelPick.provider,
        modelName: draftModelPick.modelName,
        ...(draftReasoningEffort !== null ? { reasoningEffort: draftReasoningEffort } : {}),
      });
      setDraftIntent(null);
    } catch (caught) {
      setError(toUserErrorMessage(caught, "Failed to start artifact draft."));
    }
  });

  const draftCards =
    draftEntries.length > 0 ? (
      <div className="space-y-3" data-testid="artifact-draft-list">
        {draftEntries.map((entry) => (
          <LibraryArtifactDraftCard key={entry.draft._id} entry={entry} onApplied={onSelectArtifact} />
        ))}
      </div>
    ) : null;

  return (
    // Plain container, not a landmark: this panel renders inside the app
    // sidebar's <aside>, so its own section is just content within it.
    <div className="flex h-full w-full flex-col bg-background">
      <LibraryAskThreadTabs
        tabs={tabs}
        activeThreadId={threadId}
        onSelectTab={onSelectThread}
        onCloseTab={handleCloseTab}
        onNewThread={handleCreateThread}
        isCreating={false}
        threads={threads}
        onSelectFromHistory={handleSelectFromHistory}
        onTogglePin={handleTogglePin}
        onArchiveThread={setPendingArchiveThreadId}
      />

      {threadId ? (
        <Conversation scroll={conversationScroll} className="min-h-0 flex-1">
          <ConversationContent className="space-y-3 px-4 py-3" showLoadOlderSentinel={canLoadOlderMessages}>
            {(messages ?? []).map((message) => (
              <MessageBubble
                key={message._id}
                message={message}
                activeMessageStream={activeMessageStream ?? null}
                onSelectArtifact={onSelectArtifact}
              />
            ))}
            {draftCards}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      ) : isLocked ? (
        <div className="flex min-h-0 flex-1 animate-in flex-col gap-5 px-4 py-6 fade-in duration-300">
          {draftCards}
          <NoArtifactsHint onGenerate={onGenerate} generateDisabledReason={generateDisabledReason} />
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 animate-in flex-col gap-5 px-4 py-6 fade-in duration-300">
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
                  : "Answers cite retrieved artifact chunks. Artifact drafts use Live source and wait for Apply."
              }
            />
          </div>
          <PromptSuggestionList
            prompts={activeArtifactId ? ARTIFACT_SUGGESTIONS : LIBRARY_SUGGESTIONS}
            onPick={handlePickSuggestion}
            layout="stack"
          />
        </div>
      )}

      {draftIntent ? (
        <div className="border-t border-border bg-muted/20 p-3">
          <LibraryArtifactDraftConfirmCard
            repositoryId={repositoryId}
            intent={draftIntent}
            activeArtifactTitle={activeArtifact?.title}
            disabledReason={documentActionDisabledReason}
            liveSourceLabel={liveSourceLabel}
            modelPick={draftModelPick}
            onModelPickChange={setDraftUserPick}
            reasoningEffort={draftReasoningEffort}
            onReasoningEffortChange={setDraftReasoningEffort}
            premiumModelsDisabledReason={premiumModelsDisabledReason}
            highReasoningDisabledReason={highReasoningDisabledReason}
            onChange={setDraftIntent}
            onCancel={() => setDraftIntent(null)}
            onSubmit={() => void runRequestDraft()}
            isSubmitting={isRequestingDraft}
          />
        </div>
      ) : null}

      {/*
       * Inline lock notice. Surfaces above the composer whenever the
       * artifact gate is closed AND the user is on an existing thread,
       * where the no-thread empty state's CTA isn't reachable (the
       * messages list takes that slot). The no-thread case renders
       * `NoArtifactsHint` instead, which already carries the CTA.
       */}
      {isLocked && threadId ? (
        <div className="flex items-start gap-2 border-t border-border bg-muted/40 px-3 py-2 text-[11px] text-muted-foreground">
          <SparkleIcon size={12} weight="fill" className="mt-0.5 shrink-0 text-amber-500" />
          <p id="library-ask-locked-hint" className="min-w-0 flex-1 leading-4">
            {LOCKED_HINT}
          </p>
          {onGenerate ? (
            <button
              type="button"
              disabled={generateDisabledReason !== undefined}
              title={generateDisabledReason}
              onClick={onGenerate}
              className="shrink-0 font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            >
              Generate
            </button>
          ) : null}
        </div>
      ) : null}

      <div className="border-t border-border p-3">
        {error ? <p className="mb-2 text-xs text-destructive">{error}</p> : null}
        <PromptInput
          onSubmit={(_, event) => {
            void handleSubmit(event);
          }}
        >
          <PromptInputTextarea
            ref={textareaRef}
            name="message"
            value={input}
            onChange={(event) => setInput(event.target.value)}
            placeholder={composerPlaceholder}
            className="min-h-24 text-sm"
            disabled={isSending || latestAssistantInFlight || composerDisabledReason != null}
            aria-describedby={composerHintId}
          />
          <PromptInputFooter>
            <PromptInputTools>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 px-2 text-[11px]"
                onClick={openCreateDraft}
                disabled={documentActionDisabledReason !== undefined}
                title={documentActionDisabledReason}
              >
                <FilePlusIcon size={13} weight="bold" />
                Create artifact
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 px-2 text-[11px]"
                onClick={openUpdateDraft}
                disabled={documentActionDisabledReason !== undefined || activeArtifactId === null}
                title={
                  activeArtifactId === null ? "Open an artifact to draft an update." : documentActionDisabledReason
                }
              >
                <GitDiffIcon size={13} weight="bold" />
                Update open artifact
              </Button>
              {/*
               * Library Ask model picker. Hidden while the composer
               * is locked (no artifacts) — the user can't send
               * anyway, and the picker dropdown would just clutter
               * the locked-state hint. Library Ask intentionally shows
               * every user-pickable chat model before the first send; once
               * the thread is locked to a provider, the picker narrows to
               * that provider so cached thread context stays coherent.
               */}
              {!isLocked ? (
                <PromptInputModelPicker
                  value={
                    selectedProvider && selectedModelName
                      ? { provider: selectedProvider, modelName: selectedModelName }
                      : null
                  }
                  onChange={setSelectedModel}
                  threadLockedProvider={lockedProvider}
                  preferenceScope="library"
                  getDisabledReason={(entry) =>
                    premiumModelsDisabledReason && entry.capability === "sandbox" ? premiumModelsDisabledReason : null
                  }
                />
              ) : null}
              {!isLocked ? (
                <PromptInputReasoningPicker
                  value={selectedReasoningEffort}
                  onChange={setSelectedReasoningEffort}
                  provider={selectedProvider ?? undefined}
                  modelName={selectedModelName ?? undefined}
                  preferenceScope="library"
                  disabledReasoningEfforts={highReasoningDisabledReason ? ["high", "xhigh"] : []}
                  disabledReasoningEffortMessage={highReasoningDisabledReason}
                />
              ) : null}
            </PromptInputTools>
            <Button
              type="submit"
              size="sm"
              disabled={!input.trim() || isSending || latestAssistantInFlight || composerDisabledReason != null}
              title={composerDisabledReason ?? undefined}
            >
              <PaperPlaneTiltIcon size={14} weight="fill" />
              {isSending ? "Asking..." : "Ask"}
            </Button>
          </PromptInputFooter>
        </PromptInput>
      </div>

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

/**
 * Empty-state shown when the repository has no artifacts yet. The Ask panel
 * is the single home for the Generate System Design CTA — the Library
 * main canvas only narrates the missing-document state and points users
 * here. Centering the hero + button together keeps the action immediately
 * below the description text, instead of stranded at the bottom of the
 * tall sidebar column.
 */
function NoArtifactsHint({
  onGenerate,
  generateDisabledReason,
}: {
  onGenerate?: () => void;
  generateDisabledReason?: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 animate-in flex-col items-center justify-center gap-4 px-4 py-6 fade-in duration-300">
      <EmptyStateHero
        visual={
          <div className="flex size-11 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <SparkleIcon size={20} weight="duotone" />
          </div>
        }
        title={REPOSITORY_GUIDE_COPY.noArtifactsTitle}
        description={REPOSITORY_GUIDE_COPY.noArtifactsDescription}
      />
      {onGenerate ? (
        <Button
          type="button"
          size="sm"
          className="gap-1.5"
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

function getLiveSourceDraftLabel(status: { kind: "idle" | "activating" | "ready" | "expiring_soon" } | undefined) {
  if (status === undefined) {
    return "Live source status is loading. Drafting will verify access before generation starts.";
  }
  if (status.kind === "ready" || status.kind === "expiring_soon") {
    return "Live source is active. The draft will still verify the repository before writing a proposal.";
  }
  if (status.kind === "activating") {
    return "Live source is starting. The draft job will continue once it is ready.";
  }
  return "Live source will be prepared before drafting. Nothing changes until you apply the proposal.";
}
