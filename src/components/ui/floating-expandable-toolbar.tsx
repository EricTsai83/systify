import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { motion, useReducedMotion } from "motion/react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const FLOATING_TOOLBAR_TRANSITION = { duration: 0.2, ease: [0.23, 1, 0.32, 1] } as const;
const DEFAULT_CONTENT_MAX_WIDTH = "calc(100vw - 6rem)";

type ExpandedChange = boolean | ((previous: boolean) => boolean);

export function FloatingExpandableToolbar({
  expanded,
  onExpandedChange,
  expandIcon,
  collapseIcon,
  expandLabel,
  collapseLabel,
  controlsId,
  contentMaxWidth = DEFAULT_CONTENT_MAX_WIDTH,
  children,
  className,
  contentClassName,
  "data-testid": dataTestId,
}: {
  "expanded": boolean;
  "onExpandedChange": (next: ExpandedChange) => void;
  "expandIcon": ReactNode;
  "collapseIcon": ReactNode;
  "expandLabel": string;
  "collapseLabel": string;
  "controlsId": string;
  "contentMaxWidth"?: CSSProperties["maxWidth"];
  "children": ReactNode;
  "className"?: string;
  "contentClassName"?: string;
  "data-testid"?: string;
}) {
  const [contentRef, contentWidth] = useMeasuredWidth<HTMLDivElement>();
  const { reducedMotion, transition } = useToolbarMotion();
  const renderedContentWidth = expanded ? contentWidth : 0;

  return (
    <div
      className={cn(
        "absolute top-3 right-4 z-10 flex max-w-[calc(100%-2rem)] flex-row-reverse items-center overflow-hidden border p-0.5 transition-[background-color,border-color,box-shadow,backdrop-filter] duration-150 ease-out motion-reduce:transition-none",
        expanded
          ? "border-border bg-background/95 shadow-sm backdrop-blur"
          : "border-transparent bg-transparent shadow-none backdrop-blur-none",
        className,
      )}
      data-testid={dataTestId}
    >
      <div className="flex size-7 shrink-0 items-center justify-center">
        <FloatingToolbarButton
          aria-label={expanded ? collapseLabel : expandLabel}
          aria-expanded={expanded}
          aria-controls={controlsId}
          onClick={() => onExpandedChange((previous) => !previous)}
        >
          {expanded ? collapseIcon : expandIcon}
        </FloatingToolbarButton>
      </div>

      <motion.div
        initial={false}
        id={controlsId}
        aria-hidden={!expanded}
        inert={!expanded ? true : undefined}
        animate={{
          width: renderedContentWidth,
          opacity: expanded || reducedMotion ? 1 : 0,
        }}
        transition={transition}
        className={cn("flex justify-end overflow-hidden whitespace-nowrap", !expanded && "pointer-events-none")}
        style={{ maxWidth: contentMaxWidth }}
      >
        <div ref={contentRef} className={cn("flex w-max shrink-0 flex-nowrap items-center gap-1", contentClassName)}>
          {children}
        </div>
      </motion.div>
    </div>
  );
}

function FloatingToolbarButton({
  children,
  ...props
}: Omit<ComponentPropsWithoutRef<typeof Button>, "variant" | "size" | "type" | "className"> & {
  children: ReactNode;
}) {
  return (
    <Button type="button" variant="ghost" size="sm" className="size-7 p-0 active:scale-100" {...props}>
      {children}
    </Button>
  );
}

function useMeasuredWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;

    const measure = () => {
      setWidth((currentWidth) => {
        const nextWidth = Math.ceil(element.scrollWidth);
        return currentWidth === nextWidth ? currentWidth : nextWidth;
      });
    };

    measure();

    if (typeof ResizeObserver === "undefined") return;

    const resizeObserver = new ResizeObserver(measure);
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, []);

  return [ref, width] as const;
}

function useToolbarMotion() {
  const shouldReduceMotion = useReducedMotion();
  const reducedMotion = shouldReduceMotion === true;

  return {
    reducedMotion,
    transition: reducedMotion ? ({ duration: 0 } as const) : FLOATING_TOOLBAR_TRANSITION,
  };
}
