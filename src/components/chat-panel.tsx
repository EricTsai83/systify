import { useCallback, useMemo, useState, type AnimationEvent, type FormEvent } from "react";
import { FileTextIcon, PaperPlaneTiltIcon, StopCircleIcon } from "@phosphor-icons/react";
import { useMutation, usePaginatedQuery, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { CHAT_MESSAGES_PAGE_SIZE } from "../../convex/lib/constants";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { useStatsForNerdsPreference } from "@/hooks/use-user-preferences";
import { toUserErrorMessage } from "@/lib/errors";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { useChatScroll } from "@/components/ai-elements/use-chat-scroll";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { AppNotice } from "@/components/app-notice";
import { EmptyChatHint, EmptyNoRepoHint } from "@/components/chat-empty-state";
import { MessageBubble } from "@/components/chat-message";
import { MODE_EXAMPLES } from "@/components/chat-modes";
import { GroundingToggleBar, type GroundingAxisLike } from "@/components/grounding-toggle-bar";
import { ModeExamples } from "@/components/mode-examples";
import {
  PromptInputModelPicker,
  type PromptInputModelPickerValue,
} from "@/components/ai-elements/prompt-input-model-picker";
import { PromptInputReasoningPicker } from "@/components/ai-elements/prompt-input-reasoning-picker";
import { SandboxActivityPill } from "@/components/sandbox-activity-pill";
import { Button } from "@/components/ui/button";
import type {
  ActiveMessageStream,
  ArtifactId,
  ChatMode,
  LlmProvider,
  ReasoningEffort,
  RepositoryId,
  SandboxModeStatus,
  ThreadId,
} from "@/lib/types";

type ChatPanelProps = {
  selectedThreadId: ThreadId | null;
  messages: Doc<"messages">[] | undefined;
  activeMessageStream: ActiveMessageStream | null | undefined;
  isChatLoading: boolean;
  chatInput: string;
  setChatInput: (v: string) => void;
  /**
   * The thread's persisted mode. Always `"discuss"` for panels rendered
   * by the Discuss page; Library has its own surface. Kept as a prop so
   * future surfaces that reuse the panel (e.g. a hypothetical preview
   * shell) can drive it.
   */
  chatMode: ChatMode;
  /**
   * Per-message grounding toggle state. The Discuss composer mirrors
   * these into the send-mutation args so the assistant reply observes
   * the same flags the user saw at click time.
   */
  groundLibrary: boolean;
  groundSandbox: boolean;
  setGroundLibrary: (v: boolean) => void;
  setGroundSandbox: (v: boolean) => void;
  /**
   * Composer model picker state. `selectedProvider` + `selectedModelName`
   * are the current pair the picker is rendering; `setSelectedModel`
   * fires when the user picks a new entry. The shell owns the actual
   * state (so it can pre-fill from `thread.defaultModelName` on thread
   * switches) and passes it through.
   *
   * `threadLockedProvider` mirrors `threads.lockedProvider` from the
   * thread-context query. When set, the picker hides the other provider's
   * group and renders the lock pill.
   *
   * All four are optional so unit-test renders / headless callers can
   * mount `ChatPanel` without threading picker state through. The
   * picker is hidden when `setSelectedModel` is omitted — that's the
   * single signal "this caller does not own picker state".
   */
  selectedProvider?: LlmProvider | null;
  selectedModelName?: string | null;
  setSelectedModel?: (next: PromptInputModelPickerValue) => void;
  /**
   * Per-message reasoning-effort override. The picker shows only when
   * the selected model's catalog entry supports reasoning. `null`
   * means "fall back to catalog default" — the gateway threads that
   * cascade for us.
   *
   * As with the model picker, the shell owns the state; the picker
   * resets between sends unless the shell chooses to remember it.
   */
  selectedReasoningEffort?: ReasoningEffort | null;
  setSelectedReasoningEffort?: (next: ReasoningEffort) => void;
  threadLockedProvider?: LlmProvider | null;
  /**
   * Per-axis availability verdict from `repositoryModeEligibility.evaluate`.
   * Mirrors the structured shape the eligibility module exposes, but typed
   * loosely here so the panel can render the toggle bar before the type
   * narrows on first paint.
   */
  grounding:
    | {
        library: GroundingAxisLike;
        sandbox: GroundingAxisLike;
      }
    | null
    | undefined;
  /**
   * Whether to show Discuss grounding controls. Repoless `/chat` routes are
   * Discuss-only but have no repository context, so Library/Sandbox controls
   * would be permanently unusable there.
   */
  showGroundingToggles?: boolean;
  /** Fires when the user clicks the Library "Generate System Design" CTA. */
  onOpenGenerateSystemDesign?: () => void;
  isSending: boolean;
  onSendMessage: (e: FormEvent<HTMLFormElement>) => Promise<void>;
  /**
   * Fires when the user clicks Stop on the in-flight reply. The
   * shell wires this to the `chat.cancel.cancelInFlightReply` mutation. The
   * panel only renders the Stop affordance when this prop is supplied *and*
   * the latest assistant message is still in a non-terminal state, so
   * tests / headless renders that don't need cancellation can simply omit
   * the prop and continue to see the Send button.
   */
  onCancelInFlightReply?: () => void | Promise<void>;
  /**
   * True between user click and the assistant message transitioning out
   * of `streaming` / `pending`. While true the button
   * label switches to "Stopping…" so the user sees an acknowledgement that
   * the request is in flight even before the bubble flips to "Cancelled".
   * Defaults to `false` so existing call sites don't have to thread this
   * through immediately.
   */
  isCancellingReply?: boolean;
  sandboxModeStatus: SandboxModeStatus | null;
  isSyncing: boolean;
  onSync: () => void;
  isArtifactPanelOpen?: boolean;
  onToggleArtifactPanel?: () => void;
  showArtifactToggle?: boolean;
  /** Whether the current thread has an attached repository. */
  hasAttachedRepository?: boolean;
  /**
   * Clicking an inline `[A#]` citation in an assistant reply forwards
   * the resolved artifact id to this callback. The shell uses it to open
   * the artifact panel and scroll/highlight the matching artifact card.
   * Optional so unit tests and headless renders can omit it.
   */
  onSelectArtifact?: (artifactId: ArtifactId) => void;
  /**
   * When true, the chat input and Send/Stop buttons are disabled and a
   * read-only hint is shown below the composer. Used by the archived-
   * repository banner so historical messages stay browsable but no new
   * messages can be sent until the repo is restored.
   */
  isReadOnly?: boolean;
  /** Optional copy shown below the disabled composer when `isReadOnly` is true. */
  readOnlyHint?: string;
  /**
   * Repository attached to the current thread, if any. Used to mount
   * the `SandboxActivityPill` in sandbox-tooled modes so the user can
   * explicitly activate the live source before sending. Optional so
   * pre-repo and unit-test render paths can omit it.
   */
  attachedRepositoryId?: RepositoryId;
  /**
   * Repository the composer is rendered inside, when no thread is
   * selected. Acts as the anchor for the lazy
   * `sendMessageStartingNewThread` path — when supplied the Send button
   * stays enabled on a no-thread URL so the first send can create the
   * thread atomically. Optional so callers without a repository context
   * can omit it.
   */
  repositoryId?: RepositoryId | null;
  /**
   * Whether the paginated message subscription has more history to
   * fetch (`status === "CanLoadMore"`). The conversation mounts a top
   * sentinel only while true so an Exhausted thread pays no observer
   * cost. Defaults to `false` for headless callers / tests that aren't
   * exercising load-older.
   */
  canLoadOlderMessages?: boolean;
  /**
   * Fires when the conversation's top sentinel intersects. Wired to the
   * paginated query's `loadMore`. Defaults to a no-op so call sites
   * that don't drive pagination (tests, demos) compile without
   * threading the callback through.
   */
  onLoadOlderMessages?: () => void;
};

type ChatContainerProps = Omit<ChatPanelProps, "messages" | "activeMessageStream" | "isChatLoading"> & {
  isShellLoading: boolean;
};

export function ChatContainer({ selectedThreadId, isShellLoading, ...panelProps }: ChatContainerProps) {
  // `usePaginatedQuery`'s `results` is the concatenation of every fetched
  // page in arrival order — that is, newest page first, then progressively
  // older pages as the user scrolls up. Reversing the flat array yields
  // ascending creation-time order without paying per-page reversal cost.
  const {
    results: paginatedResults,
    status: paginationStatus,
    loadMore,
  } = usePaginatedQuery(
    api.chat.threads.listMessagesPaginated,
    selectedThreadId ? { threadId: selectedThreadId } : "skip",
    { initialNumItems: CHAT_MESSAGES_PAGE_SIZE },
  );
  const messages = useMemo(() => {
    if (selectedThreadId === null) {
      return undefined;
    }
    if (paginationStatus === "LoadingFirstPage") {
      return undefined;
    }
    // `paginatedResults` from convex is plain Doc<"messages"> rows in the
    // server's paginate order (newest first). Reverse once so all
    // downstream consumers (rendering, `inFlightAssistantMessage`,
    // `hasMessages`) see ascending-by-creation-time order — the same
    // shape the prior, unpaginated query exposed.
    return [...paginatedResults].reverse();
  }, [paginatedResults, paginationStatus, selectedThreadId]);
  const activeMessageStream = useQuery(
    api.chat.streaming.getActiveMessageStream,
    selectedThreadId ? { threadId: selectedThreadId } : "skip",
  );

  const isChatLoading = isShellLoading || (selectedThreadId !== null && messages === undefined);

  const canLoadOlderMessages = paginationStatus === "CanLoadMore";
  const handleLoadOlderMessages = useCallback(() => {
    loadMore(CHAT_MESSAGES_PAGE_SIZE);
  }, [loadMore]);

  return (
    <ChatPanel
      {...panelProps}
      selectedThreadId={selectedThreadId}
      messages={messages}
      activeMessageStream={activeMessageStream}
      isChatLoading={isChatLoading}
      canLoadOlderMessages={canLoadOlderMessages}
      onLoadOlderMessages={handleLoadOlderMessages}
    />
  );
}

const NOOP_LOAD_OLDER = () => {};

export function ChatPanel({
  selectedThreadId,
  messages,
  activeMessageStream,
  isChatLoading,
  chatInput,
  setChatInput,
  chatMode,
  groundLibrary,
  groundSandbox,
  setGroundLibrary,
  setGroundSandbox,
  selectedProvider = null,
  selectedModelName = null,
  setSelectedModel,
  selectedReasoningEffort = null,
  setSelectedReasoningEffort,
  threadLockedProvider = null,
  grounding,
  showGroundingToggles = chatMode === "discuss",
  onOpenGenerateSystemDesign,
  isSending,
  onSendMessage,
  onCancelInFlightReply,
  isCancellingReply = false,
  sandboxModeStatus,
  isSyncing,
  onSync,
  isArtifactPanelOpen = false,
  onToggleArtifactPanel,
  showArtifactToggle = false,
  hasAttachedRepository = true,
  onSelectArtifact,
  isReadOnly = false,
  readOnlyHint,
  attachedRepositoryId,
  repositoryId,
  canLoadOlderMessages = false,
  onLoadOlderMessages = NOOP_LOAD_OLDER,
}: ChatPanelProps) {
  const hasMessages = (messages?.length ?? 0) > 0;
  const [showStatsForNerds] = useStatsForNerdsPreference();

  // Owns stick-to-bottom on append, anchor preservation on prepend,
  // sentinel observer for load-older, threadId-keyed reset, and
  // prefers-reduced-motion gating. `didPrependRef` is read at render
  // time below to short-circuit the entrance animation once an older
  // page has been prepended into the current thread.
  const conversationScroll = useChatScroll({
    threadId: selectedThreadId,
    messages,
    streamingSignal: activeMessageStream?.content ?? null,
    canLoadOlder: canLoadOlderMessages,
    onLoadOlder: onLoadOlderMessages,
  });

  const [seenThreads, setSeenThreads] = useState(() => new Set<ThreadId>());
  // Skip the entrance animation once either (a) the user has already
  // seen this thread's entrance animation play to completion, or (b)
  // an older page has been prepended on this thread — animating the
  // wrapper after backfilled history would render a slide-in over
  // messages that are mid-restore. `didPrepend` is state inside the
  // hook so the prepend-driven re-render carries the updated flag.
  const skipEntrance =
    selectedThreadId !== null && (seenThreads.has(selectedThreadId) || conversationScroll.didPrepend);
  const markCurrentThreadSeen = useCallback(
    (event: AnimationEvent<HTMLDivElement>) => {
      // Filter out bubbled animationend events from children (e.g. streaming
      // message bubbles) so we only mark the thread as seen when the entrance
      // animation on this container itself completes.
      if (event.target !== event.currentTarget) return;
      if (!selectedThreadId) return;
      setSeenThreads((prev) => {
        if (prev.has(selectedThreadId)) return prev;
        // Set#values preserves insertion order, so dropping the first
        // entry is the oldest seen-thread. Cap the working set so a
        // long-running tab that visits hundreds of threads doesn't
        // accumulate the id list indefinitely.
        const next = new Set(prev);
        next.add(selectedThreadId);
        if (next.size > SEEN_THREADS_CAP) {
          const oldest = next.values().next().value;
          if (oldest !== undefined) next.delete(oldest);
        }
        return next;
      });
    },
    [selectedThreadId],
  );

  const sandboxModeAvailable = sandboxModeStatus?.reasonCode === "available";

  // Lazy-provision entry point. Wired here (not in `SandboxActivityPill`)
  // so the GroundingToggleBar can fire activation directly when the user
  // clicks the otherwise-disabled Sandbox toggle in its activatable
  // sub-state — the pill is only mounted once `groundSandbox === true`,
  // so it can't be the sole trigger. `requestSandboxActivation` is
  // idempotent (returns the in-flight job if one exists) so a duplicate
  // click during activation is safe.
  const requestSandboxActivation = useMutation(api.repositories.requestSandboxActivation);
  const [activationError, setActivationError] = useState<string | null>(null);
  const [, activateSandbox] = useAsyncCallback(async () => {
    const repoId = attachedRepositoryId ?? repositoryId;
    if (!repoId) return;
    setActivationError(null);
    try {
      await requestSandboxActivation({ repositoryId: repoId });
    } catch (err) {
      setActivationError(toUserErrorMessage(err, "Couldn't start the sandbox. Try again."));
    }
  });

  /**
   * Derive "is the most recent assistant reply still in flight?"
   * from the (already-subscribed) message list rather than threading another
   * boolean prop down. We check the *last* assistant message so a brand-new
   * thread (no messages) shows Send and a thread whose last reply finished
   * shows Send too; only the in-flight assistant flips the button to Stop.
   *
   * Why we accept `pending` as well as `streaming`: there is a brief window
   * after `sendMessage` schedules the action but before
   * `markAssistantReplyRunning` fires where the assistant message status is
   * still `pending`. Cancelling in that window is valid — the action will
   * see `wasCancelled` on its first poll and skip straight to the
   * cancel finalize variant — and showing Send during that window would be
   * a UX hole the user could click into another send mid-pending.
   */
  const inFlightAssistantMessage = useMemo(() => {
    if (!messages) {
      return null;
    }
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role === "assistant") {
        return message.status === "streaming" || message.status === "pending" ? message : null;
      }
    }
    return null;
  }, [messages]);

  const canCancel = inFlightAssistantMessage !== null && typeof onCancelInFlightReply === "function";

  // Centralized gate for "should a Send fire right now?". Used both as the
  // Send button's `disabled` prop and to short-circuit the PromptInput's
  // `onSubmit` so the Enter-key path can't bypass the same checks. Without
  // the shared gate, pressing Enter while the Stop button is rendered (Stop is
  // `type="button"`, so the textarea's submit-disabled probe finds no submit
  // button and lets the submit through) would fire `onSendMessage` mid-flight.
  // The `groundSandbox && !sandboxModeAvailable` clause is here because
  // sandbox grounding needs a ready live source; sending before lifecycle is
  // `available` would let an optimistically-flipped toggle round-trip into a
  // backend reject.
  const isSendBlocked =
    isReadOnly || isSending || isSyncing || !chatInput.trim() || (groundSandbox && !sandboxModeAvailable) || canCancel;

  const shouldShowSandboxWarning =
    !isChatLoading && groundSandbox && sandboxModeStatus !== null && !sandboxModeAvailable;
  const shouldShowEmptyState = !isChatLoading && !hasMessages;
  const shouldShowSandboxPill = groundSandbox && attachedRepositoryId !== undefined;

  // Hoisted so the empty-state branch (no ScrollArea) and the messages
  // branch (inside ScrollArea) can both render the warning above their
  // content without duplicating the AppNotice props.
  const sandboxWarning = shouldShowSandboxWarning ? (
    <AppNotice
      title={getSandboxStatusTitle(sandboxModeStatus.reasonCode)}
      message={
        sandboxModeStatus.message ??
        "Live source access is unavailable right now. Sync the repository to prepare a fresh session, or turn off Sandbox grounding."
      }
      tone="warning"
      actionLabel={isSyncing ? "Syncing…" : "Sync now"}
      actionDisabled={isSyncing}
      onAction={onSync}
    />
  ) : null;
  const sandboxPill =
    shouldShowSandboxPill && attachedRepositoryId ? <SandboxActivityPill repositoryId={attachedRepositoryId} /> : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {shouldShowEmptyState ? (
        // The empty-state hint is rendered *outside* ScrollArea on purpose.
        // Radix's ScrollArea.Viewport wraps its children in an internal
        // `display: table` element, which silently breaks the percentage-
        // height / `flex-1` chain — so `min-h-full` here and `flex-1` on
        // the hint's own wrapper both collapse, parking the hint near the
        // top instead of the vertical middle of the chat column. The
        // empty state never needs to scroll, so dropping ScrollArea for
        // this branch is the cleanest fix and lets `flex-1` actually
        // reach the centered Card.
        <div className="mx-auto flex w-full min-h-0 max-w-3xl flex-1 flex-col gap-3 px-6 py-6">
          {sandboxPill}
          {sandboxWarning}
          {hasAttachedRepository ? <EmptyChatHint /> : <EmptyNoRepoHint />}
          {/*
           * Example prompts for the active mode. Renders at the bottom
           * of the empty-state column (the centered hint
           * card has `flex-1` and pushes everything below toward the
           * composer), giving the prompts a consistent "just above
           * the input" anchor regardless of viewport height. Clicking
           * a card seeds `chatInput` but does not auto-submit.
           */}
          <ModeExamples
            mode={chatMode}
            examples={MODE_EXAMPLES[chatMode]}
            onUseExample={(prompt) => setChatInput(prompt)}
            disabled={isReadOnly}
          />
        </div>
      ) : (
        // `Conversation` (ai-elements) owns a custom scroll controller
        // (`useChatScroll`) that handles stick-to-bottom on append,
        // anchor preservation on prepend, the load-older top sentinel,
        // and prefers-reduced-motion. The hook is invoked above so the
        // chat panel can read `didPrependRef` synchronously alongside
        // its entrance-animation decision. We override
        // `ConversationContent`'s default gap-8 / p-4 because the chat
        // column owns its own max-w-3xl gutter.
        <Conversation scroll={conversationScroll} className="flex-1 min-h-0">
          <ConversationContent
            className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 pb-6 pt-10"
            showLoadOlderSentinel={canLoadOlderMessages}
          >
            {sandboxPill}
            {sandboxWarning}
            {messages && (
              <div
                className={
                  skipEntrance
                    ? "flex flex-col gap-3"
                    : "flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300 ease-out"
                }
                onAnimationEnd={skipEntrance ? undefined : markCurrentThreadSeen}
              >
                {messages.map((message) => {
                  const messageStream =
                    activeMessageStream?.assistantMessageId === message._id ? activeMessageStream : null;
                  return (
                    <MessageBubble
                      key={message._id}
                      message={message}
                      activeMessageStream={messageStream}
                      onSelectArtifact={onSelectArtifact}
                      showStatsForNerds={showStatsForNerds}
                    />
                  );
                })}
              </div>
            )}
          </ConversationContent>
          <ConversationScrollButton />
        </Conversation>
      )}

      <div className="border-t border-border bg-background">
        {/*
         * `PromptInput` (ai-elements) wraps the form in an `InputGroup`
         * primitive that aligns the textarea + toolbar / submit as a
         * single bordered control. Submitting routes through PromptInput's
         * internal handler, which fires our `onSendMessage` with the
         * captured form event. Per-message state (`chatInput`) stays
         * controlled here so the parent's already-persisted draft logic
         * (mode switches, thread switches) is untouched.
         *
         * `readonly-hint` and `activationError` live OUTSIDE the
         * PromptInput because InputGroup expects only textarea + addons
         * as children; arbitrary `<p>` siblings would break its CSS-only
         * layout selectors.
         */}
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-6 py-3">
          <PromptInput
            onSubmit={(_, event) => {
              if (isSendBlocked) return;
              void onSendMessage(event);
            }}
          >
            <PromptInputTextarea
              name="message"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder={
                isReadOnly
                  ? (readOnlyHint ?? "This thread is read-only.")
                  : "Ask about architecture, module boundaries, data flow, risks…"
              }
              className="min-h-20"
              readOnly={isReadOnly}
              aria-describedby={isReadOnly && readOnlyHint ? "readonly-hint" : undefined}
            />
            <PromptInputFooter>
              <PromptInputTools>
                {showArtifactToggle && onToggleArtifactPanel ? (
                  <Button
                    type="button"
                    variant={isArtifactPanelOpen ? "secondary" : "ghost"}
                    size="sm"
                    onClick={onToggleArtifactPanel}
                    aria-label="Toggle artifacts panel"
                    aria-pressed={isArtifactPanelOpen}
                    className="h-8 shrink-0 gap-1.5 px-2 text-xs"
                  >
                    <FileTextIcon size={14} weight="bold" />
                    <span className="hidden sm:inline">Artifacts</span>
                  </Button>
                ) : null}
                {/*
                 * Model picker. Mounted left of the grounding toggles
                 * so the heaviest UX decision (which LLM provider) sits
                 * before the lighter toggles. Hidden in read-only
                 * surfaces (archived repository) because the user
                 * cannot send a message anyway. Also hidden when the
                 * caller did not wire `setSelectedModel` — that's the
                 * signal a unit-test / headless render is using
                 * `ChatPanel` without picker state.
                 */}
                {!isReadOnly && setSelectedModel ? (
                  <PromptInputModelPicker
                    value={
                      selectedProvider && selectedModelName
                        ? { provider: selectedProvider, modelName: selectedModelName }
                        : null
                    }
                    onChange={setSelectedModel}
                    threadLockedProvider={threadLockedProvider}
                  />
                ) : null}
                {!isReadOnly && setSelectedReasoningEffort ? (
                  <PromptInputReasoningPicker
                    value={selectedReasoningEffort}
                    onChange={setSelectedReasoningEffort}
                    provider={selectedProvider ?? undefined}
                    modelName={selectedModelName ?? undefined}
                  />
                ) : null}
                {showGroundingToggles && chatMode === "discuss" ? (
                  <GroundingToggleBar
                    groundLibrary={groundLibrary}
                    groundSandbox={groundSandbox}
                    setGroundLibrary={setGroundLibrary}
                    setGroundSandbox={setGroundSandbox}
                    grounding={grounding}
                    onActivateSandbox={() => void activateSandbox()}
                    onOpenGenerateSystemDesign={onOpenGenerateSystemDesign}
                  />
                ) : null}
              </PromptInputTools>
              {canCancel && !isReadOnly ? (
                /*
                 * Stop button. `type="button"` so a stray Enter in
                 * the textarea cannot accidentally submit a Stop click as if
                 * it were Send. `aria-label` plus the visible "Stop" /
                 * "Stopping…" label keep the affordance accessible to screen
                 * readers throughout the cancellation cycle.
                 *
                 * Disabled during the "Stopping…" interval to prevent
                 * double-cancels: the mutation is idempotent on the server,
                 * but stacking clicks would still fire redundant requests.
                 *
                 * Shares the `min-w-30` floor with the Send button so
                 * the composer's right edge doesn't snap horizontally when
                 * the streaming → cancelled transition swaps which button is
                 * mounted.
                 */
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={isCancellingReply}
                  aria-label="Stop generating reply"
                  data-testid="chat-panel-stop-button"
                  className="min-w-30"
                  onClick={() => {
                    void onCancelInFlightReply?.();
                  }}
                >
                  <StopCircleIcon weight="bold" />
                  <span className="grid">
                    <span aria-hidden="true" className="invisible col-start-1 row-start-1">
                      Stopping…
                    </span>
                    <span className="col-start-1 row-start-1">{isCancellingReply ? "Stopping…" : "Stop"}</span>
                  </span>
                </Button>
              ) : (
                <Button
                  type="submit"
                  variant="default"
                  size="sm"
                  disabled={isSendBlocked}
                  data-testid="chat-panel-send-button"
                  className="min-w-30"
                >
                  <PaperPlaneTiltIcon weight="bold" />
                  {/*
                   * Grid-stack the label so the button width is always sized to
                   * the longest possible state ("Sending…" / "Syncing…") and
                   * doesn't reflow when toggling between idle/sending/syncing.
                   * The invisible sizer reserves the max width; the visible
                   * span is overlaid in the same grid cell.
                   *
                   * The button's minimum width matches the Stop button so the
                   * streaming → idle swap is width-stable too.
                   */}
                  <span className="grid">
                    <span aria-hidden="true" className="invisible col-start-1 row-start-1">
                      Sending…
                    </span>
                    <span aria-hidden="true" className="invisible col-start-1 row-start-1">
                      Syncing…
                    </span>
                    <span className="col-start-1 row-start-1">
                      {isSyncing ? "Syncing…" : isSending ? "Sending…" : "Send"}
                    </span>
                  </span>
                </Button>
              )}
            </PromptInputFooter>
          </PromptInput>
          {isReadOnly && readOnlyHint ? (
            <p id="readonly-hint" className="text-xs text-muted-foreground">
              {readOnlyHint}
            </p>
          ) : null}
          {activationError ? (
            <p className="text-[11px] text-destructive" role="alert" data-testid="sandbox-activation-error">
              {activationError}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

const SEEN_THREADS_CAP = 64;

function getSandboxStatusTitle(reasonCode: SandboxModeStatus["reasonCode"] | undefined) {
  switch (reasonCode) {
    case "sandbox_provisioning":
      return "Live source still starting";
    case "missing_sandbox":
      return "Live source not ready yet";
    case "sandbox_unavailable":
      return "Live source no longer available";
    case "sandbox_expired":
      return "Live source expired";
    default:
      // Future reason codes land here until the switch is extended. Render
      // the generic copy so the banner stays accurate rather than silently
      // mislabelling a new code as "expired".
      return "Live source unavailable";
  }
}
