/* eslint-disable react-refresh/only-export-components */
import * as React from "react";
import { Slot } from "radix-ui";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
  "inline-flex cursor-pointer items-center justify-center gap-2 whitespace-nowrap font-semibold transition-[color,background-color,border-color,transform] duration-100 ease-out active:scale-[0.97] motion-reduce:active:scale-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground border border-primary hover:bg-background hover:text-foreground",
        secondary: "bg-card text-foreground border border-border hover:bg-muted hover:border-foreground/30",
        outline: "bg-transparent text-foreground border border-border hover:bg-muted hover:border-foreground/30",
        ghost: "bg-transparent text-muted-foreground hover:bg-muted hover:text-foreground border border-transparent",
        destructive: "bg-destructive text-foreground border border-destructive hover:bg-background",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        "default": "h-10 px-4 text-sm [&_svg]:size-4",
        "sm": "h-8 px-3 text-xs [&_svg]:size-3.5",
        "xs": "h-7 px-2.5 text-xs [&_svg]:size-3",
        "lg": "h-11 px-5 text-sm [&_svg]:size-4",
        "icon": "h-9 w-9 [&_svg]:size-[1.1rem]",
        "icon-xs": "size-6 rounded-none p-0 [&_svg]:size-3",
      },
    },
    defaultVariants: {
      variant: "secondary",
      size: "default",
    },
  },
);

type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    // React 19 treats `ref` as a regular prop, but TypeScript only sees it
    // when the component's prop type includes it. Declaring it here lets
    // callers (and Radix asChild Slots that inject a ref via cloneElement)
    // forward refs without resorting to forwardRef on a plain function.
    ref?: React.Ref<HTMLButtonElement>;
  };

function Button({ className, variant, size, type = "button", asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  return (
    <Comp type={asChild ? undefined : type} className={cn(buttonVariants({ variant, size, className }))} {...props} />
  );
}

export { Button, buttonVariants };
