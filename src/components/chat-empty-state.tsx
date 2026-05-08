import { useState } from "react";
import { useMutation } from "convex/react";
import { GlobeIcon, LinkIcon, LockIcon, PlusIcon, SparkleIcon } from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { AppNotice } from "@/components/app-notice";
import { ImportRepoDialog } from "@/components/import-repo-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { RepositoryId, ThreadId, WorkspaceId } from "@/lib/types";

const EMPTY_CHAT_OWL = ["   ^...^   ", "  / o,o \\  ", "  |):::(|  ", "====w=w===="].join("\n");

const EMPTY_CHAT_OWL_BLINK = ["   ^...^   ", "  / -,- \\  ", "  |):::(|  ", "====w=w===="].join("\n");

/**
 * Two stacked `<pre>` blocks render the empty-state owl: the bottom one
 * holds the open-eyes frame, the top one holds the squint frame on an
 * opaque background and animates its opacity to produce the periodic
 * blink. Extracted because both `EmptyChatHint` and `EmptyNoRepoHint`
 * render the exact same markup — duplicating the 12 lines of `<pre>`
 * tags would let the two surfaces drift on a future style tweak.
 */
function OwlAsciiArt() {
  return (
    <div className="relative mb-1 inline-grid place-items-center">
      <pre
        aria-hidden="true"
        className="pointer-events-none col-start-1 row-start-1 select-none font-mono text-[12px] leading-4 tracking-tight text-muted-foreground"
      >
        {EMPTY_CHAT_OWL}
      </pre>
      <pre
        aria-hidden="true"
        className="animate-terminal-owl-double-blink pointer-events-none col-start-1 row-start-1 select-none bg-background font-mono text-[12px] leading-4 tracking-tight text-muted-foreground"
      >
        {EMPTY_CHAT_OWL_BLINK}
      </pre>
    </div>
  );
}

export function EmptyChatHint({ analysisNudge }: { analysisNudge: { onStart: () => void } | null }) {
  return (
    <div className="flex flex-1 animate-in flex-col items-center justify-center gap-4 fade-in duration-300 ease-out">
      <Card className="border-transparent bg-transparent p-6 text-center">
        <OwlAsciiArt />
        <CardHeader className="items-center p-0 pt-5">
          <CardTitle className="text-base">Start a design conversation</CardTitle>
          <CardDescription className="text-xs">Architecture · Module dependencies · Risk hotspots</CardDescription>
        </CardHeader>
      </Card>
      {analysisNudge ? (
        // Auto-disappears once an analysis exists or starts running, so the
        // nudge feels like a one-time onboarding hint rather than a persistent
        // banner. The status panel keeps the same affordance for re-discovery.
        <Card className="w-full max-w-sm border-dashed border-border/80 bg-muted/30 p-4 text-left">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 grid size-7 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
              <SparkleIcon size={14} weight="bold" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">Run a deep analysis first</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                Build a reusable source-tree analysis so your conversations can cite it. Usually 2–3 minutes.
              </p>
              <Button
                type="button"
                variant="default"
                size="sm"
                className="mt-3"
                onClick={analysisNudge.onStart}
                data-testid="empty-state-run-analysis"
              >
                <SparkleIcon weight="bold" />
                Start analysis
              </Button>
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

/**
 * Empty-state guidance for threads that have no attached repository yet.
 * Surfaces two clear paths:
 *
 * 1. Move to a repository workspace — a dropdown listing the user's imported
 *    repos plus an "Import new repository" option that opens the ImportRepoDialog.
 * 2. Free-form discussion — the user can just start typing.
 */
export function EmptyNoRepoHint({
  threadId,
  availableRepositories,
  onImported,
  onThreadMovedToWorkspace,
}: {
  threadId: ThreadId | null;
  availableRepositories: ReadonlyArray<Doc<"repositories">>;
  onImported?: (repoId: RepositoryId, threadId: ThreadId | null, workspaceId: WorkspaceId) => void;
  onThreadMovedToWorkspace?: (workspaceId: WorkspaceId | null) => void;
}) {
  const setThreadRepository = useMutation(api.chat.threads.setThreadRepository);
  const [isAttaching, setIsAttaching] = useState(false);
  const [attachError, setAttachError] = useState<string | null>(null);
  const isAttachDisabled = isAttaching || !threadId;

  const handleAttachRepo = async (repoId: RepositoryId) => {
    if (!threadId) return;
    setIsAttaching(true);
    setAttachError(null);
    try {
      const result = await setThreadRepository({ threadId, repositoryId: repoId });
      onThreadMovedToWorkspace?.(result.workspaceId);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to attach repository";
      setAttachError(message);
      console.error("Error attaching repository:", err);
    } finally {
      setIsAttaching(false);
    }
  };

  return (
    <div className="flex flex-1 animate-in items-center justify-center fade-in duration-300 ease-out">
      <Card className="w-full max-w-md border-transparent bg-transparent p-6 text-center">
        {attachError ? (
          <div className="mb-4 w-full">
            <AppNotice
              title="Failed to attach repository"
              message={attachError}
              tone="error"
              onDismiss={() => setAttachError(null)}
              dismissLabel="Dismiss attach error"
            />
          </div>
        ) : null}
        <OwlAsciiArt />

        <CardHeader className="items-center p-0 pt-5">
          <CardTitle className="text-base">Start a design conversation</CardTitle>
        </CardHeader>

        <div className="mt-4 flex flex-col items-center gap-3">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-1.5 text-xs" disabled={isAttachDisabled}>
                <LinkIcon size={13} weight="bold" />
                {isAttaching ? "Attaching…" : "Attach repository"}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" className="w-64">
              {availableRepositories.length === 0 ? (
                <div className="px-2 py-3 text-xs text-muted-foreground">No repositories imported yet.</div>
              ) : (
                availableRepositories.map((repo) => (
                  <DropdownMenuItem
                    key={repo._id}
                    onSelect={() => void handleAttachRepo(repo._id)}
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
              {onImported ? (
                <>
                  <DropdownMenuSeparator />
                  <ImportRepoDialog
                    onImported={onImported}
                    trigger={
                      <DropdownMenuItem
                        onSelect={(e) => e.preventDefault()}
                        className="flex items-center gap-2 text-xs"
                      >
                        <PlusIcon size={12} weight="bold" />
                        Import new repository
                      </DropdownMenuItem>
                    }
                  />
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>

          <p className="max-w-xs text-xs text-muted-foreground">
            Move this thread into a repository workspace to unlock Docs and Sandbox modes, or keep typing here for a
            free-form discussion.
          </p>
        </div>
      </Card>
    </div>
  );
}
