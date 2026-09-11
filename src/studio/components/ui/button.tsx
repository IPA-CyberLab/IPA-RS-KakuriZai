import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn";

export const buttonVariants = cva("uiButton", {
  variants: {
    variant: {
      default: "uiButton--default",
      secondary: "uiButton--secondary",
      outline: "uiButton--outline",
      ghost: "uiButton--ghost",
      destructive: "uiButton--destructive"
    },
    size: {
      default: "uiButton--defaultSize",
      sm: "uiButton--sm",
      icon: "uiButton--icon"
    }
  },
  defaultVariants: {
    variant: "default",
    size: "default"
  }
});

export type ButtonProps = React.ComponentProps<"button"> & VariantProps<typeof buttonVariants> & {
  asChild?: boolean;
};

export function Button({ className, variant, size, asChild = false, type = "button", ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return (
    <Comp
      type={type}
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}
