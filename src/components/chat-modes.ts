import { ChatCircleIcon, CubeIcon, FileTextIcon } from "@phosphor-icons/react";
import type { ModeInfoEntry } from "@/components/mode-info-popover";
import type { ChatMode } from "@/lib/types";

/**
 * Static catalogue of every mode the selector can render. Order is stable
 * and doubles as the visual order of the pill bar so the user's eye learns
 * the capability ladder left-to-right: discuss → library → lab,
 * lowest-context to highest-context (and lowest-cost to highest-cost).
 *
 * `value` is the persisted DB literal (`messages.mode` / `threads.mode`)
 * AND the URL segment AND the user-facing label — one vocabulary across
 * the whole stack, by design. Adding a new mode means a single edit to
 * `chatModeValidator`; this catalogue is the UI side of the same coin.
 *
 * Each caption is the short user-facing answer to "what does this mode
 * read from?". The disabled-mode tooltip (rendered by the resolver via
 * `disabledModeReasons`) takes over when the option isn't usable.
 *
 * Lives in its own module so every consumer (mode selector, per-message
 * badge, info popover, empty-state examples, suggestion display) can
 * import the catalog directly without forming sibling-import edges
 * through `chat-panel.tsx`.
 */
export const MODE_CATALOG: ReadonlyArray<{
  value: ChatMode;
  label: string;
  caption: string;
  icon: typeof ChatCircleIcon;
  /**
   * Example prompts shown in `<ModeExamples>` above the composer when
   * the thread is empty, and re-used (first entry only) by
   * `<ModeInfoPopover>` so the popover doubles as a quick "what should
   * I ask in this mode?" reference. Two-to-three entries per mode keeps
   * the empty-state grid balanced (two columns on tablet, three on
   * desktop) and avoids overwhelming a fresh user.
   *
   * Wording targets engineering users who already know what each mode
   * does (the badge and caption tell them); the prompts are meant to be
   * *good* questions in that mode, not introductions to the modes
   * themselves.
   */
  examplePrompts: ReadonlyArray<string>;
}> = [
  {
    value: "discuss",
    label: "Discuss",
    caption: "training-only · no repo context",
    icon: ChatCircleIcon,
    examplePrompts: [
      "What are the trade-offs of optimistic vs pessimistic locking?",
      "When does CQRS pay for the extra moving parts?",
      "Explain how rate limiting interacts with idempotency keys.",
    ],
  },
  {
    value: "library",
    label: "Library",
    caption: "grounded in your design artifacts",
    icon: FileTextIcon,
    examplePrompts: [
      "Summarize the architecture decisions captured in the design artifacts.",
      "Which modules are flagged as risk hotspots in our analysis?",
      "What data-flow boundaries did the analysis call out?",
    ],
  },
  {
    value: "lab",
    label: "Lab",
    caption: "grounded in the live sandbox source tree",
    icon: CubeIcon,
    examplePrompts: [
      "Walk me through how the in-flight reply lease is held and renewed.",
      "Find every place we read OPENAI_API_KEY and explain the precedence.",
      "Show me the error paths in the import pipeline that lack tests.",
    ],
  },
];

/**
 * Plan 14 — descriptors consumed by `<ModeInfoPopover>` for the user-
 * initiated "what do the modes do?" reference. Built once from
 * `MODE_CATALOG` so the popover's vocabulary (label / caption /
 * example) cannot drift from the selector dropdown or the empty-state
 * cards. The popover only needs the *first* example prompt; the full
 * list still renders in `<ModeExamples>` when the thread is empty.
 */
export const MODE_INFO_ENTRIES: ReadonlyArray<ModeInfoEntry> = MODE_CATALOG.map((entry) => ({
  value: entry.value,
  label: entry.label,
  caption: entry.caption,
  icon: entry.icon,
  example: entry.examplePrompts[0] ?? "",
}));

/**
 * Plan 14 — O(1) lookup of a mode's example prompts by `ChatMode`. Used
 * by the empty-state `<ModeExamples>` to render the active mode's
 * cards without re-scanning `MODE_CATALOG` on every render.
 */
export const MODE_EXAMPLES: Record<ChatMode, ReadonlyArray<string>> = MODE_CATALOG.reduce(
  (acc, entry) => {
    acc[entry.value] = entry.examplePrompts;
    return acc;
  },
  {} as Record<ChatMode, ReadonlyArray<string>>,
);

/**
 * Message-mode literals that may appear on persisted messages. Identical to
 * {@link ChatMode}; retained as a separate name so future broader message-only
 * modes can extend it without touching the dropdown vocabulary.
 */
export type MessageBadgeMode = ChatMode;

/**
 * Lookup keyed by every persisted message mode so the per-message badge
 * (Plan 02) renders a label for any mode the schema permits.
 */
export const MODE_LABELS: Record<MessageBadgeMode, string> = MODE_CATALOG.reduce(
  (acc, entry) => {
    acc[entry.value] = entry.label;
    return acc;
  },
  {} as Record<ChatMode, string>,
);
