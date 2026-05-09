import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery } from "convex/react";
import { ArchiveIcon, ArrowCounterClockwiseIcon, TrashIcon } from "@phosphor-icons/react";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
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

  return (
    <div className="flex min-h-dvh flex-col bg-background">
      <header className="border-b border-border px-6 py-4">
        <div className="mx-auto flex w-full max-w-4xl items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <ArchiveIcon size={20} weight="bold" className="text-muted-foreground" />
            <h1 className="text-lg font-semibold tracking-tight">Archive</h1>
          </div>
          <Button variant="secondary" size="sm" onClick={() => void navigate(DEFAULT_AUTHENTICATED_PATH)}>
            Back to chat
          </Button>
        </div>
      </header>

      <main className="flex-1 px-6 py-8">
        <div className="mx-auto w-full max-w-4xl">
          <p className="mb-6 text-sm text-muted-foreground">
            Archived repositories are kept here so you can restore them later. Threads, messages, and analysis artifacts
            are preserved. Sandboxes are stopped to free resources — after restoring, sync the repository to provision a
            fresh sandbox before resuming chat.
          </p>

          {archived === undefined ? (
            <ArchiveListSkeleton />
          ) : archived.length === 0 ? (
            <ArchiveEmptyState />
          ) : (
            <ul className="flex flex-col gap-3">
              {archived.map((repo) => (
                <li key={repo._id}>
                  <ArchiveRow repo={repo} onRequestPermanentDelete={setPendingPermanentDelete} />
                </li>
              ))}
            </ul>
          )}
        </div>
      </main>

      <PermanentDeleteDialog repo={pendingPermanentDelete} onClose={() => setPendingPermanentDelete(null)} />
    </div>
  );
}

function ArchiveListSkeleton() {
  return (
    <ul className="flex flex-col gap-3" aria-hidden="true">
      {Array.from({ length: 3 }).map((_, index) => (
        <li key={index}>
          <Card>
            <CardHeader className="gap-2">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton className="h-3 w-1/2" />
            </CardHeader>
            <CardContent className="flex justify-end gap-2">
              <Skeleton className="h-8 w-24" />
              <Skeleton className="h-8 w-32" />
            </CardContent>
          </Card>
        </li>
      ))}
    </ul>
  );
}

function ArchiveEmptyState() {
  return (
    <Card className="text-center">
      <CardHeader className="items-center gap-2">
        <ArchiveIcon size={28} weight="duotone" className="text-muted-foreground" />
        <CardTitle className="text-base">Nothing in your archive</CardTitle>
        <CardDescription>
          When you archive a repository it appears here. You can restore or permanently delete it any time.
        </CardDescription>
      </CardHeader>
    </Card>
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

  return (
    <Card>
      <CardHeader className="gap-1">
        <CardTitle className="truncate text-base">{repo.sourceRepoFullName}</CardTitle>
        <CardDescription>
          Archived {repo.archivedAt ? formatRelativeTime(repo.archivedAt) : "recently"}
          {repo.lastImportedAt ? ` · last imported ${formatTimestamp(repo.lastImportedAt)}` : ""}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="secondary" size="sm" disabled={isRestoring} onClick={() => void handleRestore()}>
          <ArrowCounterClockwiseIcon weight="bold" />
          {isRestoring ? "Restoring…" : "Restore"}
        </Button>
        <Button type="button" variant="destructive" size="sm" onClick={() => onRequestPermanentDelete(repo)}>
          <TrashIcon weight="bold" />
          Delete permanently
        </Button>
      </CardContent>
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
