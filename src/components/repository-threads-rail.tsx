import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "motion/react";
import {
  GlobeIcon,
  LockIcon,
  PencilSimpleIcon,
  PlusIcon,
  CaretRightIcon,
  PushPinSimpleIcon,
  PushPinSimpleSlashIcon,
  ArchiveIcon,
  RobotIcon,
  ChatsCircleIcon,
} from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { MAX_RENAME_TITLE_LENGTH } from "../../convex/lib/threadDefaults";
import { Button } from "@/components/ui/button";
import { ButtonStateText } from "@/components/ui/button-state-text";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { SidebarScrollViewport } from "@/components/sidebar-scroll-viewport";
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
import { getRepolessThreadKind, getRepolessThreadKindLabel, isRepolessAgentEnabled } from "@/lib/repoless-agent";
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

const THREAD_SECTION_CONTENT_MOTION: Transition = {
  height: { type: "spring", stiffness: 520, damping: 40, mass: 0.72 },
  opacity: { duration: 0.1, ease: "easeOut" },
};

const THREAD_SECTION_CARET_MOTION: Transition = {
  type: "spring",
  stiffness: 700,
  damping: 38,
  mass: 0.58,
};

const DAY_MS = 24 * 60 * 60 * 1000;

type ThreadRecencySection = {
  label: string;
  threads: Doc<"threads">[];
};

export type ThreadRailCreateControl =
  | {
      kind: "navigate";
      label?: string;
      onRequestNewThread: () => void;
    }
  | {
      kind: "createDiscuss";
      label?: string;
      requireRepository?: boolean;
    }
  | {
      kind: "createLibraryAsk";
      label?: string;
      requireRepository: true;
    };

type ThreadRowState = {
  isSelected: boolean;
  isPinned: boolean;
  compact: boolean;
};

type ThreadRenameState = {
  isEditing: boolean;
  isCommitting: boolean;
  draft: string;
  setDraft: (value: string) => void;
  startEdit: () => void;
  commit: () => void | Promise<void>;
  handleInputKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  handleRowKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
};

type ThreadRowActions = {
  select: (thread: Doc<"threads">) => void;
  prewarm: (threadId: ThreadId) => void;
  archive: (threadId: ThreadId) => void;
  togglePin: (threadId: ThreadId, pinned: boolean) => void;
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
  createControl = { kind: "createDiscuss" },
}: {
  repositoryId: RepositoryId | null;
  repositories: Doc<"repositories">[] | undefined;
  threadMode: ThreadModeFilter;
  selectedThreadId: ThreadId | null;
  onSelectThread: (id: ThreadId | null, mode: ThreadMode) => void;
  onDeleteThread: (id: ThreadId) => void;
  onError: (message: string | null) => void;
  compact?: boolean;
  createControl?: ThreadRailCreateControl;
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
      onError(null);
      try {
        if (createControl.kind === "navigate") {
          createControl.onRequestNewThread();
          return;
        }
        if (createControl.kind === "createLibraryAsk") {
          if (!repositoryId) {
            return;
          }
          const created = await createLibraryAskThreadMutation({ repositoryId });
          onSelectThread(created._id, created.mode);
          return;
        }
        if (createControl.requireRepository === true && !repositoryId) {
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
      createControl,
      createLibraryAskThreadMutation,
      createThreadMutation,
      onError,
      onSelectThread,
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
        <ThreadCreateButton
          createControl={createControl}
          repositoryId={repositoryId}
          isCreatingThread={isCreatingThread}
          compact={compact}
          onCreate={() => void handleCreateThread()}
        />
      </div>

      <SidebarScrollViewport
        className="flex-1"
        topFade
        viewportClassName={compact ? "px-2 pb-12 pt-5" : "px-3 pb-12 pt-5"}
      >
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
      </SidebarScrollViewport>
    </div>
  );
}

function ThreadCreateButton({
  createControl,
  repositoryId,
  isCreatingThread,
  compact,
  onCreate,
}: {
  createControl: ThreadRailCreateControl;
  repositoryId: RepositoryId | null;
  isCreatingThread: boolean;
  compact?: boolean;
  onCreate: () => void;
}) {
  const label = createControl.label ?? "New thread";
  const requiresRepository =
    createControl.kind === "createLibraryAsk" ||
    (createControl.kind === "createDiscuss" && createControl.requireRepository === true);
  return (
    <Button
      type="button"
      variant="default"
      size="sm"
      className={cn("h-8 w-full justify-start gap-1.5 text-xs active:scale-100", compact && "h-8")}
      disabled={(requiresRepository && !repositoryId) || isCreatingThread}
      onClick={onCreate}
    >
      <PlusIcon size={13} weight="bold" />
      <ButtonStateText current={isCreatingThread ? "Creating…" : label} states={[label, "Creating…"]} />
    </Button>
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
        <div className="flex animate-enter-fade flex-col">
          {pinnedThreads.length > 0 && (
            <CollapsibleThreadSection label="Pinned" className="pb-3">
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
            </CollapsibleThreadSection>
          )}
          {(otherThreads.length > 0 || pinnedThreads.length === 0) && (
            <div className="flex flex-col gap-1">
              <div className="flex items-center justify-between px-1 pb-1">
                <p className="text-[11px] font-semibold text-muted-foreground">Threads</p>
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
        </div>
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

function CollapsibleThreadSection({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(true);
  const shouldReduceMotion = useReducedMotion();
  const reduceMotion = shouldReduceMotion === true;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen} className={cn("flex flex-col", className)}>
      <div className="px-1 pb-1">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-1 text-left text-[11px] font-semibold text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            aria-label={`${isOpen ? "Collapse" : "Expand"} ${label}`}
          >
            <motion.span
              aria-hidden="true"
              animate={reduceMotion ? undefined : { rotate: isOpen ? 90 : 0 }}
              transition={THREAD_SECTION_CARET_MOTION}
              className={cn("flex shrink-0", reduceMotion && isOpen && "rotate-90")}
            >
              <CaretRightIcon size={11} weight="bold" />
            </motion.span>
            <span className="truncate">{label}</span>
          </button>
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent forceMount asChild>
        <div>
          <AnimatePresence initial={false}>
            {isOpen ? (
              <motion.div
                key="content"
                initial={reduceMotion ? false : { height: 0, opacity: 0 }}
                animate={reduceMotion ? undefined : { height: "auto", opacity: 1 }}
                exit={reduceMotion ? undefined : { height: 0, opacity: 0 }}
                transition={THREAD_SECTION_CONTENT_MOTION}
                style={reduceMotion ? undefined : { overflow: "hidden" }}
              >
                {children}
              </motion.div>
            ) : null}
          </AnimatePresence>
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

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
  rowState: ThreadRowState;
  rename: ThreadRenameState;
  actions: ThreadRowActions;
  rowRef: React.RefObject<HTMLDivElement | null>;
  inputRef: React.RefObject<HTMLInputElement | null>;
  titleTextClass: string;
  titlePrefix?: React.ReactNode;
  repositoryBadge?: React.ReactNode;
  threadMeta?: React.ReactNode;
}

function ThreadItemBase({
  thread,
  rowState,
  rename,
  actions,
  rowRef,
  inputRef,
  titleTextClass,
  titlePrefix,
  repositoryBadge,
  threadMeta,
}: ThreadItemBaseProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={rename.isEditing}>
        <div ref={rowRef} className="group relative">
          {rename.isEditing ? (
            <EditableThreadRow
              rename={rename}
              inputRef={inputRef}
              compact={rowState.compact}
              titleTextClass={titleTextClass}
              repositoryBadge={repositoryBadge}
              threadMeta={threadMeta}
            />
          ) : (
            <ReadonlyThreadRow
              thread={thread}
              rowState={rowState}
              actions={actions}
              rename={rename}
              titlePrefix={titlePrefix}
              repositoryBadge={repositoryBadge}
              threadMeta={threadMeta}
              titleTextClass={titleTextClass}
            />
          )}
          <ThreadRowActionsOverlay
            thread={thread}
            isPinned={rowState.isPinned}
            onTogglePin={actions.togglePin}
            onDeleteThread={actions.archive}
          />
        </div>
      </ContextMenuTrigger>
      <ThreadRowContextMenu
        thread={thread}
        isPinned={rowState.isPinned}
        onTogglePin={actions.togglePin}
        onDeleteThread={actions.archive}
        onStartEdit={rename.startEdit}
      />
    </ContextMenu>
  );
}

function ReadonlyThreadRow({
  thread,
  rowState,
  actions,
  rename,
  titlePrefix,
  repositoryBadge,
  threadMeta,
  titleTextClass,
}: {
  thread: Doc<"threads">;
  rowState: ThreadRowState;
  actions: ThreadRowActions;
  rename: ThreadRenameState;
  titlePrefix?: React.ReactNode;
  repositoryBadge?: React.ReactNode;
  threadMeta?: React.ReactNode;
  titleTextClass: string;
}) {
  return (
    <SidebarMenuButton
      selected={rowState.isSelected}
      onClick={() => actions.select(thread)}
      onMouseEnter={() => actions.prewarm(thread._id)}
      onFocus={() => actions.prewarm(thread._id)}
      onKeyDown={rename.handleRowKeyDown}
      aria-keyshortcuts="F2"
      className={cn("py-1.5 pr-16", rowState.compact && "py-1")}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          {titlePrefix}
          <p
            onDoubleClick={rename.startEdit}
            className={cn("min-w-0 flex-1 cursor-pointer truncate font-medium text-foreground", titleTextClass)}
          >
            {thread.title}
          </p>
        </div>
        {repositoryBadge}
        {threadMeta}
      </div>
    </SidebarMenuButton>
  );
}

function EditableThreadRow({
  rename,
  inputRef,
  compact,
  titleTextClass,
  repositoryBadge,
  threadMeta,
}: {
  rename: ThreadRenameState;
  inputRef: React.RefObject<HTMLInputElement | null>;
  compact: boolean;
  titleTextClass: string;
  repositoryBadge?: React.ReactNode;
  threadMeta?: React.ReactNode;
}) {
  return (
    <EditableRowFrame className={cn("py-1.5 pr-16", compact && "py-1")}>
      <div className="min-w-0 flex-1">
        <input
          ref={inputRef}
          value={rename.draft}
          maxLength={MAX_RENAME_TITLE_LENGTH}
          aria-label="Rename thread"
          disabled={rename.isCommitting}
          onChange={(e) => rename.setDraft(e.target.value)}
          onKeyDown={rename.handleInputKeyDown}
          onBlur={() => void rename.commit()}
          className={cn(
            "m-0 block w-full truncate border-0 bg-transparent p-0 font-medium text-foreground outline-none ring-0",
            titleTextClass,
          )}
        />
        {repositoryBadge}
        {threadMeta}
      </div>
    </EditableRowFrame>
  );
}

function ThreadRowActionsOverlay({
  thread,
  isPinned,
  onTogglePin,
  onDeleteThread,
}: {
  thread: Doc<"threads">;
  isPinned: boolean;
  onTogglePin: (id: ThreadId, pinned: boolean) => void;
  onDeleteThread: (id: ThreadId) => void;
}) {
  return (
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
        {isPinned ? <PushPinSimpleSlashIcon size={13} weight="bold" /> : <PushPinSimpleIcon size={13} weight="bold" />}
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
  );
}

function ThreadRowContextMenu({
  thread,
  isPinned,
  onTogglePin,
  onDeleteThread,
  onStartEdit,
}: {
  thread: Doc<"threads">;
  isPinned: boolean;
  onTogglePin: (id: ThreadId, pinned: boolean) => void;
  onDeleteThread: (id: ThreadId) => void;
  onStartEdit: () => void;
}) {
  return (
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
        <ContextMenuItem onClick={onStartEdit}>
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
  const rowState: ThreadRowState = {
    isSelected,
    isPinned,
    compact: compact === true,
  };
  const rename: ThreadRenameState = {
    isEditing,
    isCommitting,
    draft,
    setDraft,
    startEdit: handleStartEdit,
    commit: handleCommit,
    handleInputKeyDown: handleKeyDown,
    handleRowKeyDown: handleItemKeyDown,
  };
  const actions: ThreadRowActions = {
    select: (target) => onSelectThread(target._id, target.mode),
    prewarm: onPrewarmThread,
    archive: onDeleteThread,
    togglePin: onTogglePin,
  };
  return (
    <ThreadItemBase
      thread={thread}
      rowState={rowState}
      rename={rename}
      actions={actions}
      rowRef={rowRef}
      inputRef={inputRef}
      titleTextClass={titleTextClass}
      repositoryBadge={<ThreadRepoBadge repository={repository} />}
      threadMeta={null}
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
  return !thread.repositoryId && isRepolessAgentEnabled(thread);
}

function getThreadRecencySections(threads: Doc<"threads">[]): ThreadRecencySection[] {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const todayMs = startOfToday.getTime();
  const yesterdayMs = todayMs - DAY_MS;
  const sevenDaysMs = todayMs - 7 * DAY_MS;
  const thirtyDaysMs = todayMs - 30 * DAY_MS;

  const today: Doc<"threads">[] = [];
  const yesterday: Doc<"threads">[] = [];
  const last7: Doc<"threads">[] = [];
  const last30: Doc<"threads">[] = [];
  const older: Doc<"threads">[] = [];

  for (const thread of threads) {
    const ts = thread.lastMessageAt;
    if (ts >= todayMs) today.push(thread);
    else if (ts >= yesterdayMs) yesterday.push(thread);
    else if (ts >= sevenDaysMs) last7.push(thread);
    else if (ts >= thirtyDaysMs) last30.push(thread);
    else older.push(thread);
  }

  const sections: ThreadRecencySection[] = [];
  if (today.length > 0) sections.push({ label: "Today", threads: today });
  if (yesterday.length > 0) sections.push({ label: "Yesterday", threads: yesterday });
  if (last7.length > 0) sections.push({ label: "Last 7 days", threads: last7 });
  if (last30.length > 0) sections.push({ label: "Last 30 days", threads: last30 });
  if (older.length > 0) sections.push({ label: "Older", threads: older });
  return sections;
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

      <SidebarScrollViewport className="flex-1" topFade viewportClassName="px-3 pb-12 pt-4">
        {threads === undefined ? null : (
          <div className="flex animate-enter-fade flex-col">
            {pinnedThreads.length > 0 && (
              <CollapsibleThreadSection label="Pinned" className="pb-3">
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
              </CollapsibleThreadSection>
            )}
            {otherThreads.length === 0 && pinnedThreads.length === 0 ? (
              <p className="px-1 text-xs text-muted-foreground">No conversations yet. Start one above.</p>
            ) : null}
            {agentModeThreads.length > 0 ? (
              <RepolessThreadSection
                label="Agents"
                collapsible
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
                label="Conversations"
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
      </SidebarScrollViewport>
    </div>
  );
}

function RepolessThreadSection({
  label,
  collapsible,
  threads,
  selectedThreadId,
  shouldReduceMotion,
  onSelectThread,
  onPrewarmThread,
  onDeleteThread,
  onTogglePin,
  onError,
}: {
  label: "Agents" | "Conversations";
  collapsible?: boolean;
  threads: Doc<"threads">[];
  selectedThreadId: ThreadId | null;
  shouldReduceMotion: boolean | null;
  onSelectThread: (id: ThreadId | null, mode: ThreadMode) => void;
  onPrewarmThread: (id: ThreadId) => void;
  onDeleteThread: (id: ThreadId) => void;
  onTogglePin: (id: ThreadId, pinned: boolean) => void;
  onError: (message: string | null) => void;
}) {
  const content = (
    <>
      {label === "Conversations" ? (
        <div className="flex flex-col gap-2">
          {getThreadRecencySections(threads).map((section) => (
            <div key={section.label} role="group" aria-label={section.label} className="flex flex-col">
              <p className="px-1 pb-1 text-[10px] font-medium text-muted-foreground/80">{section.label}</p>
              <RepolessThreadRows
                threads={section.threads}
                selectedThreadId={selectedThreadId}
                shouldReduceMotion={shouldReduceMotion}
                onSelectThread={onSelectThread}
                onPrewarmThread={onPrewarmThread}
                onDeleteThread={onDeleteThread}
                onTogglePin={onTogglePin}
                onError={onError}
              />
            </div>
          ))}
        </div>
      ) : (
        <RepolessThreadRows
          threads={threads}
          selectedThreadId={selectedThreadId}
          shouldReduceMotion={shouldReduceMotion}
          onSelectThread={onSelectThread}
          onPrewarmThread={onPrewarmThread}
          onDeleteThread={onDeleteThread}
          onTogglePin={onTogglePin}
          onError={onError}
        />
      )}
    </>
  );

  if (collapsible) {
    return (
      <CollapsibleThreadSection label={label} className="pb-3 last:pb-0">
        {content}
      </CollapsibleThreadSection>
    );
  }

  return (
    <div className="flex flex-col gap-1 pb-3 last:pb-0">
      <div className="flex items-center gap-1 px-1 pb-1">
        <p className="text-[11px] font-semibold text-muted-foreground">{label}</p>
      </div>
      {content}
    </div>
  );
}

function RepolessThreadRows({
  threads,
  selectedThreadId,
  shouldReduceMotion,
  onSelectThread,
  onPrewarmThread,
  onDeleteThread,
  onTogglePin,
  onError,
}: {
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
  const rowState: ThreadRowState = {
    isSelected,
    isPinned,
    compact: false,
  };
  const rename: ThreadRenameState = {
    isEditing,
    isCommitting,
    draft,
    setDraft,
    startEdit: handleStartEdit,
    commit: handleCommit,
    handleInputKeyDown: handleKeyDown,
    handleRowKeyDown: handleItemKeyDown,
  };
  const actions: ThreadRowActions = {
    select: (target) => onSelectThread(target._id, target.mode),
    prewarm: onPrewarmThread,
    archive: onDeleteThread,
    togglePin: onTogglePin,
  };
  return (
    <ThreadItemBase
      thread={thread}
      rowState={rowState}
      rename={rename}
      actions={actions}
      rowRef={rowRef}
      inputRef={inputRef}
      titleTextClass={titleTextClass}
      titlePrefix={isPinned ? <RepolessThreadKindIcon thread={thread} /> : null}
      threadMeta={null}
    />
  );
}

function RepolessThreadKindIcon({ thread }: { thread: Doc<"threads"> }) {
  const kind = getRepolessThreadKind(thread);
  const Icon = kind === "agent" ? RobotIcon : ChatsCircleIcon;
  const label = getRepolessThreadKindLabel(kind);
  return (
    <span
      aria-label={label}
      title={label}
      className="inline-flex size-3 shrink-0 items-center justify-center text-muted-foreground/80"
    >
      <Icon size={12} weight={kind === "agent" ? "fill" : "bold"} aria-hidden="true" />
    </span>
  );
}
