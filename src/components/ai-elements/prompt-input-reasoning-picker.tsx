"use client";

/**
 * Composer reasoning-effort picker. Mirrors the public API of
 * `PromptInputModelPicker` so the composer toolbar can render both
 * controls in a row without bespoke wiring per surface.
 *
 * The picker is a per-message override:
 *
 *   - Persisted on `messages.reasoningEffort` for the queued send,
 *     not on the thread row. A trivial follow-up question and a
 *     deep reasoning task can land different efforts inside the same
 *     conversation; the picker resets to the catalog default (or the
 *     last picked override) between sends.
 *   - Hidden entirely when the picked model's catalog entry carries
 *     `supportsReasoning: false` — embedding and future non-reasoning
 *     entries are the expected examples. Hiding the control rather
 *     than disabling it avoids a dangling knob the gateway would
 *     silently drop.
 *
 * Label vocabulary is provider-native:
 *
 *   - OpenAI models: `None / Low / Medium / High / XHigh` — these match
 *     the provider's API enum so a user familiar with the OpenAI
 *     console finds the familiar names.
 *   - Anthropic models: `Off / Standard / Extended / Deep / Max` — the
 *     control still stores the normalized `"none" | ...` value;
 *     the label just reflects how that maps to an Anthropic thinking
 *     budget (disabled / 5K / 16K / 32K / 64K tokens; the actual budget is wired
 *     in `buildProviderOptions`).
 *
 * The component is dumb: every catalog read goes through
 * `useQuery(api.llmCatalog.listPickableModels)` so a future per-user
 * policy that surfaces / hides reasoning lands without a UI change.
 */

import { useMemo } from "react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { LlmProvider, ReasoningEffort } from "@/lib/types";
import {
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
} from "@/components/ai-elements/prompt-input";
import { cn } from "@/lib/utils";

export interface PromptInputReasoningPickerProps {
  /**
   * Currently-picked effort, or `null` when the user has not picked
   * an override for this send (the gateway falls back to the catalog
   * entry's default in that case). The trigger label reflects the
   * effort verbatim; the picker never invents one from the catalog.
   */
  value: ReasoningEffort | null;
  onChange: (next: ReasoningEffort) => void;
  /**
   * Provider currently selected in the sibling model picker. Drives
   * the label vocabulary (OpenAI vs. Anthropic), nothing else. The
   * normalized `ReasoningEffort` is identical for both providers.
   */
  provider: LlmProvider | undefined;
  /**
   * Model name currently selected in the sibling model picker. Used
   * to look up the catalog entry's `supportsReasoning` flag — when
   * the entry is missing or the model does not support reasoning,
   * the picker renders `null` (no control, no label).
   */
  modelName: string | undefined;
  /** Same disabled semantics as the sibling model picker. */
  disabled?: boolean;
  /** Optional class for sizing inside the composer footer. */
  className?: string;
}

const EFFORTS: readonly ReasoningEffort[] = ["none", "low", "medium", "high", "xhigh"];

const OPENAI_LABELS: Record<ReasoningEffort, string> = {
  none: "None",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "XHigh",
};

// Anthropic publishes thinking as a token budget rather than an
// effort enum. Surfacing the budget-shaped vocabulary keeps the
// label honest about what the model is actually doing, without
// changing the stored value.
const ANTHROPIC_LABELS: Record<ReasoningEffort, string> = {
  none: "Off",
  low: "Standard",
  medium: "Extended",
  high: "Deep",
  xhigh: "Max",
};

function labelsForProvider(provider: LlmProvider | undefined): Record<ReasoningEffort, string> {
  if (provider === "anthropic") return ANTHROPIC_LABELS;
  return OPENAI_LABELS;
}

export function PromptInputReasoningPicker({
  value,
  onChange,
  provider,
  modelName,
  disabled = false,
  className,
}: PromptInputReasoningPickerProps) {
  // Subscribe to the catalog so we can look up `supportsReasoning`
  // for the currently selected model. The query is shared with the
  // sibling model picker and Convex memoises duplicate subscriptions
  // — no real extra cost.
  const catalogEntries = useQuery(api.llmCatalog.listPickableModels, {});
  const safeCatalog = useMemo(() => (Array.isArray(catalogEntries) ? catalogEntries : []), [catalogEntries]);

  const selectedEntry = useMemo(() => {
    if (provider === undefined || modelName === undefined) return undefined;
    return safeCatalog.find((entry) => entry.provider === provider && entry.modelName === modelName);
  }, [safeCatalog, provider, modelName]);

  // Hide entirely on non-reasoning models. The picker re-renders into
  // the row whenever the user picks a reasoning-capable model, so the
  // hide / show flip is transparent to the surrounding layout.
  // We also short-circuit until the catalog finishes loading so the
  // control doesn't flash in for a tick on a non-reasoning model.
  if (!selectedEntry || !selectedEntry.supportsReasoning) {
    return null;
  }

  const labels = labelsForProvider(provider);
  const currentLabel = value ? labels[value] : undefined;

  const handleValueChange = (next: string) => {
    if ((EFFORTS as ReadonlyArray<string>).includes(next)) {
      onChange(next as ReasoningEffort);
    }
  };

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <PromptInputSelect value={value ?? undefined} onValueChange={handleValueChange} disabled={disabled}>
        <PromptInputSelectTrigger
          aria-label="Reasoning effort"
          data-testid="prompt-input-reasoning-picker-trigger"
          className="h-8 gap-1.5 px-2 text-xs"
        >
          <PromptInputSelectValue placeholder="Reasoning">{currentLabel}</PromptInputSelectValue>
        </PromptInputSelectTrigger>
        <PromptInputSelectContent>
          {EFFORTS.map((effort) => (
            <PromptInputSelectItem key={effort} value={effort}>
              {labels[effort]}
            </PromptInputSelectItem>
          ))}
        </PromptInputSelectContent>
      </PromptInputSelect>
    </div>
  );
}
