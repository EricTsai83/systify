import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react";
import {
  GlobeIcon,
  LockIcon,
  PencilSimpleIcon,
  PlusIcon,
  PushPinSimpleIcon,
  PushPinSimpleSlashIcon,
  ArchiveIcon,
  RobotIcon,
} from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { MAX_RENAME_TITLE_LENGTH } from "../../convex/lib/threadDefaults";
import { Button } from "@/components/ui/button";
import { ButtonStateText } from "@/components/ui/button-state-text";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { SidebarMenuButton } from "@/components/ui/sidebar";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { useInlineRename } from "@/hooks/use-inline-rename";
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
 * Thread-row enter / exit motion.
 *
 * The row animates its own `height` from 0 → auto on enter (and back on
 * exit), so a freshly created thread physically *opens* into the list and
 * pushes the rows below it down through real layout reflow. This is what
 * reads as a smooth slide-in. The earlier approach animated only opacity +
 * a few px of `y` and leaned on `layout="position"` to slide the
 * siblings; in practice that reads as a plain fade (the new row never
 * visibly travels) and the sibling reflow only animates when motion's
 * layout projection actually fires. Driving the height directly makes the
 * insert unconditionally smooth and removes the dependency on layout
 * projection.
 *
 * `height` uses a critically-damped spring (ζ ≈ 0.98) so it decelerates
 * with a natural, physical feel but never overshoots — an overshoot would
 * momentarily open a gap taller than the row's content. `opacity` is a
 * short ease-out fade so the row's text reads in as it opens rather than
 * blinking in first.
 */
const THREAD_ROW_MOTION: Transition = {
  height: { type: "spring", stiffness: 300, damping: 34 },
  opacity: { duration: 0.2, ease: "easeOut" },
};

/**
 * Inline rename state machine shared between the repo-bound and repoless
 * thread item components. Same UX in both rails: double-click the title to
 * enter edit mode, Enter or blur to commit, Esc to cancel. The single click
 * that precedes the double click is deliberately allowed to bubble up to
 * the row (navigating to the thread) — matches the Notion / Linear / IDE
 * explorer convention where "double-click" means "navigate to this row AND
 * start renaming it".
 *
 * The race-prone bits (cancel-vs-blur, no-op baseline snapshotting, the
 * unmount-blur dedupe latch, post-exit focus restoration) live in
 * {@link useInlineRename}; this wrapper just binds the thread mutation and
 * keeps the legacy `handleStartEdit` / `handleCommit` / `handleKeyDown` /
 * `handleItemKeyDown` shape so the call sites don't churn.
 */
function useThreadRename({
  thread,
  onError,
  rowRef,
}: {
  thread: Doc<"threads">;
  onError: (message: string | null) => void;
  rowRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const renameThreadMutation = useMutation(api.chat.threads.renameThread);
  const inline = useInlineRename({
    currentValue: thread.title,
    onCommit: useCallback(
      async (title: string) => {
        await renameThreadMutation({ threadId: thread._id, title });
      },
      [renameThreadMutation, thread._id],
    ),
    onError,
    errorFallback: "Failed to rename thread.",
    rowRef,
  });

  return {
    isEditing: inline.isEditing,
    isCommitting: inline.isCommitting,
    draft: inline.draft,
    setDraft: inline.setDraft,
    inputRef: inline.inputRef,
    handleStartEdit: inline.startEdit,
    handleCommit: inline.commit,
    handleKeyDown: inline.handleInputKeyDown,
    handleItemKeyDown: inline.handleRowKeyDown,
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
   * When supplied, clicking "New thread" on the default rail variant navigates
   * to the shell's draft surface instead of pre-creating a backend thread.
   * Repository Discuss uses `/r/:repositoryId/discuss/new`; Library Ask still
   * creates its thread through the Ask panel flow.
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
      onSelectThread,
      requireRepositoryForCreate,
      threadMode,
      repositoryId,
    ]),
  );

  const handleNewThreadClick = useCallback(() => {
    if (onRequestNewThread && newThreadVariant !== "libraryAsk") {
      onRequestNewThread();
      return;
    }
    void handleCreateThread();
  }, [handleCreateThread, newThreadVariant, onRequestNewThread]);

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
          className={cn("h-8 w-full justify-start gap-1.5 text-xs active:scale-100", compact && "h-8")}
          disabled={
            (requireRepositoryForCreate && !repositoryId) ||
            (newThreadVariant === "libraryAsk" && !repositoryId) ||
            isCreatingThread
          }
          onClick={handleNewThreadClick}
        >
          <PlusIcon size={13} weight="bold" />
          <ButtonStateText
            current={isCreatingThread ? "Creating…" : (newThreadButtonLabel ?? "New thread")}
            states={[newThreadButtonLabel ?? "New thread", "Creating…"]}
          />
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
              <div className="flex items-center gap-1 px-1 pb-1">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Pinned</p>
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
              ) : null}
              {/*
               * Rendered even while `otherThreads` is empty so the list's
               * `AnimatePresence` stays mounted. The first thread created from
               * the `/discuss/new` draft is then an item added to an
               * already-mounted presence and animates in normally; gating the
               * whole `ThreadsList` behind `length > 0` would mount the
               * presence *with* that first row already present, and
               * `initial={false}` would pop it in with no entrance animation.
               */}
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
  const shouldReduceMotion = useReducedMotion();

  return (
    <div className="flex flex-col">
      <AnimatePresence initial={false}>
        {threads.map((thread) => {
          const isSelected = selectedThreadId === thread._id;
          const isPinned = Boolean(thread.pinnedAt);
          const repository = thread.repositoryId ? repositoriesById.get(thread.repositoryId) : undefined;
          return (
            <ThreadRowMotion key={thread._id} shouldReduceMotion={shouldReduceMotion}>
              <ThreadItem
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
            </ThreadRowMotion>
          );
        })}
      </AnimatePresence>
    </div>
  );
});

function ThreadRowMotion({
  children,
  shouldReduceMotion,
}: {
  children: React.ReactNode;
  shouldReduceMotion: boolean | null;
}) {
  const reduceMotion = shouldReduceMotion === true;
  return (
    <motion.div
      // `height: auto` enter/exit needs the box clipped while it grows, or
      // the row's content spills past the animating height. Reduced-motion
      // skips the whole animation, so it needs no clip.
      initial={reduceMotion ? false : { opacity: 0, height: 0 }}
      animate={reduceMotion ? undefined : { opacity: 1, height: "auto" }}
      exit={reduceMotion ? undefined : { opacity: 0, height: 0 }}
      transition={THREAD_ROW_MOTION}
      style={reduceMotion ? undefined : { overflow: "hidden" }}
    >
      {children}
    </motion.div>
  );
}

interface ThreadItemBaseProps {
  thread: Doc<"threads">;
  isEditing: boolean;
  isCommitting: boolean;
  draft: string;
  isPinned: boolean;
  isSelected: boolean;
  titleTextClass: string;
  compact?: boolean;
  repositoryBadge?: React.ReactNode;
  threadMeta?: React.ReactNode;
  rowRef: React.RefObject<HTMLDivElement | null>;
  inputRef: React.RefObject<HTMLInputElement | null>;
  onSelectThread: (id: ThreadId | null, mode: ThreadMode) => void;
  onPrewarmThread: (id: ThreadId) => void;
  onDeleteThread: (id: ThreadId) => void;
  onTogglePin: (id: ThreadId, pinned: boolean) => void;
  setDraft: (value: string) => void;
  handleStartEdit: () => void;
  handleCommit: () => void | Promise<void>;
  handleKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  handleItemKeyDown: (e: React.KeyboardEvent<HTMLElement>) => void;
}

function ThreadItemBase({
  thread,
  isEditing,
  isCommitting,
  draft,
  isPinned,
  isSelected,
  titleTextClass,
  compact,
  repositoryBadge,
  threadMeta,
  rowRef,
  inputRef,
  onSelectThread,
  onPrewarmThread,
  onDeleteThread,
  onTogglePin,
  setDraft,
  handleStartEdit,
  handleCommit,
  handleKeyDown,
  handleItemKeyDown,
}: ThreadItemBaseProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={isEditing}>
        <div ref={rowRef} className="group relative">
          {isEditing ? (
            <EditableRowFrame className={cn("py-1.5 pr-16", compact && "py-1")}>
              <div className="min-w-0 flex-1">
                <input
                  ref={inputRef}
                  value={draft}
                  maxLength={MAX_RENAME_TITLE_LENGTH}
                  aria-label="Rename thread"
                  disabled={isCommitting}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={handleKeyDown}
                  onBlur={() => void handleCommit()}
                  className={cn(
                    "m-0 block w-full truncate border-0 bg-transparent p-0 font-medium text-foreground outline-none ring-0",
                    titleTextClass,
                  )}
                />
                {repositoryBadge}
                {threadMeta}
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
              className={cn(
                "py-1.5 pr-16",
                compact && "py-1",
                isRepolessAgentThread(thread) &&
                  "border-l-[3px] border-l-primary/70 bg-primary/[0.06] hover:bg-primary/[0.09]",
                isSelected && isRepolessAgentThread(thread) && "bg-primary/[0.12]",
              )}
            >
              <div className="min-w-0 flex-1">
                <p
                  onDoubleClick={handleStartEdit}
                  className={cn("cursor-pointer truncate font-medium text-foreground", titleTextClass)}
                >
                  {thread.title}
                </p>
                {repositoryBadge}
                {threadMeta}
              </div>
            </SidebarMenuButton>
          )}
          <div className="pointer-events-none absolute right-1 top-1/2 flex -translate-y-1/2 items-center gap-0.5">
            <Button
              variant="ghost"
              size="icon"
              className="pointer-events-auto h-6 w-6 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                onTogglePin(thread._id, !isPinned);
              }}
              aria-label={isPinned ? "Unpin thread" : "Pin thread"}
              aria-pressed={isPinned}
              title={isPinned ? "Unpin thread" : "Pin thread"}
            >
              {isPinned ? (
                <PushPinSimpleSlashIcon size={13} weight="bold" />
              ) : (
                <PushPinSimpleIcon size={13} weight="bold" />
              )}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="pointer-events-auto h-6 w-6 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
              onClick={(event) => {
                event.stopPropagation();
                onDeleteThread(thread._id);
              }}
              aria-label="Archive thread"
              title="Archive thread"
            >
              <ArchiveIcon size={13} weight="bold" />
            </Button>
          </div>
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuGroup>
          <ContextMenuItem onClick={() => onTogglePin(thread._id, !isPinned)}>
            {isPinned ? (
              <>
                <PushPinSimpleSlashIcon weight="bold" /> Unpin
              </>
            ) : (
              <>
                <PushPinSimpleIcon weight="bold" /> Pin to top
              </>
            )}
          </ContextMenuItem>
          <ContextMenuItem onClick={handleStartEdit}>
            <PencilSimpleIcon weight="bold" /> Rename
          </ContextMenuItem>
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuGroup>
          <ContextMenuItem onClick={() => onDeleteThread(thread._id)}>
            <ArchiveIcon weight="bold" /> Archive
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}

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
  const rowRef = useRef<HTMLDivElement>(null);
  const {
    isEditing,
    isCommitting,
    draft,
    setDraft,
    inputRef,
    handleStartEdit,
    handleCommit,
    handleKeyDown,
    handleItemKeyDown,
  } = useThreadRename({
    thread,
    onError,
    rowRef,
  });

  const titleTextClass = threadTitleTextClass(compact);
  return (
    <ThreadItemBase
      thread={thread}
      isEditing={isEditing}
      isCommitting={isCommitting}
      draft={draft}
      isPinned={isPinned}
      isSelected={isSelected}
      titleTextClass={titleTextClass}
      compact={compact}
      repositoryBadge={<ThreadRepoBadge repository={repository} />}
      threadMeta={null}
      rowRef={rowRef}
      inputRef={inputRef}
      onSelectThread={onSelectThread}
      onPrewarmThread={onPrewarmThread}
      onDeleteThread={onDeleteThread}
      onTogglePin={onTogglePin}
      setDraft={setDraft}
      handleStartEdit={handleStartEdit}
      handleCommit={handleCommit}
      handleKeyDown={handleKeyDown}
      handleItemKeyDown={handleItemKeyDown}
    />
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

function isRepolessAgentThread(thread: Doc<"threads">): boolean {
  return !thread.repositoryId && (Boolean(thread.agentRole?.trim()) || Boolean(thread.agentInstructions?.trim()));
}

function RepolessThreadModeBadge({ thread }: { thread: Doc<"threads"> }) {
  const isAgentMode = isRepolessAgentThread(thread);

  if (isAgentMode) {
    return (
      <p className="mt-1 flex min-w-0 items-center gap-1.5 text-[10px] font-semibold uppercase leading-none tracking-wide text-primary">
        <RobotIcon size={10} weight="bold" className="shrink-0" />
        <span>Agent Mode</span>
        {thread.singleTurnEnabled ? (
          <span className="border border-primary/30 px-1 py-0.5 text-[9px] leading-none text-primary/80">
            Single-turn
          </span>
        ) : null}
      </p>
    );
  }

  return (
    <p className="mt-1 text-[10px] font-semibold uppercase leading-none tracking-wide text-muted-foreground/70">
      Thread Mode
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
  const setThreadPinnedMutation = useMutation(api.chat.threads.setThreadPinned);
  const shouldReduceMotion = useReducedMotion();

  const handleTogglePin = useCallback(
    (threadId: ThreadId, pinned: boolean) => {
      onError(null);
      void setThreadPinnedMutation({ threadId, pinned }).catch((error) => {
        onError(toUserErrorMessage(error, pinned ? "Failed to pin thread." : "Failed to unpin thread."));
      });
    },
    [setThreadPinnedMutation, onError],
  );

  const pinnedThreads = useMemo(() => threads?.filter((thread) => Boolean(thread.pinnedAt)) ?? [], [threads]);
  const otherThreads = useMemo(() => threads?.filter((thread) => !thread.pinnedAt) ?? [], [threads]);
  const agentModeThreads = useMemo(() => otherThreads.filter(isRepolessAgentThread), [otherThreads]);
  const threadModeThreads = useMemo(
    () => otherThreads.filter((thread) => !isRepolessAgentThread(thread)),
    [otherThreads],
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 border-b border-border px-3 py-2">
        <Button
          type="button"
          variant="default"
          size="sm"
          className="h-8 w-full justify-start gap-1.5 text-xs active:scale-100"
          disabled={!onRequestNewThread}
          aria-disabled={!onRequestNewThread}
          onClick={onRequestNewThread}
        >
          <PlusIcon size={13} weight="bold" />
          New thread
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
        {threads === undefined ? null : (
          <div className="flex flex-col">
            {pinnedThreads.length > 0 && (
              <div className="flex flex-col gap-1 pb-3">
                <div className="flex items-center gap-1 px-1 pb-1">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Pinned</p>
                </div>
                <div className="flex flex-col">
                  <AnimatePresence initial={false}>
                    {pinnedThreads.map((thread) => (
                      <ThreadRowMotion key={thread._id} shouldReduceMotion={shouldReduceMotion}>
                        <RepolessThreadItem
                          thread={thread}
                          isSelected={selectedThreadId === thread._id}
                          isPinned
                          onSelectThread={onSelectThread}
                          onPrewarmThread={prewarmThread}
                          onDeleteThread={onDeleteThread}
                          onTogglePin={handleTogglePin}
                          onError={onError}
                        />
                      </ThreadRowMotion>
                    ))}
                  </AnimatePresence>
                </div>
              </div>
            )}
            {otherThreads.length === 0 && pinnedThreads.length === 0 ? (
              <p className="px-1 text-xs text-muted-foreground">No conversations yet. Start one above.</p>
            ) : null}
            {agentModeThreads.length > 0 ? (
              <RepolessThreadSection
                label="Agent Mode"
                threads={agentModeThreads}
                selectedThreadId={selectedThreadId}
                shouldReduceMotion={shouldReduceMotion}
                onSelectThread={onSelectThread}
                onPrewarmThread={prewarmThread}
                onDeleteThread={onDeleteThread}
                onTogglePin={handleTogglePin}
                onError={onError}
              />
            ) : null}
            {threadModeThreads.length > 0 ? (
              <RepolessThreadSection
                label="Thread Mode"
                threads={threadModeThreads}
                selectedThreadId={selectedThreadId}
                shouldReduceMotion={shouldReduceMotion}
                onSelectThread={onSelectThread}
                onPrewarmThread={prewarmThread}
                onDeleteThread={onDeleteThread}
                onTogglePin={handleTogglePin}
                onError={onError}
              />
            ) : null}
          </div>
        )}
      </div>
    </div>
  );
}

function RepolessThreadSection({
  label,
  threads,
  selectedThreadId,
  shouldReduceMotion,
  onSelectThread,
  onPrewarmThread,
  onDeleteThread,
  onTogglePin,
  onError,
}: {
  label: "Agent Mode" | "Thread Mode";
  threads: Doc<"threads">[];
  selectedThreadId: ThreadId | null;
  shouldReduceMotion: boolean | null;
  onSelectThread: (id: ThreadId | null, mode: ThreadMode) => void;
  onPrewarmThread: (id: ThreadId) => void;
  onDeleteThread: (id: ThreadId) => void;
  onTogglePin: (id: ThreadId, pinned: boolean) => void;
  onError: (message: string | null) => void;
}) {
  return (
    <div className="flex flex-col gap-1 pb-3 last:pb-0">
      <div className="flex items-center gap-1 px-1 pb-1">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      </div>
      <div className="flex flex-col">
        <AnimatePresence initial={false}>
          {threads.map((thread) => (
            <ThreadRowMotion key={thread._id} shouldReduceMotion={shouldReduceMotion}>
              <RepolessThreadItem
                thread={thread}
                isSelected={selectedThreadId === thread._id}
                isPinned={false}
                onSelectThread={onSelectThread}
                onPrewarmThread={onPrewarmThread}
                onDeleteThread={onDeleteThread}
                onTogglePin={onTogglePin}
                onError={onError}
              />
            </ThreadRowMotion>
          ))}
        </AnimatePresence>
      </div>
    </div>
  );
}

function RepolessThreadItem({
  thread,
  isSelected,
  isPinned,
  onSelectThread,
  onPrewarmThread,
  onDeleteThread,
  onTogglePin,
  onError,
}: {
  thread: Doc<"threads">;
  isSelected: boolean;
  isPinned: boolean;
  onSelectThread: (id: ThreadId | null, mode: ThreadMode) => void;
  onPrewarmThread: (id: ThreadId) => void;
  onDeleteThread: (id: ThreadId) => void;
  onTogglePin: (id: ThreadId, pinned: boolean) => void;
  onError: (message: string | null) => void;
}) {
  const rowRef = useRef<HTMLDivElement>(null);
  const {
    isEditing,
    isCommitting,
    draft,
    setDraft,
    inputRef,
    handleStartEdit,
    handleCommit,
    handleKeyDown,
    handleItemKeyDown,
  } = useThreadRename({
    thread,
    onError,
    rowRef,
  });

  const titleTextClass = threadTitleTextClass(false);
  return (
    <ThreadItemBase
      thread={thread}
      isEditing={isEditing}
      isCommitting={isCommitting}
      draft={draft}
      isPinned={isPinned}
      isSelected={isSelected}
      titleTextClass={titleTextClass}
      threadMeta={<RepolessThreadModeBadge thread={thread} />}
      rowRef={rowRef}
      inputRef={inputRef}
      onSelectThread={onSelectThread}
      onPrewarmThread={onPrewarmThread}
      onDeleteThread={onDeleteThread}
      onTogglePin={onTogglePin}
      setDraft={setDraft}
      handleStartEdit={handleStartEdit}
      handleCommit={handleCommit}
      handleKeyDown={handleKeyDown}
      handleItemKeyDown={handleItemKeyDown}
    />
  );
}
