import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { GlobeIcon, LockIcon, PlusIcon, PushPinIcon, TrashIcon } from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { MAX_RENAME_TITLE_LENGTH } from "../../convex/lib/threadDefaults";
import { Button } from "@/components/ui/button";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { usePrewarmThread } from "@/hooks/use-prewarm-thread";
import { toUserErrorMessage } from "@/lib/errors";
import type { ThreadMode } from "@/route-paths";
import type { ChatMode, RepositoryId, ThreadId } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * The sidebar rail surfaces threads by the chat mode they were persisted
 * under. The filter mirrors the canonical `ChatMode` union, and the
 * Library variant of the rail uses {@link createLibraryAskThread} so the
 * freshly created thread carries an `artifactContext` scope filter on top
 * of the shared `mode: "library"` persistence.
 */
type ThreadModeFilter = ChatMode;

/**
 * Inline rename state machine shared between the repo-bound and repoless
 * thread item components. Same UX in both rails: double-click the title to
 * enter edit mode, Enter or blur to commit, Esc to cancel. The single click
 * that precedes the double click is deliberately allowed to bubble up to
 * the row (navigating to the thread) — matches the Notion / Linear / IDE
 * explorer convention where "double-click" means "navigate to this row AND
 * start renaming it".
 *
 * The "no-change" check compares against `originalTitle` (captured at
 * `handleStartEdit` time), not the live `thread.title`. Otherwise a
 * mid-edit autogen landing could change `thread.title` out from under the
 * user, and a no-typing blur would commit the *stale* default and silently
 * clobber the autogen result.
 */
function useThreadRename({ thread, onError }: { thread: Doc<"threads">; onError: (message: string | null) => void }) {
  const [isEditing, setIsEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [originalTitle, setOriginalTitle] = useState("");
  const isCancellingRef = useRef(false);
  const isCommittingRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const renameThreadMutation = useMutation(api.chat.threads.renameThread);

  const handleStartEdit = useCallback(() => {
    isCancellingRef.current = false;
    // `handleCommit` leaves the committing latch set on success so the
    // unmount-blur it triggers is suppressed. Without this reset, the next
    // rename on the same row would short-circuit silently.
    isCommittingRef.current = false;
    setOriginalTitle(thread.title);
    setDraft(thread.title);
    setIsEditing(true);
  }, [thread.title]);

  // Focus + select the input on the render that flips `isEditing` to true.
  // Using `useEffect` keyed on `isEditing` (rather than a `queueMicrotask`
  // chained off the click handler) decouples the focus from React's commit
  // ordering — it runs after every commit where the input is mounted,
  // regardless of concurrent-mode discards.
  useEffect(() => {
    if (isEditing) {
      inputRef.current?.select();
    }
  }, [isEditing]);

  const handleCommit = useCallback(async () => {
    // Escape sets the cancelling flag synchronously before flipping
    // `isEditing`; the subsequent input-unmount blur would otherwise race
    // in and commit the draft. Consume the flag and bail out.
    if (isCancellingRef.current) {
      isCancellingRef.current = false;
      setIsEditing(false);
      return;
    }
    // Guard against double-commit from Enter + unmount blur race.
    if (isCommittingRef.current) {
      return;
    }
    isCommittingRef.current = true;
    setIsEditing(false);
    const trimmed = draft.trim();
    // No-op if the user committed an empty draft or a no-change rename —
    // saves a server round trip and avoids surfacing the empty-string
    // validation as a spurious toast.
    if (!trimmed || trimmed === originalTitle) {
      return;
    }
    try {
      onError(null);
      await renameThreadMutation({ threadId: thread._id, title: trimmed });
    } catch (error) {
      isCommittingRef.current = false;
      onError(toUserErrorMessage(error, "Failed to rename thread."));
    }
  }, [draft, originalTitle, thread._id, renameThreadMutation, onError]);

  const handleCancel = useCallback(() => {
    isCancellingRef.current = true;
    setIsEditing(false);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void handleCommit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        handleCancel();
      }
    },
    [handleCommit, handleCancel],
  );

  // F2 keyboard entry into rename mode, wired to the non-editing row's
  // parent `SidebarMenuButton` (the focusable element). The title `<p>`
  // can't host its own keyboard handler — it sits inside a `<button>`, and
  // adding `tabIndex` / `role="button"` to a paragraph inside a button is
  // exactly the interactive-descendant nesting `EditableRowFrame` warns
  // against (invalid HTML, undefined focus behaviour, double screen-reader
  // announcements). Hosting the shortcut on the button keeps a single focus
  // stop per row and a clean a11y tree. F2 mirrors the rename convention in
  // Finder, Linear, and VS Code.
  const handleItemKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === "F2") {
        e.preventDefault();
        handleStartEdit();
      }
    },
    [handleStartEdit],
  );

  return {
    isEditing,
    draft,
    setDraft,
    inputRef,
    handleStartEdit,
    handleCommit,
    handleKeyDown,
    handleItemKeyDown,
  };
}

/**
 * Visual stand-in for {@link SidebarMenuButton} used while a thread title
 * is being renamed inline. Renders as a `<div>` rather than a `<button>`
 * so the `<input>` inside is HTML-valid — `<button>` disallows interactive
 * descendants, and nesting an input inside one trips React's
 * `validateDOMNesting` warning and produces undefined browser focus /
 * keyboard behavior.
 *
 * The class list intentionally mirrors `SidebarMenuButton`'s selected
 * state — `inline-flex items-center` matches the underlying `Button`
 * base, and the border + bg-muted combo mirrors the selected look.
 * Keeping the geometry identical to the non-editing button is what makes
 * the edit-mode transition layout-shift-free; if `SidebarMenuButton`'s
 * styling drifts, this row must drift with it.
 */
function EditableRowFrame({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "inline-flex h-auto w-full items-center justify-start gap-2 whitespace-nowrap rounded-none border border-transparent border-l-2 border-l-primary bg-muted px-3 py-2 text-left text-xs text-foreground",
        className,
      )}
    >
      {children}
    </div>
  );
}

/**
 * Shared text metric for the rename `<input>` and the non-editing `<p>`.
 * Pinning both to the same explicit `leading-*` value is what keeps the
 * box height identical across the edit-toggle — `<input>` defaults to UA
 * `line-height: normal` (~1.15), while a bare `<p>` inherits a typically
 * larger value from the body. Matching them eliminates the 1–3 px
 * vertical wobble you'd otherwise see when entering / leaving edit mode.
 */
function threadTitleTextClass(compact?: boolean): string {
  return compact ? "text-[11px] leading-[14px]" : "text-xs leading-4";
}

export function RepositoryThreadsRail({
  repositoryId,
  repositories,
  threadMode,
  selectedThreadId,
  onSelectThread,
  onDeleteThread,
  onError,
  compact,
  newThreadVariant,
  newThreadButtonLabel,
  requireRepositoryForCreate = false,
  onRequestNewThread,
}: {
  repositoryId: RepositoryId | null;
  repositories: Doc<"repositories">[] | undefined;
  threadMode: ThreadModeFilter;
  selectedThreadId: ThreadId | null;
  onSelectThread: (id: ThreadId | null, mode: ThreadMode) => void;
  onDeleteThread: (id: ThreadId) => void;
  onError: (message: string | null) => void;
  compact?: boolean;
  newThreadVariant?: "default" | "libraryAsk";
  newThreadButtonLabel?: string;
  /** Library Ask always needs a concrete repository; Discuss sidebar historically allowed creating from a null pointer. */
  requireRepositoryForCreate?: boolean;
  /**
   * When supplied, clicking "New Thread" on the default rail variant navigates
   * to the repository's mode URL (no thread id) instead of pre-creating an
   * orphan thread.
   */
  onRequestNewThread?: () => void;
}) {
  const createThreadMutation = useMutation(api.chat.threads.createThread);
  const createLibraryAskThreadMutation = useMutation(api.chat.threads.createLibraryAskThread);
  const setThreadPinnedMutation = useMutation(api.chat.threads.setThreadPinned);

  const threads = useQuery(api.chat.threads.listThreads, repositoryId ? { repositoryId, mode: threadMode } : "skip");

  const repositoriesById = useMemo(() => {
    const map = new Map<RepositoryId, Doc<"repositories">>();
    for (const repository of repositories ?? []) {
      map.set(repository._id, repository);
    }
    return map;
  }, [repositories]);

  const [isCreatingThread, handleCreateThread] = useAsyncCallback(
    useCallback(async () => {
      if (requireRepositoryForCreate && !repositoryId) return;
      onError(null);
      try {
        if (newThreadVariant === "libraryAsk") {
          if (!repositoryId) {
            return;
          }
          const created = await createLibraryAskThreadMutation({ repositoryId });
          onSelectThread(created._id, created.mode);
          return;
        }
        if (onRequestNewThread) {
          onRequestNewThread();
          return;
        }
        const created = await createThreadMutation({
          repositoryId: repositoryId ?? undefined,
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
      requireRepositoryForCreate,
      threadMode,
      repositoryId,
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
            (requireRepositoryForCreate && !repositoryId) ||
            (newThreadVariant === "libraryAsk" && !repositoryId) ||
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
          onError={onError}
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
  onError,
}: {
  threads: Doc<"threads">[] | undefined;
  repositoriesById: Map<RepositoryId, Doc<"repositories">>;
  selectedThreadId: ThreadId | null;
  onSelectThread: (id: ThreadId | null, mode: ThreadMode) => void;
  onDeleteThread: (id: ThreadId) => void;
  onTogglePin: (id: ThreadId, pinned: boolean) => void;
  compact?: boolean;
  onError: (message: string | null) => void;
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
                onError={onError}
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
                  onError={onError}
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
  onError,
}: {
  threads: Doc<"threads">[];
  repositoriesById: Map<RepositoryId, Doc<"repositories">>;
  selectedThreadId: ThreadId | null;
  onSelectThread: (id: ThreadId | null, mode: ThreadMode) => void;
  onPrewarmThread: (id: ThreadId) => void;
  onDeleteThread: (id: ThreadId) => void;
  onTogglePin: (id: ThreadId, pinned: boolean) => void;
  compact?: boolean;
  onError: (message: string | null) => void;
}) {
  return (
    <div className="flex flex-col animate-in fade-in slide-in-from-top-1 duration-300 ease-out">
      {threads.map((thread) => {
        const isSelected = selectedThreadId === thread._id;
        const isPinned = Boolean(thread.pinnedAt);
        const repository = thread.repositoryId ? repositoriesById.get(thread.repositoryId) : undefined;
        return (
          <ThreadItem
            key={thread._id}
            thread={thread}
            isSelected={isSelected}
            isPinned={isPinned}
            repository={repository}
            onSelectThread={onSelectThread}
            onPrewarmThread={onPrewarmThread}
            onDeleteThread={onDeleteThread}
            onTogglePin={onTogglePin}
            compact={compact}
            onError={onError}
          />
        );
      })}
    </div>
  );
});

function ThreadItem({
  thread,
  isSelected,
  isPinned,
  repository,
  onSelectThread,
  onPrewarmThread,
  onDeleteThread,
  onTogglePin,
  compact,
  onError,
}: {
  thread: Doc<"threads">;
  isSelected: boolean;
  isPinned: boolean;
  repository: Doc<"repositories"> | undefined;
  onSelectThread: (id: ThreadId | null, mode: ThreadMode) => void;
  onPrewarmThread: (id: ThreadId) => void;
  onDeleteThread: (id: ThreadId) => void;
  onTogglePin: (id: ThreadId, pinned: boolean) => void;
  compact?: boolean;
  onError: (message: string | null) => void;
}) {
  const { isEditing, draft, setDraft, inputRef, handleStartEdit, handleCommit, handleKeyDown, handleItemKeyDown } =
    useThreadRename({
      thread,
      onError,
    });

  const titleTextClass = threadTitleTextClass(compact);
  return (
    <div className="group relative">
      {isEditing ? (
        <EditableRowFrame className={cn("py-1.5 pr-16", compact && "py-1")}>
          <div className="min-w-0 flex-1">
            <input
              ref={inputRef}
              value={draft}
              maxLength={MAX_RENAME_TITLE_LENGTH}
              aria-label="Rename thread"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={() => void handleCommit()}
              className={cn(
                "m-0 block w-full truncate border-0 bg-transparent p-0 font-medium text-foreground outline-none ring-0",
                titleTextClass,
              )}
            />
            <ThreadRepoBadge repository={repository} />
          </div>
        </EditableRowFrame>
      ) : (
        <SidebarMenuButton
          selected={isSelected}
          onClick={() => onSelectThread(thread._id, thread.mode)}
          onMouseEnter={() => onPrewarmThread(thread._id)}
          onFocus={() => onPrewarmThread(thread._id)}
          onKeyDown={handleItemKeyDown}
          aria-keyshortcuts="F2"
          className={cn("py-1.5 pr-16", compact && "py-1")}
        >
          <div className="min-w-0 flex-1">
            <p
              onDoubleClick={handleStartEdit}
              className={cn("cursor-text truncate font-medium text-foreground", titleTextClass)}
            >
              {thread.title}
            </p>
            <ThreadRepoBadge repository={repository} />
          </div>
        </SidebarMenuButton>
      )}
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
}

function ThreadRepoBadge({ repository }: { repository: Doc<"repositories"> | undefined }) {
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
 * Sidebar rail for the repoless chat shell. Lists threads with
 * `repositoryId === undefined` via the dedicated
 * `chat.threads.listRepolessThreads` query. Always Discuss mode by
 * construction.
 */
export function RepolessChatsRail({
  selectedThreadId,
  onSelectThread,
  onDeleteThread,
  onRequestNewThread,
  onError,
}: {
  selectedThreadId: ThreadId | null;
  onSelectThread: (id: ThreadId | null, mode: ThreadMode) => void;
  onDeleteThread: (id: ThreadId) => void;
  onRequestNewThread?: () => void;
  /**
   * Required: rename failures (server-side validation rejecting an
   * over-length title, for instance) must surface to the user via the
   * toast pipeline. A swallowed `() => {}` default would silently drop
   * the feedback.
   */
  onError: (message: string | null) => void;
}) {
  const threads = useQuery(api.chat.threads.listRepolessThreads, {});
  const prewarmThread = usePrewarmThread();

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border px-3 py-2">
        <Button
          type="button"
          variant="default"
          size="sm"
          className="h-8 w-full justify-start gap-1.5 text-xs"
          disabled={!onRequestNewThread}
          aria-disabled={!onRequestNewThread}
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
                  <RepolessThreadItem
                    key={thread._id}
                    thread={thread}
                    isSelected={isSelected}
                    onSelectThread={onSelectThread}
                    onPrewarmThread={prewarmThread}
                    onDeleteThread={onDeleteThread}
                    onError={onError}
                  />
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function RepolessThreadItem({
  thread,
  isSelected,
  onSelectThread,
  onPrewarmThread,
  onDeleteThread,
  onError,
}: {
  thread: Doc<"threads">;
  isSelected: boolean;
  onSelectThread: (id: ThreadId | null, mode: ThreadMode) => void;
  onPrewarmThread: (id: ThreadId) => void;
  onDeleteThread: (id: ThreadId) => void;
  onError: (message: string | null) => void;
}) {
  const { isEditing, draft, setDraft, inputRef, handleStartEdit, handleCommit, handleKeyDown, handleItemKeyDown } =
    useThreadRename({
      thread,
      onError,
    });

  const titleTextClass = threadTitleTextClass(false);
  return (
    <div className="group relative">
      {isEditing ? (
        <EditableRowFrame className="py-1.5 pr-10">
          <div className="min-w-0 flex-1">
            <input
              ref={inputRef}
              value={draft}
              maxLength={MAX_RENAME_TITLE_LENGTH}
              aria-label="Rename thread"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={handleKeyDown}
              onBlur={() => void handleCommit()}
              className={cn(
                "m-0 block w-full truncate border-0 bg-transparent p-0 font-medium text-foreground outline-none ring-0",
                titleTextClass,
              )}
            />
          </div>
        </EditableRowFrame>
      ) : (
        <SidebarMenuButton
          selected={isSelected}
          onClick={() => onSelectThread(thread._id, thread.mode)}
          onMouseEnter={() => onPrewarmThread(thread._id)}
          onFocus={() => onPrewarmThread(thread._id)}
          onKeyDown={handleItemKeyDown}
          aria-keyshortcuts="F2"
          className="py-1.5 pr-10"
        >
          <div className="min-w-0 flex-1">
            <p
              onDoubleClick={handleStartEdit}
              className={cn("cursor-text truncate font-medium text-foreground", titleTextClass)}
            >
              {thread.title}
            </p>
          </div>
        </SidebarMenuButton>
      )}
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
}
