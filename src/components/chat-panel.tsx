import { Fragment, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { useMutation } from "convex/react";
import {
  ChatCircleIcon,
  CubeIcon,
  FileTextIcon,
  GlobeIcon,
  LinkIcon,
  LockIcon,
  PaperPlaneTiltIcon,
  PlusIcon,
  SparkleIcon,
  StopCircleIcon,
} from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { AppNotice } from "@/components/app-notice";
import { ImportRepoDialog } from "@/components/import-repo-dialog";
import { ToolCallTrace } from "@/components/tool-call-trace";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type {
  ActiveMessageStream,
  ArtifactId,
  RepositoryId,
  ThreadId,
  ChatMode,
  SandboxModeStatus,
  WorkspaceId,
} from "@/lib/types";

/**
 * Static catalogue of every mode the selector can render. Order is stable and
 * doubles as the visual order of the pill bar so the user's eye learns the
 * capability ladder left-to-right: discuss → docs → sandbox, lowest-context
 * to highest-context (and lowest-cost to highest-cost).
 *
 * `value` is the persisted DB literal (`messages.mode` / `threads.mode`) and
 * never changes — only the user-facing `label` / `caption` evolve. The new
 * labels ("General Chat" / "Design Docs" / "Sandbox") are aimed at making the
 * differences obvious to engineering users without requiring the onboarding
 * popover (Plan 14): "Discuss" by itself didn't tell anyone the mode is
 * *training-only*, and "Docs" was ambiguous (README? design artifacts?). The
 * "Sandbox" label is intentionally kept unchanged — it is already the shared
 * vocabulary on the engineering side (Daytona sandbox, sandbox lifecycle,
 * sandbox.process.executeCommand) so renaming it would create a needless
 * translation layer between UI copy and code.
 *
 * Each caption is the short user-facing answer to "what does this mode read
 * from?". The disabled-mode tooltip (rendered by the resolver via
 * `disabledModeReasons`) takes over when the option isn't usable.
 */
const MODE_CATALOG: ReadonlyArray<{
  value: ChatMode;
  label: string;
  caption: string;
  icon: typeof ChatCircleIcon;
}> = [
  {
    value: "discuss",
    label: "General Chat",
    caption: "training-only · no repo context",
    icon: ChatCircleIcon,
  },
  {
    value: "docs",
    label: "Design Docs",
    caption: "grounded in your design artifacts",
    icon: FileTextIcon,
  },
  {
    value: "sandbox",
    label: "Sandbox",
    caption: "grounded in the live sandbox source tree",
    icon: CubeIcon,
  },
];

/**
 * Lookup keyed by `ChatMode` so the per-message badge (Plan 02) and any
 * future onboarding popovers (Plan 14) all read from the same display
 * vocabulary. Building this off of `MODE_CATALOG` rather than re-typing the
 * labels keeps the badge and the selector pill in lockstep — renaming a mode
 * in `MODE_CATALOG` automatically renames the badge.
 */
const MODE_LABELS: Record<ChatMode, string> = MODE_CATALOG.reduce(
  (acc, entry) => {
    acc[entry.value] = entry.label;
    return acc;
  },
  {} as Record<ChatMode, string>,
);

/**
 * Token regex for the citation rewriter: matches `[A#]` (1+ digits) anywhere
 * in the assistant's body. Captures the index so the replacement walker can
 * resolve it against `messages.citationMap`.
 */
const CITATION_TOKEN_REGEX = /\[A(\d+)\]/g;

const EMPTY_CHAT_OWL = ["   ^...^   ", "  / o,o \\  ", "  |):::(|  ", "====w=w===="].join("\n");

const EMPTY_CHAT_OWL_BLINK = ["   ^...^   ", "  / -,- \\  ", "  |):::(|  ", "====w=w===="].join("\n");

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
  analysisNudge = null,
}: {
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
  onImported?: (repoId: RepositoryId, threadId: ThreadId | null, workspaceId: WorkspaceId) => void;
  onThreadMovedToWorkspace?: (workspaceId: WorkspaceId | null) => void;
  /**
   * Plan 02: clicking an inline `[A#]` citation in an assistant reply forwards
   * the resolved artifact id to this callback. The shell uses it to open
   * the artifact panel and scroll/highlight the matching artifact card.
   * Optional so unit tests and headless renders can omit it.
   */
  onSelectArtifact?: (artifactId: ArtifactId) => void;
  /**
   * Optional empty-state nudge that surfaces a deep-analysis CTA below the
   * "Start a design conversation" card when a repo is attached, no analysis
   * has been generated yet, and the sandbox is ready to host one. The shell
   * decides when to pass this in; the panel is purely presentational.
   *
   * `null` (default) hides the nudge — used for threads that already have
   * analysis, are mid-analysis, or whose sandbox isn't ready (where the CTA
   * would just bounce off the disabled state).
   */
  analysisNudge?: { onStart: () => void } | null;
}) {
  const hasMessages = (messages?.length ?? 0) > 0;
  const availableModeSet = useMemo(() => new Set(availableModes), [availableModes]);
  const sandboxModeAvailable = sandboxModeStatus?.reasonCode === "available";

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
    !isChatLoading && chatMode === "sandbox" && sandboxModeStatus && !sandboxModeAvailable;
  const shouldShowEmptyState = !isChatLoading && !hasMessages;

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
          {sandboxWarning}
          {hasAttachedRepository ? (
            <EmptyChatHint analysisNudge={analysisNudge} />
          ) : (
            <EmptyNoRepoHint
              threadId={selectedThreadId}
              availableRepositories={availableRepositories ?? []}
              onImported={onImported}
              onThreadMovedToWorkspace={onThreadMovedToWorkspace}
            />
          )}
        </div>
      ) : (
        <ScrollArea type="always" className="flex-1 min-h-0">
          <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-6 py-6">
            {sandboxWarning}
            {!isChatLoading && (
              <div className="flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
                {messages!.map((message) => (
                  <MessageBubble
                    key={message._id}
                    message={message}
                    activeMessageStream={activeMessageStream ?? null}
                    onSelectArtifact={onSelectArtifact}
                  />
                ))}
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
            placeholder="Ask about architecture, module boundaries, data flow, risks…"
            className="min-h-20 resize-none border-border"
          />
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
              <ModeCompactSelect
                chatMode={chatMode}
                setChatMode={setChatMode}
                availableModeSet={availableModeSet}
                disabledModeReasons={disabledModeReasons}
              />
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
                <ModeDesktopSelect
                  chatMode={chatMode}
                  setChatMode={setChatMode}
                  availableModeSet={availableModeSet}
                  disabledModeReasons={disabledModeReasons}
                />
              </div>
            </div>
            {canCancel ? (
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
                disabled={isSending || isSyncing || !selectedThreadId || !chatInput.trim()}
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

function ModeDesktopSelect({
  chatMode,
  setChatMode,
  availableModeSet,
  disabledModeReasons,
}: {
  chatMode: ChatMode;
  setChatMode: (v: ChatMode) => void;
  availableModeSet: Set<ChatMode>;
  disabledModeReasons: Partial<Record<ChatMode, string>>;
}) {
  const handleChange = (value: string) => {
    const mode = value as ChatMode;
    if (!availableModeSet.has(mode)) {
      return;
    }
    setChatMode(mode);
  };

  return (
    <Select value={chatMode} onValueChange={handleChange}>
      <SelectTrigger
        id="mode-desktop-select"
        aria-label="Answer mode selector"
        className="h-7 w-auto gap-2 rounded-sm border-0 bg-transparent px-2 py-0 text-xs text-muted-foreground/80 hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground focus-visible:border-0"
      >
        <SelectValue placeholder="Answer mode" />
      </SelectTrigger>
      <SelectContent align="end" sideOffset={6} collisionPadding={12} className="w-[min(15rem,calc(100vw-1.5rem))]">
        <SelectGroup>
          {MODE_CATALOG.map((option) => {
            const isAvailable = availableModeSet.has(option.value);
            const disabledReason = disabledModeReasons[option.value];
            return (
              <SelectItem key={option.value} value={option.value} disabled={!isAvailable}>
                {isAvailable
                  ? option.label
                  : disabledReason
                    ? `${option.label} (${disabledReason})`
                    : `${option.label} (locked)`}
              </SelectItem>
            );
          })}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function ModeCompactSelect({
  chatMode,
  setChatMode,
  availableModeSet,
  disabledModeReasons,
}: {
  chatMode: ChatMode;
  setChatMode: (v: ChatMode) => void;
  availableModeSet: Set<ChatMode>;
  disabledModeReasons: Partial<Record<ChatMode, string>>;
}) {
  const handleChange = (value: string) => {
    const mode = value as ChatMode;
    if (!availableModeSet.has(mode)) {
      return;
    }
    setChatMode(mode);
  };

  return (
    <div className="md:hidden">
      <label htmlFor="mode-compact-select" className="sr-only">
        Answer mode
      </label>
      <Select value={chatMode} onValueChange={handleChange}>
        <SelectTrigger
          id="mode-compact-select"
          aria-label="Answer mode selector mobile"
          className="h-7 w-auto gap-2 rounded-sm border-0 bg-transparent px-2 py-0 text-xs text-muted-foreground/80 hover:bg-muted hover:text-foreground data-[state=open]:bg-muted data-[state=open]:text-foreground focus-visible:border-0"
        >
          <SelectValue placeholder="Answer mode" />
        </SelectTrigger>
        <SelectContent align="start" sideOffset={6} collisionPadding={12} className="w-[min(15rem,calc(100vw-1.5rem))]">
          <SelectGroup>
            {MODE_CATALOG.map((option) => {
              const isAvailable = availableModeSet.has(option.value);
              const disabledReason = disabledModeReasons[option.value];
              return (
                <SelectItem key={option.value} value={option.value} disabled={!isAvailable}>
                  {isAvailable
                    ? option.label
                    : disabledReason
                      ? `${option.label} (${disabledReason})`
                      : `${option.label} (locked)`}
                </SelectItem>
              );
            })}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  );
}

function EmptyChatHint({ analysisNudge }: { analysisNudge: { onStart: () => void } | null }) {
  return (
    <div className="flex flex-1 animate-in flex-col items-center justify-center gap-4 fade-in duration-300">
      <Card className="border-transparent bg-transparent p-6 text-center">
        <div className="relative mb-1 inline-grid place-items-center">
          <pre
            aria-hidden="true"
            className="pointer-events-none col-start-1 row-start-1 select-none font-mono text-[12px] leading-4 tracking-tight text-muted-foreground"
          >
            {EMPTY_CHAT_OWL}
          </pre>
          <pre
            aria-hidden="true"
            className="animate-terminal-owl-double-blink pointer-events-none col-start-1 row-start-1 select-none bg-background font-mono text-[12px] leading-4 tracking-tight text-muted-foreground"
          >
            {EMPTY_CHAT_OWL_BLINK}
          </pre>
        </div>
        <CardHeader className="items-center p-0 pt-5">
          <CardTitle className="text-base">Start a design conversation</CardTitle>
          <CardDescription className="text-xs">Architecture · Module dependencies · Risk hotspots</CardDescription>
        </CardHeader>
      </Card>
      {analysisNudge ? (
        // Auto-disappears once an analysis exists or starts running, so the
        // nudge feels like a one-time onboarding hint rather than a persistent
        // banner. The status panel keeps the same affordance for re-discovery.
        <Card className="w-full max-w-sm border-dashed border-border/80 bg-muted/30 p-4 text-left">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
              <SparkleIcon size={14} weight="bold" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Run a deep analysis first</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                Build a reusable source-tree analysis so your conversations can cite it. Usually 2–3 minutes.
              </p>
              <Button
                type="button"
                variant="default"
                size="sm"
                className="mt-3"
                onClick={analysisNudge.onStart}
                data-testid="empty-state-run-analysis"
              >
                <SparkleIcon weight="bold" />
                Start analysis
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * Empty-state guidance for threads that have no attached repository yet.
 * Surfaces two clear paths:
 *
 * 1. Move to a repository workspace — a dropdown listing the user's imported
 *    repos plus an "Import new repository" option that opens the ImportRepoDialog.
 * 2. Free-form discussion — the user can just start typing.
 */
function EmptyNoRepoHint({
  threadId,
  availableRepositories,
  onImported,
  onThreadMovedToWorkspace,
}: {
  threadId: ThreadId | null;
  availableRepositories: ReadonlyArray<Doc<"repositories">>;
  onImported?: (repoId: RepositoryId, threadId: ThreadId | null, workspaceId: WorkspaceId) => void;
  onThreadMovedToWorkspace?: (workspaceId: WorkspaceId | null) => void;
}) {
  const setThreadRepository = useMutation(api.chat.threads.setThreadRepository);
  const [isAttaching, setIsAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);

  const handleAttachRepo = async (repoId: RepositoryId) => {
    if (!threadId) return;
    setIsAttaching(true);
    setAttachError(null);
    try {
      const result = await setThreadRepository({ threadId, repositoryId: repoId });
      onThreadMovedToWorkspace?.(result.workspaceId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to attach repository";
      setAttachError(message);
      console.error("Error attaching repository:", err);
    } finally {
      setIsAttaching(false);
    }
  };

  return (
    <div className="flex flex-1 animate-in items-center justify-center fade-in duration-300">
      <Card className="w-full max-w-md border-transparent bg-transparent p-6 text-center">
        {attachError ? (
          <div className="mb-4 w-full">
            <AppNotice
              title="Failed to attach repository"
              message={attachError}
              tone="error"
              onAction={() => setAttachError(null)}
              actionLabel="Dismiss"
            />
          </div>
        ) : null}
        <div className="relative mb-1 inline-grid place-items-center">
          <pre
            aria-hidden="true"
            className="pointer-events-none col-start-1 row-start-1 select-none font-mono text-[12px] leading-4 tracking-tight text-muted-foreground"
          >
            {EMPTY_CHAT_OWL}
          </pre>
          <pre
            aria-hidden="true"
            className="animate-terminal-owl-double-blink pointer-events-none col-start-1 row-start-1 select-none bg-background font-mono text-[12px] leading-4 tracking-tight text-muted-foreground"
          >
            {EMPTY_CHAT_OWL_BLINK}
          </pre>
        </div>

        <CardHeader className="items-center p-0 pt-5">
          <CardTitle className="text-base">Start a design conversation</CardTitle>
        </CardHeader>

        <div className="mt-4 flex flex-col items-center gap-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5 text-xs" disabled={isAttaching}>
                <LinkIcon size={13} weight="bold" />
                {isAttaching ? "Attaching…" : "Attach repository"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" className="w-64">
              {availableRepositories.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">No repositories imported yet.</div>
              ) : (
                availableRepositories.map((repo) => (
                  <DropdownMenuItem
                    key={repo._id}
                    onSelect={() => void handleAttachRepo(repo._id)}
                    className="flex items-center gap-2 text-xs"
                  >
                    {repo.visibility === "private" ? (
                      <LockIcon size={12} weight="bold" className="shrink-0 text-muted-foreground" />
                    ) : (
                      <GlobeIcon size={12} weight="bold" className="shrink-0 text-muted-foreground" />
                    )}
                    <span className="min-w-0 flex-1 truncate">{repo.sourceRepoFullName}</span>
                  </DropdownMenuItem>
                ))
              )}
              {onImported ? (
                <>
                  <DropdownMenuSeparator />
                  <ImportRepoDialog
                    onImported={onImported}
                    trigger={
                      <DropdownMenuItem
                        onSelect={(e) => e.preventDefault()}
                        className="flex items-center gap-2 text-xs"
                      >
                        <PlusIcon size={12} weight="bold" />
                        Import new repository
                      </DropdownMenuItem>
                    }
                  />
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>

          <p className="max-w-xs text-xs text-muted-foreground">
            Move this thread into a repository workspace to unlock Docs and Sandbox modes, or keep typing here for a
            free-form discussion.
          </p>
        </div>
      </Card>
    </div>
  );
}

function MessageBubble({
  message,
  activeMessageStream,
  onSelectArtifact,
}: {
  message: Doc<"messages">;
  activeMessageStream: ActiveMessageStream | null;
  onSelectArtifact?: (artifactId: ArtifactId) => void;
}) {
  const isUser = message.role === "user";
  const isAssistant = message.role === "assistant";
  const statusLabel = getMessageStatusLabel(message.status);
  const displayContent =
    isAssistant && activeMessageStream?.assistantMessageId === message._id
      ? activeMessageStream.content || message.content
      : message.content;
  // Plan 02: assistant messages show a small mode chip so the user can tell
  // which mode produced the answer (and trace surprising replies back to a
  // mode mismatch). User messages still carry `mode` in the schema, but the
  // sender already knows what mode they were in — the chip would just be
  // visual noise on their own bubble.
  const modeLabel = isAssistant ? MODE_LABELS[message.mode] : null;
  // `[A#]` rewrite: only assistant content is rewritten because user input
  // never contains real citation tokens (and rewriting it would let a user
  // accidentally render a "fake" citation by typing `[A1]`).
  //
  // Plan 11 — `unverifiedClaims` is only rendered for terminal assistant
  // states. While the message is still streaming `displayContent` is the
  // live `activeMessageStream.content`, which the lint hasn't seen yet —
  // applying ranges from a previous (or future) snapshot would flag
  // arbitrary character positions in the live content. Gating on
  // `status !== "streaming" / "pending"` matches the cost-ticker gating
  // below for the same reason: `displayContent === message.content`
  // (the lint's input) is only guaranteed in terminal states.
  const unverifiedClaims =
    isAssistant && message.status !== "streaming" && message.status !== "pending"
      ? message.unverifiedClaims
      : undefined;
  const renderedContent = isAssistant
    ? renderAssistantContent(displayContent, message.citationMap, unverifiedClaims, onSelectArtifact)
    : displayContent || "…";
  // Plan 10 — cost ticker for assistant messages: shows estimated cost
  // and tokens / tool-call count so the user can correlate spend to a
  // specific reply. Rendered only for *terminal* assistant states
  // (`completed` / `failed` / `cancelled`) — streaming messages have
  // partial usage that would tick visibly and distract from the
  // streaming content. Built from the persisted message fields rather
  // than re-derived from the model so unsupported models (`undefined`
  // costUsd) gracefully render the token-only variant instead of a
  // fake "$0.00".
  const costTicker =
    isAssistant && message.status !== "streaming" && message.status !== "pending"
      ? buildCostTickerLabel(message)
      : null;
  return (
    <Card className={cn("p-4", isUser ? "bg-muted border-transparent" : "border-transparent bg-transparent px-0")}>
      <div className="mb-1 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{message.role}</p>
          {modeLabel ? (
            <Badge
              variant="muted"
              className="border-transparent px-1.5 py-0 text-[10px] font-medium uppercase tracking-wider"
              data-testid="message-mode-badge"
            >
              {modeLabel}
            </Badge>
          ) : null}
        </div>
        <p className="text-[10px] text-muted-foreground">{statusLabel}</p>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-6">{renderedContent}</p>
      {message.errorMessage ? <p className="mt-2 text-xs text-destructive">{message.errorMessage}</p> : null}
      {isAssistant ? (
        <ToolCallTrace
          messageId={message._id}
          persistedToolCalls={message.toolCalls}
          isStreaming={message.status === "streaming"}
        />
      ) : null}
      {costTicker ? (
        <p
          className="mt-1 text-[11px] text-muted-foreground/80 tabular-nums"
          data-testid="message-cost-ticker"
          aria-label={`Reply cost ${costTicker}`}
        >
          {costTicker}
        </p>
      ) : null}
    </Card>
  );
}

/**
 * Plan 10 — render the chat-bubble cost ticker.
 *
 * Tries to surface as much information as is available, in this order:
 *
 *   1. `~$0.03 · 1.2k tokens · 5 tools` — full info (priced model,
 *      tokens reported, tool-call trace persisted).
 *   2. `~$0.03 · 1.2k tokens` — full info minus tool calls (discuss /
 *      docs replies have no tools by design).
 *   3. `1.2k tokens · 5 tools` — pricing miss (model not in
 *      `openaiPricing.ts`); we still show what we know.
 *   4. `1.2k tokens` — discuss/docs reply for a model we don't price.
 *   5. `null` — heuristic reply (no cost, no tokens). Skips the ticker
 *      entirely so the user isn't shown an empty "—" line.
 *
 * Sub-cent costs get rendered as `<$0.01` rather than `$0.00` so the
 * user can distinguish "cheap reply" from "free reply".
 */
function buildCostTickerLabel(message: Doc<"messages">): string | null {
  const inputTokens = message.estimatedInputTokens;
  const outputTokens = message.estimatedOutputTokens;
  const totalTokens =
    inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : null;
  const cost = message.estimatedCostUsd;
  const toolCallCount = message.toolCalls?.length ?? 0;

  // Heuristic / no-token replies don't get a ticker — there's nothing
  // useful to show beyond what the bubble already says.
  if (totalTokens === null && cost === undefined && toolCallCount === 0) {
    return null;
  }

  const parts: string[] = [];
  if (cost !== undefined) {
    parts.push(formatCostUsd(cost));
  }
  if (totalTokens !== null) {
    parts.push(`${formatTokenCount(totalTokens)} tokens`);
  }
  if (toolCallCount > 0) {
    parts.push(`${toolCallCount} ${toolCallCount === 1 ? "tool" : "tools"}`);
  }
  return parts.join(" · ");
}

function formatCostUsd(usd: number): string {
  if (usd < 0.01) {
    return "<$0.01";
  }
  if (usd < 1) {
    return `~$${usd.toFixed(2)}`;
  }
  return `~$${usd.toFixed(2)}`;
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1000) {
    return tokens.toString();
  }
  // 1.2k granularity — sufficient for the ticker and avoids noisy
  // single-token differences across re-renders.
  return `${(tokens / 1000).toFixed(1)}k`;
}

/**
 * One contiguous sub-region of an assistant reply. The renderer splits
 * the message content into a sequence of these so the docs-mode `[A#]`
 * citation rewriter and the sandbox-mode unverified-claim highlighter
 * can compose without either pass needing to know about the other:
 *
 *   - Each run carries the substring it covers and the absolute offset
 *     into the original content (only used for stable React keys).
 *   - `flagged` is true for runs that fall inside an `unverifiedClaims`
 *     range. The renderer wraps those runs in `<mark>`; the citation
 *     rewriter operates on the run's text either way.
 *
 * Splitting into runs *before* the citation pass means a `[A#]` token
 * that lives inside a flagged sentence still becomes a clickable
 * button — the click target sits inside the `<mark>` wrapper rather
 * than competing with it.
 */
type ContentRun = {
  readonly text: string;
  readonly offset: number;
  readonly flagged: boolean;
};

/**
 * Plan 11 — split the assistant's content into alternating "flagged"
 * (inside an `unverifiedClaims` range) and "normal" runs.
 *
 * Pure function over the content and the persisted ranges; safe to
 * call on every render of an assistant bubble (the lint output is
 * already capped at `MAX_UNVERIFIED_CLAIMS_PER_MESSAGE = 50` so the
 * loop body runs at most ~100 times per render). Defensive about
 * out-of-bounds or out-of-order ranges so a future schema migration
 * with relaxed invariants cannot crash the renderer:
 *
 *   - Sorts a defensive copy of the ranges by `start` (the lint emits
 *     them sorted, but the renderer can't trust that across schema
 *     versions).
 *   - Clamps each range to `[cursor, content.length]` so an overlapping
 *     range from a hypothetical future edit cannot produce a negative
 *     slice. Overlaps degrade to "the second range starts where the
 *     first one ended" — visually identical to a single longer
 *     highlight, which is the right failure mode.
 *   - Skips empty ranges (`end <= start`) silently rather than
 *     emitting zero-width runs that React would still allocate keys
 *     for.
 */
function buildContentRuns(
  content: string,
  ranges: ReadonlyArray<{ start: number; end: number }> | undefined,
): ContentRun[] {
  if (!ranges || ranges.length === 0) {
    return [{ text: content, offset: 0, flagged: false }];
  }
  // Defensive copy + sort so the caller can hand us the persisted array
  // without us mutating it. The lint module already sorts, so the
  // sort cost on the hot path is `O(n)` for an already-sorted input.
  const sortedRanges = [...ranges].sort((a, b) => a.start - b.start);
  const runs: ContentRun[] = [];
  let cursor = 0;
  for (const range of sortedRanges) {
    const start = Math.max(cursor, Math.min(range.start, content.length));
    const end = Math.max(start, Math.min(range.end, content.length));
    if (end <= start) {
      continue;
    }
    if (start > cursor) {
      runs.push({ text: content.slice(cursor, start), offset: cursor, flagged: false });
    }
    runs.push({ text: content.slice(start, end), offset: start, flagged: true });
    cursor = end;
  }
  if (cursor < content.length) {
    runs.push({ text: content.slice(cursor), offset: cursor, flagged: false });
  }
  return runs;
}

/**
 * Walk one content run and turn `[A#]` tokens into clickable citation
 * buttons (when the index resolves) or pass them through as plain text
 * (when it doesn't). Returns the React nodes for that run.
 *
 * Uses a *local* regex (`new RegExp(CITATION_TOKEN_REGEX.source, "g")`)
 * rather than the module-level instance: each run's walk is independent,
 * and a local regex avoids the (small but real) risk of `lastIndex`
 * leaking across runs in concurrent-mode renders.
 *
 * `keys` is a generator that the caller threads across runs so React
 * keys stay unique within the entire bubble's render pass — without
 * that, two runs each starting their key counter at zero would
 * collide.
 */
function renderCitationsInRun(
  text: string,
  indexToArtifactId: ReadonlyMap<number, ArtifactId>,
  onSelectArtifact: ((artifactId: ArtifactId) => void) | undefined,
  keys: { next: () => number },
): ReactNode[] {
  const segments: ReactNode[] = [];
  const re = new RegExp(CITATION_TOKEN_REGEX.source, "g");
  let lastIndex = 0;
  let match: RegExpExecArray | null = re.exec(text);
  while (match !== null) {
    if (match.index > lastIndex) {
      segments.push(<Fragment key={`text-${keys.next()}`}>{text.slice(lastIndex, match.index)}</Fragment>);
    }
    const tokenIndex = Number.parseInt(match[1], 10);
    const artifactId = indexToArtifactId.get(tokenIndex);
    if (artifactId && onSelectArtifact) {
      segments.push(
        <button
          key={`cite-${keys.next()}`}
          type="button"
          onClick={() => onSelectArtifact(artifactId)}
          className="mx-0.5 inline-flex items-center rounded-sm border border-primary/30 bg-primary/5 px-1 py-0 text-[11px] font-semibold leading-5 text-primary hover:bg-primary/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary"
          data-testid={`citation-link-${tokenIndex}`}
          aria-label={`Open referenced artifact A${tokenIndex}`}
        >
          {match[0]}
        </button>,
      );
    } else {
      // Unresolved tokens render as plain text so the model's intent is
      // visible even when the citation map is missing or out of range.
      segments.push(<Fragment key={`text-${keys.next()}`}>{match[0]}</Fragment>);
    }
    lastIndex = match.index + match[0].length;
    match = re.exec(text);
  }
  if (lastIndex < text.length) {
    segments.push(<Fragment key={`text-${keys.next()}`}>{text.slice(lastIndex)}</Fragment>);
  }
  return segments;
}

/**
 * Walks the assistant's content, applying two composable passes:
 *
 *   1. **Unverified-claim highlight (Plan 11).** Sentences flagged by
 *      the citation lint are wrapped in `<mark>` with a soft yellow
 *      background and a dotted underline so the user can read them
 *      with extra skepticism. Non-blocking by design — the lint never
 *      rejects model output, it just nudges the reader.
 *
 *   2. **`[A#]` citation rewrite (Plan 02).** Every artifact-citation
 *      token whose index resolves against `messages.citationMap`
 *      becomes a clickable button that forwards the artifact id to
 *      `onSelectArtifact`. Tokens that don't resolve render as plain
 *      text so the model's intent stays visible.
 *
 * The two passes compose naturally: (1) splits the content into runs,
 * then (2) rewrites `[A#]` tokens within each run regardless of
 * flagged/unflagged status. A `<mark>`ed sentence that contains a
 * `[A#]` token still has a working button — the click target lives
 * inside the highlight wrapper rather than competing with it.
 *
 * Returns a `ReactNode` array (interleaving plain-text segments with
 * `<button>` and `<mark>` elements) rather than a single string so
 * React can render the inline buttons; preserving the surrounding
 * whitespace keeps `whitespace-pre-wrap` formatting intact for prose
 * around the citations.
 */
function renderAssistantContent(
  content: string,
  citationMap: Doc<"messages">["citationMap"],
  unverifiedClaims: Doc<"messages">["unverifiedClaims"],
  onSelectArtifact: ((artifactId: ArtifactId) => void) | undefined,
): ReactNode {
  if (!content) {
    return "…";
  }
  // Build an O(1) lookup keyed by the numeric `[A#]` index. Doing this once
  // per render is cheap (citationMap caps at MAX_CONTEXT_ARTIFACTS = 6) and
  // avoids re-scanning the array for every regex match.
  const indexToArtifactId = new Map<number, ArtifactId>();
  for (const entry of citationMap ?? []) {
    indexToArtifactId.set(entry.index, entry.artifactId);
  }

  const runs = buildContentRuns(content, unverifiedClaims);
  // Single key generator threaded across runs so React keys stay unique
  // bubble-wide. Inlined as an object so the closure shape doesn't drift
  // if more renderers grow up around this one.
  let keyCounter = 0;
  const keys = {
    next: () => keyCounter++,
  };

  const out: ReactNode[] = [];
  for (const run of runs) {
    const innerNodes = renderCitationsInRun(run.text, indexToArtifactId, onSelectArtifact, keys);
    if (run.flagged) {
      out.push(
        <mark
          key={`unv-${keys.next()}`}
          // Subtle yellow tint + dotted underline reads as "soft warning"
          // without crowding the prose. The browser default `<mark>`
          // background is the bright marker-yellow Wikipedia uses for
          // search hits, which would be too loud for a per-sentence
          // signal that fires on plausibly-half-the-reply for unprompted
          // model output. Theme-aware variants keep contrast acceptable
          // in dark mode without changing semantics.
          className="rounded-sm bg-yellow-100/70 px-0.5 underline decoration-yellow-500/60 decoration-dotted underline-offset-2 dark:bg-yellow-300/15 dark:decoration-yellow-300/60"
          data-testid="unverified-claim"
          // The bubble already labels the role and mode; the title
          // here gives the user an inline tooltip explaining what the
          // highlight means without needing onboarding copy. `aria-label`
          // is omitted because the marked text itself is the content
          // — overriding it would mute the sentence for screen readers.
          title="The model did not cite a tool-verified source for this sentence. Read with skepticism."
        >
          {innerNodes}
        </mark>,
      );
    } else {
      out.push(<Fragment key={`run-${keys.next()}`}>{innerNodes}</Fragment>);
    }
  }
  return out;
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

function getMessageStatusLabel(status: Doc<"messages">["status"]) {
  switch (status) {
    case "pending":
      return "Queued";
    case "streaming":
      return "Generating";
    case "completed":
      return "Ready";
    case "failed":
      return "Failed";
    case "cancelled":
      // Plan 07 — distinct from "Failed" so the user can tell at a glance
      // that they themselves stopped the reply (vs. an upstream error).
      return "Cancelled";
    default:
      return status;
  }
}
