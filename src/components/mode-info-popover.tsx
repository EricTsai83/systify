import { InfoIcon } from "@phosphor-icons/react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { ChatMode } from "@/lib/types";

/**
 * Plan 14 — single descriptor passed to `<ModeInfoPopover>`. The chat
 * panel computes this once from `MODE_CATALOG` so the same display
 * vocabulary (label / icon) used by the selector, the badge, and the
 * empty-state example cards drives the popover too.
 *
 * `caption` is the one-line "what does this mode read from?" line
 * already shown beneath each `SelectItem`; surfacing it again here
 * gives users who don't routinely open the selector dropdown a chance
 * to learn the differences. `example` is one representative prompt
 * (the first entry in the per-mode example list) so the popover
 * doubles as a quick "what should I ask in this mode?" reference
 * without duplicating the full example grid.
 */
export type ModeInfoEntry = {
  readonly value: ChatMode;
  readonly label: string;
  readonly caption: string;
  readonly example: string;
  readonly icon: React.ComponentType<{ size?: number; weight?: "regular" | "bold" | "fill" }>;
};

/**
 * Plan 14 — `(i)` info trigger next to the mode selector that opens a
 * popover with a side-by-side comparison of all three modes. This is
 * deliberately **user-initiated** — the plan rejects modal popovers on
 * mode switch (Linear / Cursor / ChatGPT all use passive disclosure for
 * the same reason: mode switch is a high-frequency action). Putting
 * the explanation behind a click means the user can always find it
 * without it constantly fighting for their attention.
 *
 * Why this is its own component (not inlined in `ChatPanel`):
 *
 *   1. `ChatPanel` already pulls in two selector renderers (desktop +
 *      compact). Duplicating the popover JSX in both would diverge over
 *      time; extracting it lets both selectors call the same trigger.
 *   2. The popover is the natural home for any *future* mode-related
 *      learning content (e.g. "Sandbox is in beta" copy, links to
 *      runbooks). Keeping it scoped to one file means future additions
 *      land in a focused module rather than swelling chat-panel.tsx.
 *   3. The component takes only the data it needs (`entries`) so unit
 *      tests can render the popover without a full ChatPanel harness.
 */
export function ModeInfoPopover({ entries, className }: { entries: ReadonlyArray<ModeInfoEntry>; className?: string }) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          // `size="icon"` is the established pattern for square icon
          // buttons in this codebase, but the selector pill it sits
          // next to is `h-7` so we override sizing inline. Keeping
          // both visual sizes locked together prevents the trigger
          // from looking like a leftover utility nav element.
          size="icon"
          aria-label="What do the modes do?"
          data-testid="mode-info-trigger"
          className={`h-7 w-7 rounded-sm text-muted-foreground/80 hover:bg-muted hover:text-foreground ${className ?? ""}`}
        >
          <InfoIcon size={14} weight="bold" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        collisionPadding={12}
        // Wider than the default 16rem because three two-line entries
        // would otherwise stack into a tall narrow column; capping at
        // viewport-minus-1.5rem prevents the popover from clipping on
        // small screens where the selector might be near the edge.
        className="w-[min(22rem,calc(100vw-1.5rem))] p-3"
        data-testid="mode-info-popover"
      >
        <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Answer modes</p>
        <ul className="flex flex-col gap-2.5">
          {entries.map((entry) => {
            const Icon = entry.icon;
            return (
              <li key={entry.value} data-testid={`mode-info-entry-${entry.value}`} className="flex items-start gap-2.5">
                <span
                  aria-hidden="true"
                  className="mt-0.5 grid size-6 shrink-0 place-items-center rounded-sm bg-muted text-muted-foreground"
                >
                  <Icon size={12} weight="bold" />
                </span>
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold leading-5">{entry.label}</p>
                  <p className="text-[11px] leading-5 text-muted-foreground">{entry.caption}</p>
                  <p className="mt-1 text-[11px] italic leading-5 text-muted-foreground/80">“{entry.example}”</p>
                </div>
              </li>
            );
          })}
        </ul>
      </PopoverContent>
    </Popover>
  );
}
