import { BookOpenIcon, FlaskIcon } from "@phosphor-icons/react";
import type { RepositoryModeDisabledReasonCode } from "../../convex/lib/chatEligibility";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
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

const LOADING_GROUNDING_VERDICT: GroundingAxisLike = {
  enabled: false,
  code: "loading",
  message: "Loading grounding availability…",
};

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
      verdict: input.grounding?.library ?? LOADING_GROUNDING_VERDICT,
      onActiveChange: input.setGroundLibrary,
    },
    {
      id: "sandbox",
      label: "Sandbox",
      active: input.groundSandbox,
      verdict: input.grounding?.sandbox ?? LOADING_GROUNDING_VERDICT,
      onActiveChange: input.setGroundSandbox,
    },
  ];
}

/**
 * Per-message grounding selector for Discuss Mode.
 *
 * A single-select control for Library (artifact RAG), Sandbox (live source
 * tools), or no per-message grounding. Disabled options expose their reason
 * through a tooltip. Recoverable Sandbox liveness states stay selectable and
 * prepare on send.
 *
 * The session reducer also enforces mutual exclusion so this component and
 * send-time payloads cannot drift apart.
 */
export function GroundingToggleBar({ axes, hidden = false, className }: GroundingToggleBarProps) {
  if (hidden) {
    return null;
  }

  return (
    <TooltipProvider delayDuration={150}>
      <div
        role="radiogroup"
        aria-label="Discuss grounding source"
        className={cn("inline-flex min-w-0 flex-wrap items-center border border-border bg-background", className)}
      >
        <GroundingNoneOption axes={axes} />
        {axes.map((axis) => (
          <GroundingAxisOption key={axis.id} axis={axis} axes={axes} />
        ))}
      </div>
    </TooltipProvider>
  );
}

function GroundingNoneOption({ axes }: { axes: readonly GroundingAxisControl[] }) {
  const active = axes.every((axis) => !axis.active);
  return (
    <GroundingOption
      label="None"
      active={active}
      available
      onSelect={() => {
        axes.forEach((axis) => {
          if (axis.active) {
            axis.onActiveChange(false);
          }
        });
      }}
      testId="grounding-toggle-none"
    />
  );
}

function GroundingAxisOption({ axis, axes }: { axis: GroundingAxisControl; axes: readonly GroundingAxisControl[] }) {
  const enabled = axis.verdict.enabled;
  const activatable = !axis.verdict.enabled && axis.verdict.isActivatable === true;
  const available = enabled || (axis.id === "sandbox" && activatable);
  const reason = !axis.verdict.enabled ? axis.verdict.message : undefined;
  const suffix =
    axis.id === "sandbox" ? (activatable ? "prepares on send" : enabled ? "live source" : undefined) : undefined;
  const Icon = axis.id === "library" ? BookOpenIcon : FlaskIcon;
  const iconFilled = axis.active && available;

  return (
    <GroundingOption
      label={axis.label}
      icon={<Icon size={14} weight={iconFilled ? "fill" : "regular"} />}
      active={axis.active}
      available={available}
      reason={reason}
      suffix={suffix}
      onSelect={() => {
        if (!available || axis.active) {
          return;
        }
        axes.forEach((otherAxis) => {
          if (otherAxis.id !== axis.id && otherAxis.active) {
            otherAxis.onActiveChange(false);
          }
        });
        axis.onActiveChange(true);
      }}
      testId={`grounding-toggle-${axis.id}`}
    />
  );
}

type GroundingOptionProps = {
  label: string;
  icon?: React.ReactNode;
  active: boolean;
  available: boolean;
  reason?: string;
  suffix?: string;
  onSelect: () => void;
  testId: string;
};

function GroundingOption({ label, icon, active, available, reason, suffix, onSelect, testId }: GroundingOptionProps) {
  const title = available ? (suffix ? `${label} grounding (${suffix})` : `${label} grounding`) : reason;
  const button = (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      aria-disabled={!available}
      onClick={onSelect}
      title={title}
      data-testid={testId}
      className={cn(
        "inline-flex h-7 items-center gap-1.5 border-0 border-r border-border px-2 text-xs font-medium transition-colors last:border-r-0",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
        active && available
          ? "bg-primary/10 text-primary hover:bg-primary/15"
          : available
            ? "bg-background text-muted-foreground hover:bg-muted/40 hover:text-foreground"
            : "cursor-not-allowed bg-muted/30 text-muted-foreground/70",
      )}
    >
      {icon ?? null}
      <span>{label}</span>
      {suffix && available ? (
        <span aria-hidden="true" className="text-[10px] text-muted-foreground/80">
          · {suffix}
        </span>
      ) : null}
    </button>
  );

  if (!available && reason) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side="top" className="max-w-72">
          {reason}
        </TooltipContent>
      </Tooltip>
    );
  }

  return button;
}
