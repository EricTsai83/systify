import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, usePaginatedQuery } from "convex/react";
import {
  ArchiveIcon,
  ArrowSquareOutIcon,
  CaretDownIcon,
  ChatCircleText,
  CopyIcon,
  DotsThreeVerticalIcon,
  GlobeHemisphereWest,
  LinkBreak,
  LockKey,
  ShareNetwork,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Id } from "../../convex/_generated/dataModel";
import { ArchiveSettingsSection } from "@/pages/archive";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ButtonStateText } from "@/components/ui/button-state-text";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { formatExpiry } from "@/lib/format-expiry";
import { formatRelativeTime } from "@/lib/format";
import type { RepositoryId, ThreadId, ThreadMode } from "@/lib/types";
import { cn } from "@/lib/utils";
import { modeAwareThreadPath, repolessThreadPath, sharedThreadPath } from "@/route-paths";

const GROUP_INITIAL_PAGE_SIZE = 20;
const GROUP_NEXT_PAGE_SIZE = 20;
const THREAD_INITIAL_PAGE_SIZE = 8;
const THREAD_NEXT_PAGE_SIZE = 12;
const SHARE_INITIAL_PAGE_SIZE = 20;
const SHARE_NEXT_PAGE_SIZE = 20;
const DEFAULT_OPEN_GROUP_COUNT = 3;

type HistoryGroup = {
  _id: Id<"chatHistoryGroups">;
  groupKey: string;
  repositoryId?: RepositoryId;
  lastThreadAt: number;
  lastThreadId: ThreadId;
  threadCount: number;
  repository: {
    _id: RepositoryId;
    sourceRepoFullName: string;
    visibility: "public" | "private" | "unknown";
    archivedAt?: number;
  } | null;
};

type HistoryThread = {
  _id: ThreadId;
  repositoryId?: RepositoryId;
  title: string;
  mode: ThreadMode;
  lastMessageAt: number;
  activeShare: {
    _id: Id<"threadShares">;
    token: string;
    expiresAt: number;
    createdAt: number;
  } | null;
};

type ActiveShare = {
  _id: Id<"threadShares">;
  token: string;
  threadId: ThreadId;
  repositoryId?: RepositoryId;
  title: string;
  repositoryLabel: string;
  createdAt: number;
  expiresAt: number;
};

export function HistoryPage() {
  const navigate = useNavigate();
  const createOrGetThreadShare = useMutation(api.chat.threadShares.createOrGetThreadShare);
  const archiveThread = useMutation(api.chat.threads.archiveThread);
  const [pendingDelete, setPendingDelete] = useState<HistoryThread | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isArchiveOpen, setIsArchiveOpen] = useState(false);
  const [groupPageIndex, setGroupPageIndex] = useState(0);
  const [pendingGroupPageIndex, setPendingGroupPageIndex] = useState<number | null>(null);

  const {
    results: groups,
    status: groupsStatus,
    loadMore: loadMoreGroups,
  } = usePaginatedQuery(api.chat.history.listThreadHistoryGroups, {}, { initialNumItems: GROUP_INITIAL_PAGE_SIZE });
  const {
    results: activeShares,
    status: activeSharesStatus,
    loadMore: loadMoreActiveShares,
  } = usePaginatedQuery(api.chat.threadShares.listActiveThreadShares, {}, { initialNumItems: SHARE_INITIAL_PAGE_SIZE });

  const orderedGroups = useMemo(() => orderHistoryGroups(groups as HistoryGroup[]), [groups]);
  const visibleGroups = useMemo(
    () => orderedGroups.slice(groupPageIndex * GROUP_INITIAL_PAGE_SIZE, (groupPageIndex + 1) * GROUP_INITIAL_PAGE_SIZE),
    [groupPageIndex, orderedGroups],
  );
  const defaultOpenGroupIds = useMemo(
    () => new Set((groups as HistoryGroup[]).slice(0, DEFAULT_OPEN_GROUP_COUNT).map((group) => group._id)),
    [groups],
  );
  const summary = useMemo(
    () => summarizeHistory(groups as HistoryGroup[], activeShares as ActiveShare[]),
    [activeShares, groups],
  );

  const handleOpenThread = useCallback(
    (thread: HistoryThread) => {
      const path = thread.repositoryId
        ? modeAwareThreadPath(thread.repositoryId, thread._id, thread.mode)
        : repolessThreadPath(thread._id);
      void navigate(path);
    },
    [navigate],
  );

  const handleShareThread = useCallback(
    async (thread: HistoryThread) => {
      try {
        const share = await createOrGetThreadShare({ threadId: thread._id });
        const publicUrl = new URL(sharedThreadPath(share.token), window.location.origin).toString();
        const copied = await copyText(publicUrl);
        if (copied) {
          toast.success("Share link copied", {
            description: "Anyone with the link can read this transcript until it expires.",
          });
        } else {
          toast.success("Share link created", {
            description: publicUrl,
          });
        }
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to create share link.");
      }
    },
    [createOrGetThreadShare],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) {
      return;
    }
    setIsDeleting(true);
    try {
      await archiveThread({ threadId: pendingDelete._id });
      toast.success("Thread archived");
      setPendingDelete(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to archive thread.");
    } finally {
      setIsDeleting(false);
    }
  }, [archiveThread, pendingDelete]);

  const isLoadingGroups = groupsStatus === "LoadingFirstPage";
  const canLoadMoreGroups = groupsStatus === "CanLoadMore";
  const isLoadingMoreGroups = groupsStatus === "LoadingMore";
  const canGoToPreviousGroupPage = groupPageIndex > 0;
  const canGoToNextGroupPage =
    (groupPageIndex + 1) * GROUP_INITIAL_PAGE_SIZE < orderedGroups.length || canLoadMoreGroups;
  const canLoadMoreShares = activeSharesStatus === "CanLoadMore";
  const isLoadingMoreShares = activeSharesStatus === "LoadingMore";
  const handlePreviousGroupPage = useCallback(() => {
    setGroupPageIndex((current) => Math.max(0, current - 1));
  }, []);
  const handleNextGroupPage = useCallback(() => {
    const nextPageIndex = groupPageIndex + 1;
    const nextStart = nextPageIndex * GROUP_INITIAL_PAGE_SIZE;
    if (nextStart < orderedGroups.length) {
      setGroupPageIndex(nextPageIndex);
      return;
    }
    if (canLoadMoreGroups && !isLoadingMoreGroups) {
      setPendingGroupPageIndex(nextPageIndex);
      loadMoreGroups(GROUP_NEXT_PAGE_SIZE);
    }
  }, [canLoadMoreGroups, groupPageIndex, isLoadingMoreGroups, loadMoreGroups, orderedGroups.length]);

  if (pendingGroupPageIndex !== null && orderedGroups.length > pendingGroupPageIndex * GROUP_INITIAL_PAGE_SIZE) {
    setGroupPageIndex(pendingGroupPageIndex);
    setPendingGroupPageIndex(null);
  }

  return (
    <>
      <section className="flex flex-col gap-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h2 className="text-xl font-semibold tracking-tight">History</h2>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              Review past conversations, manage shared threads, and open archived repositories.
            </p>
          </div>
        </div>

        <SummaryStrip summary={summary} />

        <section className="flex flex-col gap-3" aria-labelledby="chat-history-heading">
          <div className="flex items-center justify-between gap-3">
            <h3 id="chat-history-heading" className="text-sm font-semibold">
              Chat History
            </h3>
            {isLoadingGroups ? (
              <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
                <Spinner size={13} />
                Loading
              </span>
            ) : null}
          </div>

          {isLoadingGroups ? (
            <HistoryGroupSkeleton />
          ) : orderedGroups.length === 0 ? (
            <EmptyHistoryState />
          ) : (
            <div className="flex flex-col gap-2">
              {visibleGroups.map((group) => (
                <HistoryGroupSection
                  key={group._id}
                  group={group}
                  defaultOpen={defaultOpenGroupIds.has(group._id)}
                  onOpenThread={handleOpenThread}
                  onShareThread={handleShareThread}
                  onRequestDelete={setPendingDelete}
                />
              ))}
              <div className="flex flex-col gap-2 pt-2 sm:flex-row sm:items-center sm:justify-between">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="w-fit"
                  onClick={() => setIsArchiveOpen(true)}
                >
                  <ArchiveIcon weight="bold" />
                  Archive
                </Button>
                {canGoToPreviousGroupPage || canGoToNextGroupPage || isLoadingMoreGroups ? (
                  <PageControls
                    canPrevious={canGoToPreviousGroupPage}
                    canNext={canGoToNextGroupPage}
                    isLoadingNext={isLoadingMoreGroups || pendingGroupPageIndex !== null}
                    onPrevious={handlePreviousGroupPage}
                    onNext={handleNextGroupPage}
                  />
                ) : null}
              </div>
            </div>
          )}
        </section>

        <SharedThreadsSection
          activeShares={activeShares as ActiveShare[]}
          canLoadMore={canLoadMoreShares}
          isLoadingFirstPage={activeSharesStatus === "LoadingFirstPage"}
          isLoadingMore={isLoadingMoreShares}
          onLoadMore={() => loadMoreActiveShares(SHARE_NEXT_PAGE_SIZE)}
        />
      </section>

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null);
        }}
        title="Archive thread?"
        description={
          pendingDelete
            ? `${pendingDelete.title} will be removed from active history. You can restore or permanently delete it from Archive.`
            : ""
        }
        actionLabel="Archive thread"
        loadingLabel="Archiving..."
        isPending={isDeleting}
        onConfirm={() => void handleConfirmDelete()}
      />
      <Dialog open={isArchiveOpen} onOpenChange={setIsArchiveOpen}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Archive</DialogTitle>
            <DialogDescription>Restore or permanently delete archived threads and repositories.</DialogDescription>
          </DialogHeader>
          <ArchiveSettingsSection onBackToChat={() => setIsArchiveOpen(false)} />
        </DialogContent>
      </Dialog>
    </>
  );
}

function SummaryStrip({
  summary,
}: {
  summary: { repositoryThreads: number; noRepositoryChats: number; sharedLinks: number };
}) {
  const items = [
    { label: "Repository threads", value: summary.repositoryThreads },
    { label: "No repository chats", value: summary.noRepositoryChats },
    { label: "Shared links", value: summary.sharedLinks },
  ];
  return (
    <div className="grid gap-2 border-y border-border py-2 sm:grid-cols-3" aria-label="History summary">
      {items.map((item) => (
        <div key={item.label} className="flex min-h-10 items-center justify-between gap-3 px-1">
          <span className="text-xs font-medium text-muted-foreground">{item.label}</span>
          <span className="font-mono text-sm font-semibold tabular-nums">{item.value}</span>
        </div>
      ))}
    </div>
  );
}

function PageControls({
  canPrevious,
  canNext,
  isLoadingNext,
  onPrevious,
  onNext,
}: {
  canPrevious: boolean;
  canNext: boolean;
  isLoadingNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
}) {
  return (
    <div className="flex items-center gap-1" aria-label="Pagination">
      <Button type="button" variant="ghost" size="sm" disabled={!canPrevious} onClick={onPrevious}>
        <CaretDownIcon weight="bold" className="rotate-90" />
        Previous
      </Button>
      <Button type="button" variant="ghost" size="sm" disabled={!canNext || isLoadingNext} onClick={onNext}>
        {isLoadingNext ? <Spinner size={13} /> : null}
        <ButtonStateText current={isLoadingNext ? "Loading" : "Next"} states={["Next", "Loading"]} />
        <CaretDownIcon weight="bold" className="-rotate-90" />
      </Button>
    </div>
  );
}

function HistoryGroupSection({
  group,
  defaultOpen,
  onOpenThread,
  onShareThread,
  onRequestDelete,
}: {
  group: HistoryGroup;
  defaultOpen: boolean;
  onOpenThread: (thread: HistoryThread) => void;
  onShareThread: (thread: HistoryThread) => Promise<void>;
  onRequestDelete: (thread: HistoryThread) => void;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const [pageIndex, setPageIndex] = useState(0);
  const [pendingPageIndex, setPendingPageIndex] = useState<number | null>(null);
  const repositoryIdArg = group.repositoryId ?? null;
  const {
    results: threads,
    status,
    loadMore,
  } = usePaginatedQuery(
    api.chat.history.listThreadsForHistoryGroup,
    open ? { repositoryId: repositoryIdArg } : "skip",
    { initialNumItems: THREAD_INITIAL_PAGE_SIZE },
  );
  const isNoRepository = !group.repositoryId;
  const canLoadMore = status === "CanLoadMore";
  const isLoadingMore = status === "LoadingMore";
  const threadRows = threads as HistoryThread[];
  const visibleThreads = threadRows.slice(
    pageIndex * THREAD_INITIAL_PAGE_SIZE,
    (pageIndex + 1) * THREAD_INITIAL_PAGE_SIZE,
  );
  const canGoToPreviousPage = pageIndex > 0;
  const canGoToNextPage = (pageIndex + 1) * THREAD_INITIAL_PAGE_SIZE < threadRows.length || canLoadMore;
  const handlePreviousPage = useCallback(() => {
    setPageIndex((current) => Math.max(0, current - 1));
  }, []);
  const handleNextPage = useCallback(() => {
    const nextPageIndex = pageIndex + 1;
    const nextStart = nextPageIndex * THREAD_INITIAL_PAGE_SIZE;
    if (nextStart < threadRows.length) {
      setPageIndex(nextPageIndex);
      return;
    }
    if (canLoadMore && !isLoadingMore) {
      setPendingPageIndex(nextPageIndex);
      loadMore(THREAD_NEXT_PAGE_SIZE);
    }
  }, [canLoadMore, isLoadingMore, loadMore, pageIndex, threadRows.length]);

  if (pendingPageIndex !== null && threadRows.length > pendingPageIndex * THREAD_INITIAL_PAGE_SIZE) {
    setPageIndex(pendingPageIndex);
    setPendingPageIndex(null);
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="border border-border bg-card">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="flex w-full items-start justify-between gap-3 px-3 py-3 text-left transition-colors hover:bg-muted/45 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background sm:items-center sm:px-4"
            aria-label={`${open ? "Collapse" : "Expand"} ${getGroupLabel(group)}`}
          >
            <div className="flex min-w-0 items-start gap-3">
              <GroupIcon group={group} />
              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h4 className="truncate text-sm font-semibold">{getGroupLabel(group)}</h4>
                  {group.repository?.archivedAt ? <Badge variant="muted">Archived</Badge> : null}
                </div>
                {isNoRepository ? (
                  <p className="mt-1 text-xs leading-5 text-muted-foreground">
                    General chats that are not attached to a repository.
                  </p>
                ) : null}
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-3 text-xs text-muted-foreground">
              <span>{group.threadCount} threads</span>
              <span className="hidden sm:inline">{formatRelativeTime(group.lastThreadAt)}</span>
              <CaretDownIcon
                size={14}
                weight="bold"
                className={cn("transition-transform", open ? "rotate-180" : "rotate-0")}
                aria-hidden="true"
              />
            </div>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="border-t border-border">
            {status === "LoadingFirstPage" ? (
              <ThreadRowsSkeleton />
            ) : threadRows.length === 0 ? (
              <p className="px-4 py-5 text-sm text-muted-foreground">No threads in this group.</p>
            ) : (
              <div className="flex flex-col">
                {visibleThreads.map((thread) => (
                  <ThreadHistoryRow
                    key={thread._id}
                    thread={thread}
                    noRepository={isNoRepository}
                    onOpenThread={onOpenThread}
                    onShareThread={onShareThread}
                    onRequestDelete={onRequestDelete}
                  />
                ))}
              </div>
            )}
            {canGoToPreviousPage || canGoToNextPage || isLoadingMore ? (
              <div className="flex justify-end border-t border-border px-4 py-2">
                <PageControls
                  canPrevious={canGoToPreviousPage}
                  canNext={canGoToNextPage}
                  isLoadingNext={isLoadingMore || pendingPageIndex !== null}
                  onPrevious={handlePreviousPage}
                  onNext={handleNextPage}
                />
              </div>
            ) : null}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

function ThreadHistoryRow({
  thread,
  noRepository,
  onOpenThread,
  onShareThread,
  onRequestDelete,
}: {
  thread: HistoryThread;
  noRepository: boolean;
  onOpenThread: (thread: HistoryThread) => void;
  onShareThread: (thread: HistoryThread) => Promise<void>;
  onRequestDelete: (thread: HistoryThread) => void;
}) {
  return (
    <div className="group flex min-w-0 flex-col gap-3 border-t border-border px-3 py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:px-4">
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <h5 className="truncate text-sm font-medium">{thread.title}</h5>
          <Badge variant={noRepository ? "muted" : "outline"}>{getThreadModeLabel(thread, noRepository)}</Badge>
          {thread.activeShare ? <Badge variant="accent">Shared</Badge> : null}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">Latest activity {formatRelativeTime(thread.lastMessageAt)}</p>
      </div>
      <div className="hidden shrink-0 items-center gap-1 opacity-100 transition-opacity sm:flex sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100">
        <Button type="button" variant="ghost" size="sm" onClick={() => onOpenThread(thread)}>
          <ArrowSquareOutIcon weight="bold" />
          Open
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={() => void onShareThread(thread)}>
          <ShareNetwork weight="bold" />
          Share
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => onRequestDelete(thread)}
          aria-label={`Archive ${thread.title}`}
        >
          <ArchiveIcon weight="bold" />
          Archive
        </Button>
      </div>
      <div className="flex sm:hidden">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button type="button" variant="ghost" size="sm" aria-label={`Actions for ${thread.title}`}>
              <DotsThreeVerticalIcon weight="bold" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuGroup>
              <DropdownMenuItem onSelect={() => onOpenThread(thread)}>
                <ArrowSquareOutIcon weight="bold" />
                Open
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => void onShareThread(thread)}>
                <ShareNetwork weight="bold" />
                Share
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onRequestDelete(thread)}>
                <ArchiveIcon weight="bold" />
                Archive
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}

function SharedThreadsSection({
  activeShares,
  canLoadMore,
  isLoadingFirstPage,
  isLoadingMore,
  onLoadMore,
}: {
  activeShares: ActiveShare[];
  canLoadMore: boolean;
  isLoadingFirstPage: boolean;
  isLoadingMore: boolean;
  onLoadMore: () => void;
}) {
  const revokeThreadShare = useMutation(api.chat.threadShares.revokeThreadShare);

  const handleCopy = useCallback(async (token: string) => {
    const publicUrl = new URL(sharedThreadPath(token), window.location.origin).toString();
    const copied = await copyText(publicUrl);
    if (copied) {
      toast.success("Share link copied");
    } else {
      toast.error("Could not copy the share link.");
    }
  }, []);

  const handleRevoke = useCallback(
    async (shareId: Id<"threadShares">) => {
      try {
        await revokeThreadShare({ shareId });
        toast.success("Share link revoked");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to revoke share link.");
      }
    },
    [revokeThreadShare],
  );

  return (
    <section className="flex flex-col gap-3" aria-labelledby="shared-threads-heading">
      <div className="flex items-center justify-between gap-3">
        <h3 id="shared-threads-heading" className="text-sm font-semibold">
          Shared Threads
        </h3>
        {isLoadingFirstPage ? (
          <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <Spinner size={13} />
            Loading
          </span>
        ) : null}
      </div>

      {isLoadingFirstPage ? (
        <SharedRowsSkeleton />
      ) : activeShares.length === 0 ? (
        <div className="border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
          No active public share links.
        </div>
      ) : (
        <div className="border border-border bg-card">
          {activeShares.map((share) => (
            <div
              key={share._id}
              className="flex flex-col gap-3 border-t border-border px-3 py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:px-4"
            >
              <div className="min-w-0">
                <h4 className="truncate text-sm font-medium">{share.title}</h4>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                  <span className="truncate">{share.repositoryLabel}</span>
                  <span>{formatExpiry(share.expiresAt)}</span>
                </div>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button type="button" variant="secondary" size="sm" onClick={() => void handleCopy(share.token)}>
                  <CopyIcon weight="bold" />
                  Copy link
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => void handleRevoke(share._id)}>
                  <LinkBreak weight="bold" />
                  Revoke
                </Button>
              </div>
            </div>
          ))}
          {canLoadMore || isLoadingMore ? (
            <div className="flex justify-center border-t border-border px-4 py-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!canLoadMore || isLoadingMore}
                onClick={onLoadMore}
              >
                {isLoadingMore ? <Spinner size={13} /> : null}
                <ButtonStateText
                  current={isLoadingMore ? "Loading" : "Load more links"}
                  states={["Load more links", "Loading"]}
                />
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function GroupIcon({ group }: { group: HistoryGroup }) {
  const isNoRepository = !group.repositoryId;
  const visibility = group.repository?.visibility ?? "unknown";
  return (
    <span className="flex size-8 shrink-0 items-center justify-center border border-border bg-background text-muted-foreground">
      {isNoRepository ? (
        <ChatCircleText size={15} weight="bold" aria-hidden="true" />
      ) : visibility === "private" ? (
        <LockKey size={15} weight="bold" aria-hidden="true" />
      ) : (
        <GlobeHemisphereWest size={15} weight="bold" aria-hidden="true" />
      )}
    </span>
  );
}

function HistoryGroupSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="border border-border bg-card px-4 py-3">
          <div className="flex items-center gap-3">
            <Skeleton className="size-8 shrink-0 rounded-none" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-4 w-44 max-w-full" />
              <Skeleton className="h-3 w-28 max-w-full" />
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function ThreadRowsSkeleton() {
  return (
    <div className="flex flex-col" aria-hidden="true">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="border-t border-border px-4 py-3 first:border-t-0">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-64 max-w-full" />
            <Skeleton className="h-3 w-28" />
          </div>
        </div>
      ))}
    </div>
  );
}

function SharedRowsSkeleton() {
  return (
    <div className="border border-border bg-card" aria-hidden="true">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="border-t border-border px-4 py-3 first:border-t-0">
          <div className="flex flex-col gap-2">
            <Skeleton className="h-4 w-52 max-w-full" />
            <Skeleton className="h-3 w-36 max-w-full" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyHistoryState() {
  return (
    <div className="border border-dashed border-border px-4 py-8 text-center">
      <p className="text-sm font-medium">No chat history yet.</p>
      <p className="mt-1 text-sm text-muted-foreground">Repository and no-repository conversations will appear here.</p>
    </div>
  );
}

function orderHistoryGroups(groups: HistoryGroup[]): HistoryGroup[] {
  const noRepository = groups.filter((group) => !group.repositoryId);
  const repositoryGroups = groups.filter((group) => group.repositoryId);
  return [...noRepository, ...repositoryGroups];
}

function summarizeHistory(groups: HistoryGroup[], activeShares: ActiveShare[]) {
  return groups.reduce(
    (summary, group) => {
      if (group.repositoryId) {
        summary.repositoryThreads += group.threadCount;
      } else {
        summary.noRepositoryChats += group.threadCount;
      }
      return summary;
    },
    { repositoryThreads: 0, noRepositoryChats: 0, sharedLinks: activeShares.length },
  );
}

function getGroupLabel(group: HistoryGroup): string {
  if (!group.repositoryId) {
    return "No repository";
  }
  return group.repository?.sourceRepoFullName ?? "Repository unavailable";
}

function getThreadModeLabel(thread: HistoryThread, noRepository: boolean): string {
  if (noRepository) {
    return "Chat";
  }
  return thread.mode === "library" ? "Library Ask" : "Discuss";
}

async function copyText(text: string): Promise<boolean> {
  if (typeof navigator === "undefined" || !navigator.clipboard) {
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
