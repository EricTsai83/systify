import type { ChatMode } from "@/lib/types";
import { cn } from "@/lib/utils";

/**
 * Example-prompt picker shown above the composer when the thread is
 * empty. Clicking a card seeds the composer with the prompt
 * text but **does not** auto-submit; the user can refine the wording
 * before sending. Auto-submit was rejected because the curated prompts
 * are scaffolds, not finished questions — sending verbatim teaches the
 * user that the prompts are answers rather than starting points.
 *
 * The component is intentionally presentational:
 *
 *   - The example list is owned by `MODE_CATALOG` in `chat-panel.tsx`,
 *     not duplicated here. That keeps the badge label, selector
 *     caption, popover example, and these cards in lockstep — renaming
 *     a mode or rewriting a prompt happens in exactly one place.
 *   - `onUseExample` is a plain callback rather than a "set composer
 *     value" prop so this same component can be reused in future
 *     surfaces (e.g. an onboarding tour) that don't share the
 *     composer's state shape.
 *   - Disabling is controlled from the outside (`disabled`) rather
 *     than inferred from a side-channel like "is anything sending"
 *     — the empty state is the only place this renders, where nothing
 *     is in flight, but the prop keeps the contract honest if a
 *     future caller needs to gate the cards.
 */
export function ModeExamples({
  mode,
  examples,
  onUseExample,
  disabled = false,
  className,
}: {
  mode: ChatMode;
  examples: ReadonlyArray<string>;
  onUseExample: (prompt: string) => void;
  disabled?: boolean;
  className?: string;
}) {
  if (examples.length === 0) {
    // Defensive: a mode with no prompts (shouldn't happen — every
    // entry in MODE_CATALOG has 2-3) renders nothing rather than an
    // empty heading row.
    return null;
  }

  return (
    <div
      data-testid="mode-examples"
      data-mode={mode}
      className={cn("flex w-full flex-col gap-2", className)}
      aria-label="Example prompts for the current mode"
    >
      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Try one of these</p>
      <div className="grid w-full gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {examples.map((prompt, index) => (
          <button
            key={prompt}
            type="button"
            onClick={() => onUseExample(prompt)}
            disabled={disabled}
            data-testid={`mode-example-${mode}-${index}`}
            // The button intentionally renders the full prompt rather
            // than a truncated snippet: the card *is* the suggestion,
            // and silently truncating mid-clause would force the user
            // to click before they can read it. `whitespace-normal`
            // lets long prompts wrap; `text-left` is the default for
            // multi-line button content.
            className="group flex h-full flex-col items-start gap-1 border border-border bg-card px-3 py-2 text-left text-xs leading-5 text-foreground transition-colors hover:border-foreground/30 hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50"
          >
            <span className="whitespace-normal">{prompt}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
