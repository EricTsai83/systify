import * as React from "react";
import { ScrollArea as ScrollAreaPrimitive } from "radix-ui";
import { cn } from "@/lib/utils";

const ScrollArea = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.Root>
>(({ className, children, ...props }, ref) => (
  <ScrollAreaPrimitive.Root ref={ref} className={cn("relative overflow-hidden", className)} {...props}>
    <ScrollAreaPrimitive.Viewport className="h-full w-full">{children}</ScrollAreaPrimitive.Viewport>
    <ScrollBar />
    <ScrollAreaPrimitive.Corner />
  </ScrollAreaPrimitive.Root>
));
ScrollArea.displayName = ScrollAreaPrimitive.Root.displayName;

// Scrollbar visuals are deliberately tuned to be theme-aware AND noticeably
// thinner than the platform's native scrollbar (which is ~12–15px on most
// browsers). Choices, in order:
//   • `w-1` (~4–5px depending on root font-size) — well under the native
//     bar so the chat panel reads as a clean column even when the bar is
//     persistently visible (`type="always"`). We removed the older
//     `border-l-transparent + p-px` chrome that used to eat the track,
//     so the thumb now fills the full 4–5px width and stays grabbable.
//   • `bg-muted-foreground/60` — the muted-foreground token gives strong
//     contrast in both modes (light: oklch 0.492; dark: oklch 0.641); at
//     60% alpha the bar reads as a solid, deliberate piece of UI rather
//     than a hint, which matters because the bar is now always on. The
//     previous `bg-border` token sat too close to the background in dark
//     mode (border 0.301 vs background 0.216) and effectively vanished.
//   • `hover:bg-muted-foreground/80` — bumps to near-solid under the
//     cursor so direct interaction still has affordance even though the
//     bar never auto-hides.
const ScrollBar = React.forwardRef<
  React.ElementRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>,
  React.ComponentPropsWithoutRef<typeof ScrollAreaPrimitive.ScrollAreaScrollbar>
>(({ className, orientation = "vertical", ...props }, ref) => (
  <ScrollAreaPrimitive.ScrollAreaScrollbar
    ref={ref}
    orientation={orientation}
    className={cn(
      "flex touch-none select-none transition-colors",
      orientation === "vertical" && "h-full w-1",
      orientation === "horizontal" && "h-1 flex-col",
      className,
    )}
    {...props}
  >
    <ScrollAreaPrimitive.ScrollAreaThumb className="relative flex-1 rounded-full bg-muted-foreground/60 transition-colors hover:bg-muted-foreground/80" />
  </ScrollAreaPrimitive.ScrollAreaScrollbar>
));
ScrollBar.displayName = ScrollAreaPrimitive.ScrollAreaScrollbar.displayName;

export { ScrollArea, ScrollBar };
