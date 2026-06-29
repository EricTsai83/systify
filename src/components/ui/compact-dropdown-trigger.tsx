import { CaretDownIcon } from "@phosphor-icons/react";
import type { ComponentProps, JSX, ReactNode } from "react";
import { cn } from "@/lib/utils";

export type CompactDropdownTriggerProps = Omit<ComponentProps<"button">, "children"> & {
  icon: ReactNode;
  label: ReactNode;
  caret?: ReactNode;
  hideLabelBelowSm?: boolean;
};

export function CompactDropdownTrigger({
  icon,
  label,
  caret = <CaretDownIcon size={11} weight="bold" />,
  hideLabelBelowSm = false,
  className,
  type = "button",
  ...props
}: CompactDropdownTriggerProps): JSX.Element {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex h-8 w-auto max-w-full min-w-0 shrink-0 items-center justify-start gap-1.5 rounded-none border-none bg-transparent px-2 py-0 text-xs font-medium text-muted-foreground shadow-none transition-colors",
        "hover:bg-accent hover:text-foreground",
        "focus-visible:bg-transparent focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "aria-expanded:bg-accent aria-expanded:text-foreground",
        "disabled:pointer-events-none disabled:opacity-50",
        "[&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      {...props}
    >
      {icon}
      <span className={cn("truncate leading-none", hideLabelBelowSm && "hidden sm:inline")}>{label}</span>
      {caret}
    </button>
  );
}
