import { CheckIcon, CopyIcon } from "@phosphor-icons/react";
import { useCallback, type ComponentProps, type JSX, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useClipboard } from "@/hooks/use-clipboard";
import { cn } from "@/lib/utils";

export type CopyActionButtonProps = Omit<
  ComponentProps<typeof Button>,
  "children" | "onClick" | "aria-label" | "type"
> & {
  text: string | (() => string | null | undefined);
  idleLabel?: string;
  copiedLabel?: string;
  idleAriaLabel?: string;
  copiedAriaLabel?: string;
  showLabel?: boolean;
  tooltip?: boolean;
  tooltipSide?: ComponentProps<typeof TooltipContent>["side"];
  resetAfterMs?: number;
  copyIcon?: ReactNode;
  copiedIcon?: ReactNode;
  onCopied?: () => void;
  onCopyFailed?: () => void;
};

export function CopyActionButton({
  text,
  idleLabel = "Copy",
  copiedLabel = "Copied",
  idleAriaLabel,
  copiedAriaLabel,
  showLabel = false,
  tooltip = !showLabel,
  tooltipSide = "top",
  resetAfterMs = 1500,
  copyIcon = <CopyIcon />,
  copiedIcon = <CheckIcon weight="bold" />,
  onCopied,
  onCopyFailed,
  variant = "ghost",
  size = "icon",
  pressEffect = "none",
  className,
  ...props
}: CopyActionButtonProps): JSX.Element {
  const { copied, copy } = useClipboard({ resetAfterMs });
  const currentLabel = copied ? copiedLabel : idleLabel;
  const currentAriaLabel = copied ? (copiedAriaLabel ?? copiedLabel) : (idleAriaLabel ?? idleLabel);

  const handleClick = useCallback(() => {
    const resolvedText = typeof text === "function" ? text() : text;
    if (resolvedText === null || resolvedText === undefined || resolvedText.length === 0) {
      onCopyFailed?.();
      return;
    }

    void copy(resolvedText).then((success) => {
      if (success) {
        onCopied?.();
      } else {
        onCopyFailed?.();
      }
    });
  }, [copy, onCopied, onCopyFailed, text]);

  const button = (
    <Button
      type="button"
      variant={variant}
      size={size}
      pressEffect={pressEffect}
      className={className}
      aria-label={currentAriaLabel}
      onClick={handleClick}
      {...props}
    >
      <span className="relative size-4 shrink-0" aria-hidden="true">
        <span
          className={cn(
            "absolute inset-0 flex items-center justify-center transition-[opacity,filter,transform] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
            copied ? "scale-90 opacity-0 blur-[1.5px]" : "scale-100 opacity-100 blur-0",
          )}
        >
          {copyIcon}
        </span>
        <span
          className={cn(
            "absolute inset-0 flex items-center justify-center transition-[opacity,filter,transform] duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
            copied ? "scale-100 opacity-100 blur-0" : "scale-75 opacity-0 blur-[1.5px]",
          )}
        >
          {copiedIcon}
        </span>
      </span>
      {showLabel ? currentLabel : null}
    </Button>
  );

  if (!tooltip) {
    return button;
  }

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>{button}</TooltipTrigger>
        <TooltipContent side={tooltipSide}>{currentLabel}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
