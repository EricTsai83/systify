import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { BookOpenIcon, FolderIcon, PencilSimpleIcon, TrashIcon } from "@phosphor-icons/react";
import { api } from "../../convex/_generated/api";
import type { Doc } from "../../convex/_generated/dataModel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { useAsyncCallback } from "@/hooks/use-async-callback";
import { toUserErrorMessage } from "@/lib/errors";
import { formatArtifactKind } from "@/lib/operations";
import type { ArtifactId, FolderId } from "@/lib/types";
import { cn } from "@/lib/utils";

type FolderOverviewProps = {
  folderId: FolderId;
  onSelectArtifact: (artifactId: ArtifactId) => void;
  onAfterDelete?: () => void;
  className?: string;
};

/**
 * Folder detail surface — shows the folder's metadata (name, description),
 * the artifacts inside it, and inline rename / delete actions. Used by
 * the Reader's left rail when the user clicks a folder header in the
 * navigator, and reusable in any future "folder home" surface.
 *
 * Two delete modes match the underlying mutation:
 *   - "Move contents to parent" — keeps every artifact alive, just clears
 *     their `folderId` (or repoints to the parent folder when nested).
 *   - "Delete folder and its sub-folders" — deletes the folder hierarchy
 *     but artifacts stay in the database; they surface under the
 *     navigator's "Uncategorized" node.
 *
 * Artifacts themselves are never destroyed by folder operations — the
 * folder is purely organisational.
 */
export function FolderOverview({ folderId, onSelectArtifact, onAfterDelete, className }: FolderOverviewProps) {
  const folder = useQuery(api.artifactFolders.getById, { folderId });
  const artifacts = useQuery(api.artifacts.listByFolder, { folderId });
  const renameFolder = useMutation(api.artifactFolders.rename);
  const removeFolder = useMutation(api.artifactFolders.remove);

  const [isEditing, setIsEditing] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [confirmStrategy, setConfirmStrategy] = useState<"moveContentsToParent" | "deleteContents" | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const beginEdit = () => {
    if (!folder) return;
    setDraftName(folder.name);
    setDraftDescription(folder.description ?? "");
    setIsEditing(true);
    setActionError(null);
  };

  const [isSaving, runSave] = useAsyncCallback(async () => {
    if (!folder) return;
    setActionError(null);
    try {
      await renameFolder({
        folderId: folder._id,
        name: draftName,
        description: draftDescription,
      });
      setIsEditing(false);
    } catch (error) {
      setActionError(toUserErrorMessage(error, "Failed to update folder."));
    }
  });

  const [isDeleting, runDelete] = useAsyncCallback(async () => {
    if (!folder || !confirmStrategy) return;
    setActionError(null);
    try {
      await removeFolder({ folderId: folder._id, strategy: confirmStrategy });
      setConfirmStrategy(null);
      onAfterDelete?.();
    } catch (error) {
      setActionError(toUserErrorMessage(error, "Failed to delete folder."));
    }
  });

  if (folder === undefined || artifacts === undefined) {
    return (
      <div className={cn("flex flex-col gap-3 p-4", className)}>
        <div className="h-6 w-40 animate-pulse rounded bg-muted/60" />
        <div className="h-4 w-full animate-pulse rounded bg-muted/60" />
      </div>
    );
  }

  if (folder === null) {
    return (
      <div className={cn("flex flex-col items-center justify-center p-8 text-center", className)}>
        <FolderIcon size={28} weight="duotone" className="text-muted-foreground" />
        <p className="mt-2 text-sm font-semibold">Folder not found</p>
        <p className="mt-1 text-[12px] text-muted-foreground">It may have been deleted from another window.</p>
      </div>
    );
  }

  return (
    <div className={cn("flex h-full min-h-0 flex-col", className)}>
      <div className="flex flex-col gap-3 border-b border-border p-4">
        {isEditing ? (
          <div className="flex flex-col gap-2">
            <Input
              value={draftName}
              onChange={(event) => setDraftName(event.target.value)}
              placeholder="Folder name"
              className="text-sm font-semibold"
              disabled={isSaving}
            />
            <Textarea
              value={draftDescription}
              onChange={(event) => setDraftDescription(event.target.value)}
              placeholder="Describe what this folder is for (optional)"
              className="min-h-20 text-[12px]"
              disabled={isSaving}
            />
            <div className="flex items-center justify-end gap-2">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isSaving}
                onClick={() => {
                  setIsEditing(false);
                  setActionError(null);
                }}
              >
                Cancel
              </Button>
              <Button
                type="button"
                variant="default"
                size="sm"
                disabled={isSaving || !draftName.trim()}
                onClick={() => void runSave()}
              >
                {isSaving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <FolderIcon size={16} weight="duotone" className="text-primary" />
                <h2 className="truncate text-sm font-semibold">{folder.name}</h2>
              </div>
              {folder.description ? (
                <p className="mt-1 text-[12px] text-muted-foreground">{folder.description}</p>
              ) : (
                <p className="mt-1 text-[12px] italic text-muted-foreground/80">
                  No description yet — add one to remind future-you (or your team) what lives here.
                </p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Rename folder"
                className="h-8 w-8"
                onClick={beginEdit}
              >
                <PencilSimpleIcon size={13} weight="bold" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Delete folder"
                className="h-8 w-8 text-destructive hover:text-destructive"
                onClick={() => setConfirmStrategy("moveContentsToParent")}
              >
                <TrashIcon size={13} weight="bold" />
              </Button>
            </div>
          </div>
        )}
        {actionError ? <p className="text-[11px] text-destructive">{actionError}</p> : null}
      </div>

      <div className="flex flex-col gap-2 overflow-y-auto p-4">
        <div className="flex items-baseline justify-between">
          <h3 className="text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Contents</h3>
          <span className="text-[10px] tabular-nums text-muted-foreground">
            {artifacts.length} item{artifacts.length === 1 ? "" : "s"}
          </span>
        </div>
        {artifacts.length === 0 ? (
          <Card className="border-dashed bg-background/50 text-center">
            <CardHeader className="gap-1 p-4">
              <CardTitle className="text-xs">Folder is empty</CardTitle>
              <CardDescription className="text-[11px]">
                Generate an ADR, failure mode, or diagram from a chat thread and pick this folder in the placement
                dropdown.
              </CardDescription>
            </CardHeader>
          </Card>
        ) : (
          <div className="flex flex-col gap-2">
            {artifacts.map((artifact: Doc<"artifacts">) => (
              <FolderArtifactCard key={artifact._id} artifact={artifact} onSelect={onSelectArtifact} />
            ))}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmStrategy !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmStrategy(null);
        }}
        title="Delete folder"
        description={
          confirmStrategy === "deleteContents"
            ? "This deletes the folder and every sub-folder inside it. The artifacts themselves stay in the workspace under Uncategorized."
            : "Move the artifacts and sub-folders inside this folder one level up, then delete the folder. Artifacts are preserved."
        }
        actionLabel="Delete"
        loadingLabel="Deleting…"
        isPending={isDeleting}
        onConfirm={() => void runDelete()}
      />
    </div>
  );
}

function FolderArtifactCard({
  artifact,
  onSelect,
}: {
  artifact: Doc<"artifacts">;
  onSelect: (artifactId: ArtifactId) => void;
}) {
  return (
    <button
      type="button"
      className="group flex flex-col gap-1 rounded-md border border-border bg-background p-3 text-left transition-shadow hover:shadow-sm"
      onClick={() => onSelect(artifact._id as ArtifactId)}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="truncate text-sm font-semibold">{artifact.title}</h4>
          <p className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">{artifact.summary}</p>
        </div>
        <Badge variant="outline" className="shrink-0 text-[10px] uppercase">
          {formatArtifactKind(artifact.kind)}
        </Badge>
      </div>
      <div className="flex items-center justify-end gap-2 text-[10px] text-muted-foreground">
        <span>v{artifact.version}</span>
        <span aria-hidden>·</span>
        <span className="inline-flex items-center gap-1 text-primary opacity-0 transition-opacity group-hover:opacity-100">
          <BookOpenIcon size={11} weight="bold" /> Open
        </span>
      </div>
    </button>
  );
}
