import { useEffect, useMemo, useRef, useState } from "react";
import { PushPinIcon, TrashIcon } from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import type { ThreadId } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Three-mode restructure — Library Ask thread history dialog.
 *
 * The searchable "all threads" surface for Library Ask, opened from the
 * clock button on the thread tab strip. The strip itself is only the *open
 * set*; this dialog is where the user recalls an older thread (click a row
 * to reopen it as a tab) or deletes one. Deletion is deliberately kept off
 * the tabs and lives only here, so it is always a searched-for action
 * rather than a stray click next to a close button.
 *
 * Mirrors `QuickOpenDialog`'s shape (search input + scrollable listbox);
 * `listThreads` already returns pinned-first, so rows render in order with
 * no client-side sort.
 */
export function LibraryAskHistoryDialog({
  open,
  onOpenChange,
  threads,
  activeThreadId,
  onSelectThread,
  onTogglePin,
  onDeleteThread,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  threads: Doc<"threads">[] | undefined;
  activeThreadId: ThreadId | null;
  onSelectThread: (thread: Doc<"threads">) => void;
  onTogglePin: (threadId: ThreadId, pinned: boolean) => void;
  onDeleteThread: (threadId: ThreadId) => void;
}) {
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset the filter and focus the input each time the dialog opens. setState
  // in an effect is the right tool: the reset is keyed on the external `open`
  // prop and must also schedule the deferred focus.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuery("");
      const handle = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(handle);
    }
  }, [open]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const all = threads ?? [];
    if (!needle) return all;
    return all.filter((thread) => thread.title.toLowerCase().includes(needle));
  }, [query, threads]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-lg">
        <DialogTitle className="sr-only">Library Ask thread history</DialogTitle>
        <DialogDescription className="sr-only">
          Search past Ask threads. Click a row to reopen it; use the trash button to delete one.
        </DialogDescription>
        <div className="border-b border-border px-3 py-2">
          <Input
            ref={inputRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search Ask threads by title…"
            className="h-9 border-0 bg-transparent text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
          />
        </div>
        <ScrollArea className="max-h-[60vh]">
          <ul className="flex flex-col gap-px p-1">
            {threads === undefined ? (
              <li className="px-3 py-4 text-center text-xs text-muted-foreground">Loading threads…</li>
            ) : filtered.length === 0 ? (
              <li className="px-3 py-4 text-center text-xs text-muted-foreground">
                {query.trim() ? "No matching threads." : "No Ask threads yet."}
              </li>
            ) : (
              filtered.map((thread) => {
                const threadId = thread._id as ThreadId;
                const isActive = activeThreadId === threadId;
                const isPinned = Boolean(thread.pinnedAt);
                return (
                  <li key={thread._id} className="group relative flex items-center">
                    <button
                      type="button"
                      className={cn(
                        "flex min-w-0 flex-1 items-center gap-2 rounded-md py-2 pl-3 pr-16 text-left text-sm",
                        isActive ? "bg-muted" : "hover:bg-muted/60",
                      )}
                      onClick={() => {
                        onSelectThread(thread);
                        onOpenChange(false);
                      }}
                    >
                      {isPinned ? (
                        <PushPinIcon size={11} weight="fill" className="shrink-0 text-muted-foreground" aria-hidden />
                      ) : null}
                      <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">
                        {thread.title}
                      </span>
                    </button>
                    <div className="absolute right-1 flex items-center gap-0.5">
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className={cn(
                          "h-6 w-6 transition-opacity focus-visible:opacity-100",
                          isPinned
                            ? "text-foreground opacity-100 hover:text-muted-foreground"
                            : "text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100",
                        )}
                        aria-label={isPinned ? "Unpin thread" : "Pin thread"}
                        aria-pressed={isPinned}
                        title={isPinned ? "Unpin thread" : "Pin thread"}
                        onClick={() => onTogglePin(threadId, !isPinned)}
                      >
                        <PushPinIcon size={13} weight={isPinned ? "fill" : "regular"} />
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 text-muted-foreground opacity-0 transition-opacity hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                        aria-label={`Delete ${thread.title}`}
                        title="Delete thread"
                        onClick={() => onDeleteThread(threadId)}
                      >
                        <TrashIcon size={13} weight="bold" />
                      </Button>
                    </div>
                  </li>
                );
              })
            )}
          </ul>
        </ScrollArea>
      </DialogContent>
    </Dialog>
  );
}
