import { useCallback } from "react";
import { useMutation } from "convex/react";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { api } from "../../convex/_generated/api";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { toUserErrorMessage } from "@/lib/errors";
import { ARCHIVE_PATH } from "@/route-paths";
import type { RepositoryId } from "@/lib/types";

/**
 * Owns the four destructive / state-changing actions a viewer can perform on
 * the currently-selected repository: sync, archive, restore, permanent
 * delete. Each callback resolves to the corresponding `onAfterX` so the
 * parent can drive navigation or dismiss its confirm dialog once the
 * mutation lands.
 */
export function useRepositoryLifecycle({
  selectedRepositoryId,
  setActionError,
  setShowArchiveDialog,
  setShowPermanentDeleteDialog,
  syncDisabledReason,
  onAfterArchiveRepo,
  onAfterRestoreRepo,
  onAfterPermanentDeleteRepo,
}: {
  selectedRepositoryId: RepositoryId | null;
  setActionError: (value: string | null) => void;
  setShowArchiveDialog: (value: boolean) => void;
  setShowPermanentDeleteDialog: (value: boolean) => void;
  syncDisabledReason?: string;
  onAfterArchiveRepo: () => void;
  onAfterRestoreRepo: () => void;
  onAfterPermanentDeleteRepo: () => void;
}) {
  const navigate = useNavigate();
  const syncRepositoryMutation = useMutation(api.repositories.syncRepository);
  const archiveRepositoryMutation = useMutation(api.repositories.archiveRepository);
  const restoreRepositoryMutation = useMutation(api.repositories.restoreRepository);
  const deleteRepositoryMutation = useMutation(api.repositories.deleteRepository);

  const [isSyncing, handleSync] = useAsyncCallback(
    useCallback(async () => {
      if (!selectedRepositoryId) return;
      if (syncDisabledReason) {
        setActionError(syncDisabledReason);
        return;
      }
      setActionError(null);
      try {
        await syncRepositoryMutation({ repositoryId: selectedRepositoryId });
      } catch (error) {
        setActionError(toUserErrorMessage(error, "Failed to sync the repository."));
      }
    }, [selectedRepositoryId, setActionError, syncDisabledReason, syncRepositoryMutation]),
  );

  const [isArchivingRepo, handleArchiveRepo] = useAsyncCallback(
    useCallback(async () => {
      if (!selectedRepositoryId) return;
      setActionError(null);
      try {
        await archiveRepositoryMutation({ repositoryId: selectedRepositoryId });
        setShowArchiveDialog(false);
        toast.success("Repository archived", {
          description: "Restore it any time from your archive.",
          action: {
            label: "View archive",
            onClick: () => void navigate(ARCHIVE_PATH),
          },
        });
        onAfterArchiveRepo();
      } catch (error) {
        setActionError(toUserErrorMessage(error, "Failed to archive the repository."));
      }
    }, [
      archiveRepositoryMutation,
      navigate,
      onAfterArchiveRepo,
      selectedRepositoryId,
      setActionError,
      setShowArchiveDialog,
    ]),
  );

  const [isRestoringRepo, handleRestoreRepo] = useAsyncCallback(
    useCallback(async () => {
      if (!selectedRepositoryId) return;
      setActionError(null);
      try {
        await restoreRepositoryMutation({ repositoryId: selectedRepositoryId });
        toast.success("Repository restored");
        onAfterRestoreRepo();
      } catch (error) {
        setActionError(toUserErrorMessage(error, "Failed to restore the repository."));
      }
    }, [onAfterRestoreRepo, restoreRepositoryMutation, selectedRepositoryId, setActionError]),
  );

  const [isPermanentDeletingRepo, handlePermanentDeleteRepo] = useAsyncCallback(
    useCallback(async () => {
      if (!selectedRepositoryId) return;
      setActionError(null);
      try {
        await deleteRepositoryMutation({ repositoryId: selectedRepositoryId });
        // Orphan localStorage entries for this repo's folder-nav state are
        // reaped reactively by `useStorageGC` once the `listRepositories`
        // subscription drops the deleted id — no manual cleanup here.
        setShowPermanentDeleteDialog(false);
        toast.success("Repository deleted permanently");
        onAfterPermanentDeleteRepo();
      } catch (error) {
        setActionError(toUserErrorMessage(error, "Failed to delete the repository."));
      }
    }, [
      deleteRepositoryMutation,
      onAfterPermanentDeleteRepo,
      selectedRepositoryId,
      setActionError,
      setShowPermanentDeleteDialog,
    ]),
  );

  return {
    isSyncing,
    handleSync,
    isArchivingRepo,
    handleArchiveRepo,
    isRestoringRepo,
    handleRestoreRepo,
    isPermanentDeletingRepo,
    handlePermanentDeleteRepo,
  };
}
