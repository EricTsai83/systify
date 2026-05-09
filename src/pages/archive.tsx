import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  CaretLeftIcon,
  ClockCounterClockwiseIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { toUserErrorMessage } from "@/lib/errors";
import { formatRelativeTime, formatTimestamp } from "@/lib/format";
import type { RepositoryId } from "@/lib/types";
import { DEFAULT_AUTHENTICATED_PATH } from "@/route-paths";

export function ArchivePage() {
  const navigate = useNavigate();
  const archived = useQuery(api.repositories.listArchivedRepositories);
  const [pendingPermanentDelete, setPendingPermanentDelete] = useState<Doc<"repositories"> | null>(null);
  const handleBack = useCallback(() => void navigate(DEFAULT_AUTHENTICATED_PATH), [navigate]);

  const count = archived?.length ?? 0;

  return (
    <div className="flex h-dvh w-full flex-1 flex-col overflow-y-auto bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-4">
          <div className="flex min-w-0 items-center gap-2.5">
            <div className="flex size-8 shrink-0 items-center justify-center border border-border bg-card text-muted-foreground">
              <ArchiveIcon size={15} weight="bold" />
            </div>
            <div className="flex min-w-0 items-baseline gap-2">
              <h1 className="truncate text-base font-semibold tracking-tight sm:text-lg">Archive</h1>
              {count > 0 ? (
                <span className="shrink-0 text-xs font-medium tabular-nums text-muted-foreground sm:text-sm">
                  {count}
                </span>
              ) : null}
            </div>
          </div>
          <Button variant="ghost" size="sm" onClick={handleBack} className="shrink-0" aria-label="Back to chat">
            <CaretLeftIcon weight="bold" />
            <span className="hidden sm:inline">Back to chat</span>
            <span className="sm:hidden">Back</span>
          </Button>
        </div>
      </header>

      <main className="flex-1 px-4 pb-10 pt-5 sm:px-6 sm:pb-12 sm:pt-8">
        <div className="mx-auto w-full max-w-4xl">
          {archived === undefined ? (
            <ArchiveListSkeleton />
          ) : archived.length === 0 ? (
            <ArchiveEmptyState onBackToChat={handleBack} />
          ) : (
            <>
              <p className="mb-5 text-sm leading-relaxed text-muted-foreground sm:mb-6">
                Threads, messages, and analysis artifacts are preserved while sandboxes are stopped to free resources.
                After restoring, sync the repository to provision a fresh sandbox before resuming chat.
              </p>
              <ul className="flex flex-col gap-2.5">
                {archived.map((repo) => (
                  <li key={repo._id}>
                    <ArchiveRow repo={repo} onRequestPermanentDelete={setPendingPermanentDelete} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      </main>

      <PermanentDeleteDialog repo={pendingPermanentDelete} onClose={() => setPendingPermanentDelete(null)} />
    </div>
  );
}

function ArchiveListSkeleton() {
  return (
    <div aria-hidden="true">
      <Skeleton className="mb-6 h-4 w-3/4 max-w-md" />
      <ul className="flex flex-col gap-2.5">
        {Array.from({ length: 3 }).map((_, index) => (
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
    </div>
  );
}

function ArchiveEmptyState({ onBackToChat }: { onBackToChat: () => void }) {
  return (
    <div className="flex min-h-[55vh] flex-col items-center justify-center px-4 py-10 text-center sm:py-16">
      <div className="flex size-16 items-center justify-center border border-border bg-card text-muted-foreground sm:size-20">
        <ArchiveIcon size={28} weight="duotone" />
      </div>
      <h2 className="mt-5 text-base font-semibold tracking-tight sm:text-lg">Nothing in your archive</h2>
      <p className="mt-2 max-w-sm text-sm leading-relaxed text-muted-foreground">
        Archived repositories appear here. Restore or delete any time.
      </p>
      <Button variant="secondary" size="sm" className="mt-6" onClick={onBackToChat}>
        <CaretLeftIcon weight="bold" />
        Back to chat
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
          description: `${repo.sourceRepoFullName} is back in your workspaces.`,
        });
      } catch (error) {
        toast.error(toUserErrorMessage(error, "Failed to restore the repository."));
      }
    }, [repo._id, repo.sourceRepoFullName, restoreRepository]),
  );

  const archivedLabel = repo.archivedAt ? formatRelativeTime(repo.archivedAt) : "recently";

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
            {isRestoring ? "Restoring…" : "Restore"}
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
