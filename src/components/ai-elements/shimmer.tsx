"use client";

/* eslint-disable react-hooks/static-components -- shadcn-generated; the motion wrapper is memoized per `as` element so identity is stable across renders, but the rule only accepts module-scope declarations */

import { cn } from "@/lib/utils";
import { motion } from "motion/react";
import { type CSSProperties, type ElementType, type JSX, memo, useMemo } from "react";

export type TextShimmerProps = {
  children: string;
  as?: ElementType;
  className?: string;
  duration?: number;
  spread?: number;
};

const ShimmerComponent = ({ children, as: Component = "p", className, duration = 2, spread = 2 }: TextShimmerProps) => {
  // `motion.create` returns a *new component identity* per call, so calling
  // it inline would unmount/remount on every render and reset the animation
  // state. Memoize per `Component` so the same element type reuses the same
  // motion wrapper.
  const MotionComponent = useMemo(() => motion.create(Component as keyof JSX.IntrinsicElements), [Component]);

  const dynamicSpread = useMemo(() => (children?.length ?? 0) * spread, [children, spread]);

  return (
    <MotionComponent
      animate={{ backgroundPosition: "0% center" }}
      className={cn(
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
        "[--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--color-background),#0000_calc(50%+var(--spread)))] [background-repeat:no-repeat,padding-box]",
        className,
      )}
      initial={{ backgroundPosition: "100% center" }}
      style={
        {
          "--spread": `${dynamicSpread}px`,
          "backgroundImage": "var(--bg), linear-gradient(var(--color-muted-foreground), var(--color-muted-foreground))",
        } as CSSProperties
      }
      transition={{
        repeat: Number.POSITIVE_INFINITY,
        duration,
        ease: "linear",
      }}
    >
      {children}
    </MotionComponent>
  );
};

export const Shimmer = memo(ShimmerComponent);
