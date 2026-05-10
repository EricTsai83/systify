import { useNavigate } from "react-router-dom";
import { BookOpenIcon, ChatCircleIcon, FlaskIcon } from "@phosphor-icons/react";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { discussPath, labPath, libraryPath } from "@/route-paths";
import type { ServiceMode, WorkspaceId } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ServiceModeDisabledLike {
  message: string;
}

interface ServiceModeAvailability {
  availableServiceModes: ReadonlyArray<ServiceMode>;
  disabledReasons: Partial<Record<ServiceMode, ServiceModeDisabledLike>>;
}

const SERVICE_MODE_ENTRIES: ReadonlyArray<{
  value: ServiceMode;
  label: string;
  caption: string;
  icon: typeof ChatCircleIcon;
}> = [
  {
    value: "discuss",
    label: "Discuss",
    caption: "Free-form chat",
    icon: ChatCircleIcon,
  },
  {
    value: "library",
    label: "Library",
    caption: "Read & ask artifacts",
    icon: BookOpenIcon,
  },
  {
    value: "lab",
    label: "Lab",
    caption: "Sandbox-backed",
    icon: FlaskIcon,
  },
];

/**
 * Three-mode restructure — vertical toggle that pivots the workspace
 * shell between the three top-level service modes. Sits in the sidebar
 * between the header and the Threads section so the mode the user is in
 * is one click away from anywhere they look.
 *
 * The component never persists state of its own — clicking a mode
 * navigates to the canonical URL (`/w/:wid/discuss`, `/w/:wid/library`,
 * or `/w/:wid/lab`), and `serviceMode` is computed by `useServiceMode`
 * from that URL. Disabled modes still render so the user can hover and
 * read the unlock-hint tooltip; clicking a disabled mode is a no-op.
 *
 * Cost-transparency invariant: clicking `Library` NEVER provisions a
 * sandbox. This is a property of the URL the click navigates to (the
 * Library shell never starts a Lab session); the switcher itself just
 * routes — but the invariant should not be hidden behind a layer of
 * indirection.
 */
export function ServiceModeSwitcher({
  workspaceId,
  serviceMode,
  availability,
  className,
}: {
  workspaceId: WorkspaceId | null;
  serviceMode: ServiceMode;
  availability: ServiceModeAvailability | null | undefined;
  className?: string;
}) {
  const navigate = useNavigate();

  const handleSelect = (value: string) => {
    if (!workspaceId) return;
    if (value === "" || value === serviceMode) return;
    const next = value as ServiceMode;
    if (availability && !availability.availableServiceModes.includes(next)) {
      return;
    }
    if (next === "discuss") {
      void navigate(discussPath(workspaceId));
    } else if (next === "library") {
      void navigate(libraryPath(workspaceId));
    } else if (next === "lab") {
      void navigate(labPath(workspaceId));
    }
  };

  return (
    <TooltipProvider delayDuration={200}>
      <div className={cn("border-b border-border px-2 py-2", className)}>
        <ToggleGroup
          type="single"
          value={serviceMode}
          onValueChange={handleSelect}
          aria-label="Service mode"
          className="flex flex-col gap-1"
        >
          {SERVICE_MODE_ENTRIES.map((entry) => {
            const isAvailable = availability ? availability.availableServiceModes.includes(entry.value) : true;
            const tooltip = !isAvailable ? availability?.disabledReasons[entry.value]?.message : entry.caption;
            const Icon = entry.icon;
            return (
              <Tooltip key={entry.value}>
                <TooltipTrigger asChild>
                  <ToggleGroupItem
                    value={entry.value}
                    aria-pressed={serviceMode === entry.value}
                    aria-label={entry.label}
                    aria-disabled={!isAvailable}
                    className={cn(
                      "h-9 w-full justify-start gap-2 rounded-md text-xs",
                      "data-[state=on]:bg-primary/10 data-[state=on]:text-primary",
                      !isAvailable && "cursor-not-allowed opacity-50",
                    )}
                  >
                    <Icon size={16} weight={serviceMode === entry.value ? "fill" : "regular"} />
                    <span className="font-medium group-data-[collapsible=icon]:hidden">{entry.label}</span>
                  </ToggleGroupItem>
                </TooltipTrigger>
                {tooltip ? (
                  <TooltipContent side="right" align="center" className="max-w-xs text-xs">
                    {tooltip}
                  </TooltipContent>
                ) : null}
              </Tooltip>
            );
          })}
        </ToggleGroup>
      </div>
    </TooltipProvider>
  );
}
