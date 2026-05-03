import { useMemo, useState, type FormEvent } from "react";
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
} from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { AppNotice } from "@/components/app-notice";
import { ImportRepoDialog } from "@/components/import-repo-dialog";
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
    label: "Discuss",
    caption: "no code reference",
    icon: ChatCircleIcon,
  },
  {
    value: "docs",
    label: "Docs",
    caption: "searches your design docs",
    icon: FileTextIcon,
  },
  {
    value: "sandbox",
    label: "Sandbox",
    caption: "runs in a sandbox against live code",
    icon: CubeIcon,
  },
];

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
}) {
  const hasMessages = (messages?.length ?? 0) > 0;
  const availableModeSet = useMemo(() => new Set(availableModes), [availableModes]);
  const sandboxModeAvailable = sandboxModeStatus?.reasonCode === "available";

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <ScrollArea type="always" className="flex-1">
        <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col gap-3 px-6 py-6">
          {!isChatLoading && chatMode === "sandbox" && sandboxModeStatus && !sandboxModeAvailable ? (
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
          ) : null}
          {isChatLoading ? null : !hasMessages ? (
            !hasAttachedRepository ? (
              <EmptyNoRepoHint
                threadId={selectedThreadId}
                availableRepositories={availableRepositories ?? []}
                onImported={onImported}
                onThreadMovedToWorkspace={onThreadMovedToWorkspace}
              />
            ) : (
              <EmptyChatHint />
            )
          ) : (
            <div className="flex flex-col gap-3 animate-in fade-in slide-in-from-bottom-2 duration-300">
              {messages!.map((message) => (
                <MessageBubble key={message._id} message={message} activeMessageStream={activeMessageStream ?? null} />
              ))}
            </div>
          )}
        </div>
      </ScrollArea>

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
            <Button
              type="submit"
              variant="default"
              size="sm"
              className="w-full sm:w-auto"
              disabled={isSending || isSyncing || !selectedThreadId || !chatInput.trim()}
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
                <span className="col-start-1 row-start-1">
                  {isSyncing ? "Syncing…" : isSending ? "Sending…" : "Send"}
                </span>
              </span>
            </Button>
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

function EmptyChatHint() {
  return (
    <div className="flex flex-1 animate-in items-center justify-center fade-in duration-300">
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
                {isAttaching ? "Moving…" : "Move to repository"}
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
}: {
  message: Doc<"messages">;
  activeMessageStream: ActiveMessageStream | null;
}) {
  const isUser = message.role === "user";
  const statusLabel = getMessageStatusLabel(message.status);
  const displayContent =
    message.role === "assistant" && activeMessageStream?.assistantMessageId === message._id
      ? activeMessageStream.content || message.content
      : message.content;
  return (
    <Card className={cn("p-4", isUser ? "bg-muted border-transparent" : "border-transparent bg-transparent px-0")}>
      <div className="mb-1 flex items-center justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{message.role}</p>
        <p className="text-[10px] text-muted-foreground">{statusLabel}</p>
      </div>
      <p className="whitespace-pre-wrap text-sm leading-6">{displayContent || "…"}</p>
      {message.errorMessage ? <p className="mt-2 text-xs text-destructive">{message.errorMessage}</p> : null}
    </Card>
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
    default:
      return status;
  }
}
