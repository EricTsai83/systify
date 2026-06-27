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
import { useQuery } from "convex/react";
import { api } from "../../../convex/_generated/api";
import type { LlmProvider, ModelPreferenceScope, PickableModelEntry, ReasoningEffort } from "@/lib/types";
import {
  REASONING_EFFORT_META,
  REASONING_EFFORTS,
  resolveReasoningPickerState,
} from "@/components/ai-elements/reasoning-effort-options";
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
  /** Optional class for resizing the select trigger outside the composer footer. */
  triggerClassName?: string;
  /** Optional preloaded catalog so parent toolbars can gate all controls together. */
  catalogEntries?: ReadonlyArray<PickableModelEntry> | undefined;
}

const EMPTY_REASONING_EFFORTS: readonly ReasoningEffort[] = [];

export function PromptInputReasoningPicker({
  value,
  onChange,
  provider,
  modelName,
  disabled = false,
  disabledReasoningEfforts = EMPTY_REASONING_EFFORTS,
  disabledReasoningEffortMessage,
  preferenceScope = "discuss",
  className,
  triggerClassName,
  catalogEntries: catalogEntriesProp,
}: PromptInputReasoningPickerProps) {
  // Subscribe to the catalog so we can look up `supportsReasoning`
  // for the currently selected model. The query is shared with the
  // sibling model picker and Convex memoises duplicate subscriptions
  // — no real extra cost.
  const queriedCatalogEntries = useQuery(api.llmCatalog.listPickableModels, { preferenceScope });
  const catalogEntries = catalogEntriesProp ?? queriedCatalogEntries;
  const safeCatalog = useMemo<ReadonlyArray<PickableModelEntry>>(
    () => (Array.isArray(catalogEntries) ? catalogEntries : []),
    [catalogEntries],
  );

  const pickerState = useMemo(
    () =>
      resolveReasoningPickerState({
        catalogEntries: safeCatalog,
        provider,
        modelName,
        value,
        disabledReasoningEfforts,
      }),
    [disabledReasoningEfforts, modelName, provider, safeCatalog, value],
  );

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

  useEffect(() => {
    if (pickerState === null || value === null) {
      return;
    }
    if (!pickerState.supportedEfforts.includes(value)) {
      onChange(pickerState.effectiveValue);
    }
  }, [onChange, pickerState, value]);

  // Hide entirely on non-reasoning models. The picker re-renders into
  // the row whenever the user picks a reasoning-capable model, so the
  // hide / show flip is transparent to the surrounding layout.
  // We also short-circuit until the catalog finishes loading so the
  // control doesn't flash in for a tick on a non-reasoning model.
  if (pickerState === null) {
    return null;
  }

  const currentMeta = REASONING_EFFORT_META[pickerState.effectiveValue];

  const handleValueChange = (next: string) => {
    if ((REASONING_EFFORTS as ReadonlyArray<string>).includes(next)) {
      onChange(next as ReasoningEffort);
    }
  };

  const handleTriggerPointerEnter = () => {
    clearTooltipTimer();
    tooltipTimerRef.current = window.setTimeout(() => setIsTooltipOpen(true), 650);
  };

  return (
    <div className={cn("flex items-center gap-1", className)}>
      <PromptInputSelect value={pickerState.effectiveValue} onValueChange={handleValueChange} disabled={disabled}>
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
                  triggerClassName,
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
          {pickerState.selectableEfforts.map((effort) => {
            const meta = REASONING_EFFORT_META[effort];
            const effortDisabled = pickerState.disabledEfforts.has(effort);
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
