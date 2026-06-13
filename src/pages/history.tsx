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
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useStableLoadMoreState } from "@/hooks/use-stable-load-more-state";
import { formatExpiry } from "@/lib/format-expiry";
import { formatRelativeTime } from "@/lib/format";
import { getRepolessThreadKind, getRepolessThreadKindLabel } from "@/lib/repoless-agent";
import type { RepositoryId, ThreadId, ThreadMode } from "@/lib/types";
import { modeAwareThreadPath, repolessThreadPath, sharedThreadPath } from "@/route-paths";

const GROUP_PAGE_SIZE = 8;
const HISTORY_GROUP_ROW_HEIGHT_PX = 72;
const HISTORY_GROUP_ROW_GAP_PX = 8;
const CHAT_HISTORY_PAGE_MIN_HEIGHT =
  GROUP_PAGE_SIZE * HISTORY_GROUP_ROW_HEIGHT_PX + (GROUP_PAGE_SIZE - 1) * HISTORY_GROUP_ROW_GAP_PX;
const THREAD_INITIAL_PAGE_SIZE = 8;
const THREAD_NEXT_PAGE_SIZE = 12;
const SHARE_INITIAL_PAGE_SIZE = 20;
const SHARE_NEXT_PAGE_SIZE = 20;
const HISTORY_SELECTOR_PAGE_SIZE = 100;
export const HISTORY_SELECTOR_NEXT_PAGE_SIZE = 100;
const NO_REPOSITORY_SELECTOR_VALUE = "no_repository";

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
  singleTurnEnabled?: boolean;
  agentEnabled?: boolean;
  agentRole?: string;
  agentInstructions?: string;
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
  threadArchivedAt?: number;
};

export function HistoryPage() {
  const navigate = useNavigate();
  const createOrGetThreadShare = useMutation(api.chat.threadShares.createOrGetThreadShare);
  const archiveThread = useMutation(api.chat.threads.archiveThread);
  const [pendingArchive, setPendingArchive] = useState<HistoryThread | null>(null);
  const [isArchiving, setIsArchiving] = useState(false);
  const [isArchiveOpen, setIsArchiveOpen] = useState(false);
  const [selectedHistoryScope, setSelectedHistoryScope] = useState<string | null>(null);

  const {
    results: groups,
    status: groupsStatus,
    loadMore: loadMoreGroups,
  } = usePaginatedQuery(api.chat.history.listThreadHistoryGroups, {}, { initialNumItems: HISTORY_SELECTOR_PAGE_SIZE });
  const {
    results: activeShares,
    status: activeSharesStatus,
    loadMore: loadMoreActiveShares,
  } = usePaginatedQuery(api.chat.threadShares.listActiveThreadShares, {}, { initialNumItems: SHARE_INITIAL_PAGE_SIZE });

  const orderedGroups = useMemo(() => orderHistoryGroups(groups as HistoryGroup[]), [groups]);
  const selectedGroup = useMemo(
    () =>
      orderedGroups.find((group) => getHistoryScopeValue(group) === selectedHistoryScope) ?? orderedGroups[0] ?? null,
    [orderedGroups, selectedHistoryScope],
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

  const handleConfirmArchive = useCallback(async () => {
    if (!pendingArchive) {
      return;
    }
    setIsArchiving(true);
    try {
      await archiveThread({ threadId: pendingArchive._id });
      toast.success("Thread archived");
      setPendingArchive(null);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to archive thread.");
    } finally {
      setIsArchiving(false);
    }
  }, [archiveThread, pendingArchive]);

  const isLoadingGroups = groupsStatus === "LoadingFirstPage";
  const canLoadMoreGroups = groupsStatus === "CanLoadMore";
  const isLoadingMoreGroups = groupsStatus === "LoadingMore";
  const canLoadMoreShares = activeSharesStatus === "CanLoadMore";
  const isLoadingMoreShares = activeSharesStatus === "LoadingMore";

  return (
    <>
      <section className="flex flex-col gap-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 flex-col gap-1.5">
            <h2 className="text-xl font-semibold tracking-tight">History</h2>
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              Browse active conversations, shared links, and archived threads.
            </p>
          </div>
        </div>

        <SummaryStrip summary={summary} />

        <section className="flex flex-col gap-3" aria-labelledby="chat-history-heading">
          <div className="flex items-center justify-between gap-3">
            <h3 id="chat-history-heading" className="text-sm font-semibold">
              Chat History
            </h3>
            {orderedGroups.length > 0 ? (
              <div className="flex flex-wrap items-center justify-end gap-2">
                <HistoryRepositorySelector
                  groups={orderedGroups}
                  value={getHistoryScopeValue(selectedGroup ?? orderedGroups[0])}
                  onValueChange={setSelectedHistoryScope}
                />
                {canLoadMoreGroups || isLoadingMoreGroups ? (
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    disabled={isLoadingMoreGroups}
                    onClick={() => loadMoreGroups(HISTORY_SELECTOR_NEXT_PAGE_SIZE)}
                  >
                    {isLoadingMoreGroups ? <Spinner size={13} /> : null}
                    <ButtonStateText
                      current={isLoadingMoreGroups ? "Loading" : "Load more repositories"}
                      states={["Load more repositories", "Loading"]}
                    />
                  </Button>
                ) : null}
              </div>
            ) : isLoadingGroups ? (
              <HistoryRepositorySelectorSkeleton />
            ) : null}
          </div>

          <div
            className="flex flex-col overflow-hidden border border-border bg-card"
            style={{ minHeight: CHAT_HISTORY_PAGE_MIN_HEIGHT }}
            role="group"
            aria-label="Chat history pages"
          >
            {isLoadingGroups ? (
              <HistoryGroupSkeleton />
            ) : orderedGroups.length === 0 ? (
              <EmptyHistoryState />
            ) : selectedGroup ? (
              <HistoryThreadsForScope
                key={getHistoryScopeValue(selectedGroup)}
                group={selectedGroup}
                onOpenThread={handleOpenThread}
                onShareThread={handleShareThread}
                onRequestArchive={setPendingArchive}
              />
            ) : (
              <EmptyHistoryState />
            )}
            <div className="mt-auto flex flex-col gap-3 border-t border-border bg-background/40 px-3 py-3 sm:flex-row sm:items-center sm:justify-between">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="w-fit"
                onClick={() => setIsArchiveOpen(true)}
              >
                <ArchiveIcon weight="bold" />
                Open Archive
              </Button>
            </div>
          </div>
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
        open={pendingArchive !== null}
        onOpenChange={(open) => {
          if (!open) setPendingArchive(null);
        }}
        title="Archive thread?"
        description={
          pendingArchive
            ? `${pendingArchive.title} will be removed from active history. You can restore or permanently delete it from Archive.`
            : ""
        }
        actionLabel="Archive thread"
        loadingLabel="Archiving..."
        isPending={isArchiving}
        onConfirm={() => void handleConfirmArchive()}
      />
      <Dialog open={isArchiveOpen} onOpenChange={setIsArchiveOpen}>
        <DialogContent className="flex max-h-[calc(100dvh-2rem)] w-[calc(100vw-2rem)] flex-col overflow-hidden sm:max-w-4xl [scrollbar-gutter:stable]">
          <DialogHeader>
            <DialogTitle>Archived Threads</DialogTitle>
          </DialogHeader>
          <div className="min-h-0 overflow-y-auto pr-1 [scrollbar-gutter:stable]">
            <ArchiveSettingsSection showThreadHeading={false} onBackToChat={() => setIsArchiveOpen(false)} />
          </div>
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
    { label: "Loaded repository threads", value: summary.repositoryThreads },
    { label: "Loaded no-repository threads", value: summary.noRepositoryChats },
    { label: "Shared links", value: summary.sharedLinks },
  ];
  return (
    <div className="flex flex-col border-y border-border sm:flex-row" aria-label="History summary">
      {items.map((item) => (
        <div
          key={item.label}
          className="flex min-w-0 items-baseline justify-between gap-3 border-t border-border px-4 py-2 first:border-t-0 sm:flex-1 sm:justify-start sm:border-l sm:border-t-0 sm:first:border-l-0"
          aria-label={`${item.label}: ${item.value}`}
        >
          <span className="font-mono text-base font-semibold leading-none tabular-nums text-foreground">
            {item.value}
          </span>
          <span className="truncate text-xs font-medium leading-4 text-muted-foreground">{item.label}</span>
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

function getLoadedPageIndex(itemCount: number, requestedPageIndex: number, pageSize: number): number {
  if (itemCount === 0) return 0;
  return Math.min(requestedPageIndex, Math.ceil(itemCount / pageSize) - 1);
}

function HistoryRepositorySelector({
  groups,
  value,
  onValueChange,
}: {
  groups: HistoryGroup[];
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger aria-label="Select chat history repository" className="h-9 w-56 max-w-[65vw] bg-background">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {groups.map((group) => (
            <SelectItem key={group._id} value={getHistoryScopeValue(group)}>
              {getGroupLabel(group)}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function HistoryRepositorySelectorSkeleton() {
  return (
    <div
      className="flex h-9 w-56 max-w-[65vw] items-center justify-between border border-input bg-background px-3"
      aria-hidden="true"
      data-history-repository-selector-skeleton="true"
    >
      <Skeleton className="h-4 w-32 max-w-[calc(100%-2rem)]" />
      <Skeleton className="size-4 shrink-0" />
    </div>
  );
}

function HistoryThreadsForScope({
  group,
  onOpenThread,
  onShareThread,
  onRequestArchive,
}: {
  group: HistoryGroup;
  onOpenThread: (thread: HistoryThread) => void;
  onShareThread: (thread: HistoryThread) => Promise<void>;
  onRequestArchive: (thread: HistoryThread) => void;
}) {
  const [pageIndex, setPageIndex] = useState(0);
  const repositoryIdArg = group.repositoryId ?? null;
  const {
    results: threads,
    status,
    loadMore,
  } = usePaginatedQuery(
    api.chat.history.listThreadsForHistoryGroup,
    { repositoryId: repositoryIdArg },
    {
      initialNumItems: THREAD_INITIAL_PAGE_SIZE,
    },
  );
  const isNoRepository = !group.repositoryId;
  const canLoadMore = status === "CanLoadMore";
  const isLoadingMore = status === "LoadingMore";
  const threadRows = threads as HistoryThread[];
  const displayedPageIndex = getLoadedPageIndex(threadRows.length, pageIndex, THREAD_INITIAL_PAGE_SIZE);
  const visibleThreads = threadRows.slice(
    displayedPageIndex * THREAD_INITIAL_PAGE_SIZE,
    (displayedPageIndex + 1) * THREAD_INITIAL_PAGE_SIZE,
  );
  const isPendingPage = pageIndex > displayedPageIndex && (canLoadMore || isLoadingMore);
  const canGoToPreviousPage = displayedPageIndex > 0 || isPendingPage;
  const canGoToNextPage = (displayedPageIndex + 1) * THREAD_INITIAL_PAGE_SIZE < threadRows.length || canLoadMore;
  const loadMoreState = useStableLoadMoreState({
    canLoadMore: canGoToNextPage,
    isLoadingMore: isLoadingMore || isPendingPage,
  });
  const markLoadMoreStarted = loadMoreState.markLoadMoreStarted;
  const handlePreviousPage = useCallback(() => {
    setPageIndex(Math.max(0, displayedPageIndex - 1));
  }, [displayedPageIndex]);
  const handleNextPage = useCallback(() => {
    const nextPageIndex = displayedPageIndex + 1;
    const nextStart = nextPageIndex * THREAD_INITIAL_PAGE_SIZE;
    if (nextStart < threadRows.length) {
      setPageIndex(nextPageIndex);
      return;
    }
    if (canLoadMore && !isLoadingMore) {
      markLoadMoreStarted();
      setPageIndex(nextPageIndex);
      loadMore(THREAD_NEXT_PAGE_SIZE);
    }
  }, [canLoadMore, displayedPageIndex, isLoadingMore, loadMore, markLoadMoreStarted, threadRows.length]);

  return (
    <div className="flex flex-1 flex-col bg-card">
      <div className="flex items-start justify-between gap-3 border-b border-border px-3 py-3 sm:items-center sm:px-4">
        <div className="flex min-w-0 items-start gap-3">
          <GroupIcon group={group} />
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h4 className="truncate text-sm font-semibold">{getGroupLabel(group)}</h4>
              {group.repository?.archivedAt ? <Badge variant="muted">Archived</Badge> : null}
            </div>
            {isNoRepository ? (
              <p className="mt-1 text-xs leading-5 text-muted-foreground">
                No-repository threads split into Agents and Conversations.
              </p>
            ) : null}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 text-xs text-muted-foreground sm:flex-row sm:items-center sm:gap-3">
          <span>{group.threadCount} threads</span>
          <span className="hidden sm:inline">{formatRelativeTime(group.lastThreadAt)}</span>
        </div>
      </div>
      <div>
        {status === "LoadingFirstPage" ? (
          <ThreadRowsSkeleton />
        ) : threadRows.length === 0 ? (
          <p className="px-4 py-5 text-sm text-muted-foreground">
            {isNoRepository ? "No threads in this group." : "No threads in this repository."}
          </p>
        ) : (
          <div className="flex flex-col">
            {visibleThreads.map((thread) => (
              <ThreadHistoryRow
                key={thread._id}
                thread={thread}
                noRepository={isNoRepository}
                onOpenThread={onOpenThread}
                onShareThread={onShareThread}
                onRequestArchive={onRequestArchive}
              />
            ))}
          </div>
        )}
        {canGoToPreviousPage || loadMoreState.shouldRender ? (
          <div className="flex justify-end border-t border-border px-4 py-2">
            <PageControls
              canPrevious={canGoToPreviousPage}
              canNext={loadMoreState.canLoadMore}
              isLoadingNext={loadMoreState.isLoadingMore}
              onPrevious={handlePreviousPage}
              onNext={handleNextPage}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ThreadHistoryRow({
  thread,
  noRepository,
  onOpenThread,
  onShareThread,
  onRequestArchive,
}: {
  thread: HistoryThread;
  noRepository: boolean;
  onOpenThread: (thread: HistoryThread) => void;
  onShareThread: (thread: HistoryThread) => Promise<void>;
  onRequestArchive: (thread: HistoryThread) => void;
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
      <div className="hidden shrink-0 items-center gap-1 sm:flex">
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
          onClick={() => onRequestArchive(thread)}
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
              <DropdownMenuItem onSelect={() => onRequestArchive(thread)}>
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
  const loadMoreState = useStableLoadMoreState({ canLoadMore, isLoadingMore });
  const settledCanLoadMore = loadMoreState.canLoadMore;
  const settledIsLoadingMore = loadMoreState.isLoadingMore;

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
      ) : activeShares.length === 0 && !settledCanLoadMore && !settledIsLoadingMore ? (
        <div className="animate-fade-in border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
          No active public share links.
        </div>
      ) : (
        <div className="animate-fade-in border border-border bg-card">
          {activeShares.map((share) => (
            <div
              key={share._id}
              className="flex flex-col gap-3 border-t border-border px-3 py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:px-4"
            >
              <div className="min-w-0">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <h4 className="truncate text-sm font-medium">{share.title}</h4>
                  {share.threadArchivedAt ? <Badge variant="muted">Archived thread</Badge> : null}
                </div>
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
          {loadMoreState.shouldRender ? (
            <div className="flex justify-center border-t border-border px-4 py-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!loadMoreState.canLoadMore || loadMoreState.isLoadingMore}
                onClick={() => {
                  loadMoreState.markLoadMoreStarted();
                  onLoadMore();
                }}
              >
                {loadMoreState.isLoadingMore ? <Spinner size={13} /> : null}
                <ButtonStateText
                  current={loadMoreState.isLoadingMore ? "Loading" : "Load more links"}
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
    <div className="flex flex-1 flex-col bg-card" aria-hidden="true" data-history-group-skeleton="true">
      <div className="flex items-start justify-between gap-3 border-b border-border px-3 py-3 sm:items-center sm:px-4">
        <div className="flex min-w-0 items-start gap-3">
          <Skeleton className="size-8 shrink-0 rounded-none" />
          <div className="min-w-0 flex-1">
            <Skeleton className="h-4 w-44 max-w-full" />
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1 sm:flex-row sm:items-center sm:gap-3">
          <Skeleton className="h-3 w-16" />
          <Skeleton className="hidden h-3 w-12 sm:block" />
        </div>
      </div>
      <ThreadRowsSkeleton />
    </div>
  );
}

function ThreadRowsSkeleton() {
  return (
    <div className="flex flex-col" aria-hidden="true" data-history-thread-rows-skeleton="true">
      {Array.from({ length: 3 }).map((_, index) => (
        <div
          key={index}
          className="flex min-w-0 flex-col gap-3 border-t border-border px-3 py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between sm:px-4"
        >
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <Skeleton className="h-4 w-64 max-w-full" />
              <Skeleton className="h-5 w-16" />
            </div>
            <Skeleton className="mt-1 h-3 w-36 max-w-full" />
          </div>
          <div className="hidden shrink-0 items-center gap-1 sm:flex">
            <Skeleton className="h-8 w-20" data-history-button-skeleton="true" />
            <Skeleton className="h-8 w-20" data-history-button-skeleton="true" />
            <Skeleton className="h-8 w-24" data-history-button-skeleton="true" />
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
  return [...repositoryGroups, ...noRepository];
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

function getHistoryScopeValue(group: HistoryGroup): string {
  return group.repositoryId ?? NO_REPOSITORY_SELECTOR_VALUE;
}

function getThreadModeLabel(thread: HistoryThread, noRepository: boolean): string {
  if (noRepository) {
    return getRepolessThreadKindLabel(getRepolessThreadKind(thread));
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
