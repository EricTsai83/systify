import { useState } from "react";
import { useMutation } from "convex/react";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { FolderPicker } from "@/components/folder-picker";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { toUserErrorMessage } from "@/lib/errors";
import type { ArtifactId, FolderId, RepositoryId } from "@/lib/types";

type MoveArtifactDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artifactId: ArtifactId;
  repositoryId: RepositoryId | null;
  currentFolderId: FolderId | null;
};

/**
 * Inline "Move artifact to folder" dialog. Shared by the Reader's toolbar
 * and (later) the right-rail navigator's per-artifact kebab menu so the
 * folder pick interaction stays consistent.
 *
 * The dialog reuses {@link FolderPicker} for the actual selection so users
 * can both pick existing folders and create new ones inline. Confirming
 * runs `api.artifacts.moveToFolder`; we collapse same-folder picks
 * client-side to avoid a useless server round-trip.
 *
 * The body is split out as `MoveArtifactDialogBody` and keyed on
 * `${artifactId}-${currentFolderId}` so re-opening the dialog for a
 * different artifact (or the same artifact whose folder changed
 * elsewhere) mounts a fresh body. That resets the draft pick to the
 * artifact's current folder without needing a setState-in-effect prop
 * sync — React's standard "key change → remount" semantics replace the
 * effect entirely.
 */
export function MoveArtifactDialog({
  open,
  onOpenChange,
  artifactId,
  repositoryId,
  currentFolderId,
}: MoveArtifactDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Move artifact</DialogTitle>
          <DialogDescription>
            Choose where this artifact should live. Repository-level kinds always sit at the root, so this picker
            applies to feature-level artifacts (ADR, failure mode, diagrams, …).
          </DialogDescription>
        </DialogHeader>
        {open ? (
          <MoveArtifactDialogBody
            key={`${artifactId}-${currentFolderId ?? "root"}`}
            artifactId={artifactId}
            repositoryId={repositoryId}
            currentFolderId={currentFolderId}
            onOpenChange={onOpenChange}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function MoveArtifactDialogBody({
  artifactId,
  repositoryId,
  currentFolderId,
  onOpenChange,
}: {
  artifactId: ArtifactId;
  repositoryId: RepositoryId | null;
  currentFolderId: FolderId | null;
  onOpenChange: (open: boolean) => void;
}) {
  const moveToFolder = useMutation(api.artifacts.moveToFolder);
  const [draftFolderId, setDraftFolderId] = useState<FolderId | null>(currentFolderId);
  const [error, setError] = useState<string | null>(null);

  const [isMoving, runMove] = useAsyncCallback(async () => {
    setError(null);
    try {
      await moveToFolder({
        artifactId,
        folderId: draftFolderId,
      });
      onOpenChange(false);
    } catch (err) {
      setError(toUserErrorMessage(err, "Failed to move artifact."));
    }
  });

  const isUnchanged = draftFolderId === currentFolderId;

  return (
    <>
      <div className="flex flex-col gap-3">
        <FolderPicker
          repositoryId={repositoryId}
          value={draftFolderId}
          onChange={(next) => setDraftFolderId(next)}
          hint={
            repositoryId
              ? "You can create a new folder inline below the list."
              : "This artifact is not bound to a repository, so folders are not available."
          }
          disabled={!repositoryId}
        />
        {error ? <p className="text-[12px] text-destructive">{error}</p> : null}
      </div>
      <DialogFooter>
        <DialogClose asChild>
          <Button type="button" variant="secondary" disabled={isMoving}>
            Cancel
          </Button>
        </DialogClose>
        <Button
          type="button"
          variant="default"
          disabled={isMoving || isUnchanged || !repositoryId}
          onClick={() => void runMove()}
        >
          {isMoving ? "Moving…" : "Move"}
        </Button>
      </DialogFooter>
    </>
  );
}
