import { useCallback, useMemo, useState, type AnimationEvent, type FormEvent } from "react";
import { FileTextIcon, PaperPlaneTiltIcon, StopCircleIcon } from "@phosphor-icons/react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { toUserErrorMessage } from "@/lib/errors";
import { AppNotice } from "@/components/app-notice";
import { EmptyChatHint, EmptyNoRepoHint } from "@/components/chat-empty-state";
import { MessageBubble } from "@/components/chat-message";
import { MODE_EXAMPLES } from "@/components/chat-modes";
import { GroundingToggleBar, type GroundingAxisLike } from "@/components/grounding-toggle-bar";
import { ModeExamples } from "@/components/mode-examples";
import { SandboxActivityPill } from "@/components/sandbox-activity-pill";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import type {
  ActiveMessageStream,
  ArtifactId,
  ChatMode,
  OnImportedCallback,
  RepositoryId,
  SandboxModeStatus,
  ThreadId,
  ThreadMode,
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
  /** Fires when the user clicks the Library "Generate System Design" CTA. */
  onOpenGenerateSystemDesign?: () => void;
  isSending: boolean;
  onSendMessage: (e: FormEvent<HTMLFormElement>) => Promise<void>;
  /**
   * Plan 07 — fires when the user clicks Stop on the in-flight reply. The
   * shell wires this to the `chat.cancel.cancelInFlightReply` mutation. The
   * panel only renders the Stop affordance when this prop is supplied *and*
   * the latest assistant message is still in a non-terminal state, so
   * tests / headless renders that don't need cancellation can simply omit
   * the prop and continue to see the Send button.
   */
  onCancelInFlightReply?: () => void | Promise<void>;
  /**
   * Plan 07 — true between user click and the assistant message
   * transitioning out of `streaming` / `pending`. While true the button
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
  /** All repositories the viewer owns — used to populate the attach dropdown. */
  availableRepositories?: ReadonlyArray<Doc<"repositories">>;
  /** Callback after a new repository is imported via the inline dialog. */
  onImported?: OnImportedCallback;
  onThreadMovedToRepository?: (repositoryId: RepositoryId | null, mode: ThreadMode | null) => void;
  /**
   * Plan 02: clicking an inline `[A#]` citation in an assistant reply forwards
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
};

type ChatContainerProps = Omit<ChatPanelProps, "messages" | "activeMessageStream" | "isChatLoading"> & {
  isShellLoading: boolean;
};

export function ChatContainer({ selectedThreadId, isShellLoading, ...panelProps }: ChatContainerProps) {
  const messages = useQuery(api.chat.threads.listMessages, selectedThreadId ? { threadId: selectedThreadId } : "skip");
  const activeMessageStream = useQuery(
    api.chat.streaming.getActiveMessageStream,
    selectedThreadId ? { threadId: selectedThreadId } : "skip",
  );

  const isChatLoading = isShellLoading || (selectedThreadId !== null && messages === undefined);

  return (
    <ChatPanel
      {...panelProps}
      selectedThreadId={selectedThreadId}
      messages={messages}
      activeMessageStream={activeMessageStream}
      isChatLoading={isChatLoading}
    />
  );
}

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
  grounding,
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
  availableRepositories = [],
  onImported,
  onThreadMovedToRepository,
  onSelectArtifact,
  isReadOnly = false,
  readOnlyHint,
  attachedRepositoryId,
  repositoryId,
}: ChatPanelProps) {
  const hasMessages = (messages?.length ?? 0) > 0;

  const [seenThreads, setSeenThreads] = useState(() => new Set<ThreadId>());
  const skipEntrance = selectedThreadId !== null && seenThreads.has(selectedThreadId);
  const markCurrentThreadSeen = useCallback(
    (event: AnimationEvent<HTMLDivElement>) => {
      // Filter out bubbled animationend events from children (e.g. streaming
      // message bubbles) so we only mark the thread as seen when the entrance
      // animation on this container itself completes.
      if (event.target !== event.currentTarget) return;
      if (!selectedThreadId) return;
      setSeenThreads((prev) => {
        if (prev.has(selectedThreadId)) return prev;
        const next = new Set(prev);
        next.add(selectedThreadId);
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
   * Plan 07 — derive "is the most recent assistant reply still in flight?"
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
        "Sandbox mode is unavailable right now. Sync the repository to provision a fresh sandbox, or switch to a lighter mode."
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
          {hasAttachedRepository ? (
            <EmptyChatHint />
          ) : (
            <EmptyNoRepoHint
              threadId={selectedThreadId}
              availableRepositories={availableRepositories ?? []}
              onImported={onImported}
              onThreadMovedToRepository={onThreadMovedToRepository}
            />
          )}
          {/*
           * Plan 14 — example prompts for the active mode. Renders at
           * the bottom of the empty-state column (the centered hint
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
        <ScrollArea className="flex-1 min-h-0">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-6">
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
                    />
                  );
                })}
              </div>
            )}
          </div>
        </ScrollArea>
      )}

      <div className="border-t border-border bg-background">
        <form
          className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-6 py-3"
          onSubmit={(e) => {
            void onSendMessage(e);
          }}
        >
          <Textarea
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder={
              isReadOnly
                ? (readOnlyHint ?? "This thread is read-only.")
                : "Ask about architecture, module boundaries, data flow, risks…"
            }
            className="min-h-20 resize-none border-border"
            readOnly={isReadOnly}
            aria-describedby={isReadOnly && readOnlyHint ? "readonly-hint" : undefined}
          />
          {isReadOnly && readOnlyHint ? (
            <p id="readonly-hint" className="text-xs text-muted-foreground">
              {readOnlyHint}
            </p>
          ) : null}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-2">
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
              {chatMode === "discuss" ? (
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
              {activationError ? (
                <p
                  className="basis-full text-[11px] text-destructive"
                  role="alert"
                  data-testid="sandbox-activation-error"
                >
                  {activationError}
                </p>
              ) : null}
            </div>
            {canCancel && !isReadOnly ? (
              /*
               * Plan 07 — Stop button. `type="button"` so a stray Enter in
               * the textarea cannot accidentally submit a Stop click as if
               * it were Send. `aria-label` plus the visible "Stop" /
               * "Stopping…" label keep the affordance accessible to screen
               * readers throughout the cancellation cycle.
               *
               * Disabled during the "Stopping…" interval to prevent
               * double-cancels: the mutation is idempotent on the server,
               * but stacking clicks would still fire redundant requests.
               */
              <Button
                type="button"
                variant="destructive"
                size="sm"
                className="w-full sm:w-auto"
                disabled={isCancellingReply}
                aria-label="Stop generating reply"
                data-testid="chat-panel-stop-button"
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
                className="w-full sm:w-auto"
                disabled={
                  isReadOnly ||
                  isSending ||
                  isSyncing ||
                  !chatInput.trim() ||
                  // Sandbox grounding requires a ready live source. Disable
                  // send until the sandbox lifecycle is `available` so an
                  // optimistically-flipped toggle does not produce a
                  // round-trip into a backend reject.
                  (groundSandbox && !sandboxModeAvailable)
                }
                data-testid="chat-panel-send-button"
              >
                <PaperPlaneTiltIcon weight="bold" />
                {/*
                 * Grid-stack the label so the button width is always sized to
                 * the longest possible state ("Sending…" / "Syncing…") and
                 * doesn't reflow when toggling between idle/sending/syncing.
                 * The invisible sizer reserves the max width; the visible
                 * span is overlaid in the same grid cell.
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
          </div>
        </form>
      </div>
    </div>
  );
}

function getSandboxStatusTitle(reasonCode: SandboxModeStatus["reasonCode"] | undefined) {
  switch (reasonCode) {
    case "sandbox_provisioning":
      return "Sandbox still provisioning";
    case "missing_sandbox":
      return "Sandbox not ready yet";
    case "sandbox_unavailable":
      return "Sandbox no longer available";
    case "sandbox_expired":
    default:
      return "Sandbox expired";
  }
}
