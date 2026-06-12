"use client";

/**
 * Composer reasoning-effort picker. Mirrors the public API of
 * `PromptInputModelPicker` so the composer toolbar can render both
 * controls in a row without bespoke wiring per surface.
 *
 * The picker is a per-message override:
 *
 *   - Persisted on `messages.reasoningEffort` for the queued send
 *     only after the user changes it, not on the thread row. A trivial
 *     follow-up question and a deep reasoning task can land different
 *     efforts inside the same conversation; until then the picker
 *     displays the catalog default while letting the gateway apply it.
 *   - Hidden entirely when the picked model's catalog entry carries
 *     `supportsReasoning: false` — embedding and future non-reasoning
 *     entries are the expected examples. Hiding the control rather
 *     than disabling it avoids a dangling knob the gateway would
 *     silently drop.
 *
 * Label vocabulary follows the provider/AI SDK effort vocabulary:
 *
 *   - `none` is the only exception: the UI shows `Instant` because
 *     there is no reasoning effort to apply.
 *   - Other values render as title-cased official effort names.
 *
 * The component is dumb: every catalog read goes through
 * `useQuery(api.llmCatalog.listPickableModels)` so a future per-user
 * policy that surfaces / hides reasoning lands without a UI change.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AtomIcon,
  BrainIcon,
  BracketsCurlyIcon,
  CircuitryIcon,
  GaugeIcon,
  LightningIcon,
  type Icon,
} from "@phosphor-icons/react";
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { LlmProvider, ModelPreferenceScope, ReasoningEffort } from "@/lib/types";
import {
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
} from "@/components/ai-elements/prompt-input";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

export interface PromptInputReasoningPickerProps {
  /**
   * Currently-picked effort, or `null` when the user has not picked
   * an override for this send. In the null state, the trigger displays
   * the catalog default so the row still shows the active reasoning
   * level; the gateway remains responsible for applying that default.
   */
  value: ReasoningEffort | null;
  onChange: (next: ReasoningEffort | null) => void;
  /** Provider currently selected in the sibling model picker. */
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
  /** Efforts that stay visible in the menu but cannot be selected by the current access policy. */
  disabledReasoningEfforts?: ReadonlyArray<ReasoningEffort>;
  disabledReasoningEffortMessage?: string;
  /** Settings scope used for model availability lookup. */
  preferenceScope?: ModelPreferenceScope;
  /** Optional class for sizing inside the composer footer. */
  className?: string;
}

const EFFORTS: readonly ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];

const EFFORT_META: Record<ReasoningEffort, { label: string; Icon: Icon }> = {
  none: { label: "Instant", Icon: LightningIcon },
  minimal: { label: "Minimal", Icon: GaugeIcon },
  low: { label: "Low", Icon: CircuitryIcon },
  medium: { label: "Medium", Icon: BracketsCurlyIcon },
  high: { label: "High", Icon: BrainIcon },
  xhigh: { label: "XHigh", Icon: AtomIcon },
};

export function PromptInputReasoningPicker({
  value,
  onChange,
  provider,
  modelName,
  disabled = false,
  disabledReasoningEfforts = [],
  disabledReasoningEffortMessage,
  preferenceScope = "discuss",
  className,
}: PromptInputReasoningPickerProps) {
  // Subscribe to the catalog so we can look up `supportsReasoning`
  // for the currently selected model. The query is shared with the
  // sibling model picker and Convex memoises duplicate subscriptions
  // — no real extra cost.
  const catalogEntries = useQuery(api.llmCatalog.listPickableModels, { preferenceScope });
  const safeCatalog = useMemo(() => (Array.isArray(catalogEntries) ? catalogEntries : []), [catalogEntries]);

  const selectedEntry = useMemo(() => {
    if (provider === undefined || modelName === undefined) return undefined;
    return safeCatalog.find((entry) => entry.provider === provider && entry.modelName === modelName);
  }, [safeCatalog, provider, modelName]);

  const tooltipTimerRef = useRef<number | null>(null);
  const [isTooltipOpen, setIsTooltipOpen] = useState(false);

  const clearTooltipTimer = useCallback(() => {
    if (tooltipTimerRef.current) {
      window.clearTimeout(tooltipTimerRef.current);
      tooltipTimerRef.current = null;
    }
  }, []);

  const closeTooltip = useCallback(() => {
    clearTooltipTimer();
    setIsTooltipOpen(false);
  }, [clearTooltipTimer]);

  useEffect(() => closeTooltip, [closeTooltip]);

  const supportedEfforts = useMemo(
    () => selectedEntry?.supportedReasoningEfforts ?? [],
    [selectedEntry?.supportedReasoningEfforts],
  );
  const fallbackEffort = selectedEntry?.reasoningEffort ?? supportedEfforts[0] ?? "none";

  useEffect(() => {
    if (!selectedEntry?.supportsReasoning || value === null) {
      return;
    }
    if (!supportedEfforts.includes(value)) {
      onChange(fallbackEffort);
    }
  }, [fallbackEffort, onChange, selectedEntry?.supportsReasoning, supportedEfforts, value]);

  // Hide entirely on non-reasoning models. The picker re-renders into
  // the row whenever the user picks a reasoning-capable model, so the
  // hide / show flip is transparent to the surrounding layout.
  // We also short-circuit until the catalog finishes loading so the
  // control doesn't flash in for a tick on a non-reasoning model.
  if (!selectedEntry || !selectedEntry.supportsReasoning) {
    return null;
  }

  const selectableEfforts = supportedEfforts.length > 0 ? supportedEfforts : EFFORTS;
  const disabledEffortSet = new Set(disabledReasoningEfforts);
  const effectiveValue = value !== null && supportedEfforts.includes(value) ? value : fallbackEffort;
  const currentMeta = EFFORT_META[effectiveValue];

  const handleValueChange = (next: string) => {
    if ((EFFORTS as ReadonlyArray<string>).includes(next)) {
      onChange(next as ReasoningEffort);
    }
  };

  const handleTriggerPointerEnter = () => {
    clearTooltipTimer();
    tooltipTimerRef.current = window.setTimeout(() => setIsTooltipOpen(true), 650);
  };

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <PromptInputSelect value={effectiveValue} onValueChange={handleValueChange} disabled={disabled}>
        <TooltipProvider>
          <Tooltip open={isTooltipOpen}>
            <TooltipTrigger asChild>
              <PromptInputSelectTrigger
                aria-label="Reasoning effort"
                data-testid="prompt-input-reasoning-picker-trigger"
                onPointerEnter={handleTriggerPointerEnter}
                onPointerLeave={closeTooltip}
                onPointerDown={closeTooltip}
                className={cn(
                  "h-8 w-auto min-w-0 max-w-32 justify-start gap-1.5 rounded-none border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none",
                  "hover:bg-accent hover:text-foreground",
                  "focus-visible:bg-transparent focus-visible:text-foreground",
                  "aria-expanded:bg-accent aria-expanded:text-foreground",
                )}
              >
                <div className="flex size-4 shrink-0 items-center justify-center self-center text-current">
                  <currentMeta.Icon size={14} weight="bold" />
                </div>
                <PromptInputSelectValue className="flex items-center truncate leading-none" placeholder="Reasoning">
                  {currentMeta.label}
                </PromptInputSelectValue>
              </PromptInputSelectTrigger>
            </TooltipTrigger>
            <TooltipContent side="top">Reasoning effort</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <PromptInputSelectContent className="min-w-36 border-border bg-popover p-1 text-popover-foreground shadow-lg">
          {selectableEfforts.map((effort) => {
            const meta = EFFORT_META[effort];
            const effortDisabled = disabledEffortSet.has(effort);
            return (
              <PromptInputSelectItem
                key={effort}
                value={effort}
                disabled={effortDisabled}
                title={effortDisabled ? disabledReasoningEffortMessage : undefined}
                className={cn(
                  "h-8 px-2 py-0 text-sm text-popover-foreground",
                  "focus:bg-accent focus:text-accent-foreground data-highlighted:bg-accent",
                  "[&>span:first-child]:hidden",
                )}
              >
                <div className="flex h-full w-full items-center gap-2 leading-none">
                  <span className="flex size-5 shrink-0 items-center justify-center self-center text-muted-foreground">
                    <meta.Icon size={15} weight="bold" />
                  </span>
                  <span className="leading-none">{meta.label}</span>
                </div>
              </PromptInputSelectItem>
            );
          })}
        </PromptInputSelectContent>
      </PromptInputSelect>
    </div>
  );
}
