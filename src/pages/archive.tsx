import { useCallback, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  CaretLeftIcon,
  CaretRightIcon,
  ChatCircleText,
  ClockCounterClockwiseIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { ButtonStateText } from "@/components/ui/button-state-text";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { toUserErrorMessage } from "@/lib/errors";
import { formatRelativeTime, formatTimestamp } from "@/lib/format";
import type { RepositoryId, ThreadId, ThreadMode } from "@/lib/types";
import { DEFAULT_AUTHENTICATED_PATH } from "@/route-paths";

const REPOSITORY_ARCHIVE_PAGE_SIZE = 7;
const NO_REPOSITORY_ARCHIVE_SCOPE_VALUE = "no_repository";
const DEFAULT_ARCHIVE_SCOPE_LABEL = "Choose repository / workspace";
const THREAD_ARCHIVE_LIST_HEIGHT_CLASS = "h-[45.5rem] sm:h-[29.75rem]";
const THREAD_ARCHIVE_ROW_HEIGHT_CLASS = "h-[6.5rem] sm:h-[4.25rem]";
const REPOSITORY_ARCHIVE_LIST_HEIGHT_CLASS = "h-[59.75rem] sm:h-[42.25rem]";
const REPOSITORY_ARCHIVE_ROW_HEIGHT_CLASS = "h-32 sm:h-[5.5rem]";

export function ArchivePage() {
  const navigate = useNavigate();
  const handleBack = useCallback(() => void navigate(DEFAULT_AUTHENTICATED_PATH), [navigate]);

  return (
    <div className="flex h-full w-full flex-1 flex-col overflow-y-auto bg-background [scrollbar-gutter:stable]">
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

export function ArchiveSettingsSection({
  showThreadHeading = true,
}: {
  onBackToChat?: () => void;
  showThreadHeading?: boolean;
}) {
  const [pendingPermanentDelete, setPendingPermanentDelete] = useState<Doc<"repositories"> | null>(null);
  const [pendingThreadPermanentDelete, setPendingThreadPermanentDelete] = useState<ArchivedThread | null>(null);
  const [repositoryPageIndex, setRepositoryPageIndex] = useState(0);
  const [repositoryPageCursors, setRepositoryPageCursors] = useState<Array<string | null>>([null]);
  const repositoryPageCursor = repositoryPageCursors[repositoryPageIndex] ?? null;
  const archivedThreadScopes = useQuery(api.chat.threads.listArchivedThreadRepositoryScopes) as
    | ArchivedThreadRepositoryScope[]
    | undefined;

  const repositoryPage = useQuery(api.repositories.listArchivedRepositories, {
    paginationOpts: {
      numItems: REPOSITORY_ARCHIVE_PAGE_SIZE,
      cursor: repositoryPageCursor,
    },
  }) as ArchivedRepositoryPage | undefined;

  const handlePreviousRepositoryPage = useCallback(() => {
    setRepositoryPageIndex((current) => Math.max(0, current - 1));
  }, []);

  const handleNextRepositoryPage = useCallback(() => {
    if (!repositoryPage || repositoryPage.isDone) {
      return;
    }
    const nextPageIndex = repositoryPageIndex + 1;
    setRepositoryPageCursors((current) => {
      const next = current.slice(0, nextPageIndex);
      next[nextPageIndex] = repositoryPage.continueCursor;
      return next;
    });
    setRepositoryPageIndex(nextPageIndex);
  }, [repositoryPage, repositoryPageIndex]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <ArchivedThreadsSection
        scopes={archivedThreadScopes}
        showHeading={showThreadHeading}
        onRequestPermanentDelete={setPendingThreadPermanentDelete}
      />
      <ArchiveContent
        page={repositoryPage}
        pageIndex={repositoryPageIndex}
        isLoadingSuppressed={archivedThreadScopes === undefined}
        onPreviousPage={handlePreviousRepositoryPage}
        onNextPage={handleNextRepositoryPage}
        onRequestPermanentDelete={setPendingPermanentDelete}
      />
      <PermanentDeleteDialog repo={pendingPermanentDelete} onClose={() => setPendingPermanentDelete(null)} />
      <PermanentDeleteThreadDialog
        thread={pendingThreadPermanentDelete}
        onClose={() => setPendingThreadPermanentDelete(null)}
      />
    </div>
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

type ArchivedThreadRepositoryScope = {
  repositoryId: RepositoryId | null;
  label: string;
};

type ArchivedRepositoryPage = {
  page: Doc<"repositories">[];
  isDone: boolean;
  continueCursor: string;
};

type ArchivedThreadPage = {
  page: ArchivedThread[];
  isDone: boolean;
  continueCursor: string;
};

function ArchivedThreadsSection({
  scopes,
  showHeading,
  onRequestPermanentDelete,
}: {
  scopes: ArchivedThreadRepositoryScope[] | undefined;
  showHeading: boolean;
  onRequestPermanentDelete: (thread: ArchivedThread) => void;
}) {
  const restoreArchivedThreadsForRepository = useMutation(api.chat.threads.restoreArchivedThreadsForRepository);
  const deleteArchivedThreadsForRepository = useMutation(api.chat.threads.deleteArchivedThreadsForRepository);
  const [selectedScopeValue, setSelectedScopeValue] = useState<string | null>(null);
  const [pendingBulkAction, setPendingBulkAction] = useState<"restore" | "delete" | null>(null);
  const [threadPageIndex, setThreadPageIndex] = useState(0);
  const [threadPageCursors, setThreadPageCursors] = useState<Array<string | null>>([null]);
  const threadPageCursor = threadPageCursors[threadPageIndex] ?? null;

  const selectedScope =
    scopes?.find((scope) => getArchiveScopeValue(scope) === selectedScopeValue) ?? scopes?.[0] ?? null;
  const selectedRepositoryId = selectedScope?.repositoryId ?? null;

  const archivedThreadPage = useQuery(
    api.chat.threads.listArchivedThreads,
    selectedScope
      ? {
          repositoryId: selectedRepositoryId,
          paginationOpts: {
            numItems: REPOSITORY_ARCHIVE_PAGE_SIZE,
            cursor: threadPageCursor,
          },
        }
      : "skip",
  ) as ArchivedThreadPage | undefined;

  const rows = archivedThreadPage?.page ?? [];
  const isLoadingThreadPage = scopes !== undefined && selectedScope !== null && archivedThreadPage === undefined;
  const shouldRenderThreadPaginationSkeleton = scopes === undefined || isLoadingThreadPage;
  const isBulkActionDisabled =
    scopes === undefined || selectedScope === null || isLoadingThreadPage || rows.length === 0;
  const [isBulkMutating, handleConfirmBulkAction] = useAsyncCallback(
    useCallback(async () => {
      if (!pendingBulkAction || !selectedScope) {
        return;
      }
      try {
        if (pendingBulkAction === "restore") {
          await restoreArchivedThreadsForRepository({ repositoryId: selectedRepositoryId });
          toast.success("Archived threads restored");
        } else {
          await deleteArchivedThreadsForRepository({ repositoryId: selectedRepositoryId });
          toast.success("Archived threads queued for permanent deletion");
        }
        setPendingBulkAction(null);
      } catch (error) {
        toast.error(toUserErrorMessage(error, "Failed to update archived threads."));
      }
    }, [
      deleteArchivedThreadsForRepository,
      pendingBulkAction,
      restoreArchivedThreadsForRepository,
      selectedRepositoryId,
      selectedScope,
    ]),
  );

  const handleScopeChange = useCallback((value: string) => {
    setSelectedScopeValue(value);
    setThreadPageIndex(0);
    setThreadPageCursors([null]);
  }, []);

  const handlePreviousThreadPage = useCallback(() => {
    setThreadPageIndex((current) => Math.max(0, current - 1));
  }, []);

  const handleNextThreadPage = useCallback(() => {
    if (!archivedThreadPage || archivedThreadPage.isDone) {
      return;
    }
    const nextPageIndex = threadPageIndex + 1;
    setThreadPageCursors((current) => {
      const next = current.slice(0, nextPageIndex);
      next[nextPageIndex] = archivedThreadPage.continueCursor;
      return next;
    });
    setThreadPageIndex(nextPageIndex);
  }, [archivedThreadPage, threadPageIndex]);

  return (
    <>
      <section className="flex min-h-0 flex-1 flex-col gap-3" aria-labelledby="archived-threads-heading">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          {showHeading ? (
            <h2 id="archived-threads-heading" className="text-base font-semibold tracking-tight">
              Archived Threads
            </h2>
          ) : (
            <span id="archived-threads-heading" className="sr-only">
              Archived Threads
            </span>
          )}
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={isBulkActionDisabled || isBulkMutating}
              onClick={() => setPendingBulkAction("restore")}
            >
              <ArrowCounterClockwiseIcon weight="bold" />
              Unarchive all
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={isBulkActionDisabled || isBulkMutating}
              onClick={() => setPendingBulkAction("delete")}
            >
              <TrashIcon weight="bold" />
              Permanently delete all
            </Button>
          </div>
          {scopes && scopes.length > 0 ? (
            <ArchiveRepositorySelector
              scopes={scopes}
              value={getArchiveScopeValue(selectedScope ?? scopes[0])}
              onValueChange={handleScopeChange}
            />
          ) : (
            <ArchiveRepositorySelectorPlaceholder />
          )}
        </div>
        <div>
          {scopes === undefined ? (
            <ArchiveThreadListSkeleton />
          ) : scopes.length === 0 ? (
            <div className="border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
              No archived threads.
            </div>
          ) : isLoadingThreadPage ? (
            <ArchiveThreadListSkeleton />
          ) : rows.length === 0 ? (
            <div className="border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
              No archived threads for this repository.
            </div>
          ) : (
            <div className={`overflow-hidden border border-border bg-card ${THREAD_ARCHIVE_LIST_HEIGHT_CLASS}`}>
              {rows.map((thread) => (
                <ArchivedThreadRow
                  key={thread._id}
                  thread={thread}
                  onRequestPermanentDelete={onRequestPermanentDelete}
                />
              ))}
            </div>
          )}
        </div>
        {shouldRenderThreadPaginationSkeleton ? (
          <ArchivePaginationControlsSkeleton />
        ) : archivedThreadPage && rows.length > 0 ? (
          <ArchivePaginationControls
            pageIndex={threadPageIndex}
            canGoNext={!archivedThreadPage.isDone}
            previousLabel="Previous archived threads page"
            nextLabel="Next archived threads page"
            onPreviousPage={handlePreviousThreadPage}
            onNextPage={handleNextThreadPage}
          />
        ) : null}
      </section>
      <ConfirmDialog
        open={pendingBulkAction !== null}
        onOpenChange={(open) => !open && setPendingBulkAction(null)}
        title={pendingBulkAction === "delete" ? "Permanently delete all archived threads?" : "Unarchive all threads?"}
        description={
          selectedScope
            ? pendingBulkAction === "delete"
              ? `All archived threads for ${selectedScope.label} will be permanently deleted with their messages and share links. This cannot be undone.`
              : `All archived threads for ${selectedScope.label} will be restored to active chat history.`
            : ""
        }
        actionLabel={pendingBulkAction === "delete" ? "Permanently delete all" : "Unarchive all"}
        loadingLabel={pendingBulkAction === "delete" ? "Deleting…" : "Restoring…"}
        isPending={isBulkMutating}
        onConfirm={() => void handleConfirmBulkAction()}
      />
    </>
  );
}

function ArchiveRepositorySelector({
  scopes,
  value,
  onValueChange,
}: {
  scopes: ArchivedThreadRepositoryScope[];
  value: string;
  onValueChange: (value: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onValueChange}>
      <SelectTrigger aria-label="Select archive repository" className="h-9 w-full bg-background sm:w-64">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {scopes.map((scope) => (
            <SelectItem key={getArchiveScopeValue(scope)} value={getArchiveScopeValue(scope)}>
              {scope.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function ArchiveRepositorySelectorPlaceholder() {
  return (
    <Select value={NO_REPOSITORY_ARCHIVE_SCOPE_VALUE}>
      <SelectTrigger disabled aria-label="Select archive repository" className="h-9 w-full bg-background sm:w-64">
        <span className="truncate">{DEFAULT_ARCHIVE_SCOPE_LABEL}</span>
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          <SelectItem value={NO_REPOSITORY_ARCHIVE_SCOPE_VALUE}>{DEFAULT_ARCHIVE_SCOPE_LABEL}</SelectItem>
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function getArchiveScopeValue(scope: ArchivedThreadRepositoryScope): string {
  return scope.repositoryId ?? NO_REPOSITORY_ARCHIVE_SCOPE_VALUE;
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
    <div
      className={`flex flex-col gap-3 overflow-hidden border-t border-border px-3 py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between ${THREAD_ARCHIVE_ROW_HEIGHT_CLASS}`}
    >
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex size-8 shrink-0 items-center justify-center border border-border bg-background text-muted-foreground">
          <ChatCircleText size={14} weight="bold" />
        </div>
        <div className="min-w-0 flex-1">
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
          Delete
        </Button>
      </div>
    </div>
  );
}

function ArchiveContent({
  page,
  pageIndex,
  isLoadingSuppressed,
  onPreviousPage,
  onNextPage,
  onRequestPermanentDelete,
}: {
  page: ArchivedRepositoryPage | undefined;
  pageIndex: number;
  isLoadingSuppressed: boolean;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onRequestPermanentDelete: (repo: Doc<"repositories">) => void;
}) {
  return (
    <>
      {page === undefined && !isLoadingSuppressed ? (
        <>
          <ArchiveRepositoryListSkeleton />
          <ArchivePaginationControlsSkeleton />
        </>
      ) : page === undefined ? null : page.page.length === 0 && page.isDone && pageIndex === 0 ? null : (
        <ArchiveList
          archived={page.page}
          pageIndex={pageIndex}
          canGoNext={!page.isDone}
          onPreviousPage={onPreviousPage}
          onNextPage={onNextPage}
          onRequestPermanentDelete={onRequestPermanentDelete}
        />
      )}
    </>
  );
}

function ArchiveList({
  archived,
  pageIndex,
  canGoNext,
  onPreviousPage,
  onNextPage,
  onRequestPermanentDelete,
}: {
  archived: ReadonlyArray<Doc<"repositories">>;
  pageIndex: number;
  canGoNext: boolean;
  onPreviousPage: () => void;
  onNextPage: () => void;
  onRequestPermanentDelete: (repo: Doc<"repositories">) => void;
}) {
  return (
    <>
      <ul className={`mt-4 flex flex-col gap-2.5 overflow-hidden ${REPOSITORY_ARCHIVE_LIST_HEIGHT_CLASS}`}>
        {archived.map((repo) => (
          <li key={repo._id}>
            <ArchiveRow repo={repo} onRequestPermanentDelete={onRequestPermanentDelete} />
          </li>
        ))}
      </ul>

      <ArchivePaginationControls
        pageIndex={pageIndex}
        canGoNext={canGoNext}
        previousLabel="Previous archived repositories page"
        nextLabel="Next archived repositories page"
        onPreviousPage={onPreviousPage}
        onNextPage={onNextPage}
      />
    </>
  );
}

function ArchivePaginationControls({
  pageIndex,
  canGoNext,
  previousLabel,
  nextLabel,
  onPreviousPage,
  onNextPage,
}: {
  pageIndex: number;
  canGoNext: boolean;
  previousLabel: string;
  nextLabel: string;
  onPreviousPage: () => void;
  onNextPage: () => void;
}) {
  return (
    <div className="mt-4 flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between">
      <p className="text-xs text-muted-foreground">Page {pageIndex + 1}</p>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={pageIndex === 0}
          onClick={onPreviousPage}
          aria-label={previousLabel}
        >
          <CaretLeftIcon weight="bold" />
          Previous Page
        </Button>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!canGoNext}
          onClick={onNextPage}
          aria-label={nextLabel}
        >
          Next Page
          <CaretRightIcon weight="bold" />
        </Button>
      </div>
    </div>
  );
}

function ArchivePaginationControlsSkeleton() {
  return (
    <div
      aria-hidden="true"
      data-archive-pagination-skeleton="true"
      className="mt-4 flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <Skeleton className="h-4 w-12" />
      <div className="flex gap-2">
        <Skeleton className="h-8 w-36" />
        <Skeleton className="h-8 w-28" />
      </div>
    </div>
  );
}

function ArchiveThreadListSkeleton({ rowCount = REPOSITORY_ARCHIVE_PAGE_SIZE }: { rowCount?: number }) {
  return (
    <div
      aria-hidden="true"
      className={`overflow-hidden border border-border bg-card ${THREAD_ARCHIVE_LIST_HEIGHT_CLASS}`}
    >
      {Array.from({ length: rowCount }).map((_, index) => (
        <div
          key={index}
          data-archive-skeleton-row="thread"
          className={`flex flex-col gap-3 border-t border-border px-3 py-3 first:border-t-0 sm:flex-row sm:items-center sm:justify-between ${THREAD_ARCHIVE_ROW_HEIGHT_CLASS}`}
        >
          <div className="flex min-w-0 items-start gap-3">
            <Skeleton className="size-8 shrink-0" />
            <div className="min-w-0 flex-1">
              <Skeleton className="h-4 w-44 max-w-full" />
              <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1">
                <Skeleton className="h-3 w-14" />
                <Skeleton className="h-3 w-28" />
                <Skeleton className="h-3 w-24" />
              </div>
            </div>
          </div>
          <div className="flex shrink-0 gap-2">
            <Skeleton className="h-8 flex-1 sm:w-24 sm:flex-none" />
            <Skeleton className="h-8 flex-1 sm:w-20 sm:flex-none" />
          </div>
        </div>
      ))}
    </div>
  );
}

function ArchiveRepositoryListSkeleton({ rowCount = REPOSITORY_ARCHIVE_PAGE_SIZE }: { rowCount?: number }) {
  return (
    <ul
      aria-hidden="true"
      className={`mt-4 flex flex-col gap-2.5 overflow-hidden ${REPOSITORY_ARCHIVE_LIST_HEIGHT_CLASS}`}
    >
      {Array.from({ length: rowCount }).map((_, index) => (
        <li key={index} data-archive-skeleton-row="repository">
          <Card className={`overflow-hidden p-4 ${REPOSITORY_ARCHIVE_ROW_HEIGHT_CLASS}`}>
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
    <Card
      className={`overflow-hidden p-4 transition-colors hover:border-foreground/25 ${REPOSITORY_ARCHIVE_ROW_HEIGHT_CLASS}`}
    >
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
