import type { ComponentProps, JSX, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

export type TooltipIconButtonProps = Omit<ComponentProps<typeof Button>, "children" | "aria-label"> & {
  label: string;
  tooltip?: ReactNode;
  tooltipSide?: ComponentProps<typeof TooltipContent>["side"];
  tooltipAlign?: ComponentProps<typeof TooltipContent>["align"];
  delayDuration?: number;
  children: ReactNode;
};

export function TooltipIconButton({
  label,
  tooltip,
  tooltipSide = "top",
  tooltipAlign,
  delayDuration = 150,
  type = "button",
  variant = "ghost",
  size = "icon",
  pressEffect = "none",
  children,
  ...props
}: TooltipIconButtonProps): JSX.Element {
  return (
    <TooltipProvider delayDuration={delayDuration}>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button type={type} variant={variant} size={size} pressEffect={pressEffect} aria-label={label} {...props}>
            {children}
          </Button>
        </TooltipTrigger>
        <TooltipContent side={tooltipSide} align={tooltipAlign}>
          {tooltip ?? label}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
