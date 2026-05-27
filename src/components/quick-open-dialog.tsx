import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { formatArtifactKind } from "@/lib/operations";
import { filterByQuery } from "@/lib/text-filter";
import type { ArtifactId, ArtifactListItem } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Cmd/Ctrl-P quick-open dialog for Library artifacts.
 *
 * Pure-frontend fuzzy filter: the dialog receives the workspace's full
 * artifact list (already loaded by the Library shell for the tree, so
 * no extra subscription) and filters in memory by title / summary /
 * kind. Sorted hits scroll into view; arrow keys + Enter activate the
 * highlighted row.
 *
 * Why we don't lean on shadcn `<Command>` here: the project doesn't
 * carry the package and the surface is a one-shot picker — a hand-
 * rolled list with proper aria-activedescendant gives us the same UX
 * in 60 lines without adding a dependency.
 */
export function QuickOpenDialog({
  open,
  onOpenChange,
  artifacts,
  onSelect,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  artifacts: ReadonlyArray<ArtifactListItem>;
  onSelect: (artifactId: ArtifactId) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement | null>(null);

  // Reset state every time the dialog opens so the user starts on a
  // clean filter and the focused row is the top hit. setState in an
  // effect is the right tool here: the reset is keyed on `open`
  // (external prop) and must also schedule the deferred focus, which
  // can't run during render.
  useEffect(() => {
    if (open) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuery("");
      setActiveIndex(0);
      // Defer focus by a tick — the Dialog mounts the input after the
      // open transition begins; focusing too eagerly drops the focus
      // when Radix re-mounts the overlay.
      const handle = window.setTimeout(() => inputRef.current?.focus(), 30);
      return () => window.clearTimeout(handle);
    }
  }, [open]);

  const filtered = useMemo(
    // Empty query passes through unchanged (filterByQuery returns the
    // input as-is), so the slice still acts as the "jump to recent work"
    // most-recent cap when the user hasn't typed anything yet.
    () =>
      filterByQuery(
        artifacts,
        query,
        (artifact) => `${artifact.title} ${artifact.summary} ${formatArtifactKind(artifact.kind)}`,
      ).slice(0, 50),
    [query, artifacts],
  );

  // Keep the active index in range when the result list shrinks.
  // setState in an effect is the right shape: `filtered` is derived
  // from props + query state, so deriving `activeIndex` purely during
  // render would loop. The early return guarantees one setState per
  // genuine list-length change.
  useEffect(() => {
    if (activeIndex >= filtered.length) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setActiveIndex(filtered.length === 0 ? 0 : filtered.length - 1);
    }
  }, [filtered.length, activeIndex]);

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
        onSelect(target._id as ArtifactId);
        onOpenChange(false);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden p-0 sm:max-w-xl">
        <DialogTitle className="sr-only">Quick open artifact</DialogTitle>
        <DialogDescription className="sr-only">
          Search the repository artifacts and press enter to open the highlighted row.
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
            placeholder="Search artifacts by title, summary, or kind…"
            aria-activedescendant={filtered[activeIndex] ? `quick-open-row-${filtered[activeIndex]._id}` : undefined}
            className="h-9 border-0 bg-transparent text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
          />
        </div>
        <ScrollArea className="max-h-[60vh]">
          <ul role="listbox" className="flex flex-col gap-px p-1">
            {filtered.length === 0 ? (
              <li className="px-3 py-4 text-center text-xs text-muted-foreground">No matching artifacts.</li>
            ) : (
              filtered.map((artifact, index) => (
                <li
                  key={artifact._id}
                  id={`quick-open-row-${artifact._id}`}
                  role="option"
                  aria-selected={index === activeIndex}
                >
                  <button
                    type="button"
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm",
                      index === activeIndex ? "bg-muted" : "hover:bg-muted/60",
                    )}
                    onClick={() => {
                      onSelect(artifact._id as ArtifactId);
                      onOpenChange(false);
                    }}
                    onMouseEnter={() => setActiveIndex(index)}
                  >
                    <Badge variant="outline" className="shrink-0 text-[9px] uppercase">
                      {formatArtifactKind(artifact.kind)}
                    </Badge>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-foreground">{artifact.title}</div>
                      <div className="truncate text-[11px] text-muted-foreground">{artifact.summary}</div>
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
