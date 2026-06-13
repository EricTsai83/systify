import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SidebarScrollViewport({
  children,
  className,
  topFade = false,
  viewportClassName,
}: {
  children: ReactNode;
  className?: string;
  topFade?: boolean;
  viewportClassName?: string;
}) {
  return (
    <div className={cn("relative min-h-0 overflow-hidden", className)}>
      <div
        className={cn(
          "no-scrollbar h-full overflow-x-hidden overflow-y-auto overscroll-contain",
          topFade ? "scroll-shadow-mask-y" : "scroll-shadow-mask-bottom",
          viewportClassName,
        )}
      >
        {children}
      </div>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 bottom-0 h-11 backdrop-blur-[4px] [-webkit-mask-image:linear-gradient(to_top,black_0%,black_45%,transparent_100%)] mask-[linear-gradient(to_top,black_0%,black_45%,transparent_100%)]"
      />
    </div>
  );
}
