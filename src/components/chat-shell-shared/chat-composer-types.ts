import type { FormEvent, ReactNode } from "react";
import type { GroundingAxisLike } from "@/components/grounding-toggle-bar";
import type {
  LlmProvider,
  ModelPreferenceScope,
  PickableModelEntry,
  ReasoningEffort,
  UserPickableCapability,
} from "@/lib/types";

export type ComposerModelPickValue = {
  provider: LlmProvider;
  modelName: string;
};

export type ComposerModelPickerViewModel = {
  value: ComposerModelPickValue | null;
  onChange: (next: ComposerModelPickValue) => void;
  threadLockedProvider?: LlmProvider | null;
  capability?: UserPickableCapability;
  preferenceScope: ModelPreferenceScope;
  disabled?: boolean;
  getDisabledReason?: (entry: PickableModelEntry) => string | null;
  catalogEntries: ReadonlyArray<PickableModelEntry> | undefined;
};

export type ComposerReasoningPickerViewModel = {
  value: ReasoningEffort | null;
  onChange: (next: ReasoningEffort | null) => void;
  provider: LlmProvider | undefined;
  modelName: string | undefined;
  preferenceScope: ModelPreferenceScope;
  disabled?: boolean;
  disabledReasoningEfforts?: ReadonlyArray<ReasoningEffort>;
  disabledReasoningEffortMessage?: string;
  catalogEntries: ReadonlyArray<PickableModelEntry> | undefined;
};

export type ComposerGroundingViewModel = {
  groundLibrary: boolean;
  groundSandbox: boolean;
  setGroundLibrary: (next: boolean) => void;
  setGroundSandbox: (next: boolean) => void;
  grounding:
    | {
        library: GroundingAxisLike;
        sandbox: GroundingAxisLike;
      }
    | null
    | undefined;
};

export type ChatComposerViewModel = {
  input: {
    value: string;
    setValue: (next: string) => void;
    placeholder: string;
    readOnly: boolean;
    readOnlyHint?: string;
  };
  tools: {
    ready: boolean;
    modelPicker: ComposerModelPickerViewModel | null;
    reasoningPicker: ComposerReasoningPickerViewModel | null;
    grounding: ComposerGroundingViewModel | null;
    extraControls?: ReactNode;
  };
  send: {
    isSending: boolean;
    isBlocked: boolean;
    disabledReason?: string;
    buttonState: "Send" | "Sending…" | "Syncing…";
    onSubmit: (event: FormEvent<HTMLFormElement>, contentOverride?: string) => Promise<void>;
  };
  cancel: {
    canCancel: boolean;
    isCancelling: boolean;
    onCancel?: () => Promise<void> | void;
  };
};
