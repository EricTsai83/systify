import { CheckIcon, SlidersHorizontalIcon } from "@phosphor-icons/react";
import {
  REASONING_EFFORT_META,
  resolveReasoningPickerState,
  type ReasoningPickerState,
} from "@/components/ai-elements/reasoning-effort-options";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { LlmProvider, PickableModelEntry, ReasoningEffort } from "@/lib/types";

export type CompactModelSettingsValue = {
  provider: LlmProvider;
  modelName: string;
};

export type CompactModelPickerState = {
  value: CompactModelSettingsValue | null;
  onChange: (next: CompactModelSettingsValue) => void;
  threadLockedProvider?: LlmProvider | null;
  disabled?: boolean;
  getDisabledReason?: (entry: PickableModelEntry) => string | null;
  catalogEntries: ReadonlyArray<PickableModelEntry> | undefined;
};

export type CompactReasoningPickerState = {
  value: ReasoningEffort | null;
  onChange: (next: ReasoningEffort | null) => void;
  provider: LlmProvider | undefined;
  modelName: string | undefined;
  disabledReasoningEfforts?: ReadonlyArray<ReasoningEffort>;
  disabledReasoningEffortMessage?: string;
  catalogEntries: ReadonlyArray<PickableModelEntry> | undefined;
};

export function CompactModelSettingsMenu({
  modelPicker,
  reasoningPicker,
}: {
  modelPicker: CompactModelPickerState | null;
  reasoningPicker: CompactReasoningPickerState | null;
}) {
  if (!modelPicker) return null;

  const safeModelCatalog = Array.isArray(modelPicker.catalogEntries) ? modelPicker.catalogEntries : [];
  const visibleModels = modelPicker.threadLockedProvider
    ? safeModelCatalog.filter((entry) => entry.provider === modelPicker.threadLockedProvider)
    : safeModelCatalog;
  const currentModelLabel = getModelDisplayName(modelPicker.value, safeModelCatalog);
  const reasoningState = getCompactReasoningState(reasoningPicker);
  const triggerLabel = [currentModelLabel, reasoningState?.label].filter(Boolean).join(" / ") || "Model";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={modelPicker.disabled}
          aria-label="Model settings"
          data-testid="compact-model-settings-trigger"
          className="h-8 max-w-full shrink-0 gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground active:scale-100 focus-visible:bg-muted focus-visible:ring-0 focus-visible:ring-offset-0 data-[state=open]:bg-muted data-[state=open]:text-foreground"
        >
          <SlidersHorizontalIcon size={14} weight="bold" />
          <span className="truncate">{triggerLabel}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-56 p-1" data-testid="compact-model-settings-menu">
        <DropdownMenuLabel>Model</DropdownMenuLabel>
        {visibleModels.length === 0 ? (
          <div className="px-2 py-1.5 text-xs text-muted-foreground">No models available.</div>
        ) : (
          visibleModels.map((entry) => {
            const selected =
              modelPicker.value !== null &&
              modelPicker.value.provider === entry.provider &&
              modelPicker.value.modelName === entry.modelName;
            const disabledReason = modelPicker.getDisabledReason?.(entry) ?? null;
            return (
              <DropdownMenuItem
                key={`${entry.provider}:${entry.modelName}`}
                disabled={disabledReason !== null}
                title={disabledReason ?? undefined}
                className="h-8 gap-2 pl-2 pr-2 text-sm"
                onSelect={() => modelPicker.onChange({ provider: entry.provider, modelName: entry.modelName })}
              >
                <CompactCheck selected={selected} />
                <span className="min-w-0 flex-1 truncate">{entry.displayName}</span>
              </DropdownMenuItem>
            );
          })
        )}

        {reasoningPicker && reasoningState ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel>Reasoning</DropdownMenuLabel>
            {reasoningState.selectableEfforts.map((effort) => {
              const meta = REASONING_EFFORT_META[effort];
              const selected = effort === reasoningState.effectiveValue;
              const disabled = reasoningState.disabledEfforts.has(effort);
              return (
                <DropdownMenuItem
                  key={effort}
                  disabled={disabled}
                  title={disabled ? reasoningPicker.disabledReasoningEffortMessage : undefined}
                  className="h-8 gap-2 pl-2 pr-2 text-sm"
                  onSelect={() => reasoningPicker.onChange(effort)}
                >
                  <CompactCheck selected={selected} />
                  <span className="min-w-0 flex-1 truncate">{meta.label}</span>
                </DropdownMenuItem>
              );
            })}
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CompactCheck({ selected }: { selected: boolean }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center text-primary">
      {selected ? <CheckIcon size={13} weight="bold" aria-hidden="true" /> : null}
    </span>
  );
}

function getModelDisplayName(
  value: CompactModelSettingsValue | null,
  catalogEntries: ReadonlyArray<PickableModelEntry>,
): string | undefined {
  if (!value) return undefined;
  const entry = catalogEntries.find(
    (candidate) => candidate.provider === value.provider && candidate.modelName === value.modelName,
  );
  return entry?.displayName ?? value.modelName;
}

function getCompactReasoningState(reasoningPicker: CompactReasoningPickerState | null): ReasoningPickerState | null {
  if (!reasoningPicker) return null;
  const catalogEntries = Array.isArray(reasoningPicker.catalogEntries) ? reasoningPicker.catalogEntries : [];
  return resolveReasoningPickerState({
    catalogEntries,
    provider: reasoningPicker.provider,
    modelName: reasoningPicker.modelName,
    value: reasoningPicker.value,
    disabledReasoningEfforts: reasoningPicker.disabledReasoningEfforts,
  });
}
