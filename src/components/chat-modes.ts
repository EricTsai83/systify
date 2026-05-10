import { ChatCircleIcon, CubeIcon, FileTextIcon } from "@phosphor-icons/react";
import type { ModeInfoEntry } from "@/components/mode-info-popover";
import type { ChatMode } from "@/lib/types";

/**
 * Static catalogue of every mode the selector can render. Order is stable and
 * doubles as the visual order of the pill bar so the user's eye learns the
 * capability ladder left-to-right: discuss → docs → sandbox, lowest-context
 * to highest-context (and lowest-cost to highest-cost).
 *
 * `value` is the persisted DB literal (`messages.mode` / `threads.mode`) and
 * never changes — only the user-facing `label` / `caption` evolve. The new
 * labels ("General Chat" / "Design Docs" / "Sandbox") are aimed at making the
 * differences obvious to engineering users without requiring the onboarding
 * popover (Plan 14): "Discuss" by itself didn't tell anyone the mode is
 * *training-only*, and "Docs" was ambiguous (README? design artifacts?). The
 * "Sandbox" label is intentionally kept unchanged — it is already the shared
 * vocabulary on the engineering side (Daytona sandbox, sandbox lifecycle,
 * sandbox.process.executeCommand) so renaming it would create a needless
 * translation layer between UI copy and code.
 *
 * Each caption is the short user-facing answer to "what does this mode read
 * from?". The disabled-mode tooltip (rendered by the resolver via
 * `disabledModeReasons`) takes over when the option isn't usable.
 *
 * Lives in its own module so every consumer (mode selector, per-message
 * badge, info popover, empty-state examples, suggestion display) can import
 * the catalog directly without forming sibling-import edges through
 * `chat-panel.tsx`.
 */
export const MODE_CATALOG: ReadonlyArray<{
  value: ChatMode;
  label: string;
  caption: string;
  icon: typeof ChatCircleIcon;
  /**
   * Plan 14 — example prompts shown in `<ModeExamples>` above the
   * composer when the thread is empty, and re-used (first entry only)
   * by `<ModeInfoPopover>` so the popover doubles as a quick "what
   * should I ask in this mode?" reference. Two-to-three entries per
   * mode keeps the empty-state grid balanced (two columns on tablet,
   * three on desktop) and avoids overwhelming a fresh user.
   *
   * Wording targets engineering users who already know what each
   * mode does (the badge and caption tell them); the prompts are
   * meant to be *good* questions in that mode, not introductions to
   * the modes themselves. They are also intentionally answerable —
   * dropping the user into a question whose answer requires another
   * three turns to disambiguate would be a worse first impression
   * than no examples at all.
   */
  examplePrompts: ReadonlyArray<string>;
}> = [
  {
    value: "discuss",
    label: "General Chat",
    caption: "training-only · no repo context",
    icon: ChatCircleIcon,
    examplePrompts: [
      "What are the trade-offs of optimistic vs pessimistic locking?",
      "When does CQRS pay for the extra moving parts?",
      "Explain how rate limiting interacts with idempotency keys.",
    ],
  },
  {
    value: "docs",
    label: "Design Docs",
    caption: "grounded in your design artifacts",
    icon: FileTextIcon,
    examplePrompts: [
      "Summarize the architecture decisions captured in the design artifacts.",
      "Which modules are flagged as risk hotspots in our analysis?",
      "What data-flow boundaries did the analysis call out?",
    ],
  },
  {
    value: "sandbox",
    label: "Sandbox",
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
 * Three-mode restructure — message-mode literals that may appear on
 * persisted messages, including the new `ask` / `lab` modes from the
 * three-mode restructure. Distinct from `ChatMode` (which is the
 * legacy dropdown vocabulary) so adding new persisted modes doesn't
 * smear them into the dropdown.
 */
export type MessageBadgeMode = ChatMode | "ask" | "lab";

/**
 * Lookup keyed by every persisted message mode so the per-message
 * badge (Plan 02) renders a label even for the new `ask` / `lab`
 * literals. The legacy entries come from `MODE_CATALOG`; the new
 * entries get hand-written labels matching the service-mode switcher.
 */
export const MODE_LABELS: Record<MessageBadgeMode, string> = {
  ...MODE_CATALOG.reduce(
    (acc, entry) => {
      acc[entry.value] = entry.label;
      return acc;
    },
    {} as Record<ChatMode, string>,
  ),
  ask: "Library Ask",
  lab: "Lab",
};
