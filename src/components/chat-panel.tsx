import {
  Children,
  Fragment,
  useCallback,
  useMemo,
  useRef,
  useState,
  type AnimationEvent,
  type RefObject,
  type ReactNode,
} from "react";
import { PaperPlaneTiltIcon, StopCircleIcon } from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { findInFlightAssistantMessage, useConversationThread } from "@/hooks/use-conversation-thread";
import { useStatsForNerdsPreference } from "@/hooks/use-user-preferences";
import {
  Conversation,
  ConversationContent,
  ConversationItem,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { useChatScroll } from "@/components/ai-elements/use-chat-scroll";
import {
  PromptInputComposerFrame,
  PromptInputFooter,
  PromptInputTextarea,
  PromptInputToolSeparator,
  PromptInputTools,
} from "@/components/ai-elements/prompt-input";
import { EmptyChatHint, EmptyNoRepoHint } from "@/components/chat-empty-state";
import { MessageBubble } from "@/components/chat-message";
import { MODE_EXAMPLES } from "@/components/chat-modes";
import { GroundingToggleBar, createDiscussGroundingAxes } from "@/components/grounding-toggle-bar";
import { CompactModelSettingsMenu } from "@/components/compact-model-settings-menu";
import { ModeExamples } from "@/components/mode-examples";
import { PromptInputModelPicker } from "@/components/ai-elements/prompt-input-model-picker";
import { PromptInputReasoningPicker } from "@/components/ai-elements/prompt-input-reasoning-picker";
import { SandboxActivityPill } from "@/components/sandbox-activity-pill";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ActiveMessageStream, ArtifactId, ChatMode, RepositoryId, RepositorySource, ThreadId } from "@/lib/types";
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
  /** Whether the current thread has an attached repository. */
  hasAttachedRepository?: boolean;
  /**
   * Clicking an inline `[A#]` citation in an assistant reply forwards
   * the resolved artifact id to this callback. The shell uses it to open
   * the Library Reader for that artifact.
   * Optional so unit tests and headless renders can omit it.
   */
  onSelectArtifact?: (artifactId: ArtifactId) => void;
  repositorySource?: RepositorySource;
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
  hasAttachedRepository = true,
  onSelectArtifact,
  repositorySource,
  attachedRepositoryId,
  canLoadOlderMessages = false,
  onLoadOlderMessages = NOOP_LOAD_OLDER,
}: ChatPanelProps) {
  const hasMessages = (messages?.length ?? 0) > 0;
  const [showStatsForNerds] = useStatsForNerdsPreference();
  const composerInputRef = useRef<HTMLTextAreaElement>(null);

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

  const handleUseExample = useCallback(
    (prompt: string) => {
      composer.input.setValue(prompt);
      composerInputRef.current?.focus({ preventScroll: true });
    },
    [composer.input],
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      {shouldShowEmptyState ? (
        <EmptyChatPanelBody
          chatMode={chatMode}
          hasAttachedRepository={hasAttachedRepository}
          sandboxPill={sandboxPill}
          readOnly={composer.input.readOnly}
          onUseExample={handleUseExample}
        />
      ) : (
        <MessageChatPanelBody
          selectedThreadId={selectedThreadId}
          messages={messages}
          activeMessageStream={activeMessageStream}
          conversationScroll={conversationScroll}
          canLoadOlderMessages={canLoadOlderMessages}
          skipEntrance={skipEntrance}
          onEntranceAnimationEnd={markCurrentThreadSeen}
          sandboxPill={sandboxPill}
          onSelectArtifact={onSelectArtifact}
          repositorySource={repositorySource}
          showStatsForNerds={showStatsForNerds}
        />
      )}

      <ChatComposer
        composer={composer}
        inputRef={composerInputRef}
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
  selectedThreadId: ThreadId | null;
  messages: Doc<"messages">[] | undefined;
  activeMessageStream: ActiveMessageStream | null | undefined;
  conversationScroll: ReturnType<typeof useChatScroll>;
  canLoadOlderMessages: boolean;
  skipEntrance: boolean;
  onEntranceAnimationEnd: (event: AnimationEvent<HTMLDivElement>) => void;
  sandboxPill: ReactNode;
  onSelectArtifact: ((artifactId: ArtifactId) => void) | undefined;
  repositorySource: RepositorySource | undefined;
  showStatsForNerds: boolean;
};

function MessageChatPanelBody({
  selectedThreadId,
  messages,
  activeMessageStream,
  conversationScroll,
  canLoadOlderMessages,
  skipEntrance,
  onEntranceAnimationEnd,
  sandboxPill,
  onSelectArtifact,
  repositorySource,
  showStatsForNerds,
}: MessageChatPanelBodyProps) {
  return (
    // `Conversation` owns stick-to-bottom, prepend anchor preservation,
    // load-older sentinel wiring, and reduced-motion behavior.
    <Conversation key={selectedThreadId ?? "no-thread"} scroll={conversationScroll} className="flex-1 min-h-0">
      <ConversationContent
        className={
          skipEntrance
            ? "mx-auto flex w-full max-w-3xl flex-col gap-0 px-6 pb-6 pt-10"
            : "mx-auto flex w-full max-w-3xl flex-col gap-0 px-6 pb-6 pt-10 animate-soft-enter"
        }
        showLoadOlderSentinel={canLoadOlderMessages}
        aria-busy={activeMessageStream !== null && activeMessageStream !== undefined}
        onAnimationEnd={skipEntrance ? undefined : onEntranceAnimationEnd}
      >
        {sandboxPill ? <ConversationItem messageId="sandbox-activity-pill">{sandboxPill}</ConversationItem> : null}
        {messages && (
          <MessageList
            messages={messages}
            activeMessageStream={activeMessageStream}
            onSelectArtifact={onSelectArtifact}
            repositorySource={repositorySource}
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
  onSelectArtifact: ((artifactId: ArtifactId) => void) | undefined;
  repositorySource: RepositorySource | undefined;
  showStatsForNerds: boolean;
};

function MessageList({
  messages,
  activeMessageStream,
  onSelectArtifact,
  repositorySource,
  showStatsForNerds,
}: MessageListProps) {
  return (
    <>
      {messages.map((message, index) => {
        const messageStream = activeMessageStream?.assistantMessageId === message._id ? activeMessageStream : null;
        const previousMessage = index > 0 ? messages[index - 1] : undefined;
        return (
          <ConversationItem
            key={message._id}
            messageId={message._id}
            scrollAnchor={message.role === "user"}
            className={messageSpacingClassName(previousMessage, message)}
          >
            <MessageBubble
              message={message}
              activeMessageStream={messageStream}
              onSelectArtifact={onSelectArtifact}
              repositorySource={repositorySource}
              showStatsForNerds={showStatsForNerds}
            />
          </ConversationItem>
        );
      })}
    </>
  );
}

type ChatComposerProps = {
  composer: ChatComposerViewModel;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  canCancel: boolean;
  isSendBlocked: boolean;
  sendButtonTitle: string | undefined;
};

function ChatComposer({ composer, inputRef, canCancel, isSendBlocked, sendButtonTitle }: ChatComposerProps) {
  const readOnlyHint = composer.input.readOnly ? composer.input.readOnlyHint : null;

  return (
    <div className="border-t border-border bg-background">
      <PromptInputComposerFrame
        className="mx-auto max-w-3xl px-6 py-3"
        hint={readOnlyHint}
        hintId="readonly-hint"
        onSubmit={(message, event) => {
          if (isSendBlocked) return;
          void composer.send.onSubmit(event, message.text);
        }}
      >
        <PromptInputTextarea
          ref={inputRef}
          name="message"
          value={composer.input.value}
          onChange={(e) => composer.input.setValue(e.target.value)}
          placeholder={composer.input.placeholder}
          className="min-h-20"
          readOnly={composer.input.readOnly}
          aria-describedby={readOnlyHint ? "readonly-hint" : undefined}
        />
        <PromptInputFooter>
          <ComposerTools composer={composer} />
          <ComposerAction
            composer={composer}
            canCancel={canCancel}
            isSendBlocked={isSendBlocked}
            sendButtonTitle={sendButtonTitle}
          />
        </PromptInputFooter>
      </PromptInputComposerFrame>
    </div>
  );
}

function ComposerTools({ composer }: { composer: ChatComposerViewModel }) {
  if (!composer.tools.ready) {
    return <div aria-hidden="true" data-testid="chat-panel-composer-tools-placeholder" className="min-h-8 flex-1" />;
  }

  const modelSettings = composer.tools.modelPicker ? (
    <ResponsiveComposerModelSettings composer={composer} />
  ) : composer.tools.reasoningPicker ? (
    <div className="hidden sm:flex">
      <ComposerReasoningPicker composer={composer} />
    </div>
  ) : null;
  const toolItems = [
    modelSettings,
    ...Children.toArray(composer.tools.extraControls),
    composer.tools.grounding ? <ComposerGroundingToggles composer={composer} /> : null,
  ].filter((item) => item !== null);

  return (
    <PromptInputTools className="composer-model-settings-query min-w-0 flex-1 animate-enter-fade">
      {toolItems.map((item, index) => (
        <Fragment key={index}>
          {index > 0 ? <PromptInputToolSeparator /> : null}
          {item}
        </Fragment>
      ))}
    </PromptInputTools>
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

function ResponsiveComposerModelSettings({ composer }: { composer: ChatComposerViewModel }) {
  return (
    <>
      <div className="composer-model-settings-compact">
        <CompactModelSettingsMenu
          modelPicker={composer.tools.modelPicker}
          reasoningPicker={composer.tools.reasoningPicker}
        />
      </div>
      <div className="composer-model-settings-desktop">
        <ComposerModelPicker composer={composer} />
        {composer.tools.reasoningPicker ? (
          <>
            <PromptInputToolSeparator />
            <ComposerReasoningPicker composer={composer} />
          </>
        ) : null}
      </div>
    </>
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
      size="icon"
      disabled={composer.cancel.isCancelling}
      aria-label="Stop generating reply"
      title="Stop generating reply"
      data-testid="chat-panel-stop-button"
      className="h-8 w-8 shrink-0"
      onClick={() => {
        void composer.cancel.onCancel?.();
      }}
    >
      <StopCircleIcon weight="bold" />
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
        size="icon"
        disabled={disabled}
        aria-label={composer.send.buttonState === "Send" ? "Send message" : composer.send.buttonState}
        title={disabledReason ?? (composer.send.buttonState === "Send" ? "Send message" : composer.send.buttonState)}
        data-testid="chat-panel-send-button"
        className="h-8 w-8 shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 hover:text-primary-foreground"
      >
        <PaperPlaneTiltIcon weight="bold" />
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
