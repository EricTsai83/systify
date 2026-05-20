import { CircleNotchIcon } from "@phosphor-icons/react";

import { cn } from "@/lib/utils";

/** Canonical loading spinner. `motion-safe:` keeps it static under reduced-motion. */
export function Spinner({ size = 14, className, ...props }: React.ComponentProps<typeof CircleNotchIcon>) {
  return (
    <CircleNotchIcon
      size={size}
      weight="bold"
      aria-hidden
      className={cn("motion-safe:animate-spin", className)}
      {...props}
    />
  );
}
