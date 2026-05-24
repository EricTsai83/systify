import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "framer-motion";
import { BookOpenIcon, ChatCircleIcon, FlaskIcon } from "@phosphor-icons/react";
import { discussPath, labPath, libraryPath } from "@/route-paths";
import type { ChatMode, WorkspaceId } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ChatModeDisabledLike {
  message: string;
}

interface ChatModeAvailability {
  availableModes: ReadonlyArray<ChatMode>;
  disabledReasons: Partial<Record<ChatMode, ChatModeDisabledLike>>;
}

const CHAT_MODE_ENTRIES: ReadonlyArray<{
  value: ChatMode;
  label: string;
  icon: typeof ChatCircleIcon;
}> = [
  { value: "discuss", label: "Discuss", icon: ChatCircleIcon },
  { value: "library", label: "Library", icon: BookOpenIcon },
  { value: "lab", label: "Lab", icon: FlaskIcon },
];

const MORPH: Transition = { duration: 0.3, ease: [0.77, 0, 0.175, 1] };

// `flexBasis` isn't in Framer Motion's `numberValueTypes` map, so a bare
// number (e.g. `30`) is written to `element.style` as `"30"` — which the
// browser rejects as invalid for any non-zero length. The rejected frames
// leave `flex-basis` stuck at its last valid value (typically `0`), collapsing
// the inactive button to width 0 and clipping the icon under `overflow-hidden`.
// Passing strings with explicit `px` units routes through Framer's pixel
// interpolator so every frame produces a valid declaration.
//
// Only `flex-*` properties animate. Two other geometric anchors are locked
// via className so the icon AND label feel like they were always there,
// just revealed by the morph:
//   1. Icon left position: `pl-[10px]` on the button (constant). The icon
//      sits 10px from the button's left edge in every state.
//   2. Label position: absolute `left-[30px]` (= the inactive button width).
//      When inactive, the label sits exactly at the button's right edge and
//      is clipped by `overflow-hidden`. As the button morphs wider, the
//      label is revealed by the growing visible area — no separate
//      fade/slide animation needed.
const ACTIVE_FLEX = {
  flexGrow: 1,
  flexShrink: 1,
  flexBasis: "0px",
};
const INACTIVE_FLEX = {
  flexGrow: 0,
  flexShrink: 0,
  flexBasis: "30px",
};

// Survives unmount/remount so we can detect mode switches that happen
// via route navigation (each mode is a separate route that fully
// re-creates the component tree). Keyed by workspaceId so a switch in
// one workspace doesn't trigger a phantom mount transition when the
// user later opens a different workspace.
const persistedModeByWorkspace = new Map<WorkspaceId | null, ChatMode>();

export function WorkspaceModeSwitcher({
  workspaceId,
  mode,
  availability,
  className,
}: {
  workspaceId: WorkspaceId | null;
  mode: ChatMode;
  availability: ChatModeAvailability | null | undefined;
  className?: string;
}) {
  const navigate = useNavigate();
  const shouldReduceMotion = useReducedMotion();

  const [transitionFrom] = useState<ChatMode | null>(() => {
    const prev = persistedModeByWorkspace.get(workspaceId);
    return prev !== undefined && prev !== mode ? prev : null;
  });
  const [exitPillDone, setExitPillDone] = useState(transitionFrom === null);

  useEffect(() => {
    persistedModeByWorkspace.set(workspaceId, mode);
  }, [mode, workspaceId]);

  const isMountTransition = transitionFrom !== null && !exitPillDone && !shouldReduceMotion;

  const handleSelect = (value: ChatMode, isAvailable: boolean) => {
    if (!workspaceId) return;
    if (value === mode) return;
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
        aria-label="Workspace mode"
        className="flex h-9 gap-1 rounded-md border border-border bg-muted/40 p-1"
      >
        {CHAT_MODE_ENTRIES.map((entry) => {
          const isActive = mode === entry.value;
          const isAvailable = availability ? availability.availableModes.includes(entry.value) : true;
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
                "relative flex h-full items-center justify-start overflow-hidden rounded-sm pl-[10px] outline-none",
                "motion-safe:transition-colors motion-safe:duration-300",
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

              {/* Label is always rendered and absolutely positioned at the
                  inactive button's right edge. When inactive, `overflow-hidden`
                  on the button clips it entirely; as the button morphs wider,
                  the label is revealed by the growing visible area. No
                  separate fade/slide animation — the reveal is just
                  geometry. The button's `aria-label` provides the accessible
                  name, so the visible text span is marked aria-hidden. */}
              <span
                aria-hidden="true"
                className="pointer-events-none absolute left-[30px] top-1/2 z-10 -translate-y-1/2 whitespace-nowrap text-xs font-medium"
              >
                {entry.label}
              </span>
            </motion.button>
          );
        })}
      </div>
    </div>
  );
}
