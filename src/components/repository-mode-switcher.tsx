import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { AnimatePresence, motion, useReducedMotion, type Transition } from "framer-motion";
import { BookOpenIcon, ChatCircleIcon } from "@phosphor-icons/react";
import { discussPath, libraryPath } from "@/route-paths";
import type { ChatMode, RepositoryId } from "@/lib/types";
import { cn } from "@/lib/utils";

interface ChatModeAvailability {
  modes: Readonly<Record<ChatMode, { readonly enabled: boolean }>>;
}

const CHAT_MODE_ENTRIES: ReadonlyArray<{
  value: ChatMode;
  label: string;
  icon: typeof ChatCircleIcon;
}> = [
  { value: "discuss", label: "Discuss", icon: ChatCircleIcon },
  { value: "library", label: "Library", icon: BookOpenIcon },
];

const MORPH: Transition = { duration: 0.3, ease: [0.77, 0, 0.175, 1] };

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

// Survives unmount/remount so we can detect mode switches that happen via
// route navigation. Keyed by repositoryId so a switch in one repository
// doesn't trigger a phantom mount transition when the user later opens a
// different repository.
const persistedModeByRepository = new Map<RepositoryId | null, ChatMode>();

export function RepositoryModeSwitcher({
  repositoryId,
  mode,
  availability,
  className,
}: {
  repositoryId: RepositoryId | null;
  mode: ChatMode;
  availability: ChatModeAvailability | null | undefined;
  className?: string;
}) {
  const navigate = useNavigate();
  const shouldReduceMotion = useReducedMotion();

  const [transitionFrom] = useState<ChatMode | null>(() => {
    const prev = persistedModeByRepository.get(repositoryId);
    return prev !== undefined && prev !== mode ? prev : null;
  });
  const [exitPillDone, setExitPillDone] = useState(transitionFrom === null);

  useEffect(() => {
    persistedModeByRepository.set(repositoryId, mode);
  }, [mode, repositoryId]);

  const isMountTransition = transitionFrom !== null && !exitPillDone && !shouldReduceMotion;

  const handleSelect = (value: ChatMode, isAvailable: boolean) => {
    if (!repositoryId) return;
    if (value === mode) return;
    if (!isAvailable) return;
    if (value === "discuss") {
      void navigate(discussPath(repositoryId));
    } else if (value === "library") {
      void navigate(libraryPath(repositoryId));
    }
  };

  return (
    <div className={cn("border-b border-border px-2 py-2", className)}>
      <div role="group" aria-label="Repository mode" className="flex h-9 gap-1 border border-border bg-muted/40 p-1">
        {CHAT_MODE_ENTRIES.map((entry) => {
          const isActive = mode === entry.value;
          const isAvailable = availability ? availability.modes[entry.value].enabled : true;
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
                "relative flex h-full items-center justify-start overflow-hidden pl-[10px] outline-none",
                "motion-safe:transition-colors motion-safe:duration-300",
                "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                isActive ? "text-foreground" : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
                !isAvailable && "cursor-not-allowed opacity-50 hover:bg-transparent hover:text-muted-foreground",
              )}
            >
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
                    className="absolute inset-0 bg-background shadow-sm"
                  />
                ) : null}
              </AnimatePresence>

              {isMountTransition && isFromMode ? (
                <motion.span
                  aria-hidden="true"
                  initial={{ opacity: 1 }}
                  animate={{ opacity: 0 }}
                  transition={MORPH}
                  onAnimationComplete={() => setExitPillDone(true)}
                  className="absolute inset-0 bg-background shadow-sm"
                />
              ) : null}

              <Icon size={14} weight={isActive ? "fill" : "regular"} className="relative z-10 shrink-0" />

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
