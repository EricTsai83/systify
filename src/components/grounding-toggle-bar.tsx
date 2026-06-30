import { BookOpenIcon, FlaskIcon, ProhibitIcon } from "@phosphor-icons/react";
import type { RepositoryModeDisabledReasonCode } from "../../convex/lib/chatEligibility";
import {
  PromptInputSelect,
  PromptInputSelectContent,
  PromptInputSelectItem,
  PromptInputSelectTrigger,
  PromptInputSelectValue,
} from "@/components/ai-elements/prompt-input";
import { GROUNDING_LOADING_AXIS } from "@/lib/chat-composer-session";
import { cn } from "@/lib/utils";

/**
 * Per-message grounding availability for the Discuss composer. Mirrors the
 * discriminated `AxisVerdict` / `SandboxGroundingVerdict` shape exposed by
 * `repositoryModeEligibility.evaluate`. The code field is constrained to
 * `RepositoryModeDisabledReasonCode | "loading"` so backend additions to
 * the disabled-reason enum surface as compile errors here (the `"loading"`
 * sentinel covers the placeholder verdict the bar renders while the
 * eligibility query is still in flight). The bar only branches on
 * `enabled`; specific disabled-code handling stays in the wiring layer.
 */
export type GroundingAxisLike =
  | { readonly enabled: true }
  | {
      readonly enabled: false;
      readonly code: RepositoryModeDisabledReasonCode | "feature_not_included" | "loading";
      readonly message: string;
      readonly isActivatable?: boolean;
    };

export type GroundingAxisId = "library" | "sandbox";

export type GroundingAxisControl = {
  id: GroundingAxisId;
  label: string;
  active: boolean;
  verdict: GroundingAxisLike;
  onActiveChange: (next: boolean) => void;
};

export interface GroundingToggleBarProps {
  axes: readonly GroundingAxisControl[];
  /** Hides the whole bar when true (e.g. on Library Mode where it does not apply). */
  hidden?: boolean;
  className?: string;
}

type GroundingSelectorValue = GroundingAxisId | "none";

// eslint-disable-next-line react-refresh/only-export-components
export function createDiscussGroundingAxes(input: {
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
}): readonly GroundingAxisControl[] {
  return [
    {
      id: "library",
      label: "Library",
      active: input.groundLibrary,
      verdict: input.grounding?.library ?? GROUNDING_LOADING_AXIS,
      onActiveChange: input.setGroundLibrary,
    },
    {
      id: "sandbox",
      label: "Sandbox",
      active: input.groundSandbox,
      verdict: input.grounding?.sandbox ?? GROUNDING_LOADING_AXIS,
      onActiveChange: input.setGroundSandbox,
    },
  ];
}

/**
 * Per-message grounding selector for Discuss Mode.
 *
 * A single-select control for Library (artifact RAG), Sandbox (live source
 * tools), or no per-message grounding. Disabled options keep their reason on
 * the menu item's title. Recoverable Sandbox liveness states stay selectable
 * and prepare on send.
 *
 * The session reducer also enforces mutual exclusion so this component and
 * send-time payloads cannot drift apart.
 */
export function GroundingToggleBar({ axes, hidden = false, className }: GroundingToggleBarProps) {
  if (hidden) {
    return null;
  }

  const activeAxis = axes.find((axis) => axis.active);
  const value: GroundingSelectorValue = activeAxis?.id ?? "none";
  const currentOption = activeAxis ? getAxisOptionPresentation(activeAxis) : NONE_OPTION_PRESENTATION;

  const handleValueChange = (next: string) => {
    if (!isGroundingSelectorValue(next)) {
      return;
    }
    if (next === value) {
      return;
    }
    if (next === "none") {
      axes.forEach((axis) => {
        if (axis.active) {
          axis.onActiveChange(false);
        }
      });
      return;
    }
    const selectedAxis = axes.find((axis) => axis.id === next);
    if (!selectedAxis || !isAxisAvailable(selectedAxis)) {
      return;
    }
    // Enabling one axis is enough: the session reducer (setGroundLibrary /
    // setGroundSandbox) clears the other axis automatically, so the bar does
    // not re-clear it here.
    selectedAxis.onActiveChange(true);
  };

  return (
    <div className={cn("flex min-w-0 items-center", className)}>
      <PromptInputSelect value={value} onValueChange={handleValueChange}>
        <PromptInputSelectTrigger
          aria-label="Discuss grounding source"
          data-testid="grounding-toggle-trigger"
          title={currentOption.title}
          className={cn(
            "h-8 w-auto min-w-0 max-w-40 justify-start gap-1.5 rounded-none border-none bg-transparent px-2 text-xs font-medium text-muted-foreground shadow-none",
            "hover:bg-accent hover:text-foreground",
            "focus-visible:bg-transparent focus-visible:text-foreground",
            "aria-expanded:bg-accent aria-expanded:text-foreground",
          )}
        >
          <span className="flex size-4 shrink-0 items-center justify-center self-center text-current">
            <currentOption.Icon size={14} weight={currentOption.iconWeight} />
          </span>
          <PromptInputSelectValue className="flex items-center truncate leading-none" placeholder="Grounding">
            {currentOption.label}
          </PromptInputSelectValue>
        </PromptInputSelectTrigger>
        <PromptInputSelectContent className="min-w-44 border-border bg-popover p-1 text-popover-foreground shadow-lg">
          <GroundingSelectItem
            value="none"
            label={NONE_OPTION_PRESENTATION.label}
            title={NONE_OPTION_PRESENTATION.title}
            Icon={NONE_OPTION_PRESENTATION.Icon}
            testId="grounding-toggle-none"
          />
          {axes.map((axis) => {
            const option = getAxisOptionPresentation(axis);
            return (
              <GroundingSelectItem
                key={axis.id}
                value={axis.id}
                label={option.label}
                title={option.title}
                Icon={option.Icon}
                disabled={!option.available}
                suffix={option.suffix}
                testId={`grounding-toggle-${axis.id}`}
              />
            );
          })}
        </PromptInputSelectContent>
      </PromptInputSelect>
    </div>
  );
}

type GroundingOptionPresentation = {
  label: string;
  title: string;
  Icon: typeof BookOpenIcon;
  iconWeight: "regular" | "fill" | "bold";
  available: boolean;
  suffix?: string;
};

const NONE_OPTION_PRESENTATION: GroundingOptionPresentation = {
  label: "None",
  title: "No per-message grounding",
  Icon: ProhibitIcon,
  iconWeight: "bold",
  available: true,
};

function GroundingSelectItem({
  value,
  label,
  title,
  Icon,
  disabled = false,
  suffix,
  testId,
}: {
  value: GroundingSelectorValue;
  label: string;
  title: string;
  Icon: typeof BookOpenIcon;
  disabled?: boolean;
  suffix?: string;
  testId: string;
}) {
  return (
    <PromptInputSelectItem
      value={value}
      disabled={disabled}
      title={title}
      data-testid={testId}
      className={cn(
        "h-8 px-2 py-0 text-sm text-popover-foreground",
        "focus:bg-accent focus:text-accent-foreground data-highlighted:bg-accent",
        "[&>span:first-child]:hidden",
      )}
    >
      <div className="flex h-full w-full min-w-0 items-center gap-2 leading-none">
        <span className="flex size-5 shrink-0 items-center justify-center self-center text-muted-foreground">
          <Icon size={15} weight="bold" />
        </span>
        <span className="min-w-0 truncate leading-none">{label}</span>
        {suffix ? <span className="ml-auto shrink-0 text-[10px] text-muted-foreground/80">{suffix}</span> : null}
      </div>
    </PromptInputSelectItem>
  );
}

function getAxisOptionPresentation(axis: GroundingAxisControl): GroundingOptionPresentation {
  const enabled = axis.verdict.enabled;
  const activatable = !axis.verdict.enabled && axis.verdict.isActivatable === true;
  const available = isAxisAvailable(axis);
  const reason = !axis.verdict.enabled ? axis.verdict.message : undefined;
  const suffix = axis.id === "sandbox" ? (activatable ? "Prepares" : enabled ? "Live" : undefined) : undefined;
  const Icon = axis.id === "library" ? BookOpenIcon : FlaskIcon;
  const label = axis.label;
  return {
    label,
    title: available
      ? suffix
        ? `${label} grounding (${suffix.toLowerCase()} on send)`
        : `${label} grounding`
      : (reason ?? `${label} grounding unavailable`),
    Icon,
    iconWeight: axis.active && available ? "fill" : "regular",
    available,
    suffix,
  };
}

function isAxisAvailable(axis: GroundingAxisControl): boolean {
  const enabled = axis.verdict.enabled;
  const activatable = !axis.verdict.enabled && axis.verdict.isActivatable === true;
  return enabled || (axis.id === "sandbox" && activatable);
}

function isGroundingSelectorValue(value: string): value is GroundingSelectorValue {
  return value === "none" || value === "library" || value === "sandbox";
}
