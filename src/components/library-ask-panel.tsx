import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { BookOpenIcon, PaperPlaneTiltIcon, SparkleIcon } from "@phosphor-icons/react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { CHAT_MESSAGES_PAGE_SIZE } from "../../convex/lib/constants";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { useChatScroll } from "@/components/ai-elements/use-chat-scroll";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import {
  PromptInputModelPicker,
  type PromptInputModelPickerValue,
} from "@/components/ai-elements/prompt-input-model-picker";
import { PromptInputReasoningPicker } from "@/components/ai-elements/prompt-input-reasoning-picker";
import { EmptyStateHero, PromptSuggestionList } from "@/components/chat-empty-state";
import { MessageBubble } from "@/components/chat-message";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { LibraryAskThreadTabs } from "@/components/library-ask-thread-tabs";
import { Button } from "@/components/ui/button";
import { useLibraryAskTabs } from "@/hooks/use-library-ask-tabs";
import { useDefaultModelPick } from "@/hooks/use-default-model-pick";
import { toUserErrorMessage } from "@/lib/errors";
import type { ArtifactId, LlmProvider, ReasoningEffort, RepositoryId, ThreadId } from "@/lib/types";
import { toast } from "sonner";

const LOCKED_PLACEHOLDER = "Generate a System Design to unlock Library Ask.";
const LOCKED_HINT = "Library Ask needs at least one artifact in this repository before you can send a question.";

export function LibraryAskPanel({
  repositoryId,
  threadId,
  activeArtifactId,
  hasArtifacts,
  onSelectArtifact,
  onSelectThread,
  onGenerate,
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
}) {
  const sendMessage = useMutation(api.chat.send.sendMessage);
  const sendMessageStartingNewThread = useMutation(api.chat.send.sendMessageStartingNewThread);
  const deleteThread = useMutation(api.chat.threads.deleteThread);
  const setThreadPinned = useMutation(api.chat.threads.setThreadPinned);

  const threads = useQuery(api.chat.threads.listThreads, { repositoryId, mode: "library" });
  // Dual-purpose: confirms the active thread exists (so the message queries
  // below can be gated and never throw the route into its error boundary)
  // and supplies the tab title when the thread has aged out of `listThreads`.
  const activeThreadProbe = useQuery(api.chat.threads.getThreadSummary, threadId ? { threadId } : "skip");
  // `listMessagesPaginated` / `getActiveMessageStream` THROW for a missing or
  // unauthorized thread. Only subscribe once the probe has confirmed the
  // thread exists; a stale `?ask=` bookmark then degrades to the empty
  // state instead of tearing down the Library route.
  const confirmedThreadId = threadId && activeThreadProbe ? threadId : null;
  const {
    results: paginatedMessages,
    status: messagesStatus,
    loadMore: loadOlderMessages,
  } = usePaginatedQuery(
    api.chat.threads.listMessagesPaginated,
    confirmedThreadId ? { threadId: confirmedThreadId } : "skip",
    { initialNumItems: CHAT_MESSAGES_PAGE_SIZE },
  );
  // Same ordering contract as the Discuss panel: server pages arrive
  // newest-first; flatten + reverse so all downstream consumers see
  // ascending creation-time order.
  const messages = useMemo<Doc<"messages">[] | undefined>(() => {
    if (confirmedThreadId === null) return undefined;
    if (messagesStatus === "LoadingFirstPage") return undefined;
    return [...paginatedMessages].reverse();
  }, [confirmedThreadId, messagesStatus, paginatedMessages]);
  const canLoadOlderMessages = messagesStatus === "CanLoadMore";
  const handleLoadOlderMessages = useCallback(() => {
    loadOlderMessages(CHAT_MESSAGES_PAGE_SIZE);
  }, [loadOlderMessages]);
  const activeMessageStream = useQuery(
    api.chat.streaming.getActiveMessageStream,
    confirmedThreadId ? { threadId: confirmedThreadId } : "skip",
  );

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
  const [isStarting, setIsStarting] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingDeleteThreadId, setPendingDeleteThreadId] = useState<ThreadId | null>(null);
  const [isDeletingThread, setIsDeletingThread] = useState(false);
  // Per-thread composer model pick. Mirrors `repository-shell.tsx`
  // — but the default cascade (thread default → capability default)
  // resolves through `useDefaultModelPick`, so the picker shows the
  // actual Library default on first paint instead of a placeholder.
  const [modelByThread, setModelByThread] = useState<{
    threadId: ThreadId | null;
    provider: LlmProvider | null;
    modelName: string | null;
  }>({ threadId: null, provider: null, modelName: null });
  const [reasoningByThread, setReasoningByThread] = useState<{
    threadId: ThreadId | null;
    effort: ReasoningEffort | null;
  }>({ threadId: null, effort: null });
  const setSelectedModel = useCallback(
    (next: PromptInputModelPickerValue) =>
      setModelByThread({ threadId, provider: next.provider, modelName: next.modelName }),
    [threadId],
  );
  const setSelectedReasoningEffort = useCallback(
    (next: ReasoningEffort) => setReasoningByThread({ threadId, effort: next }),
    [threadId],
  );
  const submissionLockRef = useRef(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

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
  }, [threadId]);

  // Compose the picker default through `useDefaultModelPick` so the
  // trigger label shows the actual Library default on first paint —
  // either the user's previous pick on this thread
  // (`activeThreadProbe.defaultModelName`) or the capability default
  // sourced from `ROLE_MODELS`. The thread-scoped `modelByThread`
  // local state captures the user's explicit pick on top of that.
  const lockedProvider = activeThreadProbe?.lockedProvider ?? null;
  const defaultModelName = activeThreadProbe?.defaultModelName ?? null;
  const defaultModelPick = useDefaultModelPick({
    capability: "library",
    threadLockedProvider: lockedProvider,
    threadDefaultModelName: defaultModelName,
  });
  const userPickedModel = modelByThread.threadId === threadId ? modelByThread : null;
  const selectedProvider = userPickedModel?.provider ?? defaultModelPick?.provider ?? lockedProvider ?? null;
  const selectedModelName = userPickedModel?.modelName ?? defaultModelPick?.modelName ?? defaultModelName ?? null;
  const selectedReasoningEffort = reasoningByThread.threadId === threadId ? reasoningByThread.effort : null;

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

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDeleteThreadId) return;
    const target = pendingDeleteThreadId;
    setIsDeletingThread(true);
    try {
      await deleteThread({ threadId: target });
      setPendingDeleteThreadId(null);
      // Drop it from the open-tab set; if it was the active thread, advance
      // `?ask=` to the neighbour the close suggests.
      const nextActive = closeTab(target);
      if (target === threadId) {
        onSelectThread(nextActive);
      }
    } catch (caught) {
      toast.error(toUserErrorMessage(caught, "Failed to delete thread."));
    } finally {
      setIsDeletingThread(false);
    }
  }, [closeTab, deleteThread, onSelectThread, pendingDeleteThreadId, threadId]);

  const latestAssistantInFlight = useMemo(() => {
    if (!messages) return false;
    const latestAssistant = [...messages].reverse().find((message) => message.role === "assistant");
    return latestAssistant?.status === "pending" || latestAssistant?.status === "streaming";
  }, [messages]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (submissionLockRef.current) return;
    const content = input.trim();
    if (!content || latestAssistantInFlight) return;
    submissionLockRef.current = true;
    setError(null);
    setIsStarting(!threadId);
    setIsSending(true);
    try {
      // Forward the picked pair only when BOTH halves are present.
      // The mutation rejects half-pairs with `incomplete_model_pick`;
      // dropping them here keeps an unmounted / loading picker from
      // firing a doomed send. With both unset the backend falls
      // through to the library capability default.
      const modelArgs =
        selectedProvider && selectedModelName ? { provider: selectedProvider, modelName: selectedModelName } : {};
      const reasoningArgs = selectedReasoningEffort !== null ? { reasoningEffort: selectedReasoningEffort } : {};
      // Create the thread (if needed) and persist the user message BEFORE
      // telling the parent to flip `?ask=`. Switching the active thread no
      // longer remounts this panel (the thread is a query param on the same
      // route), so this is not a remount-safety requirement anymore — but
      // the ordering still matters: flipping `?ask=` re-keys the paginated
      // message query to the new thread, and we want that query to resolve
      // with the freshly persisted user + pending-assistant pair on its
      // first read.
      let targetThreadId = threadId;
      let createdNew = false;
      if (!targetThreadId) {
        const created = await sendMessageStartingNewThread({
          repositoryId,
          content,
          mode: "library",
          artifactContext: activeArtifactId ? [activeArtifactId] : undefined,
          title: "Library Ask",
          ...modelArgs,
          ...reasoningArgs,
        });
        targetThreadId = created.threadId;
        createdNew = true;
      } else {
        await sendMessage({
          threadId: targetThreadId,
          content,
          mode: "library",
          ...modelArgs,
          ...reasoningArgs,
        });
      }
      setInput("");
      if (createdNew) {
        ensureOpen({ id: targetThreadId, title: "Library Ask" });
        onSelectThread(targetThreadId);
      }
    } catch (caught) {
      setError(toUserErrorMessage(caught, "Failed to ask Library."));
    } finally {
      submissionLockRef.current = false;
      setIsSending(false);
      setIsStarting(false);
    }
  };

  const isLocked = !hasArtifacts;

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
        onDeleteThread={setPendingDeleteThreadId}
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
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      ) : isLocked ? (
        <NoArtifactsHint onGenerate={onGenerate} />
      ) : (
        <div className="flex min-h-0 flex-1 animate-in flex-col gap-5 px-4 py-6 fade-in duration-300">
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
                  : "Answers cite retrieved artifact chunks. For live code state, enable Sandbox grounding in Discuss."
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
            placeholder={
              isLocked
                ? LOCKED_PLACEHOLDER
                : activeArtifactId
                  ? "Question about the open artifact..."
                  : "Question about this library..."
            }
            className="min-h-24 text-sm"
            disabled={isSending || latestAssistantInFlight || isLocked}
            aria-describedby={isLocked && threadId ? "library-ask-locked-hint" : undefined}
          />
          <PromptInputFooter>
            <PromptInputTools>
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
                />
              ) : null}
              {!isLocked ? (
                <PromptInputReasoningPicker
                  value={selectedReasoningEffort}
                  onChange={setSelectedReasoningEffort}
                  provider={selectedProvider ?? undefined}
                  modelName={selectedModelName ?? undefined}
                />
              ) : null}
            </PromptInputTools>
            <Button
              type="submit"
              size="sm"
              disabled={!input.trim() || isSending || latestAssistantInFlight || isLocked}
            >
              <PaperPlaneTiltIcon size={14} weight="fill" />
              {isSending || isStarting ? "Asking..." : "Ask"}
            </Button>
          </PromptInputFooter>
        </PromptInput>
      </div>

      <ConfirmDialog
        open={pendingDeleteThreadId !== null}
        onOpenChange={(open) => !open && setPendingDeleteThreadId(null)}
        title="Delete thread"
        description="This will permanently delete this thread and all its messages. This action cannot be undone."
        actionLabel="Delete thread"
        loadingLabel="Deleting…"
        isPending={isDeletingThread}
        onConfirm={() => void handleConfirmDelete()}
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
function NoArtifactsHint({ onGenerate }: { onGenerate?: () => void }) {
  return (
    <div className="flex min-h-0 flex-1 animate-in flex-col items-center justify-center gap-4 px-4 py-6 fade-in duration-300">
      <EmptyStateHero
        visual={
          <div className="flex size-11 items-center justify-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400">
            <SparkleIcon size={20} weight="duotone" />
          </div>
        }
        title="No artifacts to ask about yet"
        description="Library Ask cites indexed artifacts. Generate the System Design starter set so it has something to retrieve."
      />
      {onGenerate ? (
        <Button type="button" size="sm" className="gap-1.5" onClick={onGenerate}>
          <SparkleIcon size={14} weight="bold" />
          Generate System Design
        </Button>
      ) : null}
    </div>
  );
}
