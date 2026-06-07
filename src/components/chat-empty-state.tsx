import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

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
      <span className="animate-z-puff-3 text-muted-foreground/70">z</span>
      {"\n           "}
      <span className="animate-z-puff-2 text-muted-foreground/70">Z</span>
      {"\n         "}
      <span className="animate-z-puff-1 text-muted-foreground/70">z</span>
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
 * Shared hero block for chatroom empty states — visual, title, optional
 * description. The same structural primitive backs Library Ask, Discuss,
 * and the no-repo hint so the framework stays consistent even
 * when the visual (icon vs. ASCII owl) and copy differ per context.
 */
export function EmptyStateHero({
  visual,
  title,
  description,
}: {
  visual: ReactNode;
  title: ReactNode;
  description?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center gap-3 text-center">
      {visual}
      <div className="space-y-1">
        <h3 className="text-sm font-semibold text-foreground">{title}</h3>
        {description ? (
          <p className="mx-auto max-w-[280px] text-xs leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Shared starter-prompt list. Each prompt is a clickable card that calls
 * `onPick` with the prompt text — the caller seeds its composer (no
 * auto-submit) so users can refine before sending. `layout="stack"`
 * suits narrow surfaces (sidebar Ask panel); `layout="grid"` suits the
 * wide chat column.
 */
export function PromptSuggestionList({
  label = "Try asking",
  prompts,
  onPick,
  layout = "stack",
  disabled = false,
  className,
}: {
  label?: string;
  prompts: ReadonlyArray<string>;
  onPick: (prompt: string) => void;
  layout?: "stack" | "grid";
  disabled?: boolean;
  className?: string;
}) {
  if (prompts.length === 0) return null;
  return (
    <div data-testid="prompt-suggestions" className={cn("flex w-full flex-col gap-2", className)}>
      <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground/70">{label}</p>
      <div
        className={cn(
          layout === "grid" ? "grid w-full gap-2 sm:grid-cols-2 lg:grid-cols-3" : "flex w-full flex-col gap-1.5",
        )}
      >
        {prompts.map((prompt, index) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onPick(prompt)}
            disabled={disabled}
            data-testid={`prompt-suggestion-${index}`}
            className="group flex h-full items-start gap-2 border border-border bg-card/50 px-3 py-2 text-left text-xs leading-5 text-foreground transition-colors hover:border-foreground/30 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="min-w-0 whitespace-normal">{prompt}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * Empty-state hint for repo-attached threads with no messages yet. Users
 * generate System Design artifacts from the Library page; the chat shell
 * stays focused on conversation-starter affordances.
 */
export function EmptyChatHint() {
  return (
    // No opacity-fade entrance. The hint swaps in atomically when the
    // user leaves a populated thread for the lazy-create draft
    // (`/discuss/new`); an `animate-in fade-in` would paint a frame of
    // bare `bg-background` (owl at opacity 0) right after the message
    // list is removed, which reads as a background flash on an
    // otherwise-instant swap. The owl's own idle animation carries the
    // life here.
    <div className="flex flex-1 items-center justify-center">
      <EmptyStateHero
        visual={<OwlAsciiArt />}
        title="Start a design conversation"
        description="Architecture · Module dependencies · Risk hotspots"
      />
    </div>
  );
}

/**
 * Empty-state hint for threads with no attached repository. Binding a
 * repoless thread to a repo has no UI entry point — to work against a
 * repo, users start a new thread in that repo's shell — so this surface
 * stays focused on the conversation-starter hero.
 */
export function EmptyNoRepoHint() {
  return (
    // See EmptyChatHint: no opacity-fade entrance, so swapping in from a
    // populated thread doesn't flash a frame of bare background.
    <div className="flex flex-1 items-center justify-center">
      <EmptyStateHero
        visual={<OwlAsciiArt />}
        title="Start a design conversation"
        description="Architecture · Trade-offs · Anything you'd whiteboard"
      />
    </div>
  );
}
