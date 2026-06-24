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
import { GroundingToggleBar, createDiscussGroundingAxes } from "@/components/grounding-toggle-bar";
import { ModeExamples } from "@/components/mode-examples";
import { PromptInputModelPicker } from "@/components/ai-elements/prompt-input-model-picker";
import { PromptInputReasoningPicker } from "@/components/ai-elements/prompt-input-reasoning-picker";
import { SandboxActivityPill } from "@/components/sandbox-activity-pill";
import { Button } from "@/components/ui/button";
import { ButtonStateText } from "@/components/ui/button-state-text";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ActiveMessageStream, ArtifactId, ChatMode, RepositoryId, ThreadId } from "@/lib/types";
import type { ChatComposerViewModel } from "@/components/chat-shell-shared/chat-composer-types";

type ArtifactToggleControl = {
  isOpen: boolean;
  onToggle: () => void;
};

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
  artifactToggle?: ArtifactToggleControl | null;
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
  artifactToggle = null,
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

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {shouldShowEmptyState ? (
        <EmptyChatPanelBody
          chatMode={chatMode}
          hasAttachedRepository={hasAttachedRepository}
          sandboxPill={sandboxPill}
          readOnly={composer.input.readOnly}
          onUseExample={composer.input.setValue}
        />
      ) : (
        <MessageChatPanelBody
          messages={messages}
          activeMessageStream={activeMessageStream}
          conversationScroll={conversationScroll}
          canLoadOlderMessages={canLoadOlderMessages}
          skipEntrance={skipEntrance}
          onEntranceAnimationEnd={markCurrentThreadSeen}
          sandboxPill={sandboxPill}
          onSelectArtifact={onSelectArtifact}
          showStatsForNerds={showStatsForNerds}
        />
      )}

      <ChatComposer
        composer={composer}
        artifactToggle={artifactToggle}
        canCancel={canCancel}
        isSendBlocked={isSendBlocked}
        sendButtonTitle={sendButtonTitle}
      />
    </div>
  );
}

type EmptyChatPanelBodyProps = {
  chatMode: ChatMode;
  hasAttachedRepository: boolean;
  sandboxPill: ReactNode;
  readOnly: boolean;
  onUseExample: (prompt: string) => void;
};

function EmptyChatPanelBody({
  chatMode,
  hasAttachedRepository,
  sandboxPill,
  readOnly,
  onUseExample,
}: EmptyChatPanelBodyProps) {
  return (
    // The empty-state hint is rendered outside ScrollArea on purpose:
    // Radix's internal table wrapper breaks the percentage-height chain
    // needed for vertical centering, and this branch never needs to scroll.
    <div className="mx-auto flex w-full min-h-0 max-w-3xl flex-1 animate-soft-enter flex-col gap-3 px-6 py-6">
      {sandboxPill}
      {hasAttachedRepository ? <EmptyChatHint /> : <EmptyNoRepoHint />}
      <ModeExamples
        mode={chatMode}
        examples={MODE_EXAMPLES[chatMode]}
        onUseExample={onUseExample}
        disabled={readOnly}
      />
    </div>
  );
}

type MessageChatPanelBodyProps = {
  messages: Doc<"messages">[] | undefined;
  activeMessageStream: ActiveMessageStream | null | undefined;
  conversationScroll: ReturnType<typeof useChatScroll>;
  canLoadOlderMessages: boolean;
  skipEntrance: boolean;
  onEntranceAnimationEnd: (event: AnimationEvent<HTMLDivElement>) => void;
  sandboxPill: ReactNode;
  onSelectArtifact: ((artifactId: ArtifactId) => void) | undefined;
  showStatsForNerds: boolean;
};

function MessageChatPanelBody({
  messages,
  activeMessageStream,
  conversationScroll,
  canLoadOlderMessages,
  skipEntrance,
  onEntranceAnimationEnd,
  sandboxPill,
  onSelectArtifact,
  showStatsForNerds,
}: MessageChatPanelBodyProps) {
  return (
    // `Conversation` owns stick-to-bottom, prepend anchor preservation,
    // load-older sentinel wiring, and reduced-motion behavior.
    <Conversation scroll={conversationScroll} className="flex-1 min-h-0">
      <ConversationContent
        className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 pb-6 pt-10"
        showLoadOlderSentinel={canLoadOlderMessages}
      >
        {sandboxPill}
        {messages && (
          <MessageList
            messages={messages}
            activeMessageStream={activeMessageStream}
            skipEntrance={skipEntrance}
            onEntranceAnimationEnd={onEntranceAnimationEnd}
            onSelectArtifact={onSelectArtifact}
            showStatsForNerds={showStatsForNerds}
          />
        )}
      </ConversationContent>
      <ConversationScrollButton />
    </Conversation>
  );
}

type MessageListProps = {
  messages: Doc<"messages">[];
  activeMessageStream: ActiveMessageStream | null | undefined;
  skipEntrance: boolean;
  onEntranceAnimationEnd: (event: AnimationEvent<HTMLDivElement>) => void;
  onSelectArtifact: ((artifactId: ArtifactId) => void) | undefined;
  showStatsForNerds: boolean;
};

function MessageList({
  messages,
  activeMessageStream,
  skipEntrance,
  onEntranceAnimationEnd,
  onSelectArtifact,
  showStatsForNerds,
}: MessageListProps) {
  return (
    <div
      className={skipEntrance ? "flex flex-col gap-0" : "flex flex-col gap-0 animate-soft-enter"}
      onAnimationEnd={skipEntrance ? undefined : onEntranceAnimationEnd}
    >
      {messages.map((message, index) => {
        const messageStream = activeMessageStream?.assistantMessageId === message._id ? activeMessageStream : null;
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
  );
}

type ChatComposerProps = {
  composer: ChatComposerViewModel;
  artifactToggle: ArtifactToggleControl | null;
  canCancel: boolean;
  isSendBlocked: boolean;
  sendButtonTitle: string | undefined;
};

function ChatComposer({ composer, artifactToggle, canCancel, isSendBlocked, sendButtonTitle }: ChatComposerProps) {
  return (
    <div className="border-t border-border bg-background">
      {/*
       * `readonly-hint` lives outside PromptInput because InputGroup expects
       * only textarea + addons as children; arbitrary siblings break its
       * CSS-only layout selectors.
       */}
      <div className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-6 py-3">
        <PromptInput
          onSubmit={(message, event) => {
            if (isSendBlocked) return;
            void composer.send.onSubmit(event, message.text);
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
            <ComposerTools composer={composer} artifactToggle={artifactToggle} />
            <ComposerAction
              composer={composer}
              canCancel={canCancel}
              isSendBlocked={isSendBlocked}
              sendButtonTitle={sendButtonTitle}
            />
          </PromptInputFooter>
        </PromptInput>
        {composer.input.readOnly && composer.input.readOnlyHint ? (
          <p id="readonly-hint" className="text-xs text-muted-foreground">
            {composer.input.readOnlyHint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

function ComposerTools({
  composer,
  artifactToggle,
}: {
  composer: ChatComposerViewModel;
  artifactToggle: ArtifactToggleControl | null;
}) {
  if (!composer.tools.ready) {
    return <div aria-hidden="true" data-testid="chat-panel-composer-tools-placeholder" className="min-h-8 flex-1" />;
  }

  const toolItems = [
    artifactToggle ? <ArtifactPanelToggleButton control={artifactToggle} /> : null,
    composer.tools.modelPicker ? <ComposerModelPicker composer={composer} /> : null,
    composer.tools.reasoningPicker ? <ComposerReasoningPicker composer={composer} /> : null,
    ...Children.toArray(composer.tools.extraControls),
    composer.tools.grounding ? <ComposerGroundingToggles composer={composer} /> : null,
  ].filter((item) => item !== null);

  return (
    <PromptInputTools className="animate-enter-fade">
      {toolItems.map((item, index) => (
        <Fragment key={index}>
          {index > 0 ? <span aria-hidden="true" className="h-5 w-px shrink-0 bg-border" /> : null}
          {item}
        </Fragment>
      ))}
    </PromptInputTools>
  );
}

function ArtifactPanelToggleButton({ control }: { control: ArtifactToggleControl }) {
  return (
    <Button
      type="button"
      variant={control.isOpen ? "secondary" : "ghost"}
      size="sm"
      onClick={control.onToggle}
      aria-label="Toggle artifacts panel"
      aria-pressed={control.isOpen}
      className="h-8 shrink-0 gap-1.5 px-2 text-xs"
    >
      <FileTextIcon size={14} weight="bold" />
      <span className="hidden sm:inline">Artifacts</span>
    </Button>
  );
}

function ComposerModelPicker({ composer }: { composer: ChatComposerViewModel }) {
  const modelPicker = composer.tools.modelPicker;
  if (!modelPicker) return null;

  return (
    <PromptInputModelPicker
      value={modelPicker.value}
      onChange={modelPicker.onChange}
      threadLockedProvider={modelPicker.threadLockedProvider}
      capability={modelPicker.capability}
      preferenceScope={modelPicker.preferenceScope}
      disabled={modelPicker.disabled}
      getDisabledReason={modelPicker.getDisabledReason}
      catalogEntries={modelPicker.catalogEntries}
    />
  );
}

function ComposerReasoningPicker({ composer }: { composer: ChatComposerViewModel }) {
  const reasoningPicker = composer.tools.reasoningPicker;
  if (!reasoningPicker) return null;

  return (
    <PromptInputReasoningPicker
      value={reasoningPicker.value}
      onChange={reasoningPicker.onChange}
      provider={reasoningPicker.provider}
      modelName={reasoningPicker.modelName}
      preferenceScope={reasoningPicker.preferenceScope}
      disabled={reasoningPicker.disabled}
      disabledReasoningEfforts={reasoningPicker.disabledReasoningEfforts}
      disabledReasoningEffortMessage={reasoningPicker.disabledReasoningEffortMessage}
      catalogEntries={reasoningPicker.catalogEntries}
    />
  );
}

function ComposerGroundingToggles({ composer }: { composer: ChatComposerViewModel }) {
  const grounding = composer.tools.grounding;
  if (!grounding) return null;

  return (
    <GroundingToggleBar
      axes={createDiscussGroundingAxes({
        groundLibrary: grounding.groundLibrary,
        groundSandbox: grounding.groundSandbox,
        setGroundLibrary: grounding.setGroundLibrary,
        setGroundSandbox: grounding.setGroundSandbox,
        grounding: grounding.grounding,
      })}
    />
  );
}

function ComposerAction({
  composer,
  canCancel,
  isSendBlocked,
  sendButtonTitle,
}: {
  composer: ChatComposerViewModel;
  canCancel: boolean;
  isSendBlocked: boolean;
  sendButtonTitle: string | undefined;
}) {
  if (canCancel && !composer.input.readOnly) {
    return <StopGenerationButton composer={composer} />;
  }

  return <SendMessageButton composer={composer} disabled={isSendBlocked} disabledReason={sendButtonTitle} />;
}

function StopGenerationButton({ composer }: { composer: ChatComposerViewModel }) {
  return (
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
      <ButtonStateText current={composer.cancel.isCancelling ? "Stopping…" : "Stop"} states={["Stop", "Stopping…"]} />
    </Button>
  );
}

function SendMessageButton({
  composer,
  disabled,
  disabledReason,
}: {
  composer: ChatComposerViewModel;
  disabled: boolean;
  disabledReason: string | undefined;
}) {
  return (
    <SendButtonWithOptionalTooltip disabledReason={disabledReason}>
      <Button
        type="submit"
        variant="default"
        size="sm"
        disabled={disabled}
        title={disabledReason}
        data-testid="chat-panel-send-button"
        className="min-w-30"
      >
        <PaperPlaneTiltIcon weight="bold" />
        <ButtonStateText current={composer.send.buttonState} states={["Send", "Sending…", "Syncing…"]} />
      </Button>
    </SendButtonWithOptionalTooltip>
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
