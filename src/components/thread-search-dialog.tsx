import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "convex/react";
import { PushPinSimpleIcon } from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { api } from "../../convex/_generated/api";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { filterByQuery } from "@/lib/text-filter";
import type { ChatMode, RepositoryId, ThreadId, ThreadMode } from "@/lib/types";
import { cn } from "@/lib/utils";

type SearchThread = Doc<"threads">;

export function ThreadSearchDialog({
  open,
  onOpenChange,
  repositoryId,
  mode,
  selectedThreadId,
  onSelectThread,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  repositoryId: RepositoryId | null;
  mode: ChatMode;
  selectedThreadId: ThreadId | null;
  onSelectThread: (id: ThreadId, mode: ThreadMode) => void;
}) {
  const repoThreads = useQuery(api.chat.threads.listThreads, repositoryId ? { repositoryId, mode } : "skip");
  const repolessThreads = useQuery(api.chat.threads.listRepolessThreads, repositoryId === null ? {} : "skip");
  const threads = repositoryId === null ? repolessThreads : repoThreads;
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setQuery("");
    setActiveIndex(0);
    const handle = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(handle);
  }, [open]);

  const filtered = useMemo(
    () => filterByQuery(threads ?? [], query, (thread) => thread.title).slice(0, 50),
    [threads, query],
  );

  useEffect(() => {
    if (activeIndex >= filtered.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveIndex(filtered.length === 0 ? 0 : filtered.length - 1);
    }
  }, [activeIndex, filtered.length]);

  const selectThread = (thread: SearchThread) => {
    onSelectThread(thread._id, thread.mode);
    onOpenChange(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setActiveIndex((current) => Math.min(filtered.length - 1, current + 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((current) => Math.max(0, current - 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const target = filtered[activeIndex];
      if (target) {
        selectThread(target);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-lg" showCloseButton={false}>
        <DialogTitle className="sr-only">Search threads</DialogTitle>
        <DialogDescription className="sr-only">
          Search conversation threads and press enter to open the highlighted row.
        </DialogDescription>
        <div className="border-b border-border px-3 py-2">
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActiveIndex(0);
            }}
            onKeyDown={onKeyDown}
            placeholder="Search threads..."
            aria-activedescendant={filtered[activeIndex] ? `thread-search-row-${filtered[activeIndex]._id}` : undefined}
            className="h-9 border-0 bg-transparent text-sm focus-visible:border-transparent"
          />
        </div>
        <ScrollArea className="max-h-[min(24rem,60vh)]">
          <ul role="listbox" className="flex flex-col gap-px p-1">
            {threads === undefined ? (
              <li className="px-3 py-4 text-center text-xs text-muted-foreground">Loading threads...</li>
            ) : filtered.length === 0 ? (
              <li className="px-3 py-4 text-center text-xs text-muted-foreground">No matching threads.</li>
            ) : (
              filtered.map((thread, index) => (
                <li
                  key={thread._id}
                  id={`thread-search-row-${thread._id}`}
                  role="option"
                  aria-selected={index === activeIndex}
                >
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2 px-3 py-2 text-left text-sm",
                      index === activeIndex ? "bg-muted" : "hover:bg-muted/60",
                    )}
                    onClick={() => selectThread(thread)}
                    onMouseEnter={() => setActiveIndex(index)}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 items-center gap-1.5">
                        {thread.pinnedAt ? (
                          <PushPinSimpleIcon size={11} weight="bold" className="shrink-0 text-muted-foreground" />
                        ) : null}
                        <div className="truncate text-[13px] font-medium text-foreground">{thread.title}</div>
                      </div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">
                        {thread._id === selectedThreadId
                          ? "Current thread"
                          : formatThreadModeLabel(thread, repositoryId === null)}
                      </div>
                    </div>
                  </button>
                </li>
              ))
            )}
          </ul>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}

function formatThreadModeLabel(thread: SearchThread, isRepoless: boolean): string {
  if (isRepoless) {
    return Boolean(thread.agentRole?.trim()) || Boolean(thread.agentInstructions?.trim())
      ? "Agent Mode"
      : "Thread Mode";
  }
  return thread.mode === "library" ? "Library Ask" : "Discuss";
}
