import { memo, useCallback, useEffect, useMemo, useRef } from "react";
import { useMutation, useQuery } from "convex/react";
import { GlobeIcon, LockIcon, PlusIcon, PushPinIcon, TrashIcon } from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { ProfileCard } from "@/components/profile-card";
import { ServiceModeSwitcher } from "@/components/service-mode-switcher";
import { WorkspaceSelector } from "@/components/workspace-switcher";
import { Button } from "@/components/ui/button";
import { Sidebar, SidebarContent, SidebarFooter, SidebarHeader, SidebarMenuButton } from "@/components/ui/sidebar";
import { Logo } from "@/components/logo";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { usePrewarmThread } from "@/hooks/use-prewarm-thread";
import { useServiceMode } from "@/hooks/use-service-mode";
import { toUserErrorMessage } from "@/lib/errors";
import type { RepositoryId, ThreadId, WorkspaceId } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Thread-first sidebar with workspace switcher.
 *
 * Layout, top to bottom:
 *
 *   1. Header — logo + product name. Branding is "Systify".
 *   2. "+ New thread" CTA — creates a thread scoped to the active workspace.
 *   3. Pinned section (conditional) — threads the viewer pinned, kept above
 *      the regular list. Hidden entirely when nothing is pinned.
 *   4. Threads section — the rest of the workspace's threads in recency
 *      order. Hidden when every thread is pinned so the empty header
 *      doesn't dangle.
 *   5. Footer — profile card + workspace switcher dropdown side-by-side.
 */
export function AppSidebar({
  repositories,
  workspaces,
  activeWorkspaceId,
  onSwitchWorkspace,
  selectedThreadId,
  onSelectThread,
  onDeleteThread,
  onImported,
  onError,
}: {
  repositories: Doc<"repositories">[] | undefined;
  workspaces: Doc<"workspaces">[] | undefined;
  activeWorkspaceId: WorkspaceId | null;
  onSwitchWorkspace: (id: WorkspaceId) => void;
  selectedThreadId: ThreadId | null;
  onSelectThread: (id: ThreadId | null) => void;
  onDeleteThread: (id: ThreadId) => void;
  onImported: (repoId: RepositoryId, threadId: ThreadId | null, workspaceId: WorkspaceId) => void;
  onError: (message: string | null) => void;
}) {
  const threads = useQuery(api.chat.threads.listThreads, activeWorkspaceId ? { workspaceId: activeWorkspaceId } : {});
  const createThreadMutation = useMutation(api.chat.threads.createThread);
  const setThreadPinnedMutation = useMutation(api.chat.threads.setThreadPinned);

  // Derive the current service mode from the URL so the segmented switcher
  // can highlight the active mode. Availability lets the switcher mark
  // unavailable modes (e.g. Library/Lab in a no-repo Home workspace) as
  // disabled with their unlock-hint tooltip.
  const { serviceMode, availability } = useServiceMode(activeWorkspaceId);

  const activeWorkspace = useMemo(
    () => workspaces?.find((ws) => ws._id === activeWorkspaceId) ?? null,
    [workspaces, activeWorkspaceId],
  );

  // Map for O(1) repo lookup when rendering thread badges. Built only when
  // either side has loaded so we never show stale/empty data on the badge.
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
        const threadId = await createThreadMutation({
          workspaceId: activeWorkspaceId ?? undefined,
        });
        onSelectThread(threadId);
      } catch (error) {
        onError(toUserErrorMessage(error, "Failed to start a conversation."));
      }
    }, [createThreadMutation, onError, onSelectThread, activeWorkspaceId]),
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
    <Sidebar>
      <SidebarHeader>
        <Logo size={30} />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-lg font-semibold tracking-tight">Systify</div>
        </div>
      </SidebarHeader>

      {/*
       * Service-mode switcher — sits above the "+ New thread" button so the
       * top-level mode is the first thing the user encounters when about to
       * act. The collapsed-icon design keeps the row to a single line so
       * threads list stays close to the top.
       */}
      <ServiceModeSwitcher workspaceId={activeWorkspaceId} serviceMode={serviceMode} availability={availability} />

      {/* New thread button */}
      <div className="border-b border-border px-3 py-2">
        <Button
          type="button"
          variant="default"
          size="sm"
          className="h-8 w-full justify-start gap-1.5 text-xs"
          disabled={isCreatingThread}
          onClick={() => void handleCreateThread()}
        >
          <PlusIcon size={13} weight="bold" />
          {isCreatingThread ? "Creating..." : "New thread"}
        </Button>
      </div>

      <SidebarContent>
        <ThreadsSection
          threads={threads}
          repositoriesById={repositoriesById}
          selectedThreadId={selectedThreadId}
          onSelectThread={onSelectThread}
          onDeleteThread={onDeleteThread}
          onTogglePin={handleTogglePin}
          showRepoBadge={!activeWorkspace?.repositoryId}
        />
      </SidebarContent>

      <SidebarFooter className="px-3 py-2">
        <div className="flex items-center gap-2">
          <ProfileCard />
          <WorkspaceSelector
            workspaces={workspaces}
            activeWorkspaceId={activeWorkspaceId}
            onSwitchWorkspace={onSwitchWorkspace}
            onImported={onImported}
          />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}

// ---------------------------------------------------------------------------
// Threads section — primary navigation. Scoped to the active workspace.
// ---------------------------------------------------------------------------

function ThreadsSection({
  threads,
  repositoriesById,
  selectedThreadId,
  onSelectThread,
  onDeleteThread,
  onTogglePin,
  showRepoBadge,
}: {
  threads: Doc<"threads">[] | undefined;
  repositoriesById: Map<RepositoryId, Doc<"repositories">>;
  selectedThreadId: ThreadId | null;
  onSelectThread: (id: ThreadId | null) => void;
  onDeleteThread: (id: ThreadId) => void;
  onTogglePin: (id: ThreadId, pinned: boolean) => void;
  showRepoBadge: boolean;
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

  // Split by pinned state so the UI can render a dedicated "Pinned" block
  // above the recency-ordered list. The backend already orders pinned-first,
  // so within each subset we preserve the server's order (pinned by pinnedAt
  // desc, others by lastMessageAt desc). Memoized so the memo'd ThreadsList
  // children don't re-render on every parent tick.
  const pinnedThreads = useMemo(() => threads?.filter((thread) => Boolean(thread.pinnedAt)) ?? [], [threads]);
  const otherThreads = useMemo(() => threads?.filter((thread) => !thread.pinnedAt) ?? [], [threads]);

  return (
    <div className="flex flex-col p-3">
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
                showRepoBadge={showRepoBadge}
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
                  showRepoBadge={showRepoBadge}
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
  showRepoBadge,
}: {
  threads: Doc<"threads">[];
  repositoriesById: Map<RepositoryId, Doc<"repositories">>;
  selectedThreadId: ThreadId | null;
  onSelectThread: (id: ThreadId | null) => void;
  onPrewarmThread: (id: ThreadId) => void;
  onDeleteThread: (id: ThreadId) => void;
  onTogglePin: (id: ThreadId, pinned: boolean) => void;
  showRepoBadge: boolean;
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
              onClick={() => onSelectThread(thread._id)}
              onMouseEnter={() => onPrewarmThread(thread._id)}
              onFocus={() => onPrewarmThread(thread._id)}
              className="py-1.5 pr-16"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-xs font-medium">{thread.title}</p>
                {showRepoBadge && <ThreadRepoBadge repository={repository} />}
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

/**
 * Per-thread repo indicator. Only shown in workspaces without a bound repo.
 */
function ThreadRepoBadge({ repository }: { repository: Doc<"repositories"> | undefined }) {
  if (!repository) {
    return <p className="mt-0.5 truncate text-[10px] uppercase tracking-wider text-muted-foreground/70">Home</p>;
  }
  const Icon = repository.visibility === "private" ? LockIcon : GlobeIcon;
  return (
    <p className="mt-0.5 flex items-center gap-1 truncate text-[10px] text-muted-foreground/80">
      <Icon size={9} weight="bold" className="shrink-0" />
      <span className="truncate">{repository.sourceRepoFullName}</span>
    </p>
  );
}
