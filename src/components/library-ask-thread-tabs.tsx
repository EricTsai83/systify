import { memo } from "react";
import { PlusIcon, XIcon } from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { LibraryAskHistoryPopover } from "@/components/library-ask-history-popover";
import { Button } from "@/components/ui/button";
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area";
import { usePrewarmThread } from "@/hooks/use-prewarm-thread";
import type { OpenAskThread } from "@/hooks/use-library-ask-tabs";
import type { ThreadId } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Library Ask thread tab strip.
 *
 * An IDE-style *open set*: one tab per thread the user has opened, mirroring
 * the artifact tab strip's chrome (`LibraryTabs`) — horizontal scroll with a
 * left edge gradient, a trailing pinned slot. Click activates; the X (and
 * middle-click) **close the tab only** — they do not delete the thread.
 * Deleting a thread lives in the history popover, opened by the trailing
 * clock button, so it is always a deliberate, searched-for action.
 *
 * This is a sibling of `LibraryTabs`, not a generalization of it: the two
 * share visual chrome but neither data shape nor behavior. The strip renders
 * the `tabs` it is handed — the panel reconciles cached titles against
 * `listThreads` before passing them in.
 */
export interface LibraryAskThreadTabsProps {
  tabs: ReadonlyArray<OpenAskThread>;
  activeThreadId: ThreadId | null;
  onSelectTab: (threadId: ThreadId) => void;
  onCloseTab: (threadId: ThreadId) => void;
  onNewThread: () => void;
  /** Disables the "+" while a thread create is in flight. */
  isCreating: boolean;
  /** All Ask threads for this repository, fed to the history popover. */
  threads: Doc<"threads">[] | undefined;
  /** History row click — the panel must `ensureOpen` the picked thread. */
  onSelectFromHistory: (thread: Doc<"threads">) => void;
  onTogglePin: (threadId: ThreadId, pinned: boolean) => void;
  onDeleteThread: (threadId: ThreadId) => void;
  className?: string;
}

export const LibraryAskThreadTabs = memo(function LibraryAskThreadTabs({
  tabs,
  activeThreadId,
  onSelectTab,
  onCloseTab,
  onNewThread,
  isCreating,
  threads,
  onSelectFromHistory,
  onTogglePin,
  onDeleteThread,
  className,
}: LibraryAskThreadTabsProps) {
  const prewarmThread = usePrewarmThread();

  return (
    <div className={cn("relative flex items-center border-b border-border bg-background", className)}>
      <ScrollArea className="min-w-0 flex-1">
        <ul role="tablist" aria-label="Open Library Ask threads" className="flex items-center gap-px px-1 py-1">
          {tabs.map((tab) => {
            const isActive = activeThreadId === tab.id;
            return (
              <li key={tab.id} role="presentation" className="shrink-0">
                <div
                  role="tab"
                  tabIndex={isActive ? 0 : -1}
                  aria-selected={isActive}
                  onClick={() => onSelectTab(tab.id)}
                  onMouseEnter={() => prewarmThread(tab.id)}
                  onFocus={() => prewarmThread(tab.id)}
                  onKeyDown={(event) => {
                    if ((event.key === "Enter" || event.key === " ") && event.currentTarget === event.target) {
                      event.preventDefault();
                      onSelectTab(tab.id);
                    }
                  }}
                  onAuxClick={(event) => {
                    // Middle-click closes the tab — same as the X. Neither
                    // deletes the thread; deletion lives in the history popover.
                    if (event.button === 1) {
                      event.preventDefault();
                      onCloseTab(tab.id);
                    }
                  }}
                  className={cn(
                    "group flex max-w-[220px] cursor-pointer items-center gap-1.5 rounded-t-md border-b-2 px-2.5 py-1.5 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
                    isActive
                      ? "border-primary bg-muted/60 text-foreground"
                      : "border-transparent bg-background text-muted-foreground hover:bg-muted/40 hover:text-foreground",
                  )}
                >
                  <span className="min-w-0 truncate">{tab.title}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-5 w-5 shrink-0 opacity-50 transition-opacity hover:opacity-100"
                    aria-label={`Close ${tab.title} tab`}
                    title="Close tab"
                    onClick={(event) => {
                      event.stopPropagation();
                      onCloseTab(tab.id);
                    }}
                  >
                    <XIcon size={10} weight="bold" />
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
        <ScrollBar orientation="horizontal" />
      </ScrollArea>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 left-0 w-4 bg-gradient-to-r from-background to-transparent"
      />
      <div className="flex shrink-0 items-center gap-0.5 border-l border-border px-1.5 py-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="New Ask thread"
          title="New Ask thread"
          disabled={isCreating}
          onClick={onNewThread}
        >
          <PlusIcon size={14} weight="bold" />
        </Button>
        <LibraryAskHistoryPopover
          threads={threads}
          activeThreadId={activeThreadId}
          onSelectThread={onSelectFromHistory}
          onTogglePin={onTogglePin}
          onDeleteThread={onDeleteThread}
        />
      </div>
    </div>
  );
});
