import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { GlobeIcon, LockIcon, PlusIcon, PushPinIcon, TrashIcon } from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { usePrewarmThread } from "@/hooks/use-prewarm-thread";
import { toUserErrorMessage } from "@/lib/errors";
import type { ThreadMode } from "@/route-paths";
import type { ChatMode, RepositoryId, ThreadId, WorkspaceId } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The sidebar rail surfaces threads by the chat mode they were persisted
 * under. The filter mirrors the canonical `ChatMode` union (DB literal +
 * URL segment + UI label all share one vocabulary), and the Library
 * variant of the rail uses {@link createLibraryAskThread} so the freshly
 * created thread carries an `artifactContext` scope filter on top of the
 * shared `mode: "library"` persistence.
 */
type ThreadModeFilter = ChatMode;

export function WorkspaceThreadsRail({
  workspaceId,
  repositories,
  threadMode,
  selectedThreadId,
  onSelectThread,
  onDeleteThread,
  onError,
  compact,
  newThreadVariant,
  newThreadButtonLabel,
  requireWorkspaceForCreate = false,
  onRequestNewThread,
}: {
  workspaceId: WorkspaceId | null;
  repositories: Doc<"repositories">[] | undefined;
  threadMode: ThreadModeFilter;
  selectedThreadId: ThreadId | null;
  /**
   * Selects a thread or clears the selection. `mode` is always supplied:
   * row clicks read it off `thread.mode` (the rendered Doc), and the new-
   * thread CTA derives it from the rail's active filter. The consumer
   * routes directly to the canonical mode URL via {@link modeAwareThreadPath}
   * so a freshly-selected thread never bounces through `LegacyThreadRedirect`.
   * The id is `ThreadId | null` because some consumers (e.g. delete-then-
   * select-fallback) clear selection through this same callback — mode is
   * still required so the consumer has a well-typed value to forward when
   * it does pick a replacement.
   */
  onSelectThread: (id: ThreadId | null, mode: ThreadMode) => void;
  onDeleteThread: (id: ThreadId) => void;
  onError: (message: string | null) => void;
  compact?: boolean;
  newThreadVariant?: "default" | "libraryAsk";
  newThreadButtonLabel?: string;
  /** Library Ask always needs a concrete workspace; Discuss sidebar historically allowed creating from a null pointer. */
  requireWorkspaceForCreate?: boolean;
  /**
   * When supplied, clicking "New Thread" on the default rail variant navigates
   * to the workspace's mode URL (no thread id) instead of pre-creating an
   * orphan thread. The chat composer's first send then triggers the lazy
   * `sendMessageStartingNewThread` path. Library Ask keeps the immediate-
   * create flow because Ask threads carry an `artifactContext` scope filter
   * that has no place on the lazy path.
   */
  onRequestNewThread?: () => void;
}) {
  const createThreadMutation = useMutation(api.chat.threads.createThread);
  const createLibraryAskThreadMutation = useMutation(api.chat.threads.createLibraryAskThread);
  const setThreadPinnedMutation = useMutation(api.chat.threads.setThreadPinned);

  const threads = useQuery(api.chat.threads.listThreads, workspaceId ? { workspaceId, mode: threadMode } : "skip");

  const repositoriesById = useMemo(() => {
    const map = new Map<RepositoryId, Doc<"repositories">>();
    for (const repository of repositories ?? []) {
      map.set(repository._id, repository);
    }
    return map;
  }, [repositories]);

  const [isCreatingThread, handleCreateThread] = useAsyncCallback(
    useCallback(async () => {
      if (requireWorkspaceForCreate && !workspaceId) return;
      onError(null);
      try {
        if (newThreadVariant === "libraryAsk") {
          if (!workspaceId) {
            return;
          }
          const created = await createLibraryAskThreadMutation({ workspaceId });
          onSelectThread(created._id, created.mode);
          return;
        }
        // Default rail variant: if the shell supplied a navigate-only
        // callback, prefer it over `createThreadMutation`. The lazy first
        // send (`sendMessageStartingNewThread`) materialises the thread the
        // moment the user actually sends a message, so we no longer leave
        // an empty orphan thread behind when the user clicks New Thread
        // and then navigates away.
        if (onRequestNewThread) {
          onRequestNewThread();
          return;
        }
        const created = await createThreadMutation({
          workspaceId: workspaceId ?? undefined,
          mode: threadMode,
        });
        onSelectThread(created._id, created.mode);
      } catch (error) {
        onError(toUserErrorMessage(error, "Failed to start a conversation."));
      }
    }, [
      createLibraryAskThreadMutation,
      createThreadMutation,
      newThreadVariant,
      onError,
      onRequestNewThread,
      onSelectThread,
      requireWorkspaceForCreate,
      threadMode,
      workspaceId,
    ]),
  );

  const handleTogglePin = useCallback(
    (threadId: ThreadId, pinned: boolean) => {
      onError(null);
      void setThreadPinnedMutation({ threadId, pinned }).catch((error) => {
        onError(toUserErrorMessage(error, pinned ? "Failed to pin thread." : "Failed to unpin thread."));
      });
    },
    [setThreadPinnedMutation, onError],
  );

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", compact && "min-h-[120px]")}>
      <div className={cn("shrink-0 border-b border-border", compact ? "px-2 py-1.5" : "px-3 py-2")}>
        <Button
          type="button"
          variant="default"
          size="sm"
          className={cn("h-8 w-full justify-start gap-1.5 text-xs", compact && "h-8")}
          disabled={
            (requireWorkspaceForCreate && !workspaceId) ||
            (newThreadVariant === "libraryAsk" && !workspaceId) ||
            isCreatingThread
          }
          onClick={() => void handleCreateThread()}
        >
          <PlusIcon size={13} weight="bold" />
          {isCreatingThread ? "Creating…" : (newThreadButtonLabel ?? "New thread")}
        </Button>
      </div>

      <div className={cn("min-h-0 flex-1 overflow-y-auto overscroll-contain", compact ? "p-2" : "p-3")}>
        <ThreadsSection
          threads={threads}
          repositoriesById={repositoriesById}
          selectedThreadId={selectedThreadId}
          onSelectThread={onSelectThread}
          onDeleteThread={onDeleteThread}
          onTogglePin={handleTogglePin}
          compact={compact}
        />
      </div>
    </div>
  );
}

function ThreadsSection({
  threads,
  repositoriesById,
  selectedThreadId,
  onSelectThread,
  onDeleteThread,
  onTogglePin,
  compact,
}: {
  threads: Doc<"threads">[] | undefined;
  repositoriesById: Map<RepositoryId, Doc<"repositories">>;
  selectedThreadId: ThreadId | null;
  /**
   * See the top-level {@link WorkspaceThreadsRail} prop comment; the mode is
   * always supplied so consumers can route to canonical mode-aware URLs.
   */
  onSelectThread: (id: ThreadId | null, mode: ThreadMode) => void;
  onDeleteThread: (id: ThreadId) => void;
  onTogglePin: (id: ThreadId, pinned: boolean) => void;
  compact?: boolean;
}) {
  const previousThreadCountRef = useRef<number | null>(null);
  const liveRegionRef = useRef<HTMLSpanElement | null>(null);
  const prewarmThread = usePrewarmThread();

  useEffect(() => {
    if (threads === undefined) {
      return;
    }

    const previousCount = previousThreadCountRef.current;
    previousThreadCountRef.current = threads.length;

    if (previousCount === null || previousCount === threads.length) {
      return;
    }

    const delta = threads.length - previousCount;
    const count = Math.abs(delta);
    const message =
      delta > 0
        ? `${count} new conversation${count === 1 ? "" : "s"}. ${threads.length} total.`
        : `${count} conversation${count === 1 ? "" : "s"} removed. ${threads.length} total.`;
    if (liveRegionRef.current) {
      liveRegionRef.current.textContent = message;
    }
  }, [threads]);

  const pinnedThreads = useMemo(() => threads?.filter((thread) => Boolean(thread.pinnedAt)) ?? [], [threads]);
  const otherThreads = useMemo(() => threads?.filter((thread) => !thread.pinnedAt) ?? [], [threads]);

  return (
    <div className="flex flex-col">
      <span ref={liveRegionRef} className="sr-only" role="status" aria-live="polite" />
      {threads === undefined ? null : (
        <>
          {pinnedThreads.length > 0 && (
            <div className="flex flex-col gap-1 pb-3">
              <div className="flex items-center gap-1 px-1 pb-1 text-muted-foreground">
                <PushPinIcon size={10} weight="fill" className="shrink-0" />
                <p className="text-[11px] font-semibold uppercase tracking-wider">Pinned</p>
              </div>
              <ThreadsList
                threads={pinnedThreads}
                repositoriesById={repositoriesById}
                selectedThreadId={selectedThreadId}
                onSelectThread={onSelectThread}
                onPrewarmThread={prewarmThread}
                onDeleteThread={onDeleteThread}
                onTogglePin={onTogglePin}
                compact={compact}
              />
            </div>
          )}
          {(otherThreads.length > 0 || pinnedThreads.length === 0) && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between px-1 pb-1">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Threads</p>
              </div>
              {otherThreads.length === 0 ? (
                <p
                  className="px-1 text-xs text-muted-foreground animate-in fade-in slide-in-from-top-1 duration-300 ease-out"
                  aria-live="polite"
                >
                  No conversations yet. Start one above.
                </p>
              ) : (
                <ThreadsList
                  threads={otherThreads}
                  repositoriesById={repositoriesById}
                  selectedThreadId={selectedThreadId}
                  onSelectThread={onSelectThread}
                  onPrewarmThread={prewarmThread}
                  onDeleteThread={onDeleteThread}
                  onTogglePin={onTogglePin}
                  compact={compact}
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const ThreadsList = memo(function ThreadsList({
  threads,
  repositoriesById,
  selectedThreadId,
  onSelectThread,
  onPrewarmThread,
  onDeleteThread,
  onTogglePin,
  compact,
}: {
  threads: Doc<"threads">[];
  repositoriesById: Map<RepositoryId, Doc<"repositories">>;
  selectedThreadId: ThreadId | null;
  /**
   * See the top-level {@link WorkspaceThreadsRail} prop comment.
   */
  onSelectThread: (id: ThreadId | null, mode: ThreadMode) => void;
  onPrewarmThread: (id: ThreadId) => void;
  onDeleteThread: (id: ThreadId) => void;
  onTogglePin: (id: ThreadId, pinned: boolean) => void;
  compact?: boolean;
}) {
  return (
    <div className="flex flex-col animate-in fade-in slide-in-from-top-1 duration-300 ease-out">
      {threads.map((thread) => {
        const isSelected = selectedThreadId === thread._id;
        const isPinned = Boolean(thread.pinnedAt);
        const repository = thread.repositoryId ? repositoriesById.get(thread.repositoryId) : undefined;
        return (
          <div key={thread._id} className="group relative">
            <SidebarMenuButton
              selected={isSelected}
              onClick={() => onSelectThread(thread._id, thread.mode)}
              onMouseEnter={() => onPrewarmThread(thread._id)}
              onFocus={() => onPrewarmThread(thread._id)}
              className={cn("py-1.5 pr-16", compact && "py-1")}
            >
              <div className="min-w-0 flex-1">
                <p className={cn("truncate font-medium text-foreground", compact ? "text-[11px]" : "text-xs")}>
                  {thread.title}
                </p>
                <ThreadRepoBadge repository={repository} />
              </div>
            </SidebarMenuButton>
            <div className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "pointer-events-auto h-6 w-6 transition-opacity focus-visible:opacity-100 group-hover:opacity-100",
                  isPinned
                    ? "text-foreground opacity-100 hover:text-muted-foreground"
                    : "text-muted-foreground opacity-0 hover:text-foreground",
                )}
                onClick={() => onTogglePin(thread._id, !isPinned)}
                aria-label={isPinned ? "Unpin thread" : "Pin thread"}
                aria-pressed={isPinned}
                title={isPinned ? "Unpin thread" : "Pin thread"}
              >
                <PushPinIcon size={13} weight={isPinned ? "fill" : "regular"} />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="pointer-events-auto h-6 w-6 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                onClick={() => onDeleteThread(thread._id)}
                aria-label="Delete thread"
                title="Delete thread"
              >
                <TrashIcon size={13} weight="bold" />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
});

function ThreadRepoBadge({ repository }: { repository: Doc<"repositories"> | undefined }) {
  // Defensive null branch: `repositoriesById` may not yet carry the repo
  // during a race between the threads query and the repositories query.
  // The row's title alone carries the thread identity until the badge
  // hydrates on the next render.
  if (!repository) {
    return null;
  }
  const Icon = repository.visibility === "private" ? LockIcon : GlobeIcon;
  return (
    <p className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-muted-foreground/80">
      <Icon size={9} weight="bold" className="shrink-0" />
      <span className="truncate">{repository.sourceRepoFullName}</span>
    </p>
  );
}

/**
 * Sidebar rail for the workspaceless chat shell. Lists threads with
 * `workspaceId === undefined` via the dedicated
 * `chat.threads.listWorkspacelessThreads` query (which uses the
 * workspaceless range index, so the read cost is O(workspaceless-count)
 * rather than a full owner-table scan). Always Discuss mode by
 * construction.
 *
 * The "New thread" button navigates the parent to `/chat` (the
 * workspaceless landing) — the lazy first send materialises the thread
 * once the user actually types and submits, so the sidebar never leaves
 * an empty orphan thread behind on click.
 */
export function WorkspacelessChatsRail({
  selectedThreadId,
  onSelectThread,
  onDeleteThread,
  onRequestNewThread,
}: {
  selectedThreadId: ThreadId | null;
  onSelectThread: (id: ThreadId | null, mode: ThreadMode) => void;
  onDeleteThread: (id: ThreadId) => void;
  onRequestNewThread?: () => void;
}) {
  const threads = useQuery(api.chat.threads.listWorkspacelessThreads, {});
  const prewarmThread = usePrewarmThread();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border px-3 py-2">
        <Button
          type="button"
          variant="default"
          size="sm"
          className="h-8 w-full justify-start gap-1.5 text-xs"
          onClick={onRequestNewThread}
        >
          <PlusIcon size={13} weight="bold" />
          New thread
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
        <div className="flex flex-col">
          <div className="flex items-center gap-1 px-1 pb-1">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Chats</p>
          </div>
          {threads === undefined ? null : threads.length === 0 ? (
            <p className="px-1 text-xs text-muted-foreground">No conversations yet. Start one above.</p>
          ) : (
            <div className="flex flex-col animate-in fade-in slide-in-from-top-1 duration-300 ease-out">
              {threads.map((thread) => {
                const isSelected = selectedThreadId === thread._id;
                return (
                  <div key={thread._id} className="group relative">
                    <SidebarMenuButton
                      selected={isSelected}
                      onClick={() => onSelectThread(thread._id, thread.mode)}
                      onMouseEnter={() => prewarmThread(thread._id)}
                      onFocus={() => prewarmThread(thread._id)}
                      className="py-1.5 pr-10"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs font-medium text-foreground">{thread.title}</p>
                      </div>
                    </SidebarMenuButton>
                    <div className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="pointer-events-auto h-6 w-6 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                        onClick={() => onDeleteThread(thread._id)}
                        aria-label="Delete thread"
                        title="Delete thread"
                      >
                        <TrashIcon size={13} weight="bold" />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
