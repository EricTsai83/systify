import {
  AtomIcon,
  BrainIcon,
  BracketsCurlyIcon,
  CircuitryIcon,
  GaugeIcon,
  LightningIcon,
  type Icon,
} from "@phosphor-icons/react";
import type { LlmProvider, PickableModelEntry, ReasoningEffort } from "@/lib/types";

export const REASONING_EFFORTS: readonly ReasoningEffort[] = ["none", "minimal", "low", "medium", "high", "xhigh"];

export const REASONING_EFFORT_META: Record<ReasoningEffort, { label: string; Icon: Icon }> = {
  none: { label: "Instant", Icon: LightningIcon },
  minimal: { label: "Minimal", Icon: GaugeIcon },
  low: { label: "Low", Icon: CircuitryIcon },
  medium: { label: "Medium", Icon: BracketsCurlyIcon },
  high: { label: "High", Icon: BrainIcon },
  xhigh: { label: "XHigh", Icon: AtomIcon },
};

export type ReasoningPickerState = {
  effectiveValue: ReasoningEffort;
  label: string;
  selectableEfforts: readonly ReasoningEffort[];
  supportedEfforts: readonly ReasoningEffort[];
  disabledEfforts: ReadonlySet<ReasoningEffort>;
};

export function resolveReasoningPickerState({
  catalogEntries,
  provider,
  modelName,
  value,
  disabledReasoningEfforts,
}: {
  catalogEntries: ReadonlyArray<PickableModelEntry>;
  provider: LlmProvider | undefined;
  modelName: string | undefined;
  value: ReasoningEffort | null;
  disabledReasoningEfforts?: ReadonlyArray<ReasoningEffort>;
}): ReasoningPickerState | null {
  const selectedEntry =
    provider === undefined || modelName === undefined
      ? undefined
      : catalogEntries.find((entry) => entry.provider === provider && entry.modelName === modelName);
  if (!selectedEntry?.supportsReasoning) return null;

  const supportedEfforts: readonly ReasoningEffort[] = selectedEntry.supportedReasoningEfforts ?? [];
  const fallbackEffort: ReasoningEffort = selectedEntry.reasoningEffort ?? supportedEfforts[0] ?? "none";
  const effectiveValue = value !== null && supportedEfforts.includes(value) ? value : fallbackEffort;

  return {
    effectiveValue,
    label: REASONING_EFFORT_META[effectiveValue].label,
    selectableEfforts: supportedEfforts.length > 0 ? supportedEfforts : REASONING_EFFORTS,
    supportedEfforts,
    disabledEfforts: new Set(disabledReasoningEfforts ?? []),
  };
}
