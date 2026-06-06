import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, usePaginatedQuery } from "convex/react";
import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  CaretLeftIcon,
  CaretRightIcon,
  ChatCircleText,
  ClockCounterClockwiseIcon,
  MagnifyingGlassIcon,
  TrashIcon,
  XIcon,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { ButtonStateText } from "@/components/ui/button-state-text";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { useStableLoadMoreState } from "@/hooks/use-stable-load-more-state";
import { toUserErrorMessage } from "@/lib/errors";
import { formatRelativeTime, formatTimestamp } from "@/lib/format";
import type { RepositoryId, ThreadId, ThreadMode } from "@/lib/types";
import { DEFAULT_AUTHENTICATED_PATH } from "@/route-paths";

const INITIAL_PAGE_SIZE = 20;
const NEXT_PAGE_SIZE = 20;
const THREAD_ARCHIVE_PAGE_SIZE = 10;

export function ArchivePage() {
  const navigate = useNavigate();
  const handleBack = useCallback(() => void navigate(DEFAULT_AUTHENTICATED_PATH), [navigate]);

  return (
    <div className="flex h-dvh w-full flex-1 flex-col overflow-y-auto bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur supports-backdrop-filter:bg-background/80">
        <div className="mx-auto flex h-14 w-full max-w-4xl items-center gap-3 px-4 sm:px-6">
          <Link
            to={DEFAULT_AUTHENTICATED_PATH}
            className="group flex min-w-0 shrink-0 items-center gap-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
            aria-label="Systify · back to chat"
            title="Back to chat"
          >
            <Logo size={26} />
            <span className="truncate font-mono text-[15px] font-semibold tracking-tight text-foreground transition-colors group-hover:text-muted-foreground">
              Systify
            </span>
          </Link>
          <CaretRightIcon size={12} weight="bold" aria-hidden="true" className="shrink-0 text-muted-foreground/60" />
          <h1 className="flex min-w-0 items-center gap-2">
            <ArchiveIcon size={14} weight="bold" className="shrink-0 text-muted-foreground" aria-hidden="true" />
            <span className="truncate text-sm font-semibold tracking-tight text-foreground">Archive</span>
          </h1>
        </div>
      </header>

      <main className="flex-1 px-4 pb-10 pt-5 sm:px-6 sm:pb-12 sm:pt-8">
        <div className="mx-auto w-full max-w-4xl">
          <Button asChild variant="ghost" size="sm" className="-ml-2 mb-3 text-muted-foreground hover:text-foreground">
            <Link to={DEFAULT_AUTHENTICATED_PATH}>
              <CaretLeftIcon weight="bold" />
              Back to chat
            </Link>
          </Button>
          <ArchiveSettingsSection onBackToChat={handleBack} />
        </div>
      </main>
    </div>
  );
}

export function ArchiveSettingsSection({ onBackToChat }: { onBackToChat?: () => void }) {
  const navigate = useNavigate();
  const [pendingPermanentDelete, setPendingPermanentDelete] = useState<Doc<"repositories"> | null>(null);
  const [pendingThreadPermanentDelete, setPendingThreadPermanentDelete] = useState<ArchivedThread | null>(null);
  const [query, setQuery] = useState("");
  const handleBack = useCallback(
    () => (onBackToChat ? onBackToChat() : void navigate(DEFAULT_AUTHENTICATED_PATH)),
    [navigate, onBackToChat],
  );

  const trimmedQuery = query.trim();
  const isSearching = trimmedQuery.length > 0;

  const {
    results: archived,
    status,
    loadMore,
  } = usePaginatedQuery(
    api.repositories.listArchivedRepositories,
    { searchTerm: isSearching ? trimmedQuery : undefined },
    { initialNumItems: INITIAL_PAGE_SIZE },
  );

  const isLoadingFirstPage = status === "LoadingFirstPage";
  const canLoadMore = status === "CanLoadMore";
  const isLoadingMore = status === "LoadingMore";
  const loadMoreState = useStableLoadMoreState({ canLoadMore, isLoadingMore });
  // `usePaginatedQuery` reports an internal "LoadingPaused" state on disconnect;
  // we treat it as "settled, can't load more right now" — same UI as exhausted.
  const isExhausted = status === "Exhausted";

  return (
    <>
      <ArchivedThreadsSection onRequestPermanentDelete={setPendingThreadPermanentDelete} />
      <ArchiveContent
        archived={archived}
        isLoadingFirstPage={isLoadingFirstPage}
        canLoadMore={loadMoreState.canLoadMore}
        isLoadingMore={loadMoreState.isLoadingMore}
        isExhausted={isExhausted}
        isSearching={isSearching}
        query={query}
        onQueryChange={setQuery}
        onLoadMore={() => {
          loadMoreState.markLoadMoreStarted();
          loadMore(NEXT_PAGE_SIZE);
        }}
        onBackToChat={handleBack}
        onRequestPermanentDelete={setPendingPermanentDelete}
      />
      <PermanentDeleteDialog repo={pendingPermanentDelete} onClose={() => setPendingPermanentDelete(null)} />
      <PermanentDeleteThreadDialog
        thread={pendingThreadPermanentDelete}
        onClose={() => setPendingThreadPermanentDelete(null)}
      />
    </>
  );
}

type ArchivedThread = {
  _id: ThreadId;
  repositoryId?: RepositoryId;
  title: string;
  mode: ThreadMode;
  archivedAt: number;
  repository: {
    _id: RepositoryId;
    sourceRepoFullName: string;
  } | null;
};

function ArchivedThreadsSection({
  onRequestPermanentDelete,
}: {
  onRequestPermanentDelete: (thread: ArchivedThread) => void;
}) {
  const {
    results: archivedThreads,
    status,
    loadMore,
  } = usePaginatedQuery(api.chat.threads.listArchivedThreads, {}, { initialNumItems: THREAD_ARCHIVE_PAGE_SIZE });

  const isLoadingFirstPage = status === "LoadingFirstPage";
  const isLoadingMore = status === "LoadingMore";
  const canLoadMore = status === "CanLoadMore";
  const loadMoreState = useStableLoadMoreState({ canLoadMore, isLoadingMore });
  const rows = archivedThreads as ArchivedThread[];

  return (
    <section className="mb-6 flex flex-col gap-3" aria-labelledby="archived-threads-heading">
      <div>
        <h2 id="archived-threads-heading" className="text-base font-semibold tracking-tight">
          Archived Threads
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">Restore archived threads or delete them permanently.</p>
      </div>
      {isLoadingFirstPage ? (
        <ArchiveListSkeleton />
      ) : rows.length === 0 ? (
        <div className="border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
          No archived threads.
        </div>
      ) : (
        <div className="border border-border bg-card">
          {rows.map((thread) => (
            <ArchivedThreadRow key={thread._id} thread={thread} onRequestPermanentDelete={onRequestPermanentDelete} />
          ))}
          {loadMoreState.shouldRender ? (
            <div className="flex justify-end border-t border-border px-3 py-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!loadMoreState.canLoadMore || loadMoreState.isLoadingMore}
                onClick={() => {
                  loadMoreState.markLoadMoreStarted();
                  loadMore(THREAD_ARCHIVE_PAGE_SIZE);
                }}
              >
                {loadMoreState.isLoadingMore ? <Spinner size={13} /> : null}
                <ButtonStateText
                  current={loadMoreState.isLoadingMore ? "Loading" : "Next"}
                  states={["Next", "Loading"]}
                />
                <CaretRightIcon weight="bold" />
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </section>
  );
}

function ArchivedThreadRow({
  thread,
  onRequestPermanentDelete,
}: {
  thread: ArchivedThread;
  onRequestPermanentDelete: (thread: ArchivedThread) => void;
}) {
  const restoreThread = useMutation(api.chat.threads.restoreThread);
  const [isRestoring, handleRestore] = useAsyncCallback(
    useCallback(async () => {
      try {
        await restoreThread({ threadId: thread._id });
        toast.success("Thread restored");
      } catch (error) {
        toast.error(toUserErrorMessage(error, "Failed to restore the thread."));
      }
    }, [restoreThread, thread._id]),
  );
  const modeLabel = thread.repositoryId ? (thread.mode === "library" ? "Library Ask" : "Discuss") : "Chat";

  return (
    <div className="flex flex-col gap-3 border-t border-border px-3 py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center border border-border bg-background text-muted-foreground">
          <ChatCircleText size={14} weight="bold" />
        </div>
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{thread.title}</h3>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
            <span>{modeLabel}</span>
            {thread.repository ? <span className="truncate">{thread.repository.sourceRepoFullName}</span> : null}
            <span>Archived {formatRelativeTime(thread.archivedAt)}</span>
          </div>
        </div>
      </div>
      <div className="flex shrink-0 gap-2">
        <Button type="button" variant="secondary" size="sm" disabled={isRestoring} onClick={() => void handleRestore()}>
          <ArrowCounterClockwiseIcon weight="bold" />
          <ButtonStateText current={isRestoring ? "Restoring…" : "Restore"} states={["Restore", "Restoring…"]} />
        </Button>
        <Button type="button" variant="destructive" size="sm" onClick={() => onRequestPermanentDelete(thread)}>
          <TrashIcon weight="bold" />
          Delete now
        </Button>
      </div>
    </div>
  );
}

function ArchiveContent({
  archived,
  isLoadingFirstPage,
  canLoadMore,
  isLoadingMore,
  isExhausted,
  isSearching,
  query,
  onQueryChange,
  onLoadMore,
  onBackToChat,
  onRequestPermanentDelete,
}: {
  archived: ReadonlyArray<Doc<"repositories">>;
  isLoadingFirstPage: boolean;
  canLoadMore: boolean;
  isLoadingMore: boolean;
  isExhausted: boolean;
  isSearching: boolean;
  query: string;
  onQueryChange: (value: string) => void;
  onLoadMore: () => void;
  onBackToChat: () => void;
  onRequestPermanentDelete: (repo: Doc<"repositories">) => void;
}) {
  // Description + search input always render so the layout stays stable
  // across loading, empty, and populated states. Only the area below them
  // swaps between skeleton, empty state, no-results, or the list itself.
  return (
    <>
      <p className="mb-4 text-sm leading-relaxed text-muted-foreground sm:mb-5">
        Threads, messages, and analysis artifacts are preserved while sandboxes are stopped to free resources. After
        restoring, sync the repository to provision a fresh sandbox before resuming chat.
      </p>

      <ArchiveSearchInput query={query} onQueryChange={onQueryChange} />

      {isLoadingFirstPage && !isSearching ? (
        <ArchiveListSkeleton />
      ) : isLoadingFirstPage && isSearching ? (
        <SearchPendingState />
      ) : !isSearching && archived.length === 0 && isExhausted ? (
        <ArchiveEmptyState onBackToChat={onBackToChat} />
      ) : archived.length === 0 ? (
        <SearchNoResults query={query} onClear={() => onQueryChange("")} />
      ) : (
        <ArchiveList
          archived={archived}
          canLoadMore={canLoadMore}
          isLoadingMore={isLoadingMore}
          isExhausted={isExhausted}
          onLoadMore={onLoadMore}
          onRequestPermanentDelete={onRequestPermanentDelete}
        />
      )}
    </>
  );
}

function ArchiveList({
  archived,
  canLoadMore,
  isLoadingMore,
  isExhausted,
  onLoadMore,
  onRequestPermanentDelete,
}: {
  archived: ReadonlyArray<Doc<"repositories">>;
  canLoadMore: boolean;
  isLoadingMore: boolean;
  isExhausted: boolean;
  onLoadMore: () => void;
  onRequestPermanentDelete: (repo: Doc<"repositories">) => void;
}) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  // Keep `onLoadMore` reachable from the observer callback without re-creating
  // the observer every render — the IntersectionObserver instance is keyed
  // only on `canLoadMore`, so a stable ref pattern avoids a teardown thrash.
  const onLoadMoreRef = useRef(onLoadMore);
  useEffect(() => {
    onLoadMoreRef.current = onLoadMore;
  }, [onLoadMore]);

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !canLoadMore) {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          onLoadMoreRef.current();
        }
      },
      { rootMargin: "320px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [canLoadMore]);

  return (
    <>
      <ul className="mt-4 flex flex-col gap-2.5">
        {archived.map((repo) => (
          <li key={repo._id}>
            <ArchiveRow repo={repo} onRequestPermanentDelete={onRequestPermanentDelete} />
          </li>
        ))}
      </ul>

      {/*
        Sentinel + footer state. The sentinel sits ~320px above the visible
        bottom so loadMore fires before the user reaches the actual end of
        the list — keeping infinite scroll feeling continuous instead of
        bumpy. When `canLoadMore` flips to false the observer unsubscribes
        and the footer renders one of the terminal states below.
      */}
      <div ref={sentinelRef} aria-hidden="true" className="h-px" />

      <div className="mt-4 flex items-center justify-center" aria-live="polite">
        {isLoadingMore ? (
          <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
            <Spinner size={14} />
            Loading more
          </div>
        ) : isExhausted && archived.length > INITIAL_PAGE_SIZE ? (
          <p className="py-2 text-xs text-muted-foreground">End of archive · {archived.length} repositories</p>
        ) : null}
      </div>
    </>
  );
}

function ArchiveListSkeleton() {
  return (
    <ul aria-hidden="true" className="mt-4 flex flex-col gap-2.5">
      {Array.from({ length: 4 }).map((_, index) => (
        <li key={index}>
          <Card className="p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
              <div className="flex min-w-0 items-start gap-3">
                <Skeleton className="size-8 shrink-0" />
                <div className="flex min-w-0 flex-1 flex-col gap-2">
                  <Skeleton className="h-4 w-40" />
                  <Skeleton className="h-3 w-28" />
                </div>
              </div>
              <div className="flex gap-2 sm:shrink-0">
                <Skeleton className="h-8 flex-1 sm:w-24 sm:flex-none" />
                <Skeleton className="h-8 flex-1 sm:w-32 sm:flex-none" />
              </div>
            </div>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function SearchPendingState() {
  return (
    <div className="mt-4 flex items-center justify-center border border-dashed border-border bg-card/40 px-6 py-10 text-center">
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner size={14} />
        Searching archived repositories
      </div>
    </div>
  );
}

function ArchiveEmptyState({ onBackToChat }: { onBackToChat: () => void }) {
  return (
    <div className="mt-4 flex flex-col items-center justify-center px-4 py-12 text-center sm:py-16">
      <h2 className="text-base font-semibold tracking-tight sm:text-lg">Nothing in your archive</h2>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
        Archived repositories rest here. Restore or delete any time.
      </p>
      <Button variant="secondary" size="sm" className="mt-6" onClick={onBackToChat}>
        <CaretLeftIcon weight="bold" />
        Back to chat
      </Button>
    </div>
  );
}

function ArchiveSearchInput({ query, onQueryChange }: { query: string; onQueryChange: (value: string) => void }) {
  return (
    <div className="relative">
      <MagnifyingGlassIcon
        size={14}
        weight="bold"
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
      <Input
        type="search"
        value={query}
        onChange={(e) => onQueryChange(e.target.value)}
        placeholder="Search archived repositories"
        aria-label="Search archived repositories"
        className="pl-9 pr-9"
      />
      {query ? (
        <button
          type="button"
          onClick={() => onQueryChange("")}
          aria-label="Clear search"
          className="absolute right-2 top-1/2 flex size-6 -translate-y-1/2 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"
        >
          <XIcon size={12} weight="bold" />
        </button>
      ) : null}
    </div>
  );
}

function SearchNoResults({ query, onClear }: { query: string; onClear: () => void }) {
  return (
    <div className="mt-4 flex flex-col items-center justify-center border border-dashed border-border bg-card/40 px-6 py-10 text-center">
      <MagnifyingGlassIcon size={22} weight="duotone" className="text-muted-foreground" />
      <p className="mt-3 text-sm text-foreground">
        No matches for <span className="font-medium">&ldquo;{query}&rdquo;</span>
      </p>
      <p className="mt-1 text-xs text-muted-foreground">Try a different name or clear the search.</p>
      <Button variant="ghost" size="sm" className="mt-4" onClick={onClear}>
        Clear search
      </Button>
    </div>
  );
}

function ArchiveRow({
  repo,
  onRequestPermanentDelete,
}: {
  repo: Doc<"repositories">;
  onRequestPermanentDelete: (repo: Doc<"repositories">) => void;
}) {
  const restoreRepository = useMutation(api.repositories.restoreRepository);

  const [isRestoring, handleRestore] = useAsyncCallback(
    useCallback(async () => {
      try {
        await restoreRepository({ repositoryId: repo._id as RepositoryId });
        toast.success("Repository restored", {
          description: `${repo.sourceRepoFullName} is back in your repositories.`,
        });
      } catch (error) {
        toast.error(toUserErrorMessage(error, "Failed to restore the repository."));
      }
    }, [repo._id, repo.sourceRepoFullName, restoreRepository]),
  );

  const archivedLabel = formatRelativeTime(repo.archivedAt!);

  return (
    <Card className="p-4 transition-colors hover:border-foreground/25">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center border border-border bg-background text-muted-foreground">
            <ArchiveIcon size={14} weight="bold" />
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-sm font-semibold tracking-tight sm:text-base">{repo.sourceRepoFullName}</h3>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground sm:text-[13px]">
              <span className="inline-flex items-center gap-1">
                <ClockCounterClockwiseIcon size={12} weight="bold" />
                Archived {archivedLabel}
              </span>
              {repo.lastImportedAt ? (
                <span className="truncate">Last imported {formatTimestamp(repo.lastImportedAt)}</span>
              ) : null}
            </div>
          </div>
        </div>
        <div className="flex flex-row gap-2 sm:shrink-0">
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={isRestoring}
            onClick={() => void handleRestore()}
            className="flex-1 sm:flex-none"
          >
            <ArrowCounterClockwiseIcon weight="bold" />
            <ButtonStateText current={isRestoring ? "Restoring…" : "Restore"} states={["Restore", "Restoring…"]} />
          </Button>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => onRequestPermanentDelete(repo)}
            className="flex-1 sm:flex-none"
            aria-label={`Delete ${repo.sourceRepoFullName} permanently`}
          >
            <TrashIcon weight="bold" />
            <span className="sm:hidden">Delete</span>
            <span className="hidden sm:inline">Delete permanently</span>
          </Button>
        </div>
      </div>
    </Card>
  );
}

function PermanentDeleteDialog({ repo, onClose }: { repo: Doc<"repositories"> | null; onClose: () => void }) {
  const deleteRepository = useMutation(api.repositories.deleteRepository);

  const [isDeleting, handleDelete] = useAsyncCallback(
    useCallback(async () => {
      if (!repo) return;
      try {
        await deleteRepository({ repositoryId: repo._id as RepositoryId });
        toast.success("Repository deleted permanently");
        onClose();
      } catch (error) {
        toast.error(toUserErrorMessage(error, "Failed to delete the repository."));
      }
    }, [deleteRepository, onClose, repo]),
  );

  return (
    <ConfirmDialog
      open={repo !== null}
      onOpenChange={(open) => !open && onClose()}
      title="Permanently delete repository?"
      description={
        repo
          ? `${repo.sourceRepoFullName} will be permanently deleted along with its threads, messages, analysis artifacts, jobs, and indexed files. This cannot be undone.`
          : ""
      }
      actionLabel="Delete permanently"
      loadingLabel="Deleting…"
      isPending={isDeleting}
      onConfirm={() => void handleDelete()}
    />
  );
}

function PermanentDeleteThreadDialog({ thread, onClose }: { thread: ArchivedThread | null; onClose: () => void }) {
  const deleteArchivedThread = useMutation(api.chat.threads.deleteArchivedThread);

  const [isDeleting, handleDelete] = useAsyncCallback(
    useCallback(async () => {
      if (!thread) return;
      try {
        await deleteArchivedThread({ threadId: thread._id });
        toast.success("Thread deleted permanently");
        onClose();
      } catch (error) {
        toast.error(toUserErrorMessage(error, "Failed to delete the thread."));
      }
    }, [deleteArchivedThread, onClose, thread]),
  );

  return (
    <ConfirmDialog
      open={thread !== null}
      onOpenChange={(open) => !open && onClose()}
      title="Permanently delete thread?"
      description={
        thread
          ? `${thread.title} will be permanently deleted along with its messages and share links. This cannot be undone.`
          : ""
      }
      actionLabel="Delete permanently"
      loadingLabel="Deleting…"
      isPending={isDeleting}
      onConfirm={() => void handleDelete()}
    />
  );
}
