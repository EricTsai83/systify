import { Children, Fragment, useCallback, useMemo, useState, type AnimationEvent, type ReactNode } from "react";
import { FileTextIcon, PaperPlaneTiltIcon, StopCircleIcon } from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { findInFlightAssistantMessage, useConversationThread } from "@/hooks/use-conversation-thread";
import { useStatsForNerdsPreference } from "@/hooks/use-user-preferences";
import { Conversation, ConversationContent, ConversationScrollButton } from "@/components/ai-elements/conversation";
import { useChatScroll } from "@/components/ai-elements/use-chat-scroll";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputTextarea,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { EmptyChatHint, EmptyNoRepoHint } from "@/components/chat-empty-state";
import { MessageBubble } from "@/components/chat-message";
import { MODE_EXAMPLES } from "@/components/chat-modes";
import { GroundingToggleBar } from "@/components/grounding-toggle-bar";
import { ModeExamples } from "@/components/mode-examples";
import { PromptInputModelPicker } from "@/components/ai-elements/prompt-input-model-picker";
import { PromptInputReasoningPicker } from "@/components/ai-elements/prompt-input-reasoning-picker";
import { SandboxActivityPill } from "@/components/sandbox-activity-pill";
import { Button } from "@/components/ui/button";
import { ButtonStateText } from "@/components/ui/button-state-text";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ActiveMessageStream, ArtifactId, ChatMode, RepositoryId, ThreadId } from "@/lib/types";
import type { ChatComposerViewModel } from "@/components/chat-shell-shared/chat-composer-types";

type ChatPanelProps = {
  selectedThreadId: ThreadId | null;
  messages: Doc<"messages">[] | undefined;
  activeMessageStream: ActiveMessageStream | null | undefined;
  isChatLoading: boolean;
  composer: ChatComposerViewModel;
  /**
   * The thread's persisted mode. Always `"discuss"` for panels rendered
   * by the Discuss page; Library has its own surface. Kept as a prop so
   * future surfaces that reuse the panel (e.g. a hypothetical preview
   * shell) can drive it.
   */
  chatMode: ChatMode;
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
   * Repository attached to the current thread, if any. Used to mount
   * the passive `SandboxActivityPill` in sandbox-tooled modes. Optional
   * so pre-repo and unit-test render paths can omit it.
   */
  attachedRepositoryId?: RepositoryId;
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
  const {
    messages,
    activeMessageStream,
    isLoading: isChatLoading,
    canLoadOlderMessages,
    handleLoadOlderMessages,
  } = useConversationThread({
    threadId: selectedThreadId,
    isShellLoading,
  });

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
  composer,
  chatMode,
  isArtifactPanelOpen = false,
  onToggleArtifactPanel,
  showArtifactToggle = false,
  hasAttachedRepository = true,
  onSelectArtifact,
  attachedRepositoryId,
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

  const inFlightAssistantMessage = useMemo(() => findInFlightAssistantMessage(messages), [messages]);

  const canCancel =
    inFlightAssistantMessage !== null && composer.cancel.canCancel && typeof composer.cancel.onCancel === "function";

  // Centralized gate for "should a Send fire right now?". Used both as the
  // Send button's `disabled` prop and to short-circuit the PromptInput's
  // `onSubmit` so the Enter-key path can't bypass the same checks. Without
  // the shared gate, pressing Enter while the Stop button is rendered (Stop is
  // `type="button"`, so the textarea's submit-disabled probe finds no submit
  // button and lets the submit through) would fire `onSendMessage` mid-flight.
  const isSendBlocked = composer.send.isBlocked || canCancel;
  const sendButtonTitle = composer.send.disabledReason;

  const shouldShowEmptyState = !isChatLoading && !hasMessages;
  const shouldShowSandboxPill = composer.tools.grounding?.groundSandbox === true && attachedRepositoryId !== undefined;

  const sandboxPill =
    shouldShowSandboxPill && attachedRepositoryId ? <SandboxActivityPill repositoryId={attachedRepositoryId} /> : null;

  const composerToolItems: ReactNode[] = [
    showArtifactToggle && onToggleArtifactPanel ? (
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
    ) : null,
    composer.tools.modelPicker ? (
      <PromptInputModelPicker
        value={composer.tools.modelPicker.value}
        onChange={composer.tools.modelPicker.onChange}
        threadLockedProvider={composer.tools.modelPicker.threadLockedProvider}
        capability={composer.tools.modelPicker.capability}
        preferenceScope={composer.tools.modelPicker.preferenceScope}
        disabled={composer.tools.modelPicker.disabled}
        getDisabledReason={composer.tools.modelPicker.getDisabledReason}
        catalogEntries={composer.tools.modelPicker.catalogEntries}
      />
    ) : null,
    composer.tools.reasoningPicker ? (
      <PromptInputReasoningPicker
        value={composer.tools.reasoningPicker.value}
        onChange={composer.tools.reasoningPicker.onChange}
        provider={composer.tools.reasoningPicker.provider}
        modelName={composer.tools.reasoningPicker.modelName}
        preferenceScope={composer.tools.reasoningPicker.preferenceScope}
        disabled={composer.tools.reasoningPicker.disabled}
        disabledReasoningEfforts={composer.tools.reasoningPicker.disabledReasoningEfforts}
        disabledReasoningEffortMessage={composer.tools.reasoningPicker.disabledReasoningEffortMessage}
        catalogEntries={composer.tools.reasoningPicker.catalogEntries}
      />
    ) : null,
    ...Children.toArray(composer.tools.extraControls),
    composer.tools.grounding ? (
      <GroundingToggleBar
        groundLibrary={composer.tools.grounding.groundLibrary}
        groundSandbox={composer.tools.grounding.groundSandbox}
        setGroundLibrary={composer.tools.grounding.setGroundLibrary}
        setGroundSandbox={composer.tools.grounding.setGroundSandbox}
        grounding={composer.tools.grounding.grounding}
        onOpenGenerateSystemDesign={composer.tools.grounding.onOpenGenerateSystemDesign}
        generateDisabledReason={composer.tools.grounding.generateDisabledReason}
      />
    ) : null,
  ].filter((item) => item !== null);

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
        <div className="mx-auto flex w-full min-h-0 max-w-3xl flex-1 animate-soft-enter flex-col gap-3 px-6 py-6">
          {sandboxPill}
          {hasAttachedRepository ? <EmptyChatHint /> : <EmptyNoRepoHint />}
          {/*
           * Example prompts for the active mode. Renders at the bottom
           * of the empty-state column (the centered hint
           * card has `flex-1` and pushes everything below toward the
           * composer), giving the prompts a consistent "just above
           * the input" anchor regardless of viewport height. Clicking
           * a card seeds the composer input but does not auto-submit.
           */}
          <ModeExamples
            mode={chatMode}
            examples={MODE_EXAMPLES[chatMode]}
            onUseExample={(prompt) => composer.input.setValue(prompt)}
            disabled={composer.input.readOnly}
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
            {messages && (
              <div
                className={skipEntrance ? "flex flex-col gap-0" : "flex flex-col gap-0 animate-soft-enter"}
                onAnimationEnd={skipEntrance ? undefined : markCurrentThreadSeen}
              >
                {messages.map((message, index) => {
                  const messageStream =
                    activeMessageStream?.assistantMessageId === message._id ? activeMessageStream : null;
                  const previousMessage = index > 0 ? messages[index - 1] : undefined;
                  return (
                    <div key={message._id} className={messageSpacingClassName(previousMessage, message)}>
                      <MessageBubble
                        message={message}
                        activeMessageStream={messageStream}
                        onSelectArtifact={onSelectArtifact}
                        showStatsForNerds={showStatsForNerds}
                      />
                    </div>
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
         * internal handler, which fires the composer submit callback with
         * the captured form event. Per-message state stays controlled by
         * the composer session so persisted draft behavior remains outside
         * the rendering panel.
         *
         * `readonly-hint` lives OUTSIDE the PromptInput because InputGroup
         * expects only textarea + addons as children; arbitrary `<p>`
         * siblings would break its CSS-only layout selectors.
         */}
        <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-6 py-3">
          <PromptInput
            onSubmit={(_, event) => {
              if (isSendBlocked) return;
              void composer.send.onSubmit(event);
            }}
          >
            <PromptInputTextarea
              name="message"
              value={composer.input.value}
              onChange={(e) => composer.input.setValue(e.target.value)}
              placeholder={composer.input.placeholder}
              className="min-h-20"
              readOnly={composer.input.readOnly}
              aria-describedby={composer.input.readOnly && composer.input.readOnlyHint ? "readonly-hint" : undefined}
            />
            <PromptInputFooter>
              {composer.tools.ready ? (
                <PromptInputTools className="animate-enter-fade">
                  {composerToolItems.map((item, index) => (
                    <Fragment key={index}>
                      {index > 0 ? <span aria-hidden="true" className="h-5 w-px shrink-0 bg-border" /> : null}
                      {item}
                    </Fragment>
                  ))}
                </PromptInputTools>
              ) : (
                <div
                  aria-hidden="true"
                  data-testid="chat-panel-composer-tools-placeholder"
                  className="min-h-8 flex-1"
                />
              )}
              {canCancel && !composer.input.readOnly ? (
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
                  disabled={composer.cancel.isCancelling}
                  aria-label="Stop generating reply"
                  data-testid="chat-panel-stop-button"
                  className="min-w-30"
                  onClick={() => {
                    void composer.cancel.onCancel?.();
                  }}
                >
                  <StopCircleIcon weight="bold" />
                  <ButtonStateText
                    current={composer.cancel.isCancelling ? "Stopping…" : "Stop"}
                    states={["Stop", "Stopping…"]}
                  />
                </Button>
              ) : (
                <SendButtonWithOptionalTooltip disabledReason={sendButtonTitle}>
                  <Button
                    type="submit"
                    variant="default"
                    size="sm"
                    disabled={isSendBlocked}
                    title={sendButtonTitle}
                    data-testid="chat-panel-send-button"
                    className="min-w-30"
                  >
                    <PaperPlaneTiltIcon weight="bold" />
                    <ButtonStateText current={composer.send.buttonState} states={["Send", "Sending…", "Syncing…"]} />
                  </Button>
                </SendButtonWithOptionalTooltip>
              )}
            </PromptInputFooter>
          </PromptInput>
          {composer.input.readOnly && composer.input.readOnlyHint ? (
            <p id="readonly-hint" className="text-xs text-muted-foreground">
              {composer.input.readOnlyHint}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SendButtonWithOptionalTooltip({
  disabledReason,
  children,
}: {
  disabledReason: string | undefined;
  children: ReactNode;
}) {
  if (!disabledReason) {
    return children;
  }

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-not-allowed">{children}</span>
        </TooltipTrigger>
        <TooltipContent side="top">{disabledReason}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function messageSpacingClassName(
  previousMessage: Doc<"messages"> | undefined,
  message: Doc<"messages">,
): string | undefined {
  if (!previousMessage) return undefined;
  return messageSender(previousMessage) === messageSender(message) ? "mt-5" : "mt-12";
}

function messageSender(message: Doc<"messages">): "user" | "assistant" {
  return message.role === "user" ? "user" : "assistant";
}

const SEEN_THREADS_CAP = 64;
