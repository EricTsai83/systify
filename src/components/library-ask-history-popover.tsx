import { useEffect, useMemo, useState } from "react";
import {
  ArchiveIcon,
  ClockCounterClockwiseIcon,
  PushPinSimpleIcon,
  PushPinSimpleSlashIcon,
} from "@phosphor-icons/react";
import type { Doc } from "../../convex/_generated/dataModel";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SidebarScrollViewport } from "@/components/sidebar-scroll-viewport";
import type { ThreadId } from "@/lib/types";
import { cn } from "@/lib/utils";

const DAY_MS = 24 * 60 * 60 * 1000;

type ThreadSection = {
  /** `null` for the flat search-results section (no header rendered). */
  label: string | null;
  threads: Doc<"threads">[];
};

/**
 * Library Ask thread history popover.
 *
 * The searchable "all threads" surface for Library Ask, anchored as a popup
 * beneath the clock button on the thread tab strip. The strip itself is only
 * the *open set*; this popover is where the user recalls an older thread
 * (click a row to reopen it as a tab) or archives one. Archiving is deliberately
 * kept off the tabs and lives only here, so it is always a searched-for action
 * rather than a stray click next to a close button.
 *
 * Rows are grouped by recency (Pinned, Today, Yesterday, Previous 7 days,
 * Older) so the user can scan by "when" rather than read every title.
 * Pinned has its own section because pinning means "stay visible regardless
 * of recency" — bucketing pins by `lastMessageAt` would defeat the affordance
 * for any pin older than a week. Searching collapses the groups: when you're
 * hunting by title, date headers add nothing.
 */
export function LibraryAskHistoryPopover({
  threads,
  activeThreadId,
  onSelectThread,
  onTogglePin,
  onArchiveThread,
}: {
  threads: Doc<"threads">[] | undefined;
  activeThreadId: ThreadId | null;
  onSelectThread: (thread: Doc<"threads">) => void;
  onTogglePin: (threadId: ThreadId, pinned: boolean) => void;
  onArchiveThread: (threadId: ThreadId) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  // Reset the filter each time the popover opens. Radix auto-focuses the
  // first focusable child of PopoverContent, which is the search input.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuery("");
    }
  }, [open]);

  const sections = useMemo<ThreadSection[]>(() => {
    const all = threads ?? [];
    const needle = query.trim().toLowerCase();
    if (needle) {
      const matches = all.filter((thread) => thread.title.toLowerCase().includes(needle));
      return matches.length > 0 ? [{ label: null, threads: matches }] : [];
    }

    // Local-midnight boundaries so a thread sent at 11pm doesn't land in
    // "Yesterday" the moment it crosses some UTC threshold.
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const todayMs = startOfToday.getTime();
    const yesterdayMs = todayMs - DAY_MS;
    const sevenDaysMs = todayMs - 7 * DAY_MS;

    const pinned: Doc<"threads">[] = [];
    const today: Doc<"threads">[] = [];
    const yesterday: Doc<"threads">[] = [];
    const last7: Doc<"threads">[] = [];
    const older: Doc<"threads">[] = [];
    for (const thread of all) {
      if (thread.pinnedAt) {
        pinned.push(thread);
        continue;
      }
      const ts = thread.lastMessageAt;
      if (ts >= todayMs) today.push(thread);
      else if (ts >= yesterdayMs) yesterday.push(thread);
      else if (ts >= sevenDaysMs) last7.push(thread);
      else older.push(thread);
    }

    const out: ThreadSection[] = [];
    if (pinned.length) out.push({ label: "Pinned", threads: pinned });
    if (today.length) out.push({ label: "Today", threads: today });
    if (yesterday.length) out.push({ label: "Yesterday", threads: yesterday });
    if (last7.length) out.push({ label: "Previous 7 days", threads: last7 });
    if (older.length) out.push({ label: "Older", threads: older });
    return out;
  }, [query, threads]);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Thread history"
          title="Thread history — search, reopen, or archive past threads"
        >
          <ClockCounterClockwiseIcon size={14} weight="bold" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-64 overflow-hidden p-0"
        aria-label="Library Ask thread history"
        onInteractOutside={(event) => {
          // Keep the popover open when the interaction targets another modal
          // surface (the delete confirm dialog rendered by the parent panel).
          // Without this, clicking the dialog overlay would yank away the
          // searchable list while the user is mid-confirmation.
          const target = event.target as Element | null;
          if (target?.closest("[role='dialog'], [role='alertdialog']")) {
            event.preventDefault();
          }
        }}
      >
        <div className="border-b border-border px-3 py-2">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search Ask threads…"
            className="h-9 border-0 bg-transparent text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
          />
        </div>
        <SidebarScrollViewport className="max-h-[60vh]" viewportClassName="max-h-[60vh] pb-12">
          {threads === undefined ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">Loading threads…</div>
          ) : sections.length === 0 ? (
            <div className="px-3 py-4 text-center text-xs text-muted-foreground">
              {query.trim() ? "No matching threads." : "No Ask threads yet."}
            </div>
          ) : (
            <div className="flex flex-col pb-1">
              {sections.map((section, index) => (
                <div key={section.label ?? "results"} role="group" aria-label={section.label ?? undefined}>
                  {section.label ? (
                    <div
                      className={cn(
                        "px-3 pb-1 text-[10px] font-medium uppercase tracking-wide text-muted-foreground",
                        index === 0 ? "pt-2" : "pt-3",
                      )}
                    >
                      {section.label}
                    </div>
                  ) : null}
                  <ul className="flex flex-col gap-px px-1 pt-0.5">
                    {section.threads.map((thread) => {
                      const threadId = thread._id as ThreadId;
                      const isActive = activeThreadId === threadId;
                      const isPinned = Boolean(thread.pinnedAt);
                      return (
                        <li key={thread._id} className="group relative flex items-center">
                          <button
                            type="button"
                            className={cn(
                              "flex min-w-0 flex-1 items-center gap-2 py-1.5 pl-2 pr-14 text-left text-sm",
                              isActive ? "bg-muted" : "hover:bg-muted/60",
                            )}
                            onClick={() => {
                              onSelectThread(thread);
                              setOpen(false);
                            }}
                          >
                            {isPinned ? (
                              <PushPinSimpleIcon
                                size={11}
                                weight="fill"
                                className="shrink-0 text-muted-foreground"
                                aria-hidden
                              />
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
                              {isPinned ? (
                                <PushPinSimpleSlashIcon size={13} weight="bold" />
                              ) : (
                                <PushPinSimpleIcon size={13} weight="bold" />
                              )}
                            </Button>
                            <Button
                              type="button"
                              variant="ghost"
                              size="icon"
                              className="h-6 w-6 text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
                              aria-label={`Archive ${thread.title}`}
                              title="Archive thread"
                              onClick={() => onArchiveThread(threadId)}
                            >
                              <ArchiveIcon size={13} weight="bold" />
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </SidebarScrollViewport>
      </PopoverContent>
    </Popover>
  );
}
