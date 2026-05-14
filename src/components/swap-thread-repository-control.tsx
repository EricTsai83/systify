import { useState } from "react";
import { useMutation } from "convex/react";
import { ArrowsLeftRightIcon, CircleNotchIcon } from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { toUserErrorMessage } from "@/lib/errors";
import type { RepositoryId, ThreadId, WorkspaceId } from "@/lib/types";
import { toast } from "sonner";

/**
 * Rare escape hatch — bind the current thread to a different repository /
 * workspace. Historical messages retain their older grounding; newer sends
 * follow `getReplyContext` rules. Mirrors the UX warning in Phase 1 of the
 * product alignment plan ("Frankenstein scrollback").
 */
export function SwapThreadRepositoryControl({
  threadId,
  attachedRepositoryFullName,
  candidates,
  onMovedToWorkspace,
}: {
  threadId: ThreadId;
  attachedRepositoryFullName: string;
  candidates: readonly Doc<"repositories">[];
  onMovedToWorkspace: (workspaceId: WorkspaceId | null) => void;
}) {
  const setThreadRepository = useMutation(api.chat.threads.setThreadRepository);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<RepositoryId | null>(null);
  const [pending, setPending] = useState(false);

  if (candidates.length === 0) return null;

  const pendingRepo = picked ? candidates.find((r) => r._id === picked) : null;

  const handleSwap = async () => {
    if (!picked || !pendingRepo) return;
    setPending(true);
    try {
      const result = await setThreadRepository({ threadId, repositoryId: picked });
      if ("swappedFromRepositoryId" in result && result.swappedFromRepositoryId) {
        toast.info("Repository swapped", {
          description:
            "Earlier messages stay on the prior repo context only in the transcript. New replies use the repo you chose.",
          duration: 8500,
        });
      }
      const nextWorkspaceId = result.workspaceId;
      if (nextWorkspaceId) {
        onMovedToWorkspace(nextWorkspaceId);
      }
      setOpen(false);
      setPicked(null);
    } catch (err) {
      toast.error(toUserErrorMessage(err, "Could not swap repository."));
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="gap-1.5 text-muted-foreground md:inline-flex"
        onClick={() => setOpen(true)}
        aria-label="Switch repository for this thread"
      >
        <ArrowsLeftRightIcon size={14} />
        Switch repo
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md gap-4">
          <DialogHeader className="text-left">
            <DialogTitle>Switch repository?</DialogTitle>
            <DialogDescription className="text-left text-muted-foreground">
              The thread stays the same — only the workspace binding changes. Older messages remain as written; newer
              answers use snippets and tools from{" "}
              <span className="font-medium text-foreground">
                {pendingRepo?.sourceRepoFullName ?? "the target repo"}
              </span>{" "}
              after you confirm (today on{" "}
              <span className="font-medium text-foreground">{attachedRepositoryFullName}</span>
              ).
            </DialogDescription>
          </DialogHeader>

          <div className="grid max-h-48 gap-1 overflow-y-auto pr-1">
            {candidates.map((repo) => {
              const isActive = repo._id === picked;
              return (
                <Button
                  key={repo._id}
                  variant={isActive ? "secondary" : "outline"}
                  type="button"
                  size="sm"
                  className="h-auto min-h-9 justify-start text-left font-normal"
                  onClick={() => setPicked(repo._id)}
                >
                  <span className="truncate">{repo.sourceRepoFullName}</span>
                </Button>
              );
            })}
          </div>

          <DialogFooter className="gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="ghost" onClick={() => setOpen(false)} disabled={pending}>
              Cancel
            </Button>
            <Button
              type="button"
              variant="default"
              disabled={picked === null || pending}
              onClick={() => void handleSwap()}
              className="gap-2"
            >
              {pending ? (
                <>
                  <CircleNotchIcon className="size-4 animate-spin" aria-hidden /> Swapping…
                </>
              ) : (
                "Confirm swap"
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
