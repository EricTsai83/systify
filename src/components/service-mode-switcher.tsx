import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "framer-motion";
import { BookOpenIcon, ChatCircleIcon, FlaskIcon } from "@phosphor-icons/react";
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
  icon: typeof ChatCircleIcon;
}> = [
  { value: "discuss", label: "Discuss", icon: ChatCircleIcon },
  { value: "library", label: "Library", icon: BookOpenIcon },
  { value: "lab", label: "Lab", icon: FlaskIcon },
];

const MORPH_DURATION = 0.22;
const MORPH: Transition = { duration: MORPH_DURATION, ease: [0.77, 0, 0.175, 1] };
const LABEL_IN: Transition = { delay: MORPH_DURATION, duration: 0.1, ease: [0.16, 1, 0.3, 1] };
const LABEL_OUT: Transition = { duration: 0.12, ease: [0.77, 0, 0.175, 1] };

// `flexBasis` and `gap` aren't in Framer Motion's `numberValueTypes` map, so a
// bare number (e.g. `28`) is written to `element.style` as `"28"` — which the
// browser rejects as invalid for any non-zero length. The rejected frames leave
// `flex-basis` stuck at its last valid value (typically `0`), collapsing the
// inactive button to width 0 and clipping the icon under `overflow-hidden`.
// Passing strings with explicit `px` units routes through Framer's pixel
// interpolator so every frame produces a valid declaration.
const ACTIVE_FLEX = {
  flexGrow: 1,
  flexShrink: 1,
  flexBasis: "0px",
  gap: "6px",
  paddingLeft: 8,
  paddingRight: 8,
};
const INACTIVE_FLEX = {
  flexGrow: 0,
  flexShrink: 0,
  flexBasis: "28px",
  gap: "0px",
  paddingLeft: 0,
  paddingRight: 0,
};

// Survives unmount/remount so we can detect mode switches that happen
// via route navigation (each mode is a separate route that fully
// re-creates the component tree). Keyed by workspaceId so a switch in
// one workspace doesn't trigger a phantom mount transition when the
// user later opens a different workspace.
const persistedModeByWorkspace = new Map<WorkspaceId | null, ServiceMode>();

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
  const shouldReduceMotion = useReducedMotion();

  const [transitionFrom] = useState<ServiceMode | null>(() => {
    const prev = persistedModeByWorkspace.get(workspaceId);
    return prev !== undefined && prev !== serviceMode ? prev : null;
  });
  const [exitPillDone, setExitPillDone] = useState(transitionFrom === null);

  useEffect(() => {
    persistedModeByWorkspace.set(workspaceId, serviceMode);
  }, [serviceMode, workspaceId]);

  const isMountTransition = transitionFrom !== null && !exitPillDone && !shouldReduceMotion;

  const handleSelect = (value: ServiceMode, isAvailable: boolean) => {
    if (!workspaceId) return;
    if (value === serviceMode) return;
    if (!isAvailable) return;
    if (value === "discuss") {
      void navigate(discussPath(workspaceId));
    } else if (value === "library") {
      void navigate(libraryPath(workspaceId));
    } else if (value === "lab") {
      void navigate(labPath(workspaceId));
    }
  };

  return (
    <div className={cn("border-b border-border px-2 py-2", className)}>
      <div
        role="group"
        aria-label="Service mode"
        className="flex h-9 gap-1 rounded-md border border-border bg-muted/40 p-1"
      >
        {SERVICE_MODE_ENTRIES.map((entry) => {
          const isActive = serviceMode === entry.value;
          const isAvailable = availability ? availability.availableServiceModes.includes(entry.value) : true;
          const isFromMode = entry.value === transitionFrom;
          const Icon = entry.icon;

          const animateStyles = isActive ? ACTIVE_FLEX : INACTIVE_FLEX;
          let initialStyles: typeof ACTIVE_FLEX | typeof INACTIVE_FLEX | false = false;
          if (isMountTransition) {
            if (isActive) initialStyles = INACTIVE_FLEX;
            else if (isFromMode) initialStyles = ACTIVE_FLEX;
          }

          return (
            <motion.button
              key={entry.value}
              type="button"
              aria-pressed={isActive}
              aria-label={entry.label}
              aria-disabled={!isAvailable}
              onClick={() => handleSelect(entry.value, isAvailable)}
              initial={initialStyles}
              animate={animateStyles}
              transition={shouldReduceMotion ? { duration: 0 } : MORPH}
              whileTap={isAvailable && !shouldReduceMotion ? { scale: 0.96, transition: { duration: 0.1 } } : undefined}
              className={cn(
                "relative flex h-full items-center justify-center overflow-hidden rounded-sm outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                isActive ? "text-foreground" : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                !isAvailable && "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground",
              )}
            >
              {/* Active pill — AnimatePresence handles within-mount switches;
                  isMountTransition enables the enter animation on cross-mount switches. */}
              <AnimatePresence initial={isMountTransition}>
                {isActive ? (
                  <motion.span
                    key="pill"
                    aria-hidden="true"
                    initial={shouldReduceMotion ? false : { scale: 0.95, opacity: 0 }}
                    animate={{
                      scale: 1,
                      opacity: 1,
                      transition: shouldReduceMotion ? { duration: 0 } : MORPH,
                    }}
                    exit={{
                      scale: shouldReduceMotion ? 1 : 0.95,
                      opacity: 0,
                      transition: shouldReduceMotion ? { duration: 0 } : MORPH,
                    }}
                    className="absolute inset-0 rounded-sm bg-background shadow-sm"
                  />
                ) : null}
              </AnimatePresence>

              {/* Exit pill — fades out on the previously-active button during mount transitions */}
              {isMountTransition && isFromMode ? (
                <motion.span
                  aria-hidden="true"
                  initial={{ opacity: 1 }}
                  animate={{ opacity: 0 }}
                  transition={MORPH}
                  onAnimationComplete={() => setExitPillDone(true)}
                  className="absolute inset-0 rounded-sm bg-background shadow-sm"
                />
              ) : null}

              <Icon size={14} weight={isActive ? "fill" : "regular"} className="relative z-10 shrink-0" />

              <AnimatePresence initial={isMountTransition}>
                {isActive ? (
                  <motion.span
                    key="label"
                    initial={shouldReduceMotion ? false : { opacity: 0, x: -4 }}
                    animate={{
                      opacity: 1,
                      x: 0,
                      transition: shouldReduceMotion ? { duration: 0 } : LABEL_IN,
                    }}
                    exit={{
                      opacity: 0,
                      transition: shouldReduceMotion ? { duration: 0 } : LABEL_OUT,
                    }}
                    className="relative z-10 truncate text-xs font-medium"
                  >
                    {entry.label}
                  </motion.span>
                ) : null}
              </AnimatePresence>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
