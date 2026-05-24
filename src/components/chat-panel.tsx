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
import { MODE_CATALOG, MODE_EXAMPLES, MODE_INFO_ENTRIES, MODE_LABELS } from "@/components/chat-modes";
import { ModeExamples } from "@/components/mode-examples";
import { ModeInfoPopover } from "@/components/mode-info-popover";
import { SandboxActivityPill } from "@/components/sandbox-activity-pill";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { suggestMode } from "@/lib/suggest-mode";
import type {
  ActiveMessageStream,
  ArtifactId,
  ChatMode,
  OnImportedCallback,
  RepositoryId,
  SandboxModeStatus,
  ThreadId,
  ThreadMode,
  WorkspaceId,
} from "@/lib/types";

type ChatPanelProps = {
  selectedThreadId: ThreadId | null;
  messages: Doc<"messages">[] | undefined;
  activeMessageStream: ActiveMessageStream | null | undefined;
  isChatLoading: boolean;
  chatInput: string;
  setChatInput: (v: string) => void;
  chatMode: ChatMode;
  setChatMode: (v: ChatMode) => void;
  availableModes: readonly ChatMode[];
  disabledModeReasons: Partial<Record<ChatMode, string>>;
  /**
   * True when sandbox isn't currently in `availableModes` but the
   * disabled "Sandbox" option should still accept a click and trigger
   * a lazy `requestSandboxActivation`. Sourced from the thread context
   * (see `useThreadCapabilities`).
   */
  sandboxIsActivatable?: boolean;
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
  onThreadMovedToWorkspace?: (workspaceId: WorkspaceId | null, mode: ThreadMode | null) => void;
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
  repositoryId?: RepositoryId;
  /**
   * Workspace the composer is rendered inside, when it differs from the
   * thread context (no-thread URLs). Acts as the anchor for the lazy
   * `sendMessageStartingNewThread` path — when supplied the Send button
   * stays enabled on a no-thread URL so the first send can create the
   * thread atomically. Optional so legacy callers without a workspace
   * context can omit it.
   */
  workspaceId?: WorkspaceId | null;
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
  setChatMode,
  availableModes,
  disabledModeReasons,
  sandboxIsActivatable = false,
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
  onThreadMovedToWorkspace,
  onSelectArtifact,
  isReadOnly = false,
  readOnlyHint,
  repositoryId,
  workspaceId,
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

  const availableModeSet = useMemo(() => new Set(availableModes), [availableModes]);
  const sandboxModeAvailable = sandboxModeStatus?.reasonCode === "available";

  // Lazy-provision entry point. Wired here (not in `SandboxActivityPill`)
  // so the ModeSelect can fire activation directly when the user clicks
  // the otherwise-disabled "Sandbox" option — the pill is only mounted
  // once `chatMode === "lab"`, so it can't be the sole trigger.
  // `requestSandboxActivation` is idempotent (returns the in-flight job
  // if one exists) so a duplicate click during activation is safe.
  const requestSandboxActivation = useMutation(api.repositories.requestSandboxActivation);
  const [activationError, setActivationError] = useState<string | null>(null);
  const [, activateSandbox] = useAsyncCallback(async () => {
    if (!repositoryId) return;
    setActivationError(null);
    try {
      await requestSandboxActivation({ repositoryId });
      setChatMode("lab");
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

  /**
   * Plan 14 — session-local set of `suggestMode` keys the user has
   * dismissed. Persistence is intentionally limited to this
   * `ChatPanel` mount: a hard reload or a navigation that re-mounts
   * the panel resets the set. The dismissal models a "not this task"
   * preference rather than a long-term setting — a user who dismisses
   * the file-path nudge while drafting one message often does want
   * it back next session, and persisting forever would surface a
   * dismissed nudge as a permanent silence.
   *
   * Lazy initializer (`() => new Set()`) avoids allocating a fresh
   * `Set` on every render; React only invokes the initializer once.
   */
  const [dismissedHintKeys, setDismissedHintKeys] = useState<Set<string>>(() => new Set());

  /**
   * Plan 14 — pure heuristic suggestion based on the current input,
   * mode, and the available-mode budget. Memoized so the regex passes
   * inside `suggestMode` only run when one of the inputs actually
   * changes; without the memo every keystroke would re-evaluate even
   * when only an unrelated panel prop (e.g. `isSyncing`) flipped.
   *
   * The dismiss filter is applied *outside* the memo because the
   * dismiss set changes orthogonally to the suggestion shape — re-
   * memoizing on dismiss would be wasted work, and the membership
   * check is `O(1)` on a small set.
   */
  const rawSuggestion = useMemo(
    () => suggestMode(chatInput, chatMode, availableModes),
    [chatInput, chatMode, availableModes],
  );
  const visibleSuggestion = rawSuggestion && !dismissedHintKeys.has(rawSuggestion.key) ? rawSuggestion : null;
  const suggestedModeLabel = visibleSuggestion ? MODE_LABELS[visibleSuggestion.suggested] : null;

  const shouldShowSandboxWarning = !isChatLoading && chatMode === "lab" && sandboxModeStatus && !sandboxModeAvailable;
  const shouldShowEmptyState = !isChatLoading && !hasMessages;
  const shouldShowSandboxPill = chatMode === "lab" && repositoryId !== undefined;

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
    shouldShowSandboxPill && repositoryId ? <SandboxActivityPill repositoryId={repositoryId} /> : null;

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
              onThreadMovedToWorkspace={onThreadMovedToWorkspace}
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
          {visibleSuggestion && suggestedModeLabel ? (
            /*
             * Plan 14 — passive mode-suggestion hint. Sits between the
             * textarea and the toolbar so the user sees it without
             * losing visual contact with what they just typed. The
             * heuristic only fires when the suggested mode is actually
             * available (see `suggestMode`), so `[Switch]` is always
             * actionable. `onDismiss` records the suggestion key in
             * the session-local set, suppressing future occurrences
             * of the same heuristic until the panel re-mounts — per
             * Plan 14 this is intentional, no localStorage required.
             */
            <AppNotice
              title="Suggestion"
              message={visibleSuggestion.reason}
              tone="info"
              actionLabel={`Switch to ${suggestedModeLabel}`}
              onAction={() => setChatMode(visibleSuggestion.suggested)}
              onDismiss={() =>
                setDismissedHintKeys((prev) => {
                  // Copy-on-write so React detects the state change;
                  // mutating the existing Set in place would short-
                  // circuit the re-render and the hint would stick.
                  const next = new Set(prev);
                  next.add(visibleSuggestion.key);
                  return next;
                })
              }
              dismissLabel="Dismiss suggestion"
              className="text-left"
            />
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
                  className="h-8 shrink-0 gap-1.5 px-2 text-xs md:hidden"
                >
                  <FileTextIcon size={14} weight="bold" />
                  <span className="hidden sm:inline">Artifacts</span>
                </Button>
              ) : null}
              {/*
               * Compact (mobile) selector + `(i)` info trigger. The
               * `md:hidden` wrappers live on the parent `<div>`s rather
               * than inside `<ModeSelect>` / `<ModeInfoPopover>` so the
               * sub-components stay layout-agnostic — the panel is the
               * single owner of breakpoint visibility, which keeps any
               * future copy of these widgets easy to drop into a non-
               * responsive surface.
               *
               * Two info-popover instances (one here, one in the
               * desktop branch below) is cheaper than one positioned
               * cleverly at this scale: only one is visible per
               * breakpoint, and co-locating each with its selector
               * keeps the relationship clear.
               */}
              <div className="md:hidden">
                <ModeSelect
                  chatMode={chatMode}
                  setChatMode={setChatMode}
                  availableModeSet={availableModeSet}
                  disabledModeReasons={disabledModeReasons}
                  sandboxIsActivatable={sandboxIsActivatable}
                  onActivateSandbox={() => void activateSandbox()}
                  id="mode-compact-select"
                  ariaLabel="Answer mode selector mobile"
                  align="start"
                />
              </div>
              <div className="md:hidden">
                <ModeInfoPopover entries={MODE_INFO_ENTRIES} />
              </div>
              {activationError ? (
                <p
                  className="basis-full text-[11px] text-destructive md:hidden"
                  role="alert"
                  data-testid="sandbox-activation-error"
                >
                  {activationError}
                </p>
              ) : null}
              <div className="hidden md:flex md:min-w-0 md:items-center">
                {showArtifactToggle && onToggleArtifactPanel ? (
                  <>
                    <Button
                      type="button"
                      variant={isArtifactPanelOpen ? "secondary" : "ghost"}
                      size="xs"
                      onClick={onToggleArtifactPanel}
                      aria-label="Toggle artifacts panel"
                      aria-pressed={isArtifactPanelOpen}
                      className="gap-1.5"
                    >
                      <FileTextIcon size={14} weight="bold" />
                      <span>Artifacts</span>
                    </Button>
                    <span aria-hidden="true" className="mx-2 h-4 w-px bg-border/70" />
                  </>
                ) : null}
                <ModeSelect
                  chatMode={chatMode}
                  setChatMode={setChatMode}
                  availableModeSet={availableModeSet}
                  disabledModeReasons={disabledModeReasons}
                  sandboxIsActivatable={sandboxIsActivatable}
                  onActivateSandbox={() => void activateSandbox()}
                  id="mode-desktop-select"
                  ariaLabel="Answer mode selector"
                  align="end"
                />
                <ModeInfoPopover entries={MODE_INFO_ENTRIES} />
              </div>
              {activationError ? (
                <p
                  className="hidden text-[11px] text-destructive md:inline-block"
                  role="alert"
                  data-testid="sandbox-activation-error-desktop"
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
                  // Lazy first send needs at least one anchor: an existing
                  // thread or the workspace we'd create the thread in.
                  (selectedThreadId === null && !workspaceId) ||
                  // Lab mode requires a ready live source; if the user picked
                  // Lab optimistically via the activate flow, the send button
                  // stays disabled until the sandbox lifecycle is `available`.
                  // Prevents a wasted round-trip through the backend's
                  // `assertWorkspaceModeEligible` reject.
                  (chatMode === "lab" && !sandboxModeAvailable)
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

type ModeSelectProps = {
  chatMode: ChatMode;
  setChatMode: (v: ChatMode) => void;
  availableModeSet: Set<ChatMode>;
  disabledModeReasons: Partial<Record<ChatMode, string>>;
  /**
   * Sandbox is not in `availableModeSet` (lifecycle isn't ready) but the
   * option should still accept a click and trigger a lazy provision.
   * When true, sandbox renders as clickable with an "Activate" suffix
   * instead of the locked-out disabled state.
   */
  sandboxIsActivatable: boolean;
  /**
   * Fired when the user picks the activatable Sandbox option. The
   * caller is responsible for enqueuing `requestSandboxActivation` and
   * (optimistically) switching `chatMode` to "lab" so the
   * `SandboxActivityPill` mounts and shows provisioning progress.
   */
  onActivateSandbox: () => void;
  id: string;
  ariaLabel: string;
  align: "start" | "end";
};

/**
 * Single shadcn/Radix `<Select>` over `MODE_CATALOG` — one component, two
 * responsive instances. Visibility (`md:hidden` for compact, `hidden md:flex`
 * around the desktop variant) lives in the panel's JSX so this widget stays
 * layout-agnostic; the only knobs are `id` / `ariaLabel` (so each instance
 * has a unique accessible name and form association) and `align` (the
 * dropdown opens from the *other* edge of the trigger on mobile vs desktop
 * so it does not clip the form border).
 *
 * Disabled modes still render with their tooltip-style suffix
 * (`Sandbox (Provision a sandbox to use Sandbox mode.)`) so a glance at the
 * dropdown is enough to tell *why* a mode is locked — important because
 * the resolver surfaces these reasons through `disabledModeReasons` and we
 * want them readable without hovering.
 */
function ModeSelect({
  chatMode,
  setChatMode,
  availableModeSet,
  disabledModeReasons,
  sandboxIsActivatable,
  onActivateSandbox,
  id,
  ariaLabel,
  align,
}: ModeSelectProps) {
  const handleChange = (value: string) => {
    const mode = value as ChatMode;
    if (mode === "lab" && !availableModeSet.has(mode) && sandboxIsActivatable) {
      onActivateSandbox();
      return;
    }
    if (!availableModeSet.has(mode)) {
      return;
    }
    setChatMode(mode);
  };

  return (
    <Select value={chatMode} onValueChange={handleChange}>
      <SelectTrigger
        id={id}
        aria-label={ariaLabel}
        className="h-7 w-auto gap-2 rounded-sm border-0 bg-transparent px-2 py-0 text-xs text-muted-foreground/80 hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground focus-visible:border-0"
      >
        <SelectValue placeholder="Answer mode" />
      </SelectTrigger>
      <SelectContent align={align} sideOffset={6} collisionPadding={12} className="w-[min(15rem,calc(100vw-1.5rem))]">
        <SelectGroup>
          {MODE_CATALOG.map((option) => {
            const isAvailable = availableModeSet.has(option.value);
            const isActivatable = option.value === "lab" && !isAvailable && sandboxIsActivatable;
            const disabledReason = disabledModeReasons[option.value];
            // Activatable sandbox is rendered as clickable: the radix
            // SelectItem only fires `onValueChange` when `disabled={false}`,
            // so we must surface it as enabled even though the resolver
            // hasn't (yet) added it to `availableModes`.
            const isItemDisabled = !isAvailable && !isActivatable;
            const label = isAvailable
              ? option.label
              : isActivatable
                ? `${option.label} (click to activate)`
                : disabledReason
                  ? `${option.label} (${disabledReason})`
                  : `${option.label} (locked)`;
            return (
              <SelectItem key={option.value} value={option.value} disabled={isItemDisabled}>
                {label}
              </SelectItem>
            );
          })}
        </SelectGroup>
      </SelectContent>
    </Select>
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
