import { useRef, useState } from "react";
import { useMutation } from "convex/react";
import {
  CaretDownIcon,
  CircleNotchIcon,
  GlobeIcon,
  LinkIcon,
  LockIcon,
  XIcon,
} from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { toUserErrorMessage } from "@/lib/errors";
import type { RepositoryId, ThreadId, WorkspaceId } from "@/lib/types";

/**
 * One-shot CTA for binding a no-repo thread to a repository workspace,
 * surfaced in the TopBar when the thread is sitting in Home with no repo
 * attached yet. PRD #19 user story 2: promote a free-form discussion thread
 * into a grounded repo workspace.
 *
 * **The binding is permanent by design.** Once a repo is attached, this
 * component stops rendering (TopBar gates on `attachedRepository === null`)
 * and there is no swap or detach affordance anywhere in the UI. The decision:
 * a thread's history is grounded against the repo it was attached to, and
 * re-pointing the binding mid-conversation creates a Frankenstein context
 * where messages 1-N reference repo A and messages N+1 reference repo B —
 * confusing for the model and the user. To work against a different repo,
 * users start a new thread (cheap) instead. The backend mutation still
 * accepts arbitrary moves so a future "Fork thread" feature can copy a
 * thread into a different repo without mutating the original.
 */
export function AttachRepoMenu({
  threadId,
  availableRepositories,
  onMovedToWorkspace,
}: {
  threadId: ThreadId;
  availableRepositories: ReadonlyArray<Doc<"repositories">>;
  onMovedToWorkspace: (workspaceId: WorkspaceId | null) => void;
}) {
  const setThreadRepository = useMutation(api.chat.threads.setThreadRepository);
  // Latest-request-wins: a fast user clicking two different repos in rapid
  // succession should land on the second pick, even if the first request's
  // network round-trip happens to resolve later. We track the request id
  // generated at click time and only commit results when the in-flight id
  // still matches the latest one we issued.
  const latestRequestRef = useRef(0);
  const [pendingRequest, setPendingRequest] = useState<{
    threadId: ThreadId;
    requestId: number;
  } | null>(null);
  const [errorState, setErrorState] = useState<{
    threadId: ThreadId;
    message: string;
  } | null>(null);
  const isPending = pendingRequest?.threadId === threadId;
  const error = errorState?.threadId === threadId ? errorState.message : null;

  const handleAttach = async (repoId: RepositoryId) => {
    const requestId = latestRequestRef.current + 1;
    latestRequestRef.current = requestId;
    setErrorState(null);
    setPendingRequest({ threadId, requestId });
    try {
      const result = await setThreadRepository({ threadId, repositoryId: repoId });
      if (latestRequestRef.current === requestId) {
        onMovedToWorkspace(result.workspaceId);
      }
    } catch (err) {
      if (latestRequestRef.current === requestId) {
        setErrorState({
          threadId,
          message: toUserErrorMessage(err, "Failed to attach repository."),
        });
      }
    }
    setPendingRequest((current) => (current?.requestId === requestId ? null : current));
  };

  return (
    <div className="flex items-center gap-2">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled={isPending}
            className="gap-1.5 text-xs"
            aria-label="Attach a repository to this thread"
          >
            <LinkIcon size={12} weight="bold" />
            <span className="font-medium">Attach repository</span>
            {isPending ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground" aria-live="polite">
                <CircleNotchIcon size={11} className="animate-spin" />
                <span>Attaching…</span>
              </span>
            ) : null}
            <CaretDownIcon size={10} weight="bold" className="opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72">
          <DropdownMenuLabel className="text-[11px] uppercase tracking-wider">Attach repository</DropdownMenuLabel>
          {availableRepositories.length === 0 ? (
            // Empty-state intentionally points at the sidebar's import flow
            // rather than duplicating it inline — there's only one canonical
            // entry point to importing a repo.
            <div className="px-2 py-3 text-xs text-muted-foreground">
              You have no repositories yet. Import one to get started.
            </div>
          ) : (
            availableRepositories.map((repo) => (
              <DropdownMenuItem
                key={repo._id}
                disabled={isPending}
                onSelect={() => {
                  void handleAttach(repo._id);
                }}
                className="flex items-center gap-2 text-xs"
              >
                {repo.visibility === "private" ? (
                  <LockIcon size={12} weight="bold" className="shrink-0 text-muted-foreground" />
                ) : (
                  <GlobeIcon size={12} weight="bold" className="shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{repo.sourceRepoFullName}</span>
              </DropdownMenuItem>
            ))
          )}
        </DropdownMenuContent>
      </DropdownMenu>
      {error ? (
        <Alert variant="destructive" className="w-full grid-cols-[1fr_auto] p-1.5 text-xs md:w-auto">
          <AlertDescription className="text-xs text-destructive">{error}</AlertDescription>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="size-4 text-destructive/80 hover:text-destructive"
            onClick={() => setErrorState((current) => (current?.threadId === threadId ? null : current))}
            aria-label="Dismiss repository attach error"
          >
            <XIcon size={10} weight="bold" />
          </Button>
        </Alert>
      ) : null}
    </div>
  );
}
