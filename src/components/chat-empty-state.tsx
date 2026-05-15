import { useState } from "react";
import { useMutation } from "convex/react";
import { GlobeIcon, LinkIcon, LockIcon, PlusIcon } from "@phosphor-icons/react";
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
 * Two stacked `<pre>` blocks render the awake owl: the bottom one
 * holds the open-eyes frame, the top one holds the squint frame on an
 * opaque background and animates its opacity to produce the periodic
 * blink.
 */
function AwakeOwlAsciiArt() {
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

/**
 * Sleeping-owl counterpart to {@link AwakeOwlAsciiArt}. Eyes use a
 * `~,~` glyph — deliberately softer than the awake owl's flat `-,-`
 * blink — so the closed-eye state reads as "dreaming" rather than
 * "mid-blink". The eyes don't animate on their own — instead the
 * entire head (ears row + eyes row) is wrapped in a single span so a
 * `scaleY` compression can gently squish the whole head downward as
 * one unit, the way a drowsy creature's head settles into its
 * shoulders when nodding off. `transform-origin: bottom` (set on the
 * utility) anchors the bottom of the head to the body so the
 * compression reads as a sleepy slump rather than a center-scale.
 *
 * The owl body is otherwise static; the three dream `z` chars each
 * run their own keyframe pre-staged with the others, so the cycle
 * goes z1 (bottom) in → z2 (mid) in → z3 (top) in → hold all three →
 * all three pop out together → pause → loop. Appearance is sequential
 * (bubbles emerging one at a time, FIFO), dissipation is synchronized
 * (a single closing event), and the pause gives the cycle a peaceful
 * sleeping-breath rhythm. The head-nod shares the 5s z-puff cycle and
 * is choreographed to it: a single gentle compression that peaks just
 * as all three z's become visible, then smoothly releases before the
 * dreams start to fade. Both animations resolve together so the
 * dream-less pause is also a head-still pause. The smooth scaleY
 * cycle (1 → 0.92 → 1 with ease-in-out) reads as a quiet sleepy
 * breath — softer than a translateY drop-and-snap, which would feel
 * like the owl jerking awake instead of dozing peacefully. Single
 * `<pre>` rather than the awake owl's double-pre overlay — the dream
 * chars never overlap the body, so no opaque cover is needed.
 */
function SleepingOwlAsciiArt() {
  return (
    <pre
      aria-hidden="true"
      className="pointer-events-none mb-1 select-none font-mono text-[12px] leading-4 tracking-tight text-muted-foreground"
    >
      {"             "}
      <span className="animate-z-puff-3">z</span>
      {"\n           "}
      <span className="animate-z-puff-2">Z</span>
      {"\n         "}
      <span className="animate-z-puff-1">z</span>
      {"\n"}
      <span className="animate-owl-head-nod">{"    ^...^    \n   / ~,~ \\   "}</span>
      {"\n   |):::(|   \n ====w=w==== "}
    </pre>
  );
}

/**
 * Empty-state owl that adapts to the active theme. Light mode shows
 * the sleeping/dreaming variant (cozy moonlit Zs read well against
 * light surfaces); dark mode shows the awake blinking owl (the
 * wide-eyed "ready to chat" reading suits the terminal feel of the
 * dark theme). ThemeProvider materializes the active theme as a
 * `light`/`dark` class on `<html>`, so a single `dark:` swap is
 * enough. `display: none` on the inactive variant keeps its
 * animations from running in the background.
 */
function OwlAsciiArt() {
  return (
    <>
      <div className="dark:hidden">
        <SleepingOwlAsciiArt />
      </div>
      <div className="hidden dark:block">
        <AwakeOwlAsciiArt />
      </div>
    </>
  );
}

/**
 * Empty-state hint for repo-attached threads with no messages yet. Users
 * generate System Design artifacts from the Library page; the chat shell
 * stays focused on conversation-starter affordances.
 */
export function EmptyChatHint() {
  return (
    <div className="flex flex-1 animate-in flex-col items-center justify-center gap-4 fade-in duration-300 ease-out">
      <Card className="border-transparent bg-transparent p-6 text-center">
        <OwlAsciiArt />
        <CardHeader className="items-center p-0 pt-5">
          <CardTitle className="text-base">Start a design conversation</CardTitle>
          <CardDescription className="text-xs">Architecture · Module dependencies · Risk hotspots</CardDescription>
        </CardHeader>
      </Card>
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
